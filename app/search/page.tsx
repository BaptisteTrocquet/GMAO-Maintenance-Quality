import { headers } from "next/headers";
import GlobalSearchClient from "./search-client";

export default async function GlobalSearchPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Global search</div>
          <div className="muted">Find operational records across maintenance, assets, documents and inventory.</div>
        </div>
      </div>
      {organizationId && siteId ? (
        <GlobalSearchClient organizationId={organizationId} siteId={siteId} />
      ) : (
        <section className="card"><p>Select an organization and site to search.</p></section>
      )}
    </>
  );
}
