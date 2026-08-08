import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

const prisma = new PrismaClient();

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function demoScope() {
  const organization = await prisma.organization.findUnique({
    where: { slug: "demo-operations" },
    select: { id: true, timezone: true },
  });
  if (!organization) throw new Error("Synthetic demo organization was not seeded");

  const site = await prisma.site.findFirst({
    where: { organizationId: organization.id, code: "NORTH", active: true },
    select: { id: true },
  });
  if (!site) throw new Error("Synthetic demo site was not seeded");

  const workOrder = await prisma.workOrder.findUnique({
    where: { number: "WO-000001" },
    select: { number: true, siteId: true, plannedStart: true },
  });
  if (!workOrder || workOrder.siteId !== site.id || !workOrder.plannedStart) {
    throw new Error("Synthetic planned work order was not seeded in the demo site");
  }

  const monthParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: organization.timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(workOrder.plannedStart);
  const year = monthParts.find((part) => part.type === "year")?.value;
  const month = monthParts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not resolve synthetic planning month");

  return {
    organizationId: organization.id,
    siteId: site.id,
    workOrderNumber: workOrder.number,
    month: `${year}-${month}`,
  };
}

test("calendar schedule handles are keyboard reachable", async ({ page }) => {
  const scope = await demoScope();
  await page.setExtraHTTPHeaders({
    "x-organization-id": scope.organizationId,
    "x-site-id": scope.siteId,
  });

  const response = await page.goto(`/maintenance/calendar?month=${scope.month}`);
  expect(response?.ok()).toBe(true);

  const startHandle = page
    .getByRole("button", { name: new RegExp(`Move ${scope.workOrderNumber} planned start`, "i") })
    .first();
  await expect(startHandle).toBeVisible();
  await startHandle.focus();
  await expect(startHandle).toBeFocused();
});
