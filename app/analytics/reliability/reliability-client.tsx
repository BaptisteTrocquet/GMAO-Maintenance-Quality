"use client";

import { useCallback, useEffect, useState } from "react";

type ReliabilityData = {
  generatedAt: string;
  mttr: { hours: number | null; sampleCount: number };
  mtbfProxy: { hours: number | null; sampleCount: number; assetCount: number };
  definitions: { mttr: string; mtbfProxy: string };
};

type ResponseBody = {
  data?: ReliabilityData;
  error?: { message?: string };
};

function hoursLabel(value: number | null) {
  if (value === null) return "Not enough data";
  if (value >= 24) return `${(value / 24).toFixed(1)} days`;
  return `${value.toFixed(1)} h`;
}

export default function ReliabilityClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [data, setData] = useState<ReliabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ organizationId, siteId });
    const response = await fetch(`/api/analytics/reliability?${params.toString()}`, {
      signal,
      cache: "no-store",
    });
    const body = (await response.json()) as ResponseBody;
    if (!response.ok) throw new Error(body.error?.message ?? "Reliability analytics could not be loaded");
    setData(body.data ?? null);
  }, [organizationId, siteId]);

  useEffect(() => {
    if (!organizationId || !siteId) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(controller.signal)
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Reliability analytics could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, organizationId, siteId]);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to view reliability analytics.</p></section>;
  }
  if (loading && !data) return <section className="card muted">Loading reliability analytics…</section>;
  if (error) return <section className="card" role="alert">{error}</section>;
  if (!data) return <section className="card muted">No reliability data is available.</section>;

  return (
    <>
      <div className="grid grid-2">
        <section className="card">
          <div className="muted">MTTR · corrective repair duration</div>
          <div className="metric">{hoursLabel(data.mttr.hours)}</div>
          <p>{data.definitions.mttr}</p>
          <div className="muted">Sample: {data.mttr.sampleCount} completed corrective work orders</div>
        </section>

        <section className="card">
          <div className="muted">MTBF proxy · corrective event interval</div>
          <div className="metric">{hoursLabel(data.mtbfProxy.hours)}</div>
          <p>{data.definitions.mtbfProxy}</p>
          <div className="muted">
            Sample: {data.mtbfProxy.sampleCount} intervals across {data.mtbfProxy.assetCount} assets
          </div>
        </section>
      </div>

      <section className="card section">
        <h2>Interpretation</h2>
        <p>
          MTTR is only calculated from corrective work orders with valid start and completion timestamps. The MTBF value is explicitly a proxy based on successive corrective request events per asset; it is not a substitute for true operating-hours telemetry.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Generated {new Date(data.generatedAt).toLocaleString()}. Missing or insufficient history is shown as “Not enough data”, never as zero.
        </p>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setError(null);
            void load()
              .catch((loadError: unknown) => {
                setError(loadError instanceof Error ? loadError.message : "Reliability analytics could not be loaded");
              })
              .finally(() => setLoading(false));
          }}
          style={{ marginTop: 12 }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </section>
    </>
  );
}
