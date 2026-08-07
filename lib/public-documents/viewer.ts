import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { db } from "@/lib/db";
import { issueControlledCopy } from "@/lib/documents/controlled-copy";

const DOCUMENT_VIEWS_PER_HOUR = 60;
const DOCUMENT_LOOKUP_ACTION = "PUBLIC_DOCUMENT_LOOKUP";

export class PublicDocumentViewerError extends Error {
  constructor(
    public readonly code: "DOCUMENT_NOT_AVAILABLE" | "RATE_LIMITED",
    message: string,
  ) {
    super(message);
    this.name = "PublicDocumentViewerError";
  }
}

export async function issuePublicControlledDocument(input: {
  token: Pick<PublicMaintenanceRequestToken, "id" | "organizationId" | "siteId">;
  documentCode: string;
  origin?: string | null;
  asOf?: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const asOf = input.asOf ?? now;
  const recentCount = await db.auditLog.count({
    where: {
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: DOCUMENT_LOOKUP_ACTION,
      createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
    },
  });
  if (recentCount >= DOCUMENT_VIEWS_PER_HOUR) {
    throw new PublicDocumentViewerError(
      "RATE_LIMITED",
      "This scoped token has reached its hourly controlled-document lookup limit",
    );
  }

  const document = await db.document.findFirst({
    where: {
      organizationId: input.token.organizationId,
      code: input.documentCode,
      assetDocuments: {
        some: {
          asset: {
            siteId: input.token.siteId,
            archivedAt: null,
          },
        },
      },
    },
    select: { id: true, code: true },
  });

  await db.auditLog.create({
    data: {
      actorId: null,
      entityType: "PublicMaintenanceRequestToken",
      entityId: input.token.id,
      action: DOCUMENT_LOOKUP_ACTION,
      afterJson: JSON.stringify({
        documentCode: input.documentCode,
        found: Boolean(document),
        origin: input.origin ?? null,
        asOf,
      }),
      createdAt: now,
    },
  });

  if (!document) {
    throw new PublicDocumentViewerError(
      "DOCUMENT_NOT_AVAILABLE",
      "Controlled document is not applicable in the site bound to this scoped token",
    );
  }

  return issueControlledCopy({
    organizationId: input.token.organizationId,
    documentId: document.id,
    actorId: null,
    asOf,
  });
}
