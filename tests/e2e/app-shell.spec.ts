import { expect, test } from "@playwright/test";

test("loads the seeded dashboard and navigates to assets", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle(/OpenGMAO/);
  await expect(page.locator(".title")).toHaveText("Operations dashboard");
  await expect(page.getByText("Open work orders", { exact: true })).toBeVisible();
  await expect(page.getByText("Controlled documents", { exact: true })).toBeVisible();
  await expect(page.getByText("Active PM plans", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();

  await page.getByRole("link", { name: "Assets", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.locator(".title")).toHaveText("Assets");
  await expect(page.locator("tbody tr").first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});
