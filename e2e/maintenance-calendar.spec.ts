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

test("planning calendar is tenant scoped and keyboard navigable", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  const response = await page.goto("/maintenance/calendar?month=2026-02");
  expect(response?.ok()).toBe(true);

  await expect(page.getByText("Planning calendar", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("NORTH · North Plant · timezone Europe/Paris", { exact: true })).toBeVisible();
  await expect(page.getByText("WO-000001", { exact: true })).toBeVisible();

  const nextMonth = page.getByRole("link", { name: /Next month/i });
  await nextMonth.focus();
  await expect(nextMonth).toBeFocused();
  await nextMonth.press("Enter");
  await expect(page).toHaveURL(/month=2026-03/);
});
