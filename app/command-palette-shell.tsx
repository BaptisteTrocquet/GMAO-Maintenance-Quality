import { headers } from "next/headers";
import CommandPalette from "./command-palette";

export default async function CommandPaletteShell() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  return <CommandPalette organizationId={organizationId} siteId={siteId} />;
}
