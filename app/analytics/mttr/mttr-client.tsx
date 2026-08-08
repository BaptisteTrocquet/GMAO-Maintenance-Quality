"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type Mttr = {
  completedCorrective: number;
  validRepairs: number;
  incompleteRepairs: number;
  totalRepairMinutes: number;
  mttrMinutes: number | null;
  mttrHours: number | null;
  empty: boolean;
  insufficientData: boolean;
  from: string;
  to: string;
  generatedAt: string;
};

type ApiResponse = {
  data?: Mttr;
  error?: { message?: string };
};

function yyyyMmDd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function toExclusiveUtcDate(day: string) {
  const start = new Date(`${day}T00:00:00.000Z`);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export default function MttrClient({
  organizationId,
  siteId,
  assets,
}: {
  organizationId: string;
  siteId: string;
  assets: AssetOption[];
}) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  const [fromDay, setFromDay] = useState(yyyyMmDd(thirtyDaysAgo));
  const [throughDay, setThroughDay] = useState(yyyyMmDd(today));
  const [assetId, setAssetId] = useState("");
  const [data, setData] = useState<Mttr | null>(null);
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

      const response = await fetch(`/api/analytics/mttr?${params.toString()}`);
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load MTTR");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load MTTR");
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
          Definition: completed CORRECTIVE work orders whose completion timestamp falls in the selected UTC window. Repair time is completedAt minus startedAt. Missing or reversed timestamps are excluded from the mean and reported separately.
        </p>
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}

      {data ? (
        <>
          <div className="grid grid-4 section">
            <section className="card"><div className="muted">MTTR</div><div className="title">{data.mttrHours === null ? "—" : `${data.mttrHours.toFixed(2)} h`}</div></section>
            <section className="card"><div className="muted">Valid repairs</div><div className="title">{data.validRepairs}</div></section>
            <section className="card"><div className="muted">Completed corrective</div><div className="title">{data.completedCorrective}</div></section>
            <section className="card"><div className="muted">Incomplete data</div><div className="title">{data.incompleteRepairs}</div></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card">
              <h2>Formula detail</h2>
              {data.empty ? (
                <p className="muted">No completed corrective work was found in this reporting window.</p>
              ) : data.insufficientData ? (
                <p className="muted">
                  {data.completedCorrective} completed corrective work order{data.completedCorrective === 1 ? " was" : "s were"} found, but none has a valid startedAt → completedAt interval. MTTR is therefore undefined rather than zero.
                </p>
              ) : (
                <dl className="detail-list">
                  <div><dt>Total repair minutes</dt><dd>{data.totalRepairMinutes.toFixed(1)}</dd></div>
                  <div><dt>Valid repair count</dt><dd>{data.validRepairs}</dd></div>
                  <div><dt>Mean repair minutes</dt><dd>{data.mttrMinutes?.toFixed(1) ?? "—"}</dd></div>
                </dl>
              )}
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
