import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getEightDWorkspace, listEightDTimeline } from "@/lib/quality/eight-d";
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
    return <section className="card">Select an organization and site to view the 8D workspace.</section>;
  }

  const workspace = await getEightDWorkspace({ organizationId, siteId, eventId });
  if (!workspace) notFound();

  const [timeline, memberships] = await Promise.all([
    listEightDTimeline({ organizationId, siteId, eventId }),
    db.organizationMembership.findMany({
      where: {
        organizationId,
        active: true,
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId } } }],
      },
      select: { user: { select: { id: true, displayName: true } } },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);
  const members = memberships.map((membership) => membership.user);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← {workspace.event.eventNumber}</Link>
          <div className="title">8D workspace</div>
          <div className="muted">{workspace.event.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{workspace.event.status}</span>
          <span className="badge">{workspace.eightD?.status ?? "NOT STARTED"}</span>
          <span className="badge">{workspace.eightD?.currentDiscipline ?? "D1"}</span>
        </div>
      </div>

      <EightDWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={workspace.event.status}
        initialEightD={workspace.eightD}
        members={members}
      />

      {timeline?.length ? (
        <section className="card section">
          <h2>8D audit trail</h2>
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>{entry.actorName}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
