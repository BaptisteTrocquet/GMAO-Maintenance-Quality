CREATE TABLE "IntegrationDeadLetter" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteId" TEXT,
    "channel" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "errorCode" TEXT,
    "payloadJson" TEXT NOT NULL,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplayedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationDeadLetter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IntegrationDeadLetter_organizationId_channel_sourceId_key"
ON "IntegrationDeadLetter"("organizationId", "channel", "sourceId");

CREATE INDEX "IntegrationDeadLetter_organizationId_siteId_resolvedAt_createdAt_idx"
ON "IntegrationDeadLetter"("organizationId", "siteId", "resolvedAt", "createdAt");
