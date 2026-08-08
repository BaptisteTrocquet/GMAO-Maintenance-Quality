import Link from "next/link";
import { headers } from "next/headers";
import BacklogClient from "./backlog-client";

export default async function BacklogAnalyticsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header asset-header">
        <div>
          <div className="title">Backlog analytics</div>
          <div className="muted">Trusted open-work indicators for the selected site.</div>
        </div>
        <div className="asset-status">
          <Link className="table-link" href="/analytics/pm-compliance">PM compliance</Link>
          <Link className="table-link" href="/analytics/downtime">Downtime</Link>
          <Link className="table-link" href="/analytics/failure-pareto">Failure Pareto</Link>
        </div>
      </div>
      <BacklogClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
