import fs from "node:fs/promises";
import path from "node:path";

export interface StorageAdapter {
  put(key: string, data: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private baseDir = process.env.STORAGE_LOCAL_DIR || "./data/documents") {}

  async put(key: string, data: Uint8Array) {
    const filePath = path.join(this.baseDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return key;
  }

  async get(key: string) {
    return new Uint8Array(await fs.readFile(path.join(this.baseDir, key)));
  }

  async delete(key: string) {
    await fs.rm(path.join(this.baseDir, key), { force: true });
  }
}

export const storage = new LocalStorageAdapter();
