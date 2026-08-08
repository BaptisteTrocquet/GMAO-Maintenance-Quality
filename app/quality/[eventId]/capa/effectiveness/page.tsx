import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getQualityEvent } from "@/lib/quality/events";
import { getCapa } from "@/lib/quality/capa";
import {
  getCapaEffectiveness,
  listCapaEffectivenessTimeline,
} from "@/lib/quality/effectiveness";
import EffectivenessWorkspace from "./effectiveness-workspace";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  const iso = value instanceof Date ? value.toISOString() : value;
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default async function EffectivenessPage({
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
        <p>Select an organization and site to verify CAPA effectiveness.</p>
      </section>
    );
  }

  const [qualityEvent, scopedCapa, effectiveness, memberships] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    getCapa({ organizationId, siteId, eventId }),
    getCapaEffectiveness({ organizationId, siteId, eventId }),
    db.organizationMembership.findMany({
      where: {
        organizationId,
        active: true,
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId } } }],
      },
      select: {
        userId: true,
        user: { select: { displayName: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    }),
  ]);
  if (!qualityEvent || !scopedCapa) notFound();
  const timeline = effectiveness
    ? await listCapaEffectivenessTimeline({ organizationId, siteId, eventId })
    : [];

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}/capa`}>← CAPA</Link>
          <div className="title">Effectiveness verification · {qualityEvent.eventNumber}</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{scopedCapa.capa?.status ?? "NO CAPA"}</span>
          <span className="badge">{effectiveness?.status ?? "NOT STARTED"}</span>
          {effectiveness?.result ? <span className="badge">{effectiveness.result}</span> : null}
        </div>
      </div>

      <EffectivenessWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        capaStatus={scopedCapa.capa?.status ?? null}
        initialEffectiveness={effectiveness}
        members={memberships.map((membership) => ({
          id: membership.userId,
          displayName: membership.user.displayName,
        }))}
      />

      <section className="card section">
        <h2>Effectiveness timeline</h2>
        {timeline?.length ? (
          <ol className="timeline">
            {timeline.map((entry) => (
              <li key={entry.id}>
                <time>{formatDate(entry.createdAt)}</time>
                <strong>{entry.action}</strong>
                <span>
                  {entry.actorName}
                  {entry.after.summary ? ` · ${entry.after.summary}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No effectiveness verification activity recorded yet.</p>
        )}
      </section>
    </>
  );
}
