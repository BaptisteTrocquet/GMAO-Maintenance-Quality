import { headers } from "next/headers";
import TechnicianWorkQueue from "./technician-work-queue";

export default async function TechnicianWorkQueuePage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header asset-header">
        <div>
          <h1 className="title">My work</h1>
          <div className="muted">Focused mobile work queue for assigned maintenance.</div>
        </div>
      </div>

      {!organizationId || !siteId ? (
        <section className="card">
          <p>Select an organization and site to open technician mode.</p>
        </section>
      ) : (
        <TechnicianWorkQueue organizationId={organizationId} siteId={siteId} />
      )}
    </>
  );
}
