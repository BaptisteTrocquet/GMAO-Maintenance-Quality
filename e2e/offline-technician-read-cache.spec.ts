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

async function queuedWriteSnapshot(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("opengmao-technician-offline", 1);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!database.objectStoreNames.contains("writeQueue")) {
      database.close();
      return [];
    }
    const transaction = database.transaction("writeQueue", "readonly");
    const getAll = transaction.objectStore("writeQueue").getAll();
    const writes = await new Promise<Array<{ kind: string; endpoint: string }>>((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result as Array<{ kind: string; endpoint: string }>);
      getAll.onerror = () => reject(getAll.error);
    });
    database.close();
    return writes.map(({ kind, endpoint }) => ({ kind, endpoint }));
  });
}

test("technician reads and structured writes survive an offline to online transition", async ({
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

  const seededWorkOrder = await db.workOrder.findUnique({
    where: { number: "WO-000001" },
    include: { checkItems: true },
  });
  expect(seededWorkOrder?.assigneeId).toBe(technician.id);
  expect(seededWorkOrder?.siteId).toBe(site.id);
  expect(seededWorkOrder?.status).toBe("IN_PROGRESS");
  if (!seededWorkOrder) return;

  const original = {
    status: seededWorkOrder.status,
    laborMinutes: seededWorkOrder.laborMinutes,
    downtimeMinutes: seededWorkOrder.downtimeMinutes,
    completionNote: seededWorkOrder.completionNote,
    checkItems: seededWorkOrder.checkItems.map((item) => ({
      id: item.id,
      completed: item.completed,
      note: item.note,
    })),
  };
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
    await expect(page.getByText(/supports cached reads and queued structured edits offline/)).toBeVisible();

    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    await expect.poll(() => cachedTechnicianRequestCount(page), { timeout: 10_000 }).toBeGreaterThan(1);

    await context.setOffline(true);
    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText(/Offline copy · cached/)).toBeVisible();
    await expect(page.getByText(/Offline edits are stored on this device/)).toBeVisible();

    await expect(page.getByLabel("Labor minutes")).toBeEnabled();
    await expect(page.getByLabel("Downtime minutes")).toBeEnabled();
    await expect(page.getByLabel("Completion note")).toBeEnabled();
    await page.getByLabel("Labor minutes").fill("37");
    await page.getByLabel("Downtime minutes").fill("11");
    await page.getByLabel("Completion note").fill("Queued offline vibration inspection update");

    await page.getByRole("button", { name: "Queue progress" }).click();
    await expect(page.getByTestId("queued-write-count")).toHaveText("1 queued");
    await page.getByRole("button", { name: "Queue block" }).click();
    await expect(page.getByTestId("queued-write-count")).toHaveText("2 queued");
    await expect(page.getByText(/Status BLOCKED queued/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue resume" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Take photo" })).toBeDisabled();
    await expect(page.getByText(/Photo uploads still require a network connection/)).toBeVisible();

    await expect.poll(() => queuedWriteSnapshot(page), { timeout: 10_000 }).toEqual([
      {
        kind: "execution",
        endpoint: `/api/work-orders/${seededWorkOrder.id}/execution`,
      },
      {
        kind: "transition",
        endpoint: `/api/work-orders/${seededWorkOrder.id}`,
      },
    ]);

    const replayedPatches: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "PATCH") replayedPatches.push(new URL(request.url()).pathname);
    });

    await context.setOffline(false);
    await expect.poll(() => queuedWriteSnapshot(page), { timeout: 15_000 }).toEqual([]);
    await expect(page.getByText(/queued changes synced/)).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    expect(replayedPatches.slice(0, 2)).toEqual([
      `/api/work-orders/${seededWorkOrder.id}/execution`,
      `/api/work-orders/${seededWorkOrder.id}`,
    ]);

    await expect.poll(async () => {
      const current = await db.workOrder.findUnique({ where: { id: seededWorkOrder.id } });
      return current
        ? {
            status: current.status,
            laborMinutes: current.laborMinutes,
            downtimeMinutes: current.downtimeMinutes,
            completionNote: current.completionNote,
          }
        : null;
    }).toEqual({
      status: "BLOCKED",
      laborMinutes: 37,
      downtimeMinutes: 11,
      completionNote: "Queued offline vibration inspection update",
    });
  } finally {
    await context.setOffline(false);
    await db.workOrder.update({
      where: { id: seededWorkOrder.id },
      data: {
        status: original.status,
        laborMinutes: original.laborMinutes,
        downtimeMinutes: original.downtimeMinutes,
        completionNote: original.completionNote,
      },
    });
    for (const item of original.checkItems) {
      await db.workOrderCheckItem.update({
        where: { id: item.id },
        data: { completed: item.completed, note: item.note },
      });
    }
    await db.session.deleteMany({ where: { id: session.id } });
  }
});
