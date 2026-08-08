import { expect, test } from "@playwright/test";

test("personal dashboard renders safely without tenant context", async ({ page }) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page.getByText("My dashboard", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Your assigned maintenance work and document approvals in the selected site.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Select an organization and site to view your dashboard.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Operations dashboard", { exact: true })).toHaveCount(0);
});
