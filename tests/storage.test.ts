import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStorageFromEnv,
  InvalidStorageKeyError,
  LocalStorageAdapter,
  S3StorageAdapter,
  StorageConfigurationError,
  StorageObjectTooLargeError,
  StorageProviderError,
} from "@/lib/storage";

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

describe("S3-compatible storage adapter", () => {
  function adapterWith(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof S3StorageAdapter>[0]> = {}) {
    return new S3StorageAdapter(
      {
        endpoint: "https://objects.example.test/storage",
        bucket: "gmao-files",
        region: "eu-west-3",
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "server-only-secret",
        prefix: "tenant-files",
        ...overrides,
      },
      {
        fetchImpl,
        now: () => new Date("2026-08-08T08:30:00.000Z"),
      },
    );
  }

  it("signs PUT/GET/DELETE requests and keeps the configured namespace", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      if (init?.method === "GET") {
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "content-length": "3" },
        });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const adapter = adapterWith(fetchImpl);

    await expect(adapter.put("documents/doc 1/file.pdf", new Uint8Array([1, 2, 3]))).resolves.toBe(
      "documents/doc 1/file.pdf",
    );
    await expect(adapter.get("documents/doc 1/file.pdf")).resolves.toEqual(new Uint8Array([4, 5, 6]));
    await expect(adapter.delete("documents/doc 1/file.pdf")).resolves.toBeUndefined();

    expect(requests.map((request) => request.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(requests[0]?.url).toBe(
      "https://objects.example.test/storage/gmao-files/tenant-files/documents/doc%201/file.pdf",
    );
    const authorization = requests[0]?.headers.get("authorization") ?? "";
    expect(authorization).toContain(
      "Credential=AKIDEXAMPLE/20260808/eu-west-3/s3/aws4_request",
    );
    expect(authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(authorization).not.toContain("server-only-secret");
    expect(requests[0]?.headers.get("x-amz-date")).toBe("20260808T083000Z");
  });

  it("supports temporary credentials without exposing the session token in errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("provider says token=temporary-session-secret", { status: 500 }),
    ) as typeof fetch;
    const adapter = adapterWith(fetchImpl, { sessionToken: "temporary-session-secret" });

    await expect(adapter.get("documents/doc-1/file.pdf")).rejects.toMatchObject({
      name: "StorageProviderError",
      message: "Object storage request failed with HTTP 500",
    });
    await expect(adapter.get("documents/doc-1/file.pdf")).rejects.not.toThrow(
      /temporary-session-secret/,
    );
  });

  it("rejects unsafe endpoints and storage keys before network I/O", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(
      () => adapterWith(fetchImpl, { endpoint: "http://127.0.0.1:9000" }),
    ).toThrow(StorageConfigurationError);
    const adapter = adapterWith(fetchImpl);

    await expect(adapter.put("../escape.bin", new Uint8Array([1]))).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the configured maximum object size", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4" },
      }),
    ) as typeof fetch;
    const adapter = adapterWith(fetchImpl, { maxObjectBytes: 3 });

    await expect(adapter.get("documents/doc-1/file.pdf")).rejects.toBeInstanceOf(
      StorageObjectTooLargeError,
    );
  });

  it("redacts transport exception details", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket failure with server-only-secret");
    }) as typeof fetch;
    const adapter = adapterWith(fetchImpl);

    await expect(adapter.get("documents/doc-1/file.pdf")).rejects.toEqual(
      new StorageProviderError(),
    );
  });
});

describe("storage provider factory", () => {
  it("keeps local storage as the default provider", () => {
    expect(createStorageFromEnv({ STORAGE_LOCAL_DIR: "./data/test" })).toBeInstanceOf(
      LocalStorageAdapter,
    );
  });

  it("constructs S3-compatible storage from server environment settings", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const adapter = createStorageFromEnv(
      {
        STORAGE_PROVIDER: "s3",
        STORAGE_S3_ENDPOINT: "https://objects.example.test",
        STORAGE_S3_BUCKET: "gmao-files",
        STORAGE_S3_REGION: "eu-west-3",
        STORAGE_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
        STORAGE_S3_SECRET_ACCESS_KEY: "server-only-secret",
      },
      { fetchImpl },
    );

    expect(adapter).toBeInstanceOf(S3StorageAdapter);
  });

  it("fails closed for unsupported providers", () => {
    expect(() => createStorageFromEnv({ STORAGE_PROVIDER: "ftp" })).toThrow(
      StorageConfigurationError,
    );
  });
});
