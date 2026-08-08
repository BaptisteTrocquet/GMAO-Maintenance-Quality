import { expect, test } from "@playwright/test";

test("command palette opens from keyboard and navigates with Enter", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const input = page.getByLabel("Search records or choose an action");
  await expect(input).toBeFocused();
  await expect(page.getByRole("option", { name: /Global search/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Work-order Kanban/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search$/);
});

test("command palette closes with Escape and restores opener focus", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: /Commands/ });
  await opener.focus();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect(opener).toBeFocused();
});

test("command palette traps tab navigation inside the dialog", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const closeButton = page.getByRole("button", { name: "Close command palette" });
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("option", { name: /Quality workspace/ })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
});
