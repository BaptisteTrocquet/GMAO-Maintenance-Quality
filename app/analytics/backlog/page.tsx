import { headers } from "next/headers";
import BacklogDashboardClient from "./backlog-dashboard-client";

export default async function BacklogDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; assetId?: string }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const filters = await searchParams;

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Backlog analytics</div>
          <div className="muted">Current open-work backlog, aging and due risk with timezone-aware filters.</div>
        </div>
      </div>
      {organizationId && siteId ? (
        <BacklogDashboardClient
          organizationId={organizationId}
          siteId={siteId}
          initialFrom={filters.from ?? ""}
          initialTo={filters.to ?? ""}
          initialAssetId={filters.assetId ?? ""}
        />
      ) : (
        <section className="card"><p>Select an organization and site to view analytics.</p></section>
      )}
    </>
  );
}
