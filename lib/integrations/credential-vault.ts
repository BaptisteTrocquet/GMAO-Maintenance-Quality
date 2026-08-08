import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { RestConnectorCredential } from "@/lib/integrations/rest-connector";

const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type ConnectorCredentialSecret =
  | { kind: "bearer"; token: string }
  | { kind: "apiKey"; headerName: string; value: string };

export type ConnectorCredentialMetadata = {
  id: string;
  organizationId: string;
  connectorId: string;
  label: string;
  kind: ConnectorCredentialSecret["kind"];
  keyVersion: string;
  createdAt: Date;
  updatedAt: Date;
};

export type EncryptedConnectorCredentialRecord = ConnectorCredentialMetadata & {
  ciphertext: string;
  iv: string;
  authTag: string;
};

export interface ConnectorCredentialRecordStore {
  put(record: EncryptedConnectorCredentialRecord): Promise<EncryptedConnectorCredentialRecord>;
  find(input: {
    organizationId: string;
    connectorId: string;
    credentialId: string;
  }): Promise<EncryptedConnectorCredentialRecord | null>;
  list(input: {
    organizationId: string;
    connectorId?: string;
  }): Promise<EncryptedConnectorCredentialRecord[]>;
  delete(input: {
    organizationId: string;
    connectorId: string;
    credentialId: string;
  }): Promise<boolean>;
}

export type CredentialEncryptionKey = {
  version: string;
  key: Uint8Array;
};

export interface CredentialEncryptionKeyProvider {
  current(): CredentialEncryptionKey;
  byVersion(version: string): CredentialEncryptionKey | null;
}

export class CredentialVaultError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONFIGURATION"
      | "INVALID_CREDENTIAL"
      | "NOT_FOUND"
      | "TENANT_SCOPE_MISMATCH"
      | "DECRYPTION_FAILED"
      | "STORE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

function validateKey(input: CredentialEncryptionKey) {
  const version = input.version.trim();
  if (!version) {
    throw new CredentialVaultError(
      "INVALID_CONFIGURATION",
      "Connector credential encryption key version is required",
    );
  }
  if (input.key.byteLength !== KEY_BYTES) {
    throw new CredentialVaultError(
      "INVALID_CONFIGURATION",
      "Connector credential encryption keys must contain exactly 32 bytes",
    );
  }
  return { version, key: new Uint8Array(input.key) };
}

export function createStaticCredentialEncryptionKeyProvider(input: {
  currentVersion: string;
  keys: readonly CredentialEncryptionKey[];
}): CredentialEncryptionKeyProvider {
  const keys = new Map<string, Uint8Array>();
  for (const candidate of input.keys) {
    const key = validateKey(candidate);
    if (keys.has(key.version)) {
      throw new CredentialVaultError(
        "INVALID_CONFIGURATION",
        "Connector credential encryption key versions must be unique",
      );
    }
    keys.set(key.version, key.key);
  }

  const currentVersion = input.currentVersion.trim();
  if (!keys.has(currentVersion)) {
    throw new CredentialVaultError(
      "INVALID_CONFIGURATION",
      "Current connector credential encryption key version is unavailable",
    );
  }

  return {
    current() {
      const key = keys.get(currentVersion)!;
      return { version: currentVersion, key: new Uint8Array(key) };
    },
    byVersion(version: string) {
      const key = keys.get(version);
      return key ? { version, key: new Uint8Array(key) } : null;
    },
  };
}

function parseBase64Key(value: string, name: string) {
  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new CredentialVaultError("INVALID_CONFIGURATION", `${name} must be valid base64`);
  }
  if (key.byteLength !== KEY_BYTES) {
    throw new CredentialVaultError(
      "INVALID_CONFIGURATION",
      `${name} must decode to exactly 32 bytes`,
    );
  }
  return new Uint8Array(key);
}

export function createCredentialEncryptionKeyProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const currentVersion = env.CONNECTOR_CREDENTIAL_KEY_VERSION?.trim() || "v1";
  const currentRaw = env.CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64?.trim();
  if (!currentRaw) {
    throw new CredentialVaultError(
      "INVALID_CONFIGURATION",
      "CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64 is required",
    );
  }

  const keys: CredentialEncryptionKey[] = [
    {
      version: currentVersion,
      key: parseBase64Key(currentRaw, "CONNECTOR_CREDENTIAL_MASTER_KEY_BASE64"),
    },
  ];

  const previousVersion = env.CONNECTOR_CREDENTIAL_PREVIOUS_KEY_VERSION?.trim();
  const previousRaw = env.CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64?.trim();
  if (previousVersion || previousRaw) {
    if (!previousVersion || !previousRaw || previousVersion === currentVersion) {
      throw new CredentialVaultError(
        "INVALID_CONFIGURATION",
        "Previous connector credential key version and key must be configured together and differ from the current version",
      );
    }
    keys.push({
      version: previousVersion,
      key: parseBase64Key(previousRaw, "CONNECTOR_CREDENTIAL_PREVIOUS_MASTER_KEY_BASE64"),
    });
  }

  return createStaticCredentialEncryptionKeyProvider({ currentVersion, keys });
}

