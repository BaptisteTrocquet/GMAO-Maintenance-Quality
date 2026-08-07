import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveEffectiveRevision } from "@/lib/documents/workflow";

const READ_ACKNOWLEDGED = "READ_ACKNOWLEDGED";

export class DocumentAcknowledgementError extends Error {
  constructor(
    public readonly code:
      | "DOCUMENT_NOT_FOUND"
      | "EFFECTIVE_REVISION_NOT_FOUND"
      | "REVISION_CHECKSUM_MISSING"
      | "CHECKSUM_MISMATCH"
      | "ACKNOWLEDGEMENT_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "DocumentAcknowledgementError";
  }
}

type AcknowledgementSnapshot = {
  documentId: string;
  documentCode: string;
  revisionId: string;
  revision: string;
  checksum: string;
  effectiveAt: string | null;
  asOf: string;
  acknowledgedAt: string;
};

function parseSnapshot(value: string | null): AcknowledgementSnapshot | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as AcknowledgementSnapshot;
  } catch {
    return null;
  }
}

async function resolveAcknowledgedRevision(input: {
  organizationId: string;
  documentId: string;
  asOf: Date;
}) {
  const document = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { id: true, code: true, title: true },
  });
  if (!document) {
    throw new DocumentAcknowledgementError("DOCUMENT_NOT_FOUND", "Document not found");
  }

  const revision = await resolveEffectiveRevision({
    organizationId: input.organizationId,
    documentId: input.documentId,
    asOf: input.asOf,
  });
  if (!revision) {
    throw new DocumentAcknowledgementError(
      "EFFECTIVE_REVISION_NOT_FOUND",
      "No controlled revision is effective for the requested date",
    );
  }
  if (!revision.checksum) {
    throw new DocumentAcknowledgementError(
      "REVISION_CHECKSUM_MISSING",
      "The effective revision does not have a recorded controlled-file checksum",
    );
  }

  return { document, revision };
}

function isSerializableRetry(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function acknowledgeEffectiveRevision(input: {
  organizationId: string;
  documentId: string;
  actorId: string;
  checksum: string;
  asOf?: Date;
  now?: Date;
}) {
  const asOf = input.asOf ?? new Date();
  const { document, revision } = await resolveAcknowledgedRevision({
    organizationId: input.organizationId,
    documentId: input.documentId,
    asOf,
  });
  if (input.checksum.toLowerCase() !== revision.checksum.toLowerCase()) {
    throw new DocumentAcknowledgementError(
      "CHECKSUM_MISMATCH",
      "Acknowledgement checksum does not match the effective controlled revision",
    );
  }

  const acknowledgedAt = input.now ?? new Date();
  const snapshot: AcknowledgementSnapshot = {
    documentId: document.id,
    documentCode: document.code,
    revisionId: revision.id,
    revision: revision.revision,
    checksum: revision.checksum,
    effectiveAt: revision.effectiveAt?.toISOString() ?? null,
    asOf: asOf.toISOString(),
    acknowledgedAt: acknowledgedAt.toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const existing = await tx.auditLog.findFirst({
            where: {
              actorId: input.actorId,
              entityType: "DocumentRevision",
              entityId: revision.id,
              action: READ_ACKNOWLEDGED,
            },
            orderBy: { createdAt: "asc" },
          });
          if (existing) {
            return {
              created: false,
              auditId: existing.id,
              snapshot: parseSnapshot(existing.afterJson),
            };
          }

          const created = await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "DocumentRevision",
              entityId: revision.id,
              action: READ_ACKNOWLEDGED,
              afterJson: JSON.stringify(snapshot),
              createdAt: acknowledgedAt,
            },
          });
          return { created: true, auditId: created.id, snapshot };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (isSerializableRetry(error) && attempt < 2) continue;
      if (isSerializableRetry(error)) {
        throw new DocumentAcknowledgementError(
          "ACKNOWLEDGEMENT_CONFLICT",
          "Could not record the acknowledgement after concurrent updates",
        );
      }
      throw error;
    }
  }

  throw new DocumentAcknowledgementError(
    "ACKNOWLEDGEMENT_CONFLICT",
    "Could not record the acknowledgement",
  );
}

export async function getEffectiveRevisionAcknowledgement(input: {
  organizationId: string;
  documentId: string;
  actorId: string;
  asOf?: Date;
}) {
  const asOf = input.asOf ?? new Date();
  const { document, revision } = await resolveAcknowledgedRevision({
    organizationId: input.organizationId,
    documentId: input.documentId,
    asOf,
  });
  const audit = await db.auditLog.findFirst({
    where: {
      actorId: input.actorId,
      entityType: "DocumentRevision",
      entityId: revision.id,
      action: READ_ACKNOWLEDGED,
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    document,
    revision: {
      id: revision.id,
      revision: revision.revision,
      checksum: revision.checksum,
      effectiveAt: revision.effectiveAt,
    },
    acknowledged: Boolean(audit),
    acknowledgement: audit
      ? { auditId: audit.id, createdAt: audit.createdAt, snapshot: parseSnapshot(audit.afterJson) }
      : null,
  };
}

export async function listDocumentReadAcknowledgements(input: {
  organizationId: string;
  documentId: string;
}) {
  const document = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { id: true, code: true, title: true },
  });
  if (!document) {
    throw new DocumentAcknowledgementError("DOCUMENT_NOT_FOUND", "Document not found");
  }

  const revisions = await db.documentRevision.findMany({
    where: { documentId: document.id },
    select: { id: true, revision: true, status: true, effectiveAt: true, checksum: true },
  });
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const audits = revisions.length
    ? await db.auditLog.findMany({
        where: {
          entityType: "DocumentRevision",
          entityId: { in: revisions.map((revision) => revision.id) },
          action: READ_ACKNOWLEDGED,
        },
        include: { actor: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return {
    document,
    acknowledgements: audits.map((audit) => ({
      auditId: audit.id,
      acknowledgedAt: audit.createdAt,
      actor: audit.actor,
      revision: revisionById.get(audit.entityId) ?? null,
      snapshot: parseSnapshot(audit.afterJson),
    })),
  };
}
