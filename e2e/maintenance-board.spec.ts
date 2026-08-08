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

test("work-order board requires tenant and site context", async ({ page }) => {
  const response = await page.goto("/maintenance/board");

  expect(response?.ok()).toBe(true);
  await expect(
    page.getByText("Select an organization and site to view the work-order board.", { exact: true }),
  ).toBeVisible();
});

test("tenant-scoped work-order board supports keyboard due-filter navigation", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  const response = await page.goto("/maintenance/board");
  expect(response?.ok()).toBe(true);
  await expect(page.getByText("Work-order board", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("NORTH · North Plant · status, priority and due-date focus", { exact: true })).toBeVisible();

  const overdue = page.getByRole("link", { name: "Overdue", exact: true });
  await overdue.focus();
  await expect(overdue).toBeFocused();
  await overdue.press("Enter");

  await expect(page).toHaveURL(/due=OVERDUE/);
  await expect(page.getByRole("link", { name: "Overdue", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
