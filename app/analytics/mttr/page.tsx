import { headers } from "next/headers";
import { db } from "@/lib/db";
import MttrClient from "./mttr-client";

export default async function MttrPage() {
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
          <div className="title">MTTR</div>
          <div className="muted">
            Mean time to repair for completed corrective work in the selected site.
          </div>
        </div>
      </div>
      {organizationId && siteId ? (
        <MttrClient organizationId={organizationId} siteId={siteId} assets={assets} />
      ) : (
        <section className="card"><p>Select an organization and site to view MTTR.</p></section>
      )}
    </>
  );
}
