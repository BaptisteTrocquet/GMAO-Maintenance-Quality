import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function demoScope() {
  const organization = await prisma.organization.findUnique({
    where: { slug: "demo-operations" },
    select: { id: true },
  });
  if (!organization) throw new Error("Synthetic demo organization was not seeded");

  const site = await prisma.site.findFirst({
    where: { organizationId: organization.id, code: "NORTH", active: true },
    select: { id: true },
  });
  if (!site) throw new Error("Synthetic demo site was not seeded");
  return { organizationId: organization.id, siteId: site.id };
}

test("calendar schedule handles are keyboard reachable", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  const response = await page.goto("/maintenance/calendar?month=2026-02");
  expect(response?.ok()).toBe(true);

  const startHandle = page
    .getByRole("button", { name: /Move WO-000001 planned start/i })
    .first();
  await expect(startHandle).toBeVisible();
  await startHandle.focus();
  await expect(startHandle).toBeFocused();
});
