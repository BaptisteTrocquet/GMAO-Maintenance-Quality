import { headers } from "next/headers";
import BacklogDashboardClient from "./backlog-dashboard-client";

export default async function AnalyticsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Analytics · Backlog</div>
          <div className="muted">Current open work, aged and prioritized for the selected site.</div>
        </div>
      </div>
      <BacklogDashboardClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
