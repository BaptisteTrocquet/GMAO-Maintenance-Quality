import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidStorageKeyError, LocalStorageAdapter } from "@/lib/storage";

const roots: string[] = [];

async function temporaryStorage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gmao-storage-"));
  roots.push(root);
  return { root, adapter: new LocalStorageAdapter(root) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local storage adapter", () => {
  it("writes, reads and deletes data inside the configured root", async () => {
    const { root, adapter } = await temporaryStorage();
    const data = new TextEncoder().encode("controlled content");

    await expect(adapter.put("documents/doc-1/rev-a/file", data)).resolves.toBe(
      "documents/doc-1/rev-a/file",
    );
    await expect(adapter.get("documents/doc-1/rev-a/file")).resolves.toEqual(data);
    await expect(fs.readFile(path.join(root, "documents/doc-1/rev-a/file"))).resolves.toEqual(
      Buffer.from(data),
    );

    await adapter.delete("documents/doc-1/rev-a/file");
    await expect(fs.stat(path.join(root, "documents/doc-1/rev-a/file"))).rejects.toBeDefined();
  });

  it("rejects absolute, traversal and Windows-style separator keys", async () => {
    const { adapter } = await temporaryStorage();
    const data = new Uint8Array([1]);

    await expect(adapter.put("../escape.bin", data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(adapter.put("/tmp/escape.bin", data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(adapter.get("nested/../../escape.bin")).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(adapter.put("documents\\..\\escape.bin", data)).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
  });
});
