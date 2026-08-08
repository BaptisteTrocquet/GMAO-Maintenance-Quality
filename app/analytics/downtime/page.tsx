import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { localCalendarDate, shiftCalendarDate } from "@/lib/analytics/date-range";
import DowntimeClient from "./downtime-client";

export default async function DowntimeAnalyticsPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header"><div><div className="title">Downtime trends</div></div></div>
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
  const defaultFrom = shiftCalendarDate(today, -179);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/analytics/reliability">← Reliability analytics</Link>
          <div className="title">Downtime trends</div>
          <div className="muted">{site.code} · {site.name} · {site.organization.timezone}</div>
        </div>
        <div className="asset-status">
          <Link className="table-link" href="/analytics/backlog">Backlog</Link>
        </div>
      </div>

      <DowntimeClient
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
