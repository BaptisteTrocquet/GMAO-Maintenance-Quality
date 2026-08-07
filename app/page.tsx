import { db } from "@/lib/db";

export default async function Dashboard() {
  const [assets, openWorkOrders, docs, plans] = await Promise.all([
    db.asset.count(),
    db.workOrder.count({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    db.document.count(),
    db.maintenancePlan.count({ where: { active: true } })
  ]);

  const workOrders = await db.workOrder.findMany({ where: { status: { notIn: ["COMPLETED", "CANCELLED"] } }, include: { asset: true, assignee: true }, orderBy: { requestedAt: "desc" }, take: 8 });

  return <>
    <div className="header"><div><div className="title">Operations dashboard</div><div className="muted">Maintenance and controlled documents in one place.</div></div></div>
    <div className="grid grid-4">
      <div className="card"><div className="muted">Assets</div><div className="metric">{assets}</div></div>
      <div className="card"><div className="muted">Open work orders</div><div className="metric">{openWorkOrders}</div></div>
      <div className="card"><div className="muted">Controlled documents</div><div className="metric">{docs}</div></div>
      <div className="card"><div className="muted">Active PM plans</div><div className="metric">{plans}</div></div>
    </div>
    <div className="section card"><h2>Current work</h2><table className="table"><thead><tr><th>WO</th><th>Asset</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th></tr></thead><tbody>{workOrders.map(wo => <tr key={wo.id}><td>{wo.number}</td><td>{wo.asset?.code ?? "—"}</td><td>{wo.title}</td><td><span className="badge">{wo.status}</span></td><td>{wo.priority}</td><td>{wo.assignee?.displayName ?? "Unassigned"}</td></tr>)}</tbody></table></div>
  </>;
}
