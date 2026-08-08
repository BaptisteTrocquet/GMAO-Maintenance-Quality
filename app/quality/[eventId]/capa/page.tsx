import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getQualityEvent } from "@/lib/quality/events";
import { getCapa, listCapaTimeline } from "@/lib/quality/capa";
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

  const [qualityEvent, scoped, timeline, memberships] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    getCapa({ organizationId, siteId, eventId }),
    listCapaTimeline({ organizationId, siteId, eventId }),
    db.organizationMembership.findMany({
      where: {
        organizationId,
        active: true,
        user: { active: true },
      },
      select: {
        userId: true,
        user: { select: { displayName: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);
  if (!qualityEvent || !scoped) notFound();

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
          <span className="badge">{scoped.capa?.status ?? "NOT STARTED"}</span>
        </div>
      </div>

      <CapaWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={qualityEvent.status}
        initialCapa={scoped.capa}
        owners={memberships.map((membership) => ({
          id: membership.userId,
          name: membership.user.displayName,
        }))}
      />

      <section className="card section">
        <h2>CAPA timeline</h2>
        {timeline?.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>{entry.actorName}</span>
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
