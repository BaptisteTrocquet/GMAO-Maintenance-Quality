import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { localCalendarDate, shiftCalendarDate } from "@/lib/analytics/date-range";
import { db } from "@/lib/db";
import LaborUtilizationClient from "./labor-utilization-client";

export default async function LaborUtilizationPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header"><div><div className="title">Labor utilization</div></div></div>
        <section className="card"><p>Select an organization and site to continue.</p></section>
      </>
    );
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: {
      code: true,
      name: true,
      organization: { select: { timezone: true } },
      assets: {
        where: { archivedAt: null },
        select: { id: true, code: true, name: true },
        orderBy: { code: "asc" },
        take: 500,
      },
    },
  });
  if (!site) notFound();

  const today = localCalendarDate(new Date(), site.organization.timezone);
  const defaultFrom = shiftCalendarDate(today, -89);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/analytics/backlog">← Analytics</Link>
          <div className="title">Labor utilization</div>
          <div className="muted">Recorded labor distribution · {site.code} · {site.name} · {site.organization.timezone}</div>
        </div>
      </div>

      <LaborUtilizationClient
        organizationId={organizationId}
        siteId={siteId}
        timeZone={site.organization.timezone}
        assets={site.assets}
        defaultFrom={defaultFrom}
        defaultTo={today}
      />
    </>
  );
}
