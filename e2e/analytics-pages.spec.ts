import { expect, test } from "@playwright/test";

test("backlog and PM compliance analytics coexist after sequential E9 merges", async ({ page }) => {
  let response = await page.goto("/analytics/backlog");
  expect(response?.ok()).toBe(true);
  await expect(page.getByText("Backlog analytics", { exact: true })).toBeVisible();

  response = await page.goto("/analytics/pm-compliance");
  expect(response?.ok()).toBe(true);
  await expect(page.getByText("PM compliance", { exact: true })).toBeVisible();
  await expect(page.getByText("Select an organization and site to view PM compliance.")).toBeVisible();
});
