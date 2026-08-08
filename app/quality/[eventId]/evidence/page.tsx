import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import { listQualityEvidence } from "@/lib/quality/evidence";
import EvidenceWorkspace from "./evidence-workspace";

export default async function QualityEvidencePage({
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
        <p>Select an organization and site to view quality evidence.</p>
      </section>
    );
  }

  const event = await getQualityEvent({ organizationId, siteId, eventId });
  if (!event) notFound();
  const evidence = await listQualityEvidence({ organizationId, siteId, eventId });

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">Evidence · {event.eventNumber}</div>
          <div className="muted">{event.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{event.status}</span>
          <span className="badge">{event.severity}</span>
        </div>
      </div>

      <EvidenceWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={event.status}
        initialEvidence={evidence}
      />
    </>
  );
}
