import { headers } from "next/headers";
import { db } from "@/lib/db";
import MtbfClient from "./mtbf-client";

export default async function MtbfPage() {
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
          <div className="title">MTBF</div>
          <div className="muted">
            Event-interval reliability proxy between successive corrective events on the same asset.
          </div>
        </div>
      </div>
      {organizationId && siteId ? (
        <MtbfClient organizationId={organizationId} siteId={siteId} assets={assets} />
      ) : (
        <section className="card"><p>Select an organization and site to view MTBF.</p></section>
      )}
    </>
  );
}
