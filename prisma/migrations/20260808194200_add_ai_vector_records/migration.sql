CREATE TABLE "AiVectorRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteScope" TEXT NOT NULL DEFAULT '',
    "namespace" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vector" DOUBLE PRECISION[],
    "metadataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiVectorRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiVectorRecord_organizationId_siteScope_namespace_recordId_key"
ON "AiVectorRecord"("organizationId", "siteScope", "namespace", "recordId");

CREATE INDEX "AiVectorRecord_organizationId_siteScope_namespace_dimensions_idx"
ON "AiVectorRecord"("organizationId", "siteScope", "namespace", "dimensions");

CREATE INDEX "AiVectorRecord_organizationId_updatedAt_idx"
ON "AiVectorRecord"("organizationId", "updatedAt");
