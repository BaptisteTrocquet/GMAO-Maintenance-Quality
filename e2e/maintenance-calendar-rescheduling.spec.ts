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

function unscheduledCard(page: import("@playwright/test").Page) {
  return page.locator('article[aria-label*="WO-000001"][aria-label*="unscheduled item"]');
}

test("keyboard/date fallback sends a scoped planning PATCH", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/work-orders/*", async (route) => {
    if (route.request().method() === "PATCH") {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { id: "synthetic" } }),
      });
      return;
    }
    await route.continue();
  });

  const response = await page.goto("/maintenance/calendar?month=2026-02");
  expect(response?.ok()).toBe(true);

  const card = unscheduledCard(page);
  await expect(card).toBeVisible();
  const dateInput = card.getByLabel("Move WO-000001 to date");
  await dateInput.focus();
  await expect(dateInput).toBeFocused();
  await dateInput.fill("2026-01-31");
  await card.getByRole("button", { name: "Move", exact: true }).click();

  await expect.poll(() => payload).not.toBeNull();
  expect(payload).toMatchObject({
    organizationId: scope.organizationId,
    siteId: scope.siteId,
    plannedStart: "2026-01-31T07:00:00.000Z",
  });
});

test("dragging an unscheduled work order onto a calendar day sends the same scoped PATCH", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  let payload: Record<string, unknown> | null = null;
  await page.route("**/api/work-orders/*", async (route) => {
    if (route.request().method() === "PATCH") {
      payload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { id: "synthetic" } }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/maintenance/calendar?month=2026-02");
  const card = unscheduledCard(page);
  const target = page.locator('section[data-date="2026-01-31"]');
  await expect(card).toBeVisible();
  await expect(target).toBeVisible();

  await card.dragTo(target);

  await expect.poll(() => payload).not.toBeNull();
  expect(payload).toMatchObject({
    organizationId: scope.organizationId,
    siteId: scope.siteId,
    plannedStart: "2026-01-31T07:00:00.000Z",
  });
});
