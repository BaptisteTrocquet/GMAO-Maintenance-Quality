import Link from "next/link";
import { headers } from "next/headers";
import LaborCapacityClient from "./labor-capacity-client";

export default async function LaborCapacityPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <Link className="muted" href="/analytics/labor-utilization">← Labor utilization</Link>
          <div className="title">Labor capacity baseline</div>
          <div className="muted">Configure planned weekly capacity for maintenance analytics.</div>
        </div>
      </div>
      {organizationId && siteId ? (
        <LaborCapacityClient organizationId={organizationId} siteId={siteId} />
      ) : (
        <section className="card"><p>Select an organization and site to continue.</p></section>
      )}
    </>
  );
}
