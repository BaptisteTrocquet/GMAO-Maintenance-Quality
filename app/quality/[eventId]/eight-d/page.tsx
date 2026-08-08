import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getEightDWorkspace, listEightDTimeline } from "@/lib/quality/eight-d";
import { getQualityEvent } from "@/lib/quality/events";
import EightDWorkspace from "./eight-d-workspace";

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function EightDPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to open 8D.</p></section>;
  }

  const [qualityEvent, workspace, timeline, memberships] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    getEightDWorkspace({ organizationId, siteId, eventId }),
    listEightDTimeline({ organizationId, siteId, eventId }),
    db.organizationMembership.findMany({
      where: {
        organizationId,
        active: true,
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId } } }],
      },
      select: {
        role: true,
        user: { select: { id: true, displayName: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);
  if (!qualityEvent || !workspace) notFound();

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">8D · {qualityEvent.eventNumber}</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">8D {workspace.eightD?.status ?? "NOT STARTED"}</span>
          <span className="badge">{workspace.eightD?.currentDiscipline ?? "D1"}</span>
          <span className="badge">CAPA {workspace.capa?.status ?? "NOT STARTED"}</span>
        </div>
      </div>

      <EightDWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        initialEightD={workspace.eightD}
        capa={workspace.capa}
        members={memberships.map((membership) => ({
          id: membership.user.id,
          name: membership.user.displayName,
          role: membership.role,
        }))}
      />

      <section className="card section">
        <h2>8D audit trail</h2>
        {timeline?.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>{entry.actorName}{entry.after ? ` · ${entry.after.currentDiscipline} · ${entry.after.status}` : ""}</span>
              </li>
            ))}
          </ol>
        ) : <p className="muted">No 8D revisions recorded yet.</p>}
      </section>
    </>
  );
}
