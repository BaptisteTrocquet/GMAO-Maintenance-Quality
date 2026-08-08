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
          <div className="muted">Live maintenance and inventory signals for the selected site.</div>
        </div>
      </div>
      <NotificationCenterClient organizationId={organizationId} siteId={siteId} />
    </>
  );
}
