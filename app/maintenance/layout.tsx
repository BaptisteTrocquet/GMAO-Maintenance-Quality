import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import SavedPlanningViews from "./saved-planning-views";

export default async function MaintenanceLayout({ children }: { children: ReactNode }) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";

  return (
    <>
      <nav className="card" aria-label="Maintenance workspace" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link className="table-link" href="/maintenance">Overview</Link>
          <Link className="table-link" href="/maintenance/kanban">Work-order Kanban</Link>
          <Link className="table-link" href="/maintenance/calendar">Calendar planning</Link>
          <Link className="table-link" href="/maintenance/workload">Team workload</Link>
        </div>
      </nav>
      <SavedPlanningViews organizationId={organizationId} />
      {children}
    </>
  );
}
