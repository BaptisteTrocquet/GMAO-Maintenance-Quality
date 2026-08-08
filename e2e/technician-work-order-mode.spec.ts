import { expect, test } from "@playwright/test";

test("technician mode captures an explicit mobile signature before completion", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setExtraHTTPHeaders({
    "x-organization-id": "org-e2e",
    "x-site-id": "site-e2e",
  });

  await page.route("**/api/work-orders/technician?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          workOrders: [{
            id: "wo-e2e",
            number: "WO-E2E-001",
            title: "Inspect synthetic pump",
            description: "Synthetic technician workflow fixture",
            status: "IN_PROGRESS",
            priority: "HIGH",
            type: "CORRECTIVE",
            plannedStart: "2026-08-08T06:00:00.000Z",
            dueAt: "2026-08-08T10:00:00.000Z",
            startedAt: "2026-08-08T06:15:00.000Z",
            updatedAt: "2026-08-08T06:15:00.000Z",
            asset: { id: "asset-e2e", code: "P-E2E", name: "Synthetic pump" },
            assignee: { id: "tech-e2e", displayName: "Synthetic Technician" },
            team: null,
            _count: { checkItems: 1, attachments: 0 },
          }],
        },
      }),
    });
  });

  const detail = {
    id: "wo-e2e",
    number: "WO-E2E-001",
    title: "Inspect synthetic pump",
    description: "Synthetic technician workflow fixture",
    status: "IN_PROGRESS",
    priority: "HIGH",
    type: "CORRECTIVE",
    plannedStart: "2026-08-08T06:00:00.000Z",
    dueAt: "2026-08-08T10:00:00.000Z",
    startedAt: "2026-08-08T06:15:00.000Z",
    laborMinutes: 0,
    downtimeMinutes: 0,
    completionNote: null,
    asset: { id: "asset-e2e", code: "P-E2E", name: "Synthetic pump" },
    assignee: { id: "tech-e2e", displayName: "Synthetic Technician" },
    team: null,
    checkItems: [{ id: "check-e2e", label: "Verify guard", completed: false, note: null }],
  };

  await page.route("**/api/work-orders/technician/wo-e2e?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          workOrder: detail,
          signer: { id: "tech-e2e", displayName: "Synthetic Technician" },
          completionSignature: null,
        },
      }),
    });
  });

  let executionBody: Record<string, unknown> | null = null;
  await page.route("**/api/work-orders/wo-e2e/execution", async (route) => {
    executionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { ...detail, completionNote: "Guard verified" } }),
    });
  });

  let transitionBody: Record<string, unknown> | null = null;
  await page.route("**/api/work-orders/wo-e2e", async (route) => {
    transitionBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { ...detail, status: "COMPLETED" } }),
    });
  });

  await page.goto("/maintenance/my-work");
  await expect(page.getByRole("heading", { name: "My work" })).toBeVisible();
  await page.getByRole("link", { name: /WO-E2E-001 · Inspect synthetic pump/ }).click();

  await expect(page.getByRole("heading", { name: "WO-E2E-001 · Inspect synthetic pump" })).toBeVisible();
  const blockButton = page.getByRole("button", { name: "Block work" });
  await expect(blockButton).toBeVisible();
  expect((await blockButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  const completeButton = page.getByRole("button", { name: "Complete and sign" });
  await expect(completeButton).toBeDisabled();
  await expect(page.getByTestId("signature-capture")).toContainText(
    "Authenticated signer: Synthetic Technician",
  );

  await page.getByRole("checkbox", { name: "Verify guard" }).check();
  await page.getByLabel("Note for Verify guard").fill("OK");
  await page.getByLabel("Labor minutes").fill("35");
  await page.getByLabel("Downtime minutes").fill("5");
  await page.getByLabel("Completion note").fill("Guard verified");
  await expect(completeButton).toBeDisabled();

  await page.getByLabel("Type your name to sign").fill("Wrong Technician");
  await expect(page.getByText("Typed signature must match Synthetic Technician.")).toBeVisible();
  await expect(completeButton).toBeDisabled();

  await page.getByLabel("Type your name to sign").fill("Synthetic Technician");
  const attestation = page.getByRole("checkbox", { name: /I confirm that the recorded work/ });
  await expect(attestation).toBeEnabled();
  await attestation.check();
  await expect(completeButton).toBeEnabled();
  await completeButton.click();

  await expect.poll(() => executionBody).toEqual({
    organizationId: "org-e2e",
    siteId: "site-e2e",
    laborMinutes: 35,
    downtimeMinutes: 5,
    completionNote: "Guard verified",
    checklistUpdates: [{ id: "check-e2e", completed: true, note: "OK" }],
  });
  await expect.poll(() => transitionBody).toEqual({
    organizationId: "org-e2e",
    siteId: "site-e2e",
    status: "COMPLETED",
    completionSignature: {
      signerName: "Synthetic Technician",
      attested: true,
    },
  });
});
