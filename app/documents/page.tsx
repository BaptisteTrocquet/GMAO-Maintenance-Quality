import Link from "next/link";
import { db } from "@/lib/db";

export default async function DocumentsPage() {
  const documents = await db.document.findMany({
    include: {
      revisions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { approvals: true },
      },
      assetDocuments: { include: { asset: true } },
    },
    orderBy: { code: "asc" },
  });

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Documents</div>
          <div className="muted">
            Controlled document masters, revisions, ownership, approvals and asset applicability.
          </div>
        </div>
      </div>
      <div className="card">
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Title</th>
                <th>Type</th>
                <th>Owner</th>
                <th>Latest revision</th>
                <th>Status</th>
                <th>Linked assets</th>
                <th>Approvals</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const revision = document.revisions[0];
                return (
                  <tr key={document.id}>
                    <td>
                      <Link className="table-link" href={`/documents/${document.id}`}>
                        {document.code}
                      </Link>
                    </td>
                    <td>
                      <Link className="table-link" href={`/documents/${document.id}`}>
                        {document.title}
                      </Link>
                    </td>
                    <td>{document.type}</td>
                    <td>{document.owner ?? "—"}</td>
                    <td>{revision?.revision ?? "—"}</td>
                    <td><span className="badge">{revision?.status ?? "NO REVISION"}</span></td>
                    <td>{document.assetDocuments.map((link) => link.asset.code).join(", ") || "—"}</td>
                    <td>
                      {revision?.approvals.filter((approval) => approval.decision === "APPROVED").length ?? 0}
                      {revision ? ` / ${revision.approvals.length}` : ""}
                    </td>
                  </tr>
                );
              })}
              {documents.length === 0 ? (
                <tr>
                  <td colSpan={8}>No controlled documents.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
