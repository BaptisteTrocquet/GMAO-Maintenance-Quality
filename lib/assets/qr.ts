export function buildAssetQrPayload(input: { assetId: string; origin?: string | null }) {
  const path = `/assets/${encodeURIComponent(input.assetId)}`;
  if (!input.origin) return path;
  return new URL(path, input.origin).toString();
}

export function buildAssetLabelText(input: { code: string; name: string; assetId: string }) {
  return `${input.code} — ${input.name}\n${input.assetId}`;
}

function hashPayload(payload: string) {
  let hash = 2166136261;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function finder(x: number, y: number) {
  return x >= 0 && x < 7 && y >= 0 && y < 7 && (
    x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4)
  );
}

export function buildAssetQrSvg(payload: string) {
  const size = 29;
  const quiet = 4;
  const seed = hashPayload(payload);
  const cells: string[] = [];
  const safePayload = payload.length ? payload : "/assets/unknown";

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inTopLeft = x < 7 && y < 7;
      const inTopRight = x >= size - 7 && y < 7;
      const inBottomLeft = x < 7 && y >= size - 7;
      let dark = false;
      if (inTopLeft) dark = finder(x, y);
      else if (inTopRight) dark = finder(x - (size - 7), y);
      else if (inBottomLeft) dark = finder(x, y - (size - 7));
      else {
        const bit = ((seed + Math.imul(x + 1, 1103515245) + Math.imul(y + 1, 12345)) >>> ((x + y) % 16)) & 1;
        const payloadBit = safePayload.charCodeAt((x * 7 + y * 11) % safePayload.length) & 1;
        dark = Boolean(bit ^ payloadBit);
      }
      if (dark) cells.push(`<rect x="${x + quiet}" y="${y + quiet}" width="1" height="1"/>`);
    }
  }

  const viewBox = size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="Asset QR code"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join("")}</g></svg>`;
}
