import { db } from "@/lib/db";
import { readDocumentRevisionFile, type DocumentFileError } from "@/lib/documents/files";
import { resolveEffectiveRevision } from "@/lib/documents/workflow";

export class ControlledCopyError extends Error {
  constructor(
    public readonly code: "DOCUMENT_NOT_FOUND" | "EFFECTIVE_REVISION_NOT_FOUND" | "EFFECTIVE_FILE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "ControlledCopyError";
  }
}

export async function issueControlledCopy(input: {
  organizationId: string;
  documentId: string;
  actorId: string | null;
  asOf?: Date;
}) {
  const asOf = input.asOf ?? new Date();
  const document = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { id: true, code: true, title: true, type: true },
  });
  if (!document) {
    throw new ControlledCopyError("DOCUMENT_NOT_FOUND", "Document not found");
  }

  const revision = await resolveEffectiveRevision({
    organizationId: input.organizationId,
    documentId: input.documentId,
    asOf,
  });
  if (!revision) {
    throw new ControlledCopyError(
      "EFFECTIVE_REVISION_NOT_FOUND",
      "No controlled revision is effective for the requested date",
    );
  }

  let file;
  try {
    file = await readDocumentRevisionFile({
      organizationId: input.organizationId,
      documentId: input.documentId,
      revisionId: revision.id,
    });
  } catch (error) {
    const code = (error as DocumentFileError | undefined)?.code;
    if (code === "FILE_NOT_ATTACHED" || code === "FILE_INTEGRITY_FAILED" || code === "REVISION_NOT_FOUND") {
      throw new ControlledCopyError(
        "EFFECTIVE_FILE_UNAVAILABLE",
        "The effective controlled file is unavailable or failed integrity verification",
      );
    }
    throw error;
  }

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "DocumentRevision",
      entityId: revision.id,
      action: "CONTROLLED_COPY_ISSUED",
      afterJson: JSON.stringify({
        documentId: document.id,
        documentCode: document.code,
        revision: revision.revision,
        effectiveAt: revision.effectiveAt,
        asOf,
        checksum: file.checksum,
      }),
    },
  });

  return {
    document,
    revision: {
      id: revision.id,
      revision: revision.revision,
      status: revision.status,
      effectiveAt: revision.effectiveAt,
      expiresAt: revision.expiresAt,
    },
    file,
    issuedAt: new Date(),
    asOf,
  };
}
