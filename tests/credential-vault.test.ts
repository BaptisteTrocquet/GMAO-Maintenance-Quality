import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCredentialEncryptionKeyProviderFromEnv,
  createStaticCredentialEncryptionKeyProvider,
  CredentialVaultError,
  EncryptedConnectorCredentialVault,
  type ConnectorCredentialRecordStore,
  type EncryptedConnectorCredentialRecord,
} from "@/lib/integrations/credential-vault";

class MemoryCredentialStore implements ConnectorCredentialRecordStore {
  records = new Map<string, EncryptedConnectorCredentialRecord>();
  throwMessage: string | null = null;

  private maybeThrow() {
    if (this.throwMessage) throw new Error(this.throwMessage);
  }

  async put(record: EncryptedConnectorCredentialRecord) {
    this.maybeThrow();
    const saved = { ...record };
    this.records.set(record.id, saved);
    return saved;
  }

  async find(input: { organizationId: string; connectorId: string; credentialId: string }) {
    this.maybeThrow();
    const record = this.records.get(input.credentialId);
    if (
      !record ||
      record.organizationId !== input.organizationId ||
      record.connectorId !== input.connectorId
    ) {
      return null;
    }
    return { ...record };
  }

  async list(input: { organizationId: string; connectorId?: string }) {
    this.maybeThrow();
    return [...this.records.values()]
      .filter(
        (record) =>
          record.organizationId === input.organizationId &&
          (input.connectorId === undefined || record.connectorId === input.connectorId),
      )
      .map((record) => ({ ...record }));
  }

  async delete(input: { organizationId: string; connectorId: string; credentialId: string }) {
    this.maybeThrow();
    const record = this.records.get(input.credentialId);
    if (
      !record ||
      record.organizationId !== input.organizationId ||
      record.connectorId !== input.connectorId
    ) {
      return false;
    }
    return this.records.delete(input.credentialId);
  }
}

function key(version: string, fill: number) {
  return { version, key: new Uint8Array(32).fill(fill) };
}

function keys(currentVersion = "v1") {
  return createStaticCredentialEncryptionKeyProvider({
    currentVersion,
    keys: [key("v1", 1), key("v2", 2)],
  });
}

const NOW = new Date("2026-08-08T09:00:00.000Z");

function createVault(store = new MemoryCredentialStore(), provider = keys()) {
  return {
    store,
    vault: new EncryptedConnectorCredentialVault(store, provider, () => NOW),
  };
}

