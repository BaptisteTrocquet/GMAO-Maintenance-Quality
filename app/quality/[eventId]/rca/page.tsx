import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getQualityEvent } from "@/lib/quality/events";
import { getQualityRca } from "@/lib/quality/root-cause";

const categories = [
  "PEOPLE",
  "MACHINE",
  "METHOD",
  "MATERIAL",
  "MEASUREMENT",
  "ENVIRONMENT",
] as const;

function rootCauseStatement(
  rca: NonNullable<Awaited<ReturnType<typeof getQualityRca>>>,
  source: "FIVE_WHY" | "ISHIKAWA",
  refId: string,
) {
  if (source === "FIVE_WHY") {
    return rca.fiveWhys.find((step) => step.id === refId)?.answer ?? refId;
  }
  return rca.ishikawaCauses.find((cause) => cause.id === refId)?.statement ?? refId;
}

export default async function QualityRcaPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return <section className="card">Select an organization and site to view root-cause analysis.</section>;
  }

  const qualityEvent = await getQualityEvent({ organizationId, siteId, eventId });
  if (!qualityEvent) notFound();
  const rca = await getQualityRca({ organizationId, siteId, eventId });

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href={`/quality/${eventId}`}>← {qualityEvent.eventNumber}</Link>
          <div className="title">Root-cause analysis</div>
          <div className="muted">{qualityEvent.title}</div>
        </div>
        <span className="badge">{rca?.status ?? "NOT STARTED"}</span>
      </div>

      {!rca ? (
        <section className="card">
          <h2>Analysis not started</h2>
          <p className="muted">
            Start the RCA after immediate containment using the quality RCA API. The workspace supports structured 5 Why and Ishikawa analysis.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Problem statement</h2>
            <p>{rca.problemStatement}</p>
            <div className="muted">
              Frozen event reference: {rca.eventNumber} · {rca.eventTitle}
            </div>
          </section>

          <div className="grid grid-2 section">
            <section className="card">
              <h2>5 Why</h2>
              {rca.fiveWhys.length ? (
                <ol className="timeline">
                  {rca.fiveWhys.map((step) => (
                    <li key={step.id}>
                      <strong>Why {step.sequence}?</strong>
                      <span>{step.answer}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No 5 Why steps recorded.</p>
              )}
            </section>

            <section className="card">
              <h2>Ishikawa</h2>
              <div className="grid">
                {categories.map((category) => {
                  const causes = rca.ishikawaCauses.filter((cause) => cause.category === category);
                  return (
                    <div key={category}>
                      <strong>{category}</strong>
                      {causes.length ? (
                        <ul>
                          {causes.map((cause) => <li key={cause.id}>{cause.statement}</li>)}
                        </ul>
                      ) : (
                        <div className="muted">No causes recorded.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="card section">
            <h2>Selected root causes</h2>
            {rca.rootCauses.length ? (
              <div className="stack-list">
                {rca.rootCauses.map((reference) => (
                  <div key={`${reference.source}:${reference.refId}`}>
                    <strong>{reference.source === "FIVE_WHY" ? "5 Why" : "Ishikawa"}</strong>
                    <span> · {rootCauseStatement(rca, reference.source, reference.refId)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No root cause selected yet. Finalization remains blocked.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
