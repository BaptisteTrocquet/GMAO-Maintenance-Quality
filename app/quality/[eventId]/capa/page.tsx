import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCapaWorkspace, listCapaTimeline } from "@/lib/quality/capa";
import { getQualityEvent } from "@/lib/quality/events";
import CapaWorkspace from "./capa-workspace";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function CapaPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <section className="card">
        <p>Select an organization and site to open CAPA.</p>
      </section>
    );
  }

  const [qualityEvent, workspace, timeline, memberships] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    getCapaWorkspace({ organizationId, siteId, eventId }),
    listCapaTimeline({ organizationId, siteId, eventId }),
    db.organizationMembership.findMany({
      where: {
        organizationId,
        active: true,
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId } } },
        ],
      },
      select: { userId: true, user: { select: { displayName: true } } },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);
  if (!qualityEvent || !workspace) notFound();

  const members = memberships.map((membership) => ({
    id: membership.userId,
    name: membership.user.displayName,
  }));

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">CAPA · {qualityEvent.eventNumber}</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">{workspace.capa?.status ?? "NOT STARTED"}</span>
          <span className="badge">RCA {workspace.rootCauseConfirmed ? "CONFIRMED" : "PENDING"}</span>
        </div>
      </div>

      {members.length ? (
        <CapaWorkspace
          organizationId={organizationId}
          siteId={siteId}
          eventId={eventId}
          eventStatus={qualityEvent.status}
          rootCauseConfirmed={workspace.rootCauseConfirmed}
          members={members}
          initialCapa={workspace.capa}
        />
      ) : (
        <section className="card">
          <p>No active site member is available to own CAPA actions.</p>
        </section>
      )}

      <section className="card section">
        <h2>CAPA audit trail</h2>
        {timeline?.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>
                  {entry.actorName}
                  {entry.after ? ` · ${entry.after.actions.length} action(s) · ${entry.after.status}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No CAPA activity recorded yet.</p>
        )}
      </section>
    </>
  );
}
