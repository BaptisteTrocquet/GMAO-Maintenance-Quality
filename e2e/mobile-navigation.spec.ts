import { expect, test } from "@playwright/test";

test("mobile navigation replaces the desktop sidebar and supports keyboard dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  await expect(page.locator(".sidebar")).toBeHidden();
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(triggerBox?.width ?? 0).toBeGreaterThanOrEqual(44);

  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const drawer = page.getByRole("dialog", { name: "Mobile navigation" });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole("button", { name: "Close navigation" });
  await expect(close).toBeFocused();
  const assetsLink = drawer.getByRole("link", { name: "Assets", exact: true });
  const assetsBox = await assetsLink.boundingBox();
  expect(assetsBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(
    drawer.getByRole("navigation", { name: "Primary mobile navigation" }).getByRole("link", {
      name: "Dashboard",
    }),
  ).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await drawer.getByRole("link", { name: "Assets", exact: true }).click();
  await expect(page).toHaveURL(/\/assets$/);
  await expect(page.getByRole("dialog", { name: "Mobile navigation" })).toBeHidden();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("dialog", { name: "Mobile navigation" }).getByRole("link", {
      name: "Assets",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
});

test("desktop navigation remains available above the mobile breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");

  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});
