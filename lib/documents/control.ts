import { db } from "@/lib/db";

export class DocumentControlError extends Error {
  constructor(
    public readonly code: "DOCUMENT_NOT_FOUND" | "REVISION_NOT_FOUND" | "REVISION_IMMUTABLE",
    message: string,
  ) {
    super(message);
    this.name = "DocumentControlError";
  }
}

export async function updateDocumentMaster(input: {
  organizationId: string;
  documentId: string;
  actorId: string;
  title?: string;
  type?: string;
  owner?: string | null;
  description?: string | null;
}) {
  const existing = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
  });
  if (!existing) throw new DocumentControlError("DOCUMENT_NOT_FOUND", "Document not found");

  const updated = await db.document.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "Document",
      entityId: existing.id,
      action: "UPDATED",
      beforeJson: JSON.stringify(existing),
      afterJson: JSON.stringify(updated),
    },
  });
  return updated;
}

export async function createDocumentRevision(input: {
  organizationId: string;
  documentId: string;
  revision: string;
  changeSummary?: string | null;
  actorId: string;
}) {
  const document = await db.document.findFirst({
    where: { id: input.documentId, organizationId: input.organizationId },
    select: { id: true, code: true, title: true },
  });
  if (!document) throw new DocumentControlError("DOCUMENT_NOT_FOUND", "Document not found");

  const created = await db.documentRevision.create({
    data: {
      documentId: document.id,
      revision: input.revision,
      status: "DRAFT",
      changeSummary: input.changeSummary ?? null,
      createdBy: input.actorId,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "DocumentRevision",
      entityId: created.id,
      action: "CREATED",
      afterJson: JSON.stringify({
        ...created,
        documentCode: document.code,
        documentTitle: document.title,
      }),
    },
  });
  return created;
}

export async function updateDraftDocumentRevision(input: {
  organizationId: string;
  documentId: string;
  revisionId: string;
  actorId: string;
  changeSummary?: string | null;
}) {
  const existing = await db.documentRevision.findFirst({
    where: {
      id: input.revisionId,
      documentId: input.documentId,
      document: { organizationId: input.organizationId },
    },
  });
  if (!existing) throw new DocumentControlError("REVISION_NOT_FOUND", "Document revision not found");
  if (existing.status !== "DRAFT") {
    throw new DocumentControlError(
      "REVISION_IMMUTABLE",
      "Revision metadata can only be edited while the revision is DRAFT",
    );
  }

  const updated = await db.documentRevision.update({
    where: { id: existing.id },
    data: { changeSummary: input.changeSummary ?? null },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "DocumentRevision",
      entityId: existing.id,
      action: "UPDATED",
      beforeJson: JSON.stringify(existing),
      afterJson: JSON.stringify(updated),
    },
  });
  return updated;
}
