"use strict";
import axios from "axios";
import fs from "fs";
import path from "path";
import { promisify } from "util";
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const mkdirAsync = promisify(fs.mkdir);
const existsAsync = promisify(fs.exists);

async function ensureDirectoryExistence(filePath) {
  const dirnames = [path.dirname(filePath)];
  let backTracking = false;
  while (dirnames.length > 0) {
    const dirname = dirnames.pop();
    if (backTracking) {
      try {
        await mkdirAsync(dirname);
      } catch (e) {
        if (e.code !== "EEXIST") {
          throw e;
        }
      }
    } else if (await existsAsync(dirname)) {
      backTracking = true;
    } else {
      dirnames.push(dirname, path.dirname(dirname));
    }
  }
}

export class DownloadsScheduler {
  constructor(dest, proxy, timeout, parallelism, ignoreMissingAssets) {
    this.instance = axios.create({
      timeout: timeout * 1000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_5) \
        AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36"
      },
      ...(proxy ? { proxy } : null)
    });
    this.dest = dest;
    this.parallelism = parallelism;
    this.queue = [];
    this.ignoreMissingAssets = ignoreMissingAssets;
  }

  enqueue(entry) {
    this.queue.push(entry);
  }

  async handleDownload(entry) {
    const { filename, url } = entry;
    const fullfilename = path.join(this.dest, filename);
    const idFilename = fullfilename + ".id";
    if ((await existsAsync(fullfilename)) && (await existsAsync(idFilename))) {
      const oldId = (await readFileAsync(idFilename)).toString();
      if (oldId === entry.id) {
        console.log(`file ${filename} is already up-to-date.`);
        return;
      }
    }
    console.log("fetching", filename);
    const response = await this.instance.get(url, {
      responseType: "arraybuffer"
    });
    await ensureDirectoryExistence(fullfilename);
    console.log("writing", filename);
    await writeFileAsync(fullfilename, response.data, "binary");
    await writeFileAsync(idFilename, entry.id);
  }

  async handleDownloadTask(entry) {
    for (let attempts = 1; attempts <= 3; attempts++) {
      try {
        await this.handleDownload(entry);
        break;
      } catch (e) {
        if (e.code === "ENOTFOUND" && attempts < 3) {
          console.warn(
            `[ERROR] Couldn't not download ${
              entry.filename
            }. We'll wait for a few seconds. (attempt: #${attempts})`
          );
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else if (
          e.response &&
          e.response.status === 404 &&
          this.ignoreMissingAssets
        ) {
          console.warn(`[WARNING] Missing asset: ${entry.filename} !`);
          break;
        } else {
          throw e;
        }
      }
    }
  }

  async enqueueDownloadTask(initialEntry) {
    await this.handleDownloadTask(initialEntry);
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      await this.handleDownloadTask(entry);
    }
  }

  async start() {
    const pendingTasks = this.queue
      .splice(0, this.parallelism)
      .map(entry => this.enqueueDownloadTask(entry));
    await Promise.all(pendingTasks);
  }
}
