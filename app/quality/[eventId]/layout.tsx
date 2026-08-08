import Link from "next/link";
import type { ReactNode } from "react";

export default async function QualityEventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const base = `/quality/${eventId}`;

  return (
    <>
      <nav className="card" aria-label="Quality event workspace" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Link className="table-link" href={base}>Overview</Link>
          <Link className="table-link" href={`${base}/root-cause`}>Root cause</Link>
          <Link className="table-link" href={`${base}/capa`}>CAPA</Link>
          <Link className="table-link" href={`${base}/eight-d`}>8D</Link>
          <Link className="table-link" href={`${base}/evidence`}>Evidence</Link>
        </div>
      </nav>
      {children}
    </>
  );
}
