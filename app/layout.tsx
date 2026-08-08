import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "OpenGMAO",
  description: "Open-source maintenance and document management"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">OpenGMAO</div>
            <nav className="nav">
              <Link href="/">Dashboard</Link>
              <Link href="/assets">Assets</Link>
              <Link href="/maintenance">Maintenance</Link>
              <Link href="/maintenance/kanban">Planning</Link>
              <Link href="/documents">Documents</Link>
              <Link href="/inventory">Inventory</Link>
              <Link href="/quality">Quality</Link>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
