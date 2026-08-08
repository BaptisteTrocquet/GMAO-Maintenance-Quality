import { headers } from "next/headers";
import PersonalDashboardClient from "./personal-dashboard-client";

export default async function Dashboard() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return <PersonalDashboardClient organizationId={organizationId} siteId={siteId} />;
}
