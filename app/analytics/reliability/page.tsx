import { headers } from "next/headers";
import ReliabilityClient from "./reliability-client";

export default async function ReliabilityAnalyticsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Reliability analytics</div>
          <div className="muted">MTTR and MTBF event-interval indicators for the selected site.</div>
        </div>
      </div>
      <ReliabilityClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
