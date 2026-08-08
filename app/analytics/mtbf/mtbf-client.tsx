"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type Mtbf = {
  failureEvents: number;
  validIntervals: number;
  excludedIntervals: number;
  contributingAssets: number;
  totalIntervalMinutes: number;
  mtbfMinutes: number | null;
  mtbfHours: number | null;
  empty: boolean;
  from: string;
  to: string;
  generatedAt: string;
  definition: string;
};

type ApiResponse = {
  data?: Mtbf;
  error?: { message?: string };
};

function yyyyMmDd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function toExclusiveUtcDate(day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export default function MtbfClient({
  organizationId,
  siteId,
  assets,
}: {
  organizationId: string;
  siteId: string;
  assets: AssetOption[];
}) {
  const today = new Date();
  const ninetyDaysAgo = new Date(today.getTime() - 89 * 24 * 60 * 60 * 1000);
  const [fromDay, setFromDay] = useState(yyyyMmDd(ninetyDaysAgo));
  const [throughDay, setThroughDay] = useState(yyyyMmDd(today));
  const [assetId, setAssetId] = useState("");
  const [data, setData] = useState<Mtbf | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        organizationId,
        siteId,
        from: new Date(`${fromDay}T00:00:00.000Z`).toISOString(),
        to: toExclusiveUtcDate(throughDay),
      });
      if (assetId) params.set("assetId", assetId);

      const response = await fetch(`/api/analytics/mtbf?${params.toString()}`);
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load MTBF");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load MTBF");
    } finally {
      setLoading(false);
    }
  }, [assetId, fromDay, organizationId, siteId, throughDay]);

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
            <span className="muted">From (UTC)</span>
            <input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Through (UTC)</span>
            <input type="date" value={throughDay} onChange={(event) => setThroughDay(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Asset</span>
            <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
              <option value="">All assets</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.code} · {asset.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={loading}>{loading ? "Refreshing…" : "Apply"}</button>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          This metric is an event-interval proxy, not operating-hours MTBF. It uses successive non-cancelled CORRECTIVE request timestamps on the same asset until explicit failure telemetry is available.
        </p>
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}

      {data ? (
        <>
          <div className="grid grid-4 section">
            <section className="card"><div className="muted">MTBF proxy</div><div className="title">{data.mtbfHours === null ? "—" : `${data.mtbfHours.toFixed(1)} h`}</div></section>
            <section className="card"><div className="muted">Valid intervals</div><div className="title">{data.validIntervals}</div></section>
            <section className="card"><div className="muted">Failure events</div><div className="title">{data.failureEvents}</div></section>
            <section className="card"><div className="muted">Contributing assets</div><div className="title">{data.contributingAssets}</div></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card">
              <h2>Formula detail</h2>
              {data.empty ? (
                <p className="muted">No valid interval between two corrective events was available in this reporting window.</p>
              ) : (
                <dl className="detail-list">
                  <div><dt>Total interval minutes</dt><dd>{data.totalIntervalMinutes.toFixed(1)}</dd></div>
                  <div><dt>Valid intervals</dt><dd>{data.validIntervals}</dd></div>
                  <div><dt>Excluded first/invalid intervals</dt><dd>{data.excludedIntervals}</dd></div>
                </dl>
              )}
              <p className="muted">{data.definition}</p>
            </section>
            <section className="card">
              <h2>Reporting window</h2>
              <dl className="detail-list">
                <div><dt>From</dt><dd>{data.from}</dd></div>
                <div><dt>To (exclusive)</dt><dd>{data.to}</dd></div>
                <div><dt>Generated</dt><dd>{data.generatedAt}</dd></div>
              </dl>
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
