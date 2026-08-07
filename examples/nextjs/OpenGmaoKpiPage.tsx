import React from "react";
import { OpenGmaoClient, type KpiCard } from "../../sdk/index";

export type OpenGmaoServerConfig = {
  baseUrl: string;
  tokenId: string;
  token: string;
};

export async function loadOpenGmaoKpis(
  config: OpenGmaoServerConfig,
  fetchImpl?: typeof fetch,
) {
  const client = new OpenGmaoClient({
    ...config,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return client.kpis.get();
}

export function KpiPanel({ kpis }: { kpis: KpiCard }) {
  return (
    <section aria-labelledby="maintenance-kpis">
      <h2 id="maintenance-kpis">Maintenance KPIs</h2>
      <dl>
        <div><dt>Open work orders</dt><dd>{kpis.openWorkOrders}</dd></div>
        <div><dt>Overdue</dt><dd>{kpis.overdueWorkOrders}</dd></div>
        <div><dt>In progress</dt><dd>{kpis.inProgressWorkOrders}</dd></div>
        <div><dt>Assets out of service</dt><dd>{kpis.outOfServiceAssets}</dd></div>
      </dl>
      <p>Updated {new Date(kpis.generatedAt).toLocaleString()}</p>
    </section>
  );
}

export default async function OpenGmaoKpiPage() {
  const baseUrl = process.env.GMAO_BASE_URL;
  const tokenId = process.env.GMAO_KPI_TOKEN_ID;
  const token = process.env.GMAO_KPI_TOKEN;

  if (!baseUrl || !tokenId || !token) {
    return <p>OpenGMAO server integration is not configured.</p>;
  }

  const kpis = await loadOpenGmaoKpis({ baseUrl, tokenId, token });
  return <KpiPanel kpis={kpis} />;
}
