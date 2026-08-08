import { headers } from "next/headers";
import CalendarRescheduler from "./calendar-rescheduler";

export default async function MaintenanceCalendarLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      {organizationId && siteId ? (
        <CalendarRescheduler organizationId={organizationId} siteId={siteId} />
      ) : null}
      {children}
    </>
  );
}
