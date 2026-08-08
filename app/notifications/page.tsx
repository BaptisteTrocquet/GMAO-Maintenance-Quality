import { headers } from "next/headers";
import NotificationCenterClient from "./notification-center-client";

export default async function NotificationCenterPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Notification center</div>
          <div className="muted">Actionable operational alerts from maintenance, inventory and quality.</div>
        </div>
      </div>
      {organizationId && siteId ? (
        <NotificationCenterClient organizationId={organizationId} siteId={siteId} />
      ) : (
        <section className="card"><p>Select an organization and site to view notifications.</p></section>
      )}
    </>
  );
}
