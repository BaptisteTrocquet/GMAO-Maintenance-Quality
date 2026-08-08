CREATE TABLE "ConnectorCredentialRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorCredentialRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConnectorCredentialRecord_organizationId_connectorId_createdAt_idx"
ON "ConnectorCredentialRecord"("organizationId", "connectorId", "createdAt");

CREATE INDEX "ConnectorCredentialRecord_organizationId_updatedAt_idx"
ON "ConnectorCredentialRecord"("organizationId", "updatedAt");
