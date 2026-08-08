"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type PmCompliance = {
  due: number;
  completedOnTime: number;
  completedLate: number;
  openOverdue: number;
  missed: number;
  complianceRate: number | null;
  empty: boolean;
  from: string;
  to: string;
  generatedAt: string;
  reporting: {
    fromDate: string;
    throughDate: string;
    timeZone: string;
  };
};

type ApiResponse<T> = {
  data?: T;
  error?: { message?: string };
};

function yyyyMmDd(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function PmComplianceClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 29);
  const [fromDay, setFromDay] = useState(yyyyMmDd(thirtyDaysAgo));
  const [throughDay, setThroughDay] = useState(yyyyMmDd(today));
  const [assetId, setAssetId] = useState("");
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [data, setData] = useState<PmCompliance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ organizationId, siteId });
    void fetch(`/api/assets?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as ApiResponse<AssetOption[]>;
        if (!response.ok) throw new Error(body.error?.message ?? "Unable to load assets");
        setAssets(body.data ?? []);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setAssets([]);
      });

    return () => controller.abort();
  }, [organizationId, siteId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        organizationId,
        siteId,
        from: fromDay,
        to: throughDay,
      });
      if (assetId) params.set("assetId", assetId);

      const response = await fetch(`/api/analytics/pm-compliance?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse<PmCompliance>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load PM compliance");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load PM compliance");
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
            <span className="muted">From (site calendar)</span>
            <input type="date" value={fromDay} onChange={(event) => setFromDay(event.target.value)} required />
          </label>
          <label>
            <span className="muted">Through (site calendar)</span>
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
          Definition: non-cancelled PREVENTIVE work orders due in the selected site-calendar window. Future due dates are excluded. A PM is compliant only when completed on or before its due date.
        </p>
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}

      {data ? (
        <>
          <div className="grid grid-4 section">
            <section className="card"><div className="muted">PM due</div><div className="title">{data.due}</div></section>
            <section className="card"><div className="muted">Compliance</div><div className="title">{data.complianceRate === null ? "—" : `${data.complianceRate.toFixed(1)}%`}</div></section>
            <section className="card"><div className="muted">Completed on time</div><div className="title">{data.completedOnTime}</div></section>
            <section className="card"><div className="muted">Missed</div><div className="title">{data.missed}</div></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card">
              <h2>Outcome detail</h2>
              {data.empty ? (
                <p className="muted">No preventive work orders were due in this reporting window.</p>
              ) : (
                <dl className="detail-list">
                  <div><dt>Completed late</dt><dd>{data.completedLate}</dd></div>
                  <div><dt>Still open after due date</dt><dd>{data.openOverdue}</dd></div>
                </dl>
              )}
            </section>
            <section className="card">
              <h2>Reporting window</h2>
              <dl className="detail-list">
                <div><dt>Calendar dates</dt><dd>{data.reporting.fromDate} → {data.reporting.throughDate}</dd></div>
                <div><dt>Site timezone</dt><dd>{data.reporting.timeZone}</dd></div>
                <div><dt>From UTC</dt><dd>{data.from}</dd></div>
                <div><dt>Effective to UTC</dt><dd>{data.to}</dd></div>
                <div><dt>Generated</dt><dd>{data.generatedAt}</dd></div>
              </dl>
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
