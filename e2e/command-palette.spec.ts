import { expect, test } from "@playwright/test";

test("opens command palette with keyboard and activates selected action", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const input = page.getByLabel("Search records or choose an action");
  await expect(input).toBeFocused();

  const firstOption = dialog.getByRole("option").first();
  await expect(firstOption).toHaveAttribute("aria-selected", "true");
  await expect(firstOption).toContainText("Global search");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search$/);
});

test("closes command palette with Escape", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
