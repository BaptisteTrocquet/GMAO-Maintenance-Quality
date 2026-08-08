import { expect, test } from "@playwright/test";
import { db } from "../lib/db";
import { createSession } from "../lib/auth/session";

async function cachedTechnicianRequestCount(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) =>
      name.startsWith("opengmao-technician-read-v1:"),
    );
    let count = 0;
    for (const name of names) {
      count += (await (await caches.open(name)).keys()).length;
    }
    return count;
  });
}

test("technician reads fall back to a session-partitioned cache while writes stay disabled offline", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const [organization, technician] = await Promise.all([
    db.organization.findUnique({ where: { slug: "demo-operations" } }),
    db.user.findUnique({ where: { email: "technician@example.local" } }),
  ]);
  expect(organization).not.toBeNull();
  expect(technician).not.toBeNull();
  if (!organization || !technician) return;

  const site = await db.site.findFirst({
    where: { organizationId: organization.id, code: "NORTH" },
  });
  expect(site).not.toBeNull();
  if (!site) return;

  const seededWorkOrder = await db.workOrder.findUnique({ where: { number: "WO-000001" } });
  expect(seededWorkOrder?.assigneeId).toBe(technician.id);
  expect(seededWorkOrder?.siteId).toBe(site.id);

  const session = await createSession(technician.id);

  try {
    await page.setExtraHTTPHeaders({
      authorization: `Bearer ${session.token}`,
      "x-organization-id": organization.id,
      "x-site-id": site.id,
    });

    await page.goto("/maintenance/my-work");
    await expect(page.getByRole("heading", { name: "My work" })).toBeVisible();
    await expect(page.getByRole("link", { name: /WO-000001 · Investigate abnormal vibration/ })).toBeVisible();

    await expect
      .poll(
        () => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)),
        { timeout: 10_000 },
      )
      .toBe(true);

    await expect(page.getByText(/Assigned work is cached after a successful online refresh/)).toBeVisible();
    await page.getByRole("button", { name: "Refresh assigned work" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect.poll(() => cachedTechnicianRequestCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Refresh assigned work" }).click();
    await expect(page.getByText(/Offline copy · cached/)).toBeVisible();
    await expect(page.getByText(/Read-only cached data/)).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh assigned work" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: /WO-000001 · Investigate abnormal vibration/ }).click();
    await expect(page.getByRole("heading", { name: "WO-000001 · Investigate abnormal vibration" })).toBeVisible();
    await expect(page.getByText(/This work order is cached after successful online reads/)).toBeVisible();

    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect.poll(() => cachedTechnicianRequestCount(page), { timeout: 10_000 }).toBeGreaterThan(1);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText(/Offline copy · cached/)).toBeVisible();
    await expect(page.getByText(/Read-only mode/)).toBeVisible();

    await expect(page.getByRole("button", { name: "Block work" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save progress" })).toBeDisabled();
    await expect(page.getByLabel("Labor minutes")).toBeDisabled();
    await expect(page.getByLabel("Downtime minutes")).toBeDisabled();
    await expect(page.getByLabel("Completion note")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Take photo" })).toBeDisabled();
    await expect(page.getByText(/Offline write queuing is not enabled yet/)).toBeVisible();

    await context.setOffline(false);
    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Block work" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Save progress" })).toBeEnabled();
  } finally {
    await context.setOffline(false);
    await db.session.deleteMany({ where: { id: session.id } });
  }
});
