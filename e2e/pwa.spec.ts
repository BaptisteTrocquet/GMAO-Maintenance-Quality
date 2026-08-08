import { expect, test } from "@playwright/test";

test("publishes an installable manifest and registers the root service worker", async ({ page, request }) => {
  await page.goto("/");

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
  };
  expect(manifest).toMatchObject({
    name: "OpenGMAO",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: "/icons/pwa-192.svg", sizes: "192x192" }),
      expect.objectContaining({ src: "/icons/pwa-512.svg", sizes: "512x512" }),
    ]),
  );

  const workerResponse = await request.get("/sw.js");
  expect(workerResponse.ok()).toBe(true);
  expect(await workerResponse.text()).toContain('self.addEventListener("install"');

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!("serviceWorker" in navigator)) return false;
          return Boolean(await navigator.serviceWorker.getRegistration("/"));
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
});
