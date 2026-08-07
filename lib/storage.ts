import fs from "node:fs/promises";
import path from "node:path";

export interface StorageAdapter {
  put(key: string, data: Uint8Array): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

export class InvalidStorageKeyError extends Error {
  constructor(message = "Storage key must stay inside the configured storage root") {
    super(message);
    this.name = "InvalidStorageKeyError";
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(baseDir = process.env.STORAGE_LOCAL_DIR || "./data/documents") {
    this.root = path.resolve(baseDir);
  }

  private resolveKey(key: string) {
    const segments = key.split("/");
    if (
      !key ||
      path.isAbsolute(key) ||
      key.includes("\\") ||
      key.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new InvalidStorageKeyError();
    }

    const filePath = path.resolve(this.root, ...segments);
    if (filePath === this.root || !filePath.startsWith(`${this.root}${path.sep}`)) {
      throw new InvalidStorageKeyError();
    }
    return filePath;
  }

  async put(key: string, data: Uint8Array) {
    const filePath = this.resolveKey(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    return key;
  }

  async get(key: string) {
    return new Uint8Array(await fs.readFile(this.resolveKey(key)));
  }

  async delete(key: string) {
    await fs.rm(this.resolveKey(key), { force: true });
  }
}

export const storage = new LocalStorageAdapter();
