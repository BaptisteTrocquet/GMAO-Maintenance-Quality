import { db } from "@/lib/db";

export default async function DocumentsPage() {
  const documents = await db.document.findMany({ include: { revisions: { orderBy: { createdAt: "desc" }, take: 1, include: { approvals: true } }, assetDocuments: { include: { asset: true } } }, orderBy: { code: "asc" } });
  return <><div className="header"><div><div className="title">Documents</div><div className="muted">Controlled documents, revisions, approvals and applicability.</div></div></div><div className="card"><table className="table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Revision</th><th>Status</th><th>Linked assets</th><th>Approvals</th></tr></thead><tbody>{documents.map(d => { const r=d.revisions[0]; return <tr key={d.id}><td>{d.code}</td><td>{d.title}</td><td>{d.type}</td><td>{r?.revision ?? "—"}</td><td>{r?.status ?? "—"}</td><td>{d.assetDocuments.map(x=>x.asset.code).join(", ") || "—"}</td><td>{r?.approvals.filter(a=>a.decision==="APPROVED").length ?? 0}</td></tr>; })}</tbody></table></div></>;
}
