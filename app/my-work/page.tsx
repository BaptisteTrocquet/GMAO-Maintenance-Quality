import { headers } from "next/headers";
import MyWorkClient from "./my-work-client";

export default async function MyWorkPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">My work</div>
          <div className="muted">Your direct and team maintenance workload for the selected site.</div>
        </div>
      </div>
      {organizationId && siteId ? (
        <MyWorkClient organizationId={organizationId} siteId={siteId} />
      ) : (
        <section className="card"><p>Select an organization and site to view your personal dashboard.</p></section>
      )}
    </>
  );
}
