import { expect, test } from "@playwright/test";
import { createSession } from "../lib/auth/session";
import { db } from "../lib/db";

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
    const writes = await new Promise<
      Array<{
        kind: string;
        body: Record<string, unknown>;
        lastError: string | null;
        lastErrorCode: string | null;
        lastErrorStatus: number | null;
        conflictAt: string | null;
      }>
    >((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    database.close();
    return writes.map((write) => ({
      kind: write.kind,
      body: write.body,
      lastError: write.lastError ?? null,
      lastErrorCode: write.lastErrorCode ?? null,
      lastErrorStatus: write.lastErrorStatus ?? null,
      conflictAt: write.conflictAt ?? null,
    }));
  });
}

test("technician can keep or discard an offline write that conflicts with the server", async ({
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
    startedAt: seededWorkOrder.startedAt,
    completedAt: seededWorkOrder.completedAt,
  };
  const session = await createSession(technician.id);

  try {
    await page.setExtraHTTPHeaders({
      authorization: `Bearer ${session.token}`,
      "x-organization-id": organization.id,
      "x-site-id": site.id,
    });

    await page.goto("/maintenance/my-work");
    await page.getByRole("link", { name: /WO-000001 · Investigate abnormal vibration/ }).click();
    await expect(page.getByRole("heading", { name: "WO-000001 · Investigate abnormal vibration" })).toBeVisible();

    await expect
      .poll(
        () => page.evaluate(() => Boolean(navigator.serviceWorker?.controller)),
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    await context.setOffline(true);
    await page.getByRole("button", { name: "Refresh work order" }).click();
    await expect(page.getByText(/Offline copy · cached/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue progress" })).toBeEnabled();

    await page.getByLabel("Labor minutes").fill("73");
    await page.getByLabel("Downtime minutes").fill("19");
    await page.getByLabel("Completion note").fill("Local offline vibration findings");
    await page.getByRole("button", { name: "Queue progress" }).click();
    await expect(page.getByTestId("queued-write-count")).toHaveText("1 queued");

    await expect.poll(() => queuedWriteSnapshot(page)).toHaveLength(1);

    await db.workOrder.update({
      where: { id: seededWorkOrder.id },
      data: {
        status: "COMPLETED",
        laborMinutes: 12,
        downtimeMinutes: 3,
        completionNote: "Server-side completion while technician was offline",
        completedAt: new Date(),
      },
    });

    await context.setOffline(false);

    const conflict = page.getByTestId("sync-conflict");
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await expect(conflict.getByRole("heading", { name: "Sync conflict" })).toBeVisible();
    await expect(conflict.getByText("WORK_NOT_ACTIVE", { exact: true })).toBeVisible();
    await expect(conflict.getByText(/Execution can only be recorded while the work order is in progress or blocked/)).toBeVisible();
    await expect(conflict.getByText(/Progress update · labor 73 min · downtime 19 min · completion note/)).toBeVisible();

    const serverVersion = conflict.getByTestId("server-conflict-version");
    await expect(serverVersion.getByText("Status: COMPLETED", { exact: true })).toBeVisible();
    await expect(serverVersion.getByText("Labor: 12 min", { exact: true })).toBeVisible();
    await expect(serverVersion.getByText("Downtime: 3 min", { exact: true })).toBeVisible();
    await expect(serverVersion.getByText(/Server-side completion while technician was offline/)).toBeVisible();

    await expect.poll(() => queuedWriteSnapshot(page)).toEqual([
      expect.objectContaining({
        kind: "execution",
        lastErrorCode: "WORK_NOT_ACTIVE",
        lastErrorStatus: 409,
        conflictAt: expect.any(String),
      }),
    ]);

    await expect(page.getByLabel("Labor minutes")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save progress" })).toBeDisabled();

    await conflict.getByRole("button", { name: "Keep local change" }).click();
    await expect(page.getByText(/Local queued change kept/)).toBeVisible();
    await expect(page.getByTestId("queued-write-count")).toHaveText("1 queued");

    await page.reload();
    await expect(page.getByTestId("sync-conflict")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("queued-write-count")).toHaveText("1 queued");
    await expect(page.getByTestId("server-conflict-version").getByText("Status: COMPLETED", { exact: true })).toBeVisible();

    await page.getByTestId("sync-conflict").getByRole("button", {
      name: "Discard local change and use server",
    }).click();

    await expect(page.getByTestId("sync-conflict")).toHaveCount(0);
    await expect(page.getByTestId("queued-write-count")).toHaveCount(0);
    await expect.poll(() => queuedWriteSnapshot(page)).toEqual([]);
    await expect(page.getByText(/Local queued change discarded/)).toBeVisible();
    await expect(page.getByText("COMPLETED", { exact: true }).first()).toBeVisible();

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
      status: "COMPLETED",
      laborMinutes: 12,
      downtimeMinutes: 3,
      completionNote: "Server-side completion while technician was offline",
    });
  } finally {
    await context.setOffline(false);
    await db.workOrder.update({
      where: { id: seededWorkOrder.id },
      data: original,
    });
    await db.session.deleteMany({ where: { id: session.id } });
  }
});
