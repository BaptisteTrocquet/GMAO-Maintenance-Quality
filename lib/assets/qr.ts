export function buildAssetQrPayload(input: { assetId: string; origin?: string | null }) {
  const path = `/assets/${encodeURIComponent(input.assetId)}`;
  if (!input.origin) return path;
  return new URL(path, input.origin).toString();
}

export function buildAssetLabelText(input: { code: string; name: string; assetId: string }) {
  return `${input.code} — ${input.name}\n${input.assetId}`;
}
