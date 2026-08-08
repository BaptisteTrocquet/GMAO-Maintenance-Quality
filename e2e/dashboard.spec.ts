import { expect, test } from "@playwright/test";

test("seeded operations dashboard renders through Next and PostgreSQL", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page.getByText("Operations dashboard", { exact: true })).toBeVisible();
  await expect(page.getByText("Maintenance and controlled documents in one place.", { exact: true })).toBeVisible();
  await expect(page.getByText("Current work", { exact: true })).toBeVisible();
  await expect(page.locator("table.table")).toBeVisible();
});
