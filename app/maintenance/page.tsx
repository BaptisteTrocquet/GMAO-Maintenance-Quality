import { db } from "@/lib/db";

function formatDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

export default async function MaintenancePage() {
  const [workOrders, plans] = await Promise.all([
    db.workOrder.findMany({
      include: { site: true, asset: true, assignee: true },
      orderBy: { requestedAt: "desc" },
    }),
    db.maintenancePlan.findMany({
      include: { asset: true, checklistItems: true },
      orderBy: { nextDueAt: "asc" },
    }),
  ]);

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Maintenance</div>
          <div className="muted">Corrective and preventive maintenance.</div>
        </div>
      </div>
      <div className="section card">
        <h2>Work orders</h2>
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>WO</th>
                <th>Site</th>
                <th>Asset</th>
                <th>Title</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Planned</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {workOrders.map((workOrder) => (
                <tr key={workOrder.id}>
                  <td>{workOrder.number}</td>
                  <td>{workOrder.site.code}</td>
                  <td>{workOrder.asset?.code ?? "—"}</td>
                  <td>{workOrder.title}</td>
                  <td>{workOrder.type}</td>
                  <td>{workOrder.priority}</td>
                  <td><span className="badge">{workOrder.status}</span></td>
                  <td>{workOrder.assignee?.displayName ?? "Unassigned"}</td>
                  <td>{formatDate(workOrder.plannedStart)}</td>
                  <td>{formatDate(workOrder.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="section card">
        <h2>Preventive plans</h2>
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr><th>Asset</th><th>Plan</th><th>Frequency</th><th>Checklist</th></tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td>{plan.asset.code}</td>
                  <td>{plan.name}</td>
                  <td>{plan.frequencyValue} {plan.frequencyUnit}</td>
                  <td>{plan.checklistItems.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
