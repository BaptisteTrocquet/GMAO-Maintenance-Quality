import { expect, test } from "@playwright/test";

test("command palette opens from keyboard and navigates with Enter", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  const trigger = page.getByRole("button", { name: /Commands/ });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const input = page.getByLabel("Search permitted records or choose an action");
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

test("command palette closes with Escape and restores trigger focus", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  const trigger = page.getByRole("button", { name: /Commands/ });
  await trigger.focus();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect(trigger).toBeFocused();
});
