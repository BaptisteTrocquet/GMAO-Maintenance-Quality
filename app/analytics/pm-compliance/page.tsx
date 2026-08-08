import { headers } from "next/headers";
import { localCalendarDate, shiftCalendarDate } from "@/lib/analytics/date-range";
import { db } from "@/lib/db";
import PmComplianceClient from "./pm-compliance-client";

export default async function PmCompliancePage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  const site = organizationId && siteId
    ? await db.site.findFirst({
        where: { id: siteId, organizationId, active: true },
        select: {
          organization: { select: { timezone: true } },
          assets: {
            where: { archivedAt: null },
            select: { id: true, code: true, name: true },
            orderBy: { code: "asc" },
            take: 500,
          },
        },
      })
    : null;

  const timeZone = site?.organization.timezone ?? "UTC";
  const throughDay = localCalendarDate(new Date(), timeZone);
  const fromDay = shiftCalendarDate(throughDay, -29);

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
      {organizationId && siteId && site ? (
        <PmComplianceClient
          organizationId={organizationId}
          siteId={siteId}
          assets={site.assets}
          timeZone={timeZone}
          initialFromDay={fromDay}
          initialThroughDay={throughDay}
        />
      ) : (
        <section className="card"><p>Select an active organization and site to view PM compliance.</p></section>
      )}
    </>
  );
}
