import { expect, test } from "@playwright/test";

test("mobile asset QR scanner exposes camera and a validated manual fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setExtraHTTPHeaders({
    "x-organization-id": "org-e2e",
    "x-site-id": "site-e2e",
  });

  let requestBody: unknown;
  await page.route("**/api/assets/scan", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          asset: { id: "asset-e2e", code: "A-E2E", name: "Synthetic asset" },
          href: "/assets/asset-e2e",
        },
      }),
    });
  });

  const response = await page.goto("/assets/scan");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Scan asset QR" })).toBeVisible();

  const start = page.getByRole("button", { name: "Start camera" });
  await expect(start).toBeVisible();
  const startBox = await start.boundingBox();
  expect(startBox?.height ?? 0).toBeGreaterThanOrEqual(44);

  const manual = page.getByLabel("Asset QR route or URL");
  await expect(manual).toBeVisible();
  await manual.fill("/assets/asset-e2e");
  await page.getByRole("button", { name: "Open asset" }).click();

  await expect.poll(() => requestBody).toEqual({
    organizationId: "org-e2e",
    siteId: "site-e2e",
    payload: "/assets/asset-e2e",
  });
  await expect(page).toHaveURL(/\/assets\/asset-e2e$/);
});

test("mobile navigation exposes Scan QR and marks the scanner route active", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/assets/scan");

  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Mobile navigation" });
  const scanLink = drawer.getByRole("link", { name: "Scan QR", exact: true });
  await expect(scanLink).toBeVisible();
  await expect(scanLink).toHaveAttribute("aria-current", "page");
});