describe("encrypted connector credential vault", () => {
  let store: MemoryCredentialStore;
  let vault: EncryptedConnectorCredentialVault;

  beforeEach(() => {
    ({ store, vault } = createVault());
  });

  it("encrypts bearer secrets at rest and returns only safe metadata from put/list", async () => {
    const secret = "vendor-token-super-secret";
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP production",
      secret: { kind: "bearer", token: secret },
    });

    expect(created).toMatchObject({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP production",
      kind: "bearer",
      keyVersion: "v1",
    });
    expect(JSON.stringify(created)).not.toContain(secret);

    const stored = store.records.get(created.id)!;
    expect(stored.ciphertext).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);

    const listed = await vault.list({ organizationId: "org-a", connectorId: "erp-primary" });
    expect(listed).toEqual([created]);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("resolves a scoped bearer credential in the REST connector runtime shape", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP production",
      secret: { kind: "bearer", token: "token-a" },
    });

    await expect(
      vault.resolve({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: created.id,
      }),
    ).resolves.toEqual({ kind: "bearer", organizationId: "org-a", token: "token-a" });
  });

  it("supports API-key credentials without exposing their value in metadata", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "iot-primary",
      label: "IoT key",
      secret: { kind: "apiKey", headerName: "X-Vendor-Key", value: "iot-secret" },
    });

    expect(created.kind).toBe("apiKey");
    expect(JSON.stringify(created)).not.toContain("iot-secret");
    await expect(
      vault.resolve({
        organizationId: "org-a",
        connectorId: "iot-primary",
        credentialId: created.id,
      }),
    ).resolves.toEqual({
      kind: "apiKey",
      organizationId: "org-a",
      headerName: "X-Vendor-Key",
      value: "iot-secret",
    });
  });

  it("does not allow a credential id to cross organization or connector scope", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "Scoped credential",
      secret: { kind: "bearer", token: "tenant-secret" },
    });

    await expect(
      vault.resolve({
        organizationId: "org-b",
        connectorId: "erp-primary",
        credentialId: created.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      vault.resolve({
        organizationId: "org-a",
        connectorId: "other-connector",
        credentialId: created.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed if a faulty store returns a record from another tenant", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "Scoped credential",
      secret: { kind: "bearer", token: "tenant-secret" },
    });
    const originalFind = store.find.bind(store);
    store.find = async () => ({ ...(store.records.get(created.id)!), organizationId: "org-b" });

    await expect(
      vault.resolve({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: created.id,
      }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });

    store.find = originalFind;
  });

  it("binds ciphertext to tenant, connector, id, kind and key version with authenticated data", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "Scoped credential",
      secret: { kind: "bearer", token: "tenant-secret" },
    });
    const record = store.records.get(created.id)!;
    store.records.set(created.id, { ...record, connectorId: "tampered-connector" });

    await expect(
      vault.resolve({
        organizationId: "org-a",
        connectorId: "tampered-connector",
        credentialId: created.id,
      }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });

  it("re-encrypts updated credentials with the current key while preserving the id", async () => {
    const first = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP credential",
      secret: { kind: "bearer", token: "old-secret" },
    });

    const rotatedVault = new EncryptedConnectorCredentialVault(store, keys("v2"), () => NOW);
    const updated = await rotatedVault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      credentialId: first.id,
      label: "ERP credential rotated",
      secret: { kind: "bearer", token: "new-secret" },
    });

    expect(updated.id).toBe(first.id);
    expect(updated.keyVersion).toBe("v2");
    await expect(
      rotatedVault.resolve({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: first.id,
      }),
    ).resolves.toMatchObject({ token: "new-secret" });
  });

  it("can still decrypt records encrypted under the previous key version", async () => {
    const first = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP credential",
      secret: { kind: "bearer", token: "old-key-secret" },
    });

    const rotatedVault = new EncryptedConnectorCredentialVault(store, keys("v2"), () => NOW);
    await expect(
      rotatedVault.resolve({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: first.id,
      }),
    ).resolves.toMatchObject({ token: "old-key-secret" });
  });

  it("redacts store/provider failures instead of propagating secret-bearing diagnostics", async () => {
    store.throwMessage = "upstream failed while processing bearer secret-do-not-log";

    let error: unknown;
    try {
      await vault.list({ organizationId: "org-a" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CredentialVaultError);
    expect(error).toMatchObject({ code: "STORE_ERROR" });
    expect(String(error)).not.toContain("secret-do-not-log");
  });

  it("rejects corrupted ciphertext with a generic error that contains no credential material", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP credential",
      secret: { kind: "bearer", token: "never-in-error" },
    });
    const record = store.records.get(created.id)!;
    store.records.set(created.id, { ...record, ciphertext: "AAAA" });

    let error: unknown;
    try {
      await vault.resolve({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: created.id,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: "DECRYPTION_FAILED" });
    expect(String(error)).not.toContain("never-in-error");
  });

  it("deletes only within the exact organization and connector scope", async () => {
    const created = await vault.put({
      organizationId: "org-a",
      connectorId: "erp-primary",
      label: "ERP credential",
      secret: { kind: "bearer", token: "delete-secret" },
    });

    await expect(
      vault.delete({
        organizationId: "org-b",
        connectorId: "erp-primary",
        credentialId: created.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.records.has(created.id)).toBe(true);

    await expect(
      vault.delete({
        organizationId: "org-a",
        connectorId: "erp-primary",
        credentialId: created.id,
      }),
    ).resolves.toEqual({ deleted: true });
    expect(store.records.has(created.id)).toBe(false);
  });

  it("rejects unsafe or empty credential values before persisting anything", async () => {
    await expect(
      vault.put({
        organizationId: "org-a",
        connectorId: "erp-primary",
        label: "Bad key",
        secret: { kind: "apiKey", headerName: "Host", value: "secret" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    await expect(
      vault.put({
        organizationId: "org-a",
        connectorId: "erp-primary",
        label: "Bad token",
        secret: { kind: "bearer", token: "   " },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(store.records.size).toBe(0);
  });

  it("builds a rotation-capable key provider from server environment keys", () => {
    const current = randomBytes(32).toString("base64");
    const previous = randomBytes(32).toString("base64");
    const provider = createCredentialEncryptionKeyProviderFromEnv({
      CONNECTOR_CREDENTIAL_KEY_VERSION: "v2",
      CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64: current,
      CONNECTOR_CREDENTIAL_PREVIOUS_KEY_VERSION: "v1",
      CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64: previous,
    });

    expect(provider.current().version).toBe("v2");
    expect(provider.byVersion("v1")?.key.byteLength).toBe(32);
  });

  it("requires exactly 32 bytes of base64-decoded master key material", () => {
    expect(() =>
      createCredentialEncryptionKeyProviderFromEnv({
        CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64: Buffer.from("too-short").toString("base64"),
      }),
    ).toThrow(CredentialVaultError);
    expect(() => createCredentialEncryptionKeyProviderFromEnv({})).toThrow(CredentialVaultError);
  });
});
