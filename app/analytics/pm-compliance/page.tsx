import { headers } from "next/headers";
import { db } from "@/lib/db";
import PmComplianceClient from "./pm-compliance-client";

export default async function PmCompliancePage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  const assets = organizationId && siteId
    ? await db.asset.findMany({
        where: {
          siteId,
          archivedAt: null,
          site: { organizationId, active: true },
        },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        take: 500,
      })
    : [];

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
        <PmComplianceClient organizationId={organizationId} siteId={siteId} assets={assets} />
      ) : (
        <section className="card"><p>Select an organization and site to view PM compliance.</p></section>
      )}
    </>
  );
}
