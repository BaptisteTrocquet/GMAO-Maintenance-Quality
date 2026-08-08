import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";

test("mobile work order supports camera capture preview and photo upload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/maintenance");
  await page.getByRole("link", { name: "WO-000001", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();

  const takePhoto = page.getByRole("button", { name: "Take photo" });
  const chooseImage = page.getByRole("button", { name: "Choose image" });
  await expect(takePhoto).toBeVisible();
  await expect(chooseImage).toBeVisible();
  expect((await takePhoto.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  const cameraInput = page.getByLabel("Take work order photo");
  await expect(cameraInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
  await expect(cameraInput).toHaveAttribute("capture", "environment");

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
  const fileChooserPromise = page.waitForEvent("filechooser");
  await takePhoto.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({ name: "field-photo.jpg", mimeType: "image/jpeg", buffer: jpeg });

  await expect(page.getByAltText("Selected work order attachment preview")).toBeVisible();
  await expect(page.getByText(/field-photo\.jpg is ready to upload/i)).toBeVisible();

  let uploadUrl = "";
  let uploadContentType = "";
  await page.route("**/api/work-orders/**/attachments/upload?**", async (route) => {
    uploadUrl = route.request().url();
    uploadContentType = route.request().headers()["content-type"] ?? "";
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { id: "photo-e2e", fileName: "field-photo.jpg" } }),
    });
  });

  await page.getByRole("button", { name: "Upload photo" }).click();
  await expect(page.getByText(/field-photo\.jpg was added to this work order/i)).toBeVisible();
  await expect.poll(() => uploadUrl).toContain("/attachments/upload?");
  expect(uploadUrl).toContain("organizationId=");
  expect(uploadUrl).toContain("siteId=");
  expect(uploadContentType).toContain("multipart/form-data");
});
