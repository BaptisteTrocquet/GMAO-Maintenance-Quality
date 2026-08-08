import { headers } from "next/headers";
import BulkActionsClient from "./bulk-actions-client";

export default async function BulkActionsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Bulk work-order actions</div>
          <div className="muted">
            Apply a single audited triage change to a bounded selection of work orders in the selected site.
          </div>
        </div>
      </div>
      <BulkActionsClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
