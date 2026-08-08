import { headers } from "next/headers";
import GlobalSearchClient from "./global-search-client";

export default async function GlobalSearchPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Global search</div>
          <div className="muted">
            Find operational records across the selected site without crossing role or tenant boundaries.
          </div>
        </div>
      </div>
      <GlobalSearchClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
