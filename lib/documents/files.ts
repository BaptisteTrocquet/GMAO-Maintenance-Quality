import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { storage, type StorageAdapter } from "@/lib/storage";

export const MAX_CONTROLLED_DOCUMENT_BYTES = 20 * 1024 * 1024;

export class DocumentFileError extends Error {
  constructor(
    public readonly code:
      | "REVISION_NOT_FOUND"
      | "REVISION_IMMUTABLE"
      | "FILE_REQUIRED"
      | "FILE_TOO_LARGE"
      | "FILE_NOT_ATTACHED"
      | "FILE_INTEGRITY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DocumentFileError";
  }
}

export function sha256Hex(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex");
}

function storageKeyFor(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  checksum: string;
}) {
  return `documents/${input.organizationId}/${input.documentId}/${input.revisionId}/${input.checksum}`;
}

export async function attachDocumentRevisionFile(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  actorId: string;
  fileName: string;
  mimeType?: string | null;
  data: Uint8Array;
  adapter?: StorageAdapter;
}) {
  if (input.data.byteLength === 0) {
    throw new DocumentFileError("FILE_REQUIRED", "Controlled document file cannot be empty");
  }
  if (input.data.byteLength > MAX_CONTROLLED_DOCUMENT_BYTES) {
    throw new DocumentFileError(
      "FILE_TOO_LARGE",
      `Controlled document file cannot exceed ${MAX_CONTROLLED_DOCUMENT_BYTES} bytes`,
    );
  }

  const revision = await db.documentRevision.findFirst({
    where: {
      id: input.revisionId,
      documentId: input.documentId,
      document: { organizationId: input.organizationId },
    },
  });
  if (!revision) {
    throw new DocumentFileError("REVISION_NOT_FOUND", "Document revision not found");
  }
  if (revision.status !== "DRAFT") {
    throw new DocumentFileError(
      "REVISION_IMMUTABLE",
      "Files can only be attached or replaced while the revision is DRAFT",
    );
  }

  const adapter = input.adapter ?? storage;
  const checksum = sha256Hex(input.data);
  const storageKey = storageKeyFor({
    organizationId: input.organizationId,
    documentId: input.documentId,
    revisionId: input.revisionId,
    checksum,
  });
  await adapter.put(storageKey, input.data);

  let updated;
  try {
    updated = await db.documentRevision.update({
      where: { id: revision.id },
      data: {
        storageKey,
        fileName: input.fileName,
        mimeType: input.mimeType ?? null,
        checksum,
      },
    });

    await db.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: "DocumentRevision",
        entityId: revision.id,
        action: revision.storageKey ? "FILE_REPLACED" : "FILE_ATTACHED",
        beforeJson: JSON.stringify({
          storageKey: revision.storageKey,
          fileName: revision.fileName,
          mimeType: revision.mimeType,
          checksum: revision.checksum,
        }),
        afterJson: JSON.stringify({ storageKey, fileName: input.fileName, mimeType: input.mimeType ?? null, checksum }),
      },
    });
  } catch (error) {
    await adapter.delete(storageKey).catch(() => undefined);
    throw error;
  }

  if (revision.storageKey && revision.storageKey !== storageKey) {
    await adapter.delete(revision.storageKey).catch(() => undefined);
  }

  return updated;
}

export async function readDocumentRevisionFile(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  adapter?: StorageAdapter;
}) {
  const revision = await db.documentRevision.findFirst({
    where: {
      id: input.revisionId,
      documentId: input.documentId,
      document: { organizationId: input.organizationId },
    },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      storageKey: true,
      checksum: true,
    },
  });
  if (!revision) {
    throw new DocumentFileError("REVISION_NOT_FOUND", "Document revision not found");
  }
  if (!revision.storageKey || !revision.checksum || !revision.fileName) {
    throw new DocumentFileError("FILE_NOT_ATTACHED", "Document revision has no controlled file attached");
  }

  const adapter = input.adapter ?? storage;
  const data = await adapter.get(revision.storageKey);
  const actualChecksum = sha256Hex(data);
  if (actualChecksum !== revision.checksum) {
    throw new DocumentFileError(
      "FILE_INTEGRITY_FAILED",
      "Stored controlled document does not match its recorded SHA-256 checksum",
    );
  }

  return {
    data,
    fileName: revision.fileName,
    mimeType: revision.mimeType ?? "application/octet-stream",
    checksum: revision.checksum,
    storageKey: revision.storageKey,
  };
}
