import Link from "next/link";
import type { ReactNode } from "react";

export default function MaintenanceLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="card maintenance-workspace-nav" aria-label="Maintenance workspace">
        <Link className="table-link" href="/maintenance">Overview</Link>
        <Link className="table-link" href="/maintenance/board">Work-order board</Link>
      </nav>
      {children}
    </>
  );
}
