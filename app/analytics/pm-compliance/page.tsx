import { headers } from "next/headers";
import PmComplianceClient from "./pm-compliance-client";

export default async function PmCompliancePage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">PM compliance</div>
          <div className="muted">
            Preventive work completed on or before its due date, scoped to the selected site.
          </div>
        </div>
      </div>
      {organizationId && siteId ? (
        <PmComplianceClient organizationId={organizationId} siteId={siteId} />
      ) : (
        <section className="card"><p>Select an organization and site to view PM compliance.</p></section>
      )}
    </>
  );
}
