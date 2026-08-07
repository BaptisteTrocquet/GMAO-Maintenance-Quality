import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";

function formatDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

function formatDateTime(value: Date | null | undefined) {
  return value ? `${value.toISOString().replace("T", " ").slice(0, 16)} UTC` : "—";
}

export default async function DocumentDetailPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  const document = await db.document.findUnique({
    where: { id: documentId },
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
        include: { approvals: { include: { approver: true } } },
      },
      assetDocuments: {
        include: { asset: { include: { site: true } } },
        orderBy: { asset: { code: "asc" } },
      },
    },
  });
  if (!document) notFound();

  const audit = await db.auditLog.findMany({
    where: {
      OR: [
        { entityType: "Document", entityId: document.id },
        {
          entityType: "DocumentRevision",
          entityId: { in: document.revisions.map((revision) => revision.id) },
        },
        {
          entityType: "AssetDocument",
          entityId: { endsWith: `:${document.id}` },
        },
      ],
    },
    include: { actor: { select: { id: true, displayName: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const latest = document.revisions[0];
  const revisionById = new Map(document.revisions.map((revision) => [revision.id, revision]));
  const readAcknowledgements = audit.filter(
    (entry) => entry.entityType === "DocumentRevision" && entry.action === "READ_ACKNOWLEDGED",
  );

  return (
    <>
      <div className="header">
        <div>
          <Link className="muted" href="/documents">← Documents</Link>
          <div className="title">{document.code} · {document.title}</div>
          <div className="muted">Controlled document master record</div>
        </div>
        <div>
          <span className="badge">{latest?.status ?? "NO REVISION"}</span>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Master metadata</h2>
          <dl className="detail-list">
            <div><dt>Code</dt><dd>{document.code}</dd></div>
            <div><dt>Title</dt><dd>{document.title}</dd></div>
            <div><dt>Type</dt><dd>{document.type}</dd></div>
            <div><dt>Owner</dt><dd>{document.owner ?? "—"}</dd></div>
            <div><dt>Created</dt><dd>{formatDateTime(document.createdAt)}</dd></div>
            <div><dt>Updated</dt><dd>{formatDateTime(document.updatedAt)}</dd></div>
          </dl>
          <h3>Description</h3>
          <p>{document.description ?? "No description."}</p>
        </section>

        <section className="card">
          <h2>Applicability</h2>
          {document.assetDocuments.length ? (
            <div className="stack-list">
              {document.assetDocuments.map((link) => (
                <div key={link.assetId}>
                  <Link className="table-link" href={`/assets/${link.assetId}`}>
                    <strong>{link.asset.code}</strong> · {link.asset.name}
                  </Link>
                  <span className="muted"> · {link.asset.site.code} · {link.relation}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">No linked assets.</div>
          )}
        </section>
      </div>

      <section className="card section">
        <h2>Revision history</h2>
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Status</th>
                <th>Change summary</th>
                <th>Created</th>
                <th>Effective</th>
                <th>Expires</th>
                <th>File</th>
                <th>Checksum</th>
                <th>Approvals</th>
              </tr>
            </thead>
            <tbody>
              {document.revisions.map((revision) => {
                const approved = revision.approvals.filter(
                  (approval) => approval.decision === "APPROVED",
                ).length;
                return (
                  <tr key={revision.id}>
                    <td><strong>{revision.revision}</strong></td>
                    <td><span className="badge">{revision.status}</span></td>
                    <td>{revision.changeSummary ?? "—"}</td>
                    <td>{formatDateTime(revision.createdAt)}</td>
                    <td>{formatDate(revision.effectiveAt)}</td>
                    <td>{formatDate(revision.expiresAt)}</td>
                    <td>{revision.fileName ?? "—"}</td>
                    <td>{revision.checksum ? <code>{revision.checksum.slice(0, 16)}…</code> : "—"}</td>
                    <td>{approved} / {revision.approvals.length}</td>
                  </tr>
                );
              })}
              {document.revisions.length === 0 ? (
                <tr><td colSpan={9}>No revisions yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card section">
        <h2>Approval details</h2>
        {document.revisions.some((revision) => revision.approvals.length > 0) ? (
          <div className="stack-list">
            {document.revisions.flatMap((revision) =>
              revision.approvals.map((approval) => (
                <div key={approval.id}>
                  <strong>Rev {revision.revision}</strong> · {approval.approver.displayName} · {approval.decision}
                  <span className="muted"> · {formatDateTime(approval.decidedAt)}</span>
                  {approval.comment ? <span> · {approval.comment}</span> : null}
                </div>
              )),
            )}
          </div>
        ) : (
          <div className="muted">No approval decisions recorded.</div>
        )}
      </section>

      <section className="card section">
        <h2>Read acknowledgements</h2>
        {readAcknowledgements.length ? (
          <div className="stack-list">
            {readAcknowledgements.map((entry) => (
              <div key={entry.id}>
                <strong>Rev {revisionById.get(entry.entityId)?.revision ?? entry.entityId}</strong>
                <span> · {entry.actor?.displayName ?? "Unknown user"}</span>
                <span className="muted"> · {formatDateTime(entry.createdAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">No read acknowledgements recorded yet.</div>
        )}
      </section>

      <section className="card section">
        <h2>Audit timeline</h2>
        {audit.length ? (
          <ol className="timeline">
            {audit.map((entry) => (
              <li key={entry.id}>
                <time>{formatDateTime(entry.createdAt)}</time>
                <strong>{entry.entityType} · {entry.action}</strong>
                <span>
                  {entry.entityId}
                  {entry.actor ? ` · ${entry.actor.displayName}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="muted">No document audit events recorded yet.</div>
        )}
      </section>
    </>
  );
}
