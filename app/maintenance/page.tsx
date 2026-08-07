import Link from "next/link";
import { db } from "@/lib/db";
import { advanceCalendarDue, type CalendarFrequencyUnit } from "@/lib/maintenance/calendar";
import { calculateMaintenanceForecast } from "@/lib/maintenance/forecast";

function formatDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

function formatMeterValue(value: number | null, unit?: string | null) {
  return value === null ? "—" : `${value.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

export default async function MaintenancePage() {
  const [workOrders, plans] = await Promise.all([
    db.workOrder.findMany({
      include: { site: true, asset: true, assignee: true, team: true },
      orderBy: { requestedAt: "desc" },
    }),
    db.maintenancePlan.findMany({
      include: {
        asset: { include: { site: { include: { organization: { select: { timezone: true } } } } } },
        meter: {
          include: { readings: { orderBy: { readingAt: "desc" }, take: 1 } },
        },
        checklistItems: true,
      },
      orderBy: [{ nextDueAt: "asc" }, { nextDueMeterValue: "asc" }],
    }),
  ]);
  const now = new Date();
  const forecast = calculateMaintenanceForecast({
    now,
    horizonDays: 30,
    plans,
    workOrders: workOrders
      .filter(
        (workOrder) =>
          workOrder.type === "PREVENTIVE" &&
          workOrder.status !== "COMPLETED" &&
          workOrder.status !== "CANCELLED" &&
          workOrder.dueAt !== null,
      )
      .map((workOrder) => ({
        id: workOrder.id,
        number: workOrder.number,
        title: workOrder.title,
        dueAt: workOrder.dueAt,
        asset: workOrder.asset ? { code: workOrder.asset.code } : null,
      })),
  });

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Maintenance</div>
          <div className="muted">Corrective and preventive maintenance.</div>
        </div>
      </div>

      <div className="section card">
        <h2>Maintenance health</h2>
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>Score</th>
                <th>Status</th>
                <th>Overdue plans</th>
                <th>Overdue preventive WOs</th>
                <th>Due within 30 days / soon</th>
                <th>Paused plans</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>{forecast.health.score}/100</strong></td>
                <td><span className="badge">{forecast.health.status}</span></td>
                <td>{forecast.health.overduePlans}</td>
                <td>{forecast.health.overdueWorkOrders}</td>
                <td>{forecast.health.dueSoon}</td>
                <td>{forecast.health.pausedPlans}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="muted">
          Score starts at 100 and applies transparent penalties for overdue plans, overdue preventive work orders and near-term due work.
        </div>
      </div>

      <div className="section card">
        <h2>30-day preventive forecast</h2>
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>State</th>
                <th>Type</th>
                <th>Asset</th>
                <th>Item</th>
                <th>Due / threshold</th>
              </tr>
            </thead>
            <tbody>
              {forecast.entries.slice(0, 10).map((entry) => (
                <tr key={`${entry.kind}-${entry.id}`}>
                  <td><span className="badge">{entry.state}</span></td>
                  <td>{entry.kind}</td>
                  <td>{entry.assetCode ?? "—"}</td>
                  <td>{entry.title}</td>
                  <td>
                    {entry.kind === "METER_PLAN"
                      ? `${formatMeterValue(entry.currentMeterValue, entry.meterUnit)} / ${formatMeterValue(entry.dueMeterValue, entry.meterUnit)}`
                      : formatDate(entry.dueAt)}
                  </td>
                </tr>
              ))}
              {forecast.entries.length === 0 ? (
                <tr>
                  <td colSpan={5}>No preventive maintenance items in the current forecast.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
                <th>Team</th>
                <th>Planned</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {workOrders.map((workOrder) => (
                <tr key={workOrder.id}>
                  <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number}</Link></td>
                  <td>{workOrder.site.code}</td>
                  <td>{workOrder.asset?.code ?? "—"}</td>
                  <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.title}</Link></td>
                  <td>{workOrder.type}</td>
                  <td>{workOrder.priority}</td>
                  <td><span className="badge">{workOrder.status}</span></td>
                  <td>{workOrder.assignee?.displayName ?? "Unassigned"}</td>
                  <td>{workOrder.team?.name ?? "—"}</td>
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
              <tr>
                <th>Asset</th>
                <th>Plan</th>
                <th>Recurrence</th>
                <th>Current meter</th>
                <th>Next due</th>
                <th>Following due</th>
                <th>Status</th>
                <th>Checklist</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const isMeterPlan = plan.frequencyUnit === "METER";
                const followingDueAt =
                  plan.nextDueAt && !isMeterPlan
                    ? advanceCalendarDue({
                        currentDueAt: plan.nextDueAt,
                        frequencyValue: plan.frequencyValue,
                        frequencyUnit: plan.frequencyUnit as CalendarFrequencyUnit,
                        timeZone: plan.asset.site.organization.timezone,
                      })
                    : null;
                const latestMeterValue = plan.meter?.readings[0]?.value ?? null;
                const followingDueMeterValue =
                  isMeterPlan && plan.nextDueMeterValue !== null
                    ? plan.nextDueMeterValue + plan.frequencyValue
                    : null;
                const calendarOverdue = plan.active && plan.nextDueAt ? plan.nextDueAt < now : false;
                const meterDue =
                  plan.active && isMeterPlan && latestMeterValue !== null && plan.nextDueMeterValue !== null
                    ? latestMeterValue >= plan.nextDueMeterValue
                    : false;
                const recurrence = isMeterPlan
                  ? `${plan.frequencyValue.toLocaleString()} ${plan.meter?.unit ?? "units"} · ${plan.meter?.code ?? "meter"}`
                  : `${plan.frequencyValue} ${plan.frequencyUnit}`;
                return (
                  <tr key={plan.id}>
                    <td>{plan.asset.code}</td>
                    <td>{plan.name}</td>
                    <td>{recurrence}</td>
                    <td>{isMeterPlan ? formatMeterValue(latestMeterValue, plan.meter?.unit) : "—"}</td>
                    <td>
                      {isMeterPlan
                        ? formatMeterValue(plan.nextDueMeterValue, plan.meter?.unit)
                        : formatDate(plan.nextDueAt)}
                    </td>
                    <td>
                      {isMeterPlan
                        ? formatMeterValue(followingDueMeterValue, plan.meter?.unit)
                        : formatDate(followingDueAt)}
                    </td>
                    <td>
                      <span className="badge">
                        {plan.active ? (calendarOverdue || meterDue ? "DUE" : "ACTIVE") : "PAUSED"}
                      </span>
                    </td>
                    <td>{plan.checklistItems.length}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
