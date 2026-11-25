import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Storage, StoredObject } from "./types.js";

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error("storage key escapes the storage root");
    }
    return full;
  }

  localPath(key: string): string {
    return this.resolve(key);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Write then rename so a crash never leaves a half written object behind.
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, data);
    await rename(temp, target);
  }

  async putFile(key: string, filePath: string): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(filePath, temp);
    await rename(temp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readStream(key: string): Promise<Readable> {
    const target = this.resolve(key);
    await stat(target);
    return createReadStream(target);
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const start = this.resolve(prefix.replace(/\/+$/, ""));
    const found: StoredObject[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (!entry.name.includes(".tmp-")) {
          const info = await stat(full);
          found.push({ key: path.relative(this.root, full).split(path.sep).join("/"), size: info.size });
        }
      }
    };
    await walk(start);
    return found.filter((object) => object.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
