import Link from "next/link";
import type { ReactNode } from "react";

export default function MaintenanceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="card" aria-label="Maintenance workspace" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link className="table-link" href="/maintenance">Overview</Link>
          <Link className="table-link" href="/maintenance/kanban">Work-order Kanban</Link>
        </div>
      </nav>
      {children}
    </>
  );
}