function normalizeScope(input: { organizationId: string; connectorId: string }) {
  const organizationId = input.organizationId.trim();
  const connectorId = input.connectorId.trim();
  if (!organizationId || !connectorId) {
    throw new CredentialVaultError(
      "INVALID_CREDENTIAL",
      "Connector credential organizationId and connectorId are required",
    );
  }
  return { organizationId, connectorId };
}

function validateSecret(secret: ConnectorCredentialSecret): ConnectorCredentialSecret {
  if (secret.kind === "bearer") {
    const token = secret.token.trim();
    if (!token) {
      throw new CredentialVaultError("INVALID_CREDENTIAL", "Bearer credential is empty");
    }
    return { kind: "bearer", token };
  }

  const headerName = secret.headerName.trim();
  const normalizedHeader = headerName.toLowerCase();
  if (
    !headerName ||
    !secret.value ||
    normalizedHeader === "host" ||
    normalizedHeader === "content-length" ||
    normalizedHeader === "cookie"
  ) {
    throw new CredentialVaultError(
      "INVALID_CREDENTIAL",
      "API-key credential header or value is invalid",
    );
  }
  return { kind: "apiKey", headerName, value: secret.value };
}

function aad(record: Pick<
  EncryptedConnectorCredentialRecord,
  "id" | "organizationId" | "connectorId" | "kind" | "keyVersion"
>) {
  return Buffer.from(
    `opengmao:connector-credential:${record.organizationId}:${record.connectorId}:${record.id}:${record.kind}:${record.keyVersion}`,
    "utf8",
  );
}

