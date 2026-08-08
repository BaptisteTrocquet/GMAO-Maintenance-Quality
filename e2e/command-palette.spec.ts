import { expect, test } from "@playwright/test";

test("command palette opens from keyboard and navigates with Enter", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  const input = page.getByRole("combobox", {
    name: "Search permitted records or choose an action",
  });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "true");

  const options = dialog.getByRole("option");
  const optionCount = await options.count();
  expect(optionCount).toBeGreaterThan(0);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");

  // Keep the pointer outside the command options so this test exercises keyboard selection only.
  await page.mouse.move(0, 0);
  await page.keyboard.press("End");
  await expect(options.nth(optionCount - 1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");

  // Exercise ArrowDown navigation without assuming a hard-coded quick-action order.
  const labels = await options.allTextContents();
  const kanbanIndex = labels.findIndex((label) => label.includes("Work-order Kanban"));
  expect(kanbanIndex).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < kanbanIndex; index += 1) {
    await page.keyboard.press("ArrowDown");
  }
  await expect(page.getByRole("option", { name: /Work-order Kanban/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Return to the first option and verify Enter still activates the selected action.
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search$/);
});

test("command palette closes with Escape and restores trigger focus", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Commands/ });
  await trigger.focus();

  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("command palette shortcut toggles closed and clears the previous query", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Commands/ });
  const dialog = page.getByRole("dialog", { name: "Command palette" });

  // Open through the hydrated button first. Keyboard opening itself is covered by the first test;
  // this scenario specifically verifies that the global shortcut toggles state and clears query data.
  await trigger.click();
  await expect(dialog).toBeVisible();
  const input = page.getByRole("combobox", {
    name: "Search permitted records or choose an action",
  });
  await input.fill("wo");

  await page.keyboard.press("Control+K");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Control+K");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("");
});
