import { headers } from "next/headers";
import PersonalDashboardClient from "./personal-dashboard-client";

export default async function Dashboard() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">My dashboard</div>
          <div className="muted">Your assigned maintenance work and document approvals in the selected site.</div>
        </div>
      </div>
      <PersonalDashboardClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
