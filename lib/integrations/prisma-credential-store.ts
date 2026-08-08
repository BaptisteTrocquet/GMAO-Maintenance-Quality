import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createCredentialEncryptionKeyProviderFromEnv,
  EncryptedConnectorCredentialVault,
  type ConnectorCredentialRecordStore,
  type EncryptedConnectorCredentialRecord,
} from "@/lib/integrations/credential-vault";

type StoredCredentialRow = {
  id: string;
  organizationId: string;
  connectorId: string;
  label: string;
  kind: string;
  keyVersion: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: Date;
  updatedAt: Date;
};

function toEncryptedRecord(row: StoredCredentialRow): EncryptedConnectorCredentialRecord {
  if (row.kind !== "bearer" && row.kind !== "apiKey") {
    throw new Error("Connector credential record has an unsupported kind");
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    connectorId: row.connectorId,
    label: row.label,
    kind: row.kind,
    keyVersion: row.keyVersion,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function auditMetadata(row: StoredCredentialRow) {
  return {
    organizationId: row.organizationId,
    connectorId: row.connectorId,
    credentialId: row.id,
    label: row.label,
    kind: row.kind,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaConnectorCredentialRecordStore implements ConnectorCredentialRecordStore {
  constructor(private readonly client: PrismaClient = db) {}

  async put(record: EncryptedConnectorCredentialRecord) {
    const saved = await this.client.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: record.organizationId },
        select: { id: true },
      });
      if (!organization) {
        throw new Error("Connector credential organization does not exist");
      }

      const existing = await tx.connectorCredentialRecord.findUnique({
        where: { id: record.id },
      });
      if (
        existing &&
        (existing.organizationId !== record.organizationId ||
          existing.connectorId !== record.connectorId)
      ) {
        throw new Error("Connector credential id already belongs to another tenant scope");
      }

      const persisted = await tx.connectorCredentialRecord.upsert({
        where: { id: record.id },
        create: {
          id: record.id,
          organizationId: record.organizationId,
          connectorId: record.connectorId,
          label: record.label,
          kind: record.kind,
          keyVersion: record.keyVersion,
          ciphertext: record.ciphertext,
          iv: record.iv,
          authTag: record.authTag,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
        update: {
          label: record.label,
          kind: record.kind,
          keyVersion: record.keyVersion,
          ciphertext: record.ciphertext,
          iv: record.iv,
          authTag: record.authTag,
          updatedAt: record.updatedAt,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          entityType: "ConnectorCredential",
          entityId: persisted.id,
          action: existing ? "UPDATED" : "CREATED",
          beforeJson: existing ? JSON.stringify(auditMetadata(existing)) : null,
          afterJson: JSON.stringify(auditMetadata(persisted)),
        },
      });

      return persisted;
    });

    return toEncryptedRecord(saved);
  }

  async find(input: { organizationId: string; connectorId: string; credentialId: string }) {
    const row = await this.client.connectorCredentialRecord.findFirst({
      where: {
        id: input.credentialId,
        organizationId: input.organizationId,
        connectorId: input.connectorId,
      },
    });
    return row ? toEncryptedRecord(row) : null;
  }

  async list(input: { organizationId: string; connectorId?: string }) {
    const rows = await this.client.connectorCredentialRecord.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.connectorId === undefined ? {} : { connectorId: input.connectorId }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toEncryptedRecord);
  }

  async delete(input: { organizationId: string; connectorId: string; credentialId: string }) {
    return this.client.$transaction(async (tx) => {
      const existing = await tx.connectorCredentialRecord.findFirst({
        where: {
          id: input.credentialId,
          organizationId: input.organizationId,
          connectorId: input.connectorId,
        },
      });
      if (!existing) return false;

      await tx.connectorCredentialRecord.delete({ where: { id: existing.id } });
      await tx.auditLog.create({
        data: {
          actorId: null,
          entityType: "ConnectorCredential",
          entityId: existing.id,
          action: "DELETED",
          beforeJson: JSON.stringify(auditMetadata(existing)),
          afterJson: null,
        },
      });
      return true;
    });
  }
}

export function createPrismaConnectorCredentialVault(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return new EncryptedConnectorCredentialVault(
    new PrismaConnectorCredentialRecordStore(),
    createCredentialEncryptionKeyProviderFromEnv(env),
  );
}
