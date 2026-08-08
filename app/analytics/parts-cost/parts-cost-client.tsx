"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type AssetOption = { id: string; code: string; name: string };
type PartsCostPayload = {
  generatedAt: string;
  timezone: string;
  range: { from: string; toExclusive: string };
  assetId: string | null;
  empty: boolean;
  lineCount: number;
  pricedLineCount: number;
  unpricedLineCount: number;
  quantity: number;
  costAmount: number;
  averageCostPerPricedLine: number | null;
  incompleteCost: boolean;
  trend: Array<{
    month: string;
    lineCount: number;
    pricedLineCount: number;
    unpricedLineCount: number;
    quantity: number;
    costAmount: number;
  }>;
  topParts: Array<{
    partId: string;
    sku: string;
    name: string;
    unit: string;
    lineCount: number;
    pricedLineCount: number;
    unpricedLineCount: number;
    quantity: number;
    costAmount: number;
  }>;
  definition: string;
};

type ApiResponse = { data?: PartsCostPayload; error?: { message?: string } };

function amount(value: number) {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PartsCostClient({
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
  const [data, setData] = useState<PartsCostPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ organizationId, siteId, from, to });
      if (assetId) params.set("assetId", assetId);
      const response = await fetch(`/api/analytics/parts-cost?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load parts cost analytics");
      }
      setData(body.data);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : "Unable to load parts cost analytics");
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
          <div className="grid grid-4 section">
            <section className="card">
              <div className="muted">Captured cost amount*</div>
              <div className="title">{amount(data.costAmount)}</div>
            </section>
            <section className="card">
              <div className="muted">Consumption lines</div>
              <div className="title">{data.lineCount}</div>
            </section>
            <section className="card">
              <div className="muted">Priced / unpriced</div>
              <div className="title">{data.pricedLineCount} / {data.unpricedLineCount}</div>
            </section>
            <section className="card">
              <div className="muted">Avg. per priced line*</div>
              <div className="title">
                {data.averageCostPerPricedLine === null ? "—" : amount(data.averageCostPerPricedLine)}
              </div>
            </section>
          </div>

          {data.incompleteCost ? (
            <section className="card section" role="status">
              <strong>Incomplete cost coverage.</strong>{" "}
              {data.unpricedLineCount} consumption line{data.unpricedLineCount === 1 ? " has" : "s have"} no captured unit cost and is excluded from the monetary total.
            </section>
          ) : null}

          <section className="card section">
            <p className="muted" style={{ margin: 0 }}>{data.definition}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              * Amounts intentionally have no currency symbol because currency is not modeled on consumption records yet.
            </p>
          </section>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>Monthly consumed-parts cost</h2>
              {data.trend.length ? (
                <table className="table">
                  <thead><tr><th>Month</th><th>Lines</th><th>Unpriced</th><th>Quantity</th><th>Cost*</th></tr></thead>
                  <tbody>
                    {data.trend.map((point) => (
                      <tr key={point.month}>
                        <td>{point.month}</td>
                        <td>{point.lineCount}</td>
                        <td>{point.unpricedLineCount}</td>
                        <td>{point.quantity}</td>
                        <td>{amount(point.costAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No consumed parts in this reporting window.</p>}
            </section>

            <section className="card responsive-table">
              <h2>Top parts by captured cost</h2>
              {data.topParts.length ? (
                <table className="table">
                  <thead><tr><th>Part</th><th>Quantity</th><th>Unpriced</th><th>Cost*</th></tr></thead>
                  <tbody>
                    {data.topParts.map((part) => (
                      <tr key={part.partId}>
                        <td>{part.sku} · {part.name}</td>
                        <td>{part.quantity} {part.unit}</td>
                        <td>{part.unpricedLineCount}</td>
                        <td>{amount(part.costAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No priced part consumption in this reporting window.</p>}
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
