import { PrismaClient } from "@prisma/client";
import {
  createStaticCredentialEncryptionKeyProvider,
  EncryptedConnectorCredentialVault,
} from "@/lib/integrations/credential-vault";
import { PrismaConnectorCredentialRecordStore } from "@/lib/integrations/prisma-credential-store";

const prisma = new PrismaClient();
const CONNECTOR_ID = "db-smoke-connector";

function key(version: string, fill: number) {
  return { version, key: new Uint8Array(32).fill(fill) };
}

function keyProvider(currentVersion: "v1" | "v2") {
  return createStaticCredentialEncryptionKeyProvider({
    currentVersion,
    keys: [key("v1", 1), key("v2", 2)],
  });
}

async function main() {
  const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;

  if (rows[0]?.ok !== 1) {
    throw new Error("Database readiness check returned an unexpected result");
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: "demo-operations" },
    select: { id: true },
  });
  if (!organization) throw new Error("Synthetic demo organization is unavailable");

  await prisma.connectorCredentialRecord.deleteMany({
    where: { organizationId: organization.id, connectorId: CONNECTOR_ID },
  });

  const store = new PrismaConnectorCredentialRecordStore(prisma);
  const vault = new EncryptedConnectorCredentialVault(store, keyProvider("v1"));
  const firstSecret = "synthetic-db-smoke-secret-v1";
  const created = await vault.put({
    organizationId: organization.id,
    connectorId: CONNECTOR_ID,
    label: "Synthetic DB smoke credential",
    secret: { kind: "bearer", token: firstSecret },
  });

  const persisted = await prisma.connectorCredentialRecord.findUnique({
    where: { id: created.id },
  });
  if (!persisted || JSON.stringify(persisted).includes(firstSecret)) {
    throw new Error("Connector credential was not persisted safely");
  }

  const restartedVault = new EncryptedConnectorCredentialVault(
    new PrismaConnectorCredentialRecordStore(prisma),
    keyProvider("v1"),
  );
  const resolved = await restartedVault.resolve({
    organizationId: organization.id,
    connectorId: CONNECTOR_ID,
    credentialId: created.id,
  });
  if (resolved.kind !== "bearer" || resolved.token !== firstSecret) {
    throw new Error("Connector credential did not survive vault re-instantiation");
  }

  let crossScopeRejected = false;
  try {
    await restartedVault.resolve({
      organizationId: organization.id,
      connectorId: "other-connector",
      credentialId: created.id,
    });
  } catch {
    crossScopeRejected = true;
  }
  if (!crossScopeRejected) throw new Error("Connector credential crossed connector scope");

  const rotatedVault = new EncryptedConnectorCredentialVault(
    new PrismaConnectorCredentialRecordStore(prisma),
    keyProvider("v2"),
  );
  const secondSecret = "synthetic-db-smoke-secret-v2";
  const rotated = await rotatedVault.put({
    organizationId: organization.id,
    connectorId: CONNECTOR_ID,
    credentialId: created.id,
    label: "Synthetic DB smoke credential rotated",
    secret: { kind: "bearer", token: secondSecret },
  });
  if (rotated.keyVersion !== "v2") throw new Error("Credential key rotation did not persist");

  const auditRows = await prisma.auditLog.findMany({
    where: { entityType: "ConnectorCredential", entityId: created.id },
    orderBy: { createdAt: "asc" },
  });
  const auditJson = JSON.stringify(auditRows);
  if (
    auditJson.includes(firstSecret) ||
    auditJson.includes(secondSecret) ||
    (persisted.ciphertext && auditJson.includes(persisted.ciphertext))
  ) {
    throw new Error("Connector credential audit metadata contains secret material");
  }

  await rotatedVault.delete({
    organizationId: organization.id,
    connectorId: CONNECTOR_ID,
    credentialId: created.id,
  });
  if (await prisma.connectorCredentialRecord.findUnique({ where: { id: created.id } })) {
    throw new Error("Connector credential deletion did not persist");
  }

  console.log("Database integration check passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
