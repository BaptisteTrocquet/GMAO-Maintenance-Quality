import "./globals.css";
import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import CommandPalette from "./command-palette";
import MobileNavigation from "./mobile-navigation";
import { PRIMARY_NAVIGATION } from "./navigation-items";
import PwaRegister from "./pwa-register";

export const metadata: Metadata = {
  title: "OpenGMAO",
  description: "Open-source maintenance and document management",
  manifest: "/manifest.webmanifest",
  applicationName: "OpenGMAO",
  icons: {
    icon: [
      { url: "/icons/pwa-192.svg", type: "image/svg+xml", sizes: "192x192" },
      { url: "/icons/pwa-512.svg", type: "image/svg+xml", sizes: "512x512" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#111827",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return (
    <html lang="en">
      <body>
        <PwaRegister />
        <MobileNavigation />
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">OpenGMAO</div>
            <nav className="nav" aria-label="Primary navigation">
              {PRIMARY_NAVIGATION.map((item) => (
                <Link key={item.href} href={item.href}>{item.label}</Link>
              ))}
            </nav>
            <CommandPalette organizationId={organizationId} siteId={siteId} />
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
