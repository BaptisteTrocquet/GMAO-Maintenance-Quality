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

  return (
    <>
      <nav className="card" aria-label="Quality event workspace" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Link className="table-link" href={`/quality/${eventId}`}>Event</Link>
          <Link className="table-link" href={`/quality/${eventId}/root-cause`}>Root cause</Link>
          <Link className="table-link" href={`/quality/${eventId}/capa`}>CAPA</Link>
          <Link className="table-link" href={`/quality/${eventId}/eight-d`}>8D</Link>
          <Link className="table-link" href={`/quality/${eventId}/evidence`}>Evidence</Link>
        </div>
      </nav>
      {children}
    </>
  );
}