function metadata(record: EncryptedConnectorCredentialRecord): ConnectorCredentialMetadata {
  return {
    id: record.id,
    organizationId: record.organizationId,
    connectorId: record.connectorId,
    label: record.label,
    kind: record.kind,
    keyVersion: record.keyVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function randomCredentialId() {
  return `cred_${randomBytes(18).toString("base64url")}`;
}

function serializeSecret(secret: ConnectorCredentialSecret) {
  return Buffer.from(JSON.stringify(secret), "utf8");
}

function deserializeSecret(value: Buffer): ConnectorCredentialSecret {
  try {
    const parsed = JSON.parse(value.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (record.kind === "bearer" && typeof record.token === "string") {
      return validateSecret({ kind: "bearer", token: record.token });
    }
    if (
      record.kind === "apiKey" &&
      typeof record.headerName === "string" &&
      typeof record.value === "string"
    ) {
      return validateSecret({
        kind: "apiKey",
        headerName: record.headerName,
        value: record.value,
      });
    }
  } catch {
    // Deliberately fall through to one generic failure that never includes plaintext.
  }
  throw new CredentialVaultError("DECRYPTION_FAILED", "Connector credential could not be decrypted");
}

export class EncryptedConnectorCredentialVault {
  constructor(
    private readonly store: ConnectorCredentialRecordStore,
    private readonly keys: CredentialEncryptionKeyProvider,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateKey(keys.current());
  }

  private async storeCall<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch {
      throw new CredentialVaultError("STORE_ERROR", "Connector credential storage operation failed");
    }
  }

  async put(input: {
    organizationId: string;
    connectorId: string;
    credentialId?: string;
    label: string;
    secret: ConnectorCredentialSecret;
  }): Promise<ConnectorCredentialMetadata> {
    const scope = normalizeScope(input);
    const label = input.label.trim();
    if (!label || label.length > 150) {
      throw new CredentialVaultError(
        "INVALID_CREDENTIAL",
        "Connector credential label must contain between 1 and 150 characters",
      );
    }
    const secret = validateSecret(input.secret);
    const id = input.credentialId?.trim() || randomCredentialId();
    if (!id) throw new CredentialVaultError("INVALID_CREDENTIAL", "Credential id is required");

    let existing: EncryptedConnectorCredentialRecord | null = null;
    if (input.credentialId) {
      existing = await this.storeCall(() =>
        this.store.find({ ...scope, credentialId: id }),
      );
      if (!existing) throw new CredentialVaultError("NOT_FOUND", "Connector credential not found");
      if (
        existing.organizationId !== scope.organizationId ||
        existing.connectorId !== scope.connectorId ||
        existing.id !== id
      ) {
        throw new CredentialVaultError(
          "TENANT_SCOPE_MISMATCH",
          "Connector credential record does not match the requested tenant scope",
        );
      }
    }

    const encryptionKey = validateKey(this.keys.current());
    const iv = randomBytes(IV_BYTES);
    const createdAt = existing?.createdAt ?? this.now();
    const updatedAt = this.now();
    const recordBase: EncryptedConnectorCredentialRecord = {
      id,
      ...scope,
      label,
      kind: secret.kind,
      keyVersion: encryptionKey.version,
      createdAt,
      updatedAt,
      ciphertext: "",
      iv: iv.toString("base64url"),
      authTag: "",
    };

    const cipher = createCipheriv(CIPHER, encryptionKey.key, iv);
    cipher.setAAD(aad(recordBase));
    const ciphertext = Buffer.concat([cipher.update(serializeSecret(secret)), cipher.final()]);
    const record: EncryptedConnectorCredentialRecord = {
      ...recordBase,
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };

    const saved = await this.storeCall(() => this.store.put(record));
    if (
      saved.id !== id ||
      saved.organizationId !== scope.organizationId ||
      saved.connectorId !== scope.connectorId
    ) {
      throw new CredentialVaultError(
        "TENANT_SCOPE_MISMATCH",
        "Connector credential store returned a record outside the requested tenant scope",
      );
    }
    return metadata(saved);
  }

  async resolve(input: {
    organizationId: string;
    connectorId: string;
    credentialId: string;
  }): Promise<RestConnectorCredential> {
    const scope = normalizeScope(input);
    const credentialId = input.credentialId.trim();
    if (!credentialId) throw new CredentialVaultError("NOT_FOUND", "Connector credential not found");
    const record = await this.storeCall(() => this.store.find({ ...scope, credentialId }));
    if (!record) throw new CredentialVaultError("NOT_FOUND", "Connector credential not found");
    if (
      record.id !== credentialId ||
      record.organizationId !== scope.organizationId ||
      record.connectorId !== scope.connectorId
    ) {
      throw new CredentialVaultError(
        "TENANT_SCOPE_MISMATCH",
        "Connector credential record does not match the requested tenant scope",
      );
    }

    const key = this.keys.byVersion(record.keyVersion);
    if (!key) {
      throw new CredentialVaultError(
        "DECRYPTION_FAILED",
        "Connector credential could not be decrypted",
      );
    }

    try {
      const decipher = createDecipheriv(CIPHER, validateKey(key).key, Buffer.from(record.iv, "base64url"));
      decipher.setAAD(aad(record));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64url")),
        decipher.final(),
      ]);
      const secret = deserializeSecret(plaintext);
      if (secret.kind !== record.kind) {
        throw new CredentialVaultError(
          "DECRYPTION_FAILED",
          "Connector credential could not be decrypted",
        );
      }
      return secret.kind === "bearer"
        ? { kind: "bearer", organizationId: scope.organizationId, token: secret.token }
        : {
            kind: "apiKey",
            organizationId: scope.organizationId,
            headerName: secret.headerName,
            value: secret.value,
          };
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "DECRYPTION_FAILED",
        "Connector credential could not be decrypted",
      );
    }
  }

  async list(input: {
    organizationId: string;
    connectorId?: string;
  }): Promise<ConnectorCredentialMetadata[]> {
    const organizationId = input.organizationId.trim();
    const connectorId = input.connectorId?.trim();
    if (!organizationId || (input.connectorId !== undefined && !connectorId)) {
      throw new CredentialVaultError("INVALID_CREDENTIAL", "Credential scope is invalid");
    }
    const records = await this.storeCall(() => this.store.list({ organizationId, connectorId }));
    for (const record of records) {
      if (
        record.organizationId !== organizationId ||
        (connectorId !== undefined && record.connectorId !== connectorId)
      ) {
        throw new CredentialVaultError(
          "TENANT_SCOPE_MISMATCH",
          "Connector credential store returned a record outside the requested tenant scope",
        );
      }
    }
    return records.map(metadata);
  }

  async delete(input: {
    organizationId: string;
    connectorId: string;
    credentialId: string;
  }) {
    const scope = normalizeScope(input);
    const credentialId = input.credentialId.trim();
    if (!credentialId) throw new CredentialVaultError("NOT_FOUND", "Connector credential not found");
    const deleted = await this.storeCall(() => this.store.delete({ ...scope, credentialId }));
    if (!deleted) throw new CredentialVaultError("NOT_FOUND", "Connector credential not found");
    return { deleted: true as const };
  }
}
