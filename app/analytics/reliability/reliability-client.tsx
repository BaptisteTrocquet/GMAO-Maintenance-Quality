"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type ReliabilityPayload = {
  generatedAt: string;
  timezone: string;
  range: { from: string | null; toExclusive: string };
  assetId: string | null;
  mttr: { hours: number | null; sampleCount: number; excludedIncomplete: number };
  mtbf: { hours: number | null; sampleCount: number; assetCount: number };
  definitions: { mttr: string; mtbf: string };
};

type ApiResponse = { data?: ReliabilityPayload; error?: { message?: string } };

function formatHours(value: number | null) {
  return value === null ? "—" : `${value.toFixed(1)} h`;
}

export default function ReliabilityClient({
  organizationId,
  siteId,
  timeZone,
  assets,
  defaultFrom,
  defaultTo,
}: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  assets: AssetOption[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [assetId, setAssetId] = useState("");
  const [data, setData] = useState<ReliabilityPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, from, to });
      if (assetId) params.set("assetId", assetId);
      const response = await fetch(`/api/analytics/reliability?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load reliability analytics");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load reliability analytics");
    } finally {
      setLoading(false);
    }
  }, [assetId, from, organizationId, siteId, to]);

  useEffect(() => {
    void load();
  }, [load]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load();
  }

  return (
    <>
      <section className="card">
        <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end" }}>
          <label>
            <span className="muted">From ({timeZone})</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Through ({timeZone})</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Asset</span>
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              <option value="">All active assets</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={loading}>{loading ? "Refreshing…" : "Apply"}</button>
        </form>
      </section>

      {error ? <section className="card section" role="alert">{error}</section> : null}

      {data ? (
        <>
          <div className="grid grid-2 section">
            <section className="card">
              <div className="muted">MTTR</div>
              <div className="title">{formatHours(data.mttr.hours)}</div>
              <p>{data.mttr.sampleCount} valid completed corrective sample{data.mttr.sampleCount === 1 ? "" : "s"}</p>
              <p className="muted">{data.mttr.excludedIncomplete} completed corrective record{data.mttr.excludedIncomplete === 1 ? "" : "s"} excluded for incomplete or invalid timestamps.</p>
              <p className="muted">{data.definitions.mttr}</p>
            </section>
            <section className="card">
              <div className="muted">MTBF proxy</div>
              <div className="title">{formatHours(data.mtbf.hours)}</div>
              <p>
                {data.mtbf.sampleCount} corrective-event interval{data.mtbf.sampleCount === 1 ? "" : "s"}
                {data.mtbf.assetCount ? ` across ${data.mtbf.assetCount} asset${data.mtbf.assetCount === 1 ? "" : "s"}` : ""}
              </p>
              <p className="muted">{data.definitions.mtbf}</p>
            </section>
          </div>

          <section className="card section">
            <h2>Reporting basis</h2>
            <dl className="detail-list">
              <div><dt>Timezone</dt><dd>{data.timezone}</dd></div>
              <div><dt>From</dt><dd>{data.range.from ?? "All history"}</dd></div>
              <div><dt>To (exclusive)</dt><dd>{data.range.toExclusive}</dd></div>
              <div><dt>Asset</dt><dd>{data.assetId ?? "All active assets"}</dd></div>
              <div><dt>Generated</dt><dd>{data.generatedAt}</dd></div>
            </dl>
          </section>
        </>
      ) : null}
    </>
  );
}
