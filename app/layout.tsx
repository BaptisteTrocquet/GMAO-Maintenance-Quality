import "./globals.css";
import Link from "next/link";
import { headers } from "next/headers";
import CommandPalette from "./command-palette";

export const metadata = {
  title: "OpenGMAO",
  description: "Open-source maintenance and document management"
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">OpenGMAO</div>
            <nav className="nav">
              <Link href="/">Dashboard</Link>
              <Link href="/search">Search</Link>
              <Link href="/notifications">Notifications</Link>
              <Link href="/assets">Assets</Link>
              <Link href="/maintenance">Maintenance</Link>
              <Link href="/maintenance/kanban">Kanban</Link>
              <Link href="/maintenance/calendar">Calendar</Link>
              <Link href="/maintenance/workload">Workload</Link>
              <Link href="/analytics/backlog">Analytics</Link>
              <Link href="/analytics/pm-compliance">PM compliance</Link>
              <Link href="/analytics/reliability">Reliability</Link>
              <Link href="/analytics/downtime">Downtime</Link>
              <Link href="/documents">Documents</Link>
              <Link href="/inventory">Inventory</Link>
              <Link href="/quality">Quality</Link>
            </nav>
            <CommandPalette organizationId={organizationId} siteId={siteId} />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
