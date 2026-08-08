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
    return <section className="card">Select an organization and site to view quality evidence.</section>;
  }

  const [qualityEvent, evidence] = await Promise.all([
    getQualityEvent({ organizationId, siteId, eventId }),
    listQualityEvidence({ organizationId, siteId, eventId }),
  ]);
  if (!qualityEvent || evidence === null) notFound();

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← Quality event</Link>
          <div className="title">Evidence · {qualityEvent.eventNumber}</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <div className="asset-status">
          <span className="badge">{qualityEvent.status}</span>
          <span className="badge">{evidence.length} evidence</span>
        </div>
      </div>

      <EvidenceWorkspace
        organizationId={organizationId}
        siteId={siteId}
        eventId={eventId}
        eventStatus={qualityEvent.status}
        initialEvidence={evidence}
      />
    </>
  );
}
