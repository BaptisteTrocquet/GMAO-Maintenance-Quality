export type ParsedAssetQrPayload = {
  assetId: string;
  href: string;
};

const QR_VERSION = 3;
const QR_SIZE = QR_VERSION * 4 + 17;
const QR_DATA_CODEWORDS = 55;
const QR_ECC_CODEWORDS = 15;
const QR_MAX_BYTE_LENGTH = 53;
const QR_QUIET_ZONE = 4;

export function buildAssetQrPayload(input: { assetId: string; origin?: string | null }) {
  const path = `/assets/${encodeURIComponent(input.assetId)}`;
  if (!input.origin) return path;
  return new URL(path, input.origin).toString();
}

export function parseAssetQrPayload(
  payload: string,
  expectedOrigin?: string | null,
): ParsedAssetQrPayload | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }

    if (expectedOrigin) {
      let origin: string;
      try {
        origin = new URL(expectedOrigin).origin;
      } catch {
        return null;
      }
      if (parsed.origin !== origin) return null;
    }
    if (parsed.search || parsed.hash) return null;
    pathname = parsed.pathname;
  }

  const match = /^\/assets\/([^/?#]+)\/?$/.exec(pathname);
  if (!match) return null;

  let assetId: string;
  try {
    assetId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!assetId || assetId.includes("/") || assetId.includes("\\")) return null;

  return {
    assetId,
    href: `/assets/${encodeURIComponent(assetId)}`,
  };
}

export function buildAssetLabelText(input: { code: string; name: string; assetId: string }) {
  return `${input.code} — ${input.name}\n${input.assetId}`;
}

function appendBits(target: number[], value: number, length: number) {
  for (let bit = length - 1; bit >= 0; bit -= 1) {
    target.push((value >>> bit) & 1);
  }
}

function gfMultiply(left: number, right: number) {
  let x = left;
  let y = right;
  let result = 0;
  for (let index = 0; index < 8; index += 1) {
    if (y & 1) result ^= x;
    y >>>= 1;
    const carry = x & 0x80;
    x = (x << 1) & 0xff;
    if (carry) x ^= 0x1d;
  }
  return result;
}

function reedSolomonGenerator(degree: number) {
  let generator = [1];
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    const next = Array(generator.length + 1).fill(0) as number[];
    for (let offset = 0; offset < generator.length; offset += 1) {
      next[offset] ^= generator[offset];
      next[offset + 1] ^= gfMultiply(generator[offset], root);
    }
    generator = next;
    root = gfMultiply(root, 2);
  }
  return generator;
}

function reedSolomonRemainder(data: number[], degree: number) {
  const generator = reedSolomonGenerator(degree);
  let remainder = Array(degree).fill(0) as number[];
  for (const value of data) {
    const factor = value ^ remainder[0];
    remainder = [...remainder.slice(1), 0];
    for (let index = 0; index < degree; index += 1) {
      remainder[index] ^= gfMultiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

function encodeQrData(payload: string) {
  const bytes = [...new TextEncoder().encode(payload)];
  if (bytes.length > QR_MAX_BYTE_LENGTH) {
    throw new Error(`Asset QR payload is too long; maximum is ${QR_MAX_BYTE_LENGTH} UTF-8 bytes`);
  }

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const capacity = QR_DATA_CODEWORDS * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let index = 0; index < terminator; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let offset = 0; offset < bits.length; offset += 8) {
    let value = 0;
    for (const bit of bits.slice(offset, offset + 8)) value = (value << 1) | bit;
    codewords.push(value);
  }

  const pads = [0xec, 0x11];
  for (let index = 0; codewords.length < QR_DATA_CODEWORDS; index += 1) {
    codewords.push(pads[index % pads.length]);
  }

  return [...codewords, ...reedSolomonRemainder(codewords, QR_ECC_CODEWORDS)];
}

function formatBits(mask: number) {
  const errorCorrectionLevel = 0b01; // QR error-correction level L.
  const data = (errorCorrectionLevel << 3) | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function buildQrMatrix(payload: string) {
  const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false) as boolean[]);
  const functionModules = Array.from(
    { length: QR_SIZE },
    () => Array(QR_SIZE).fill(false) as boolean[],
  );

  function setFunctionModule(x: number, y: number, dark: boolean) {
    if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) return;
    modules[y][x] = dark;
    functionModules[y][x] = true;
  }

  function drawFinderPattern(centerX: number, centerY: number) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunctionModule(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
      }
    }
  }

  drawFinderPattern(3, 3);
  drawFinderPattern(QR_SIZE - 4, 3);
  drawFinderPattern(3, QR_SIZE - 4);

  for (const centerY of [6, 22]) {
    for (const centerX of [6, 22]) {
      if (functionModules[centerY][centerX]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunctionModule(
            centerX + dx,
            centerY + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
        }
      }
    }
  }

  for (let index = 8; index < QR_SIZE - 8; index += 1) {
    setFunctionModule(6, index, index % 2 === 0);
    setFunctionModule(index, 6, index % 2 === 0);
  }

  const mask = 0;
  const format = formatBits(mask);
  for (let index = 0; index <= 5; index += 1) {
    setFunctionModule(8, index, ((format >>> index) & 1) !== 0);
  }
  setFunctionModule(8, 7, ((format >>> 6) & 1) !== 0);
  setFunctionModule(8, 8, ((format >>> 7) & 1) !== 0);
  setFunctionModule(7, 8, ((format >>> 8) & 1) !== 0);
  for (let index = 9; index < 15; index += 1) {
    setFunctionModule(14 - index, 8, ((format >>> index) & 1) !== 0);
  }
  for (let index = 0; index < 8; index += 1) {
    setFunctionModule(QR_SIZE - 1 - index, 8, ((format >>> index) & 1) !== 0);
  }
  for (let index = 8; index < 15; index += 1) {
    setFunctionModule(8, QR_SIZE - 15 + index, ((format >>> index) & 1) !== 0);
  }
  setFunctionModule(8, QR_SIZE - 8, true);

  const codewords = encodeQrData(payload);
  const dataBits: number[] = [];
  for (const codeword of codewords) appendBits(dataBits, codeword, 8);

  let bitIndex = 0;
  let right = QR_SIZE - 1;
  let upward = true;
  while (right >= 1) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const y = upward ? QR_SIZE - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (functionModules[y][x]) continue;
        const bit = bitIndex < dataBits.length ? dataBits[bitIndex] : 0;
        bitIndex += 1;
        const invert = (x + y) % 2 === 0;
        modules[y][x] = Boolean(bit ^ Number(invert));
      }
    }
    upward = !upward;
    right -= 2;
  }

  return modules;
}

export function buildAssetQrSvg(payload: string) {
  const matrix = buildQrMatrix(payload);
  const cells: string[] = [];
  for (let y = 0; y < QR_SIZE; y += 1) {
    for (let x = 0; x < QR_SIZE; x += 1) {
      if (matrix[y][x]) {
        cells.push(
          `<rect x="${x + QR_QUIET_ZONE}" y="${y + QR_QUIET_ZONE}" width="1" height="1"/>`,
        );
      }
    }
  }

  const viewBox = QR_SIZE + QR_QUIET_ZONE * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" role="img" aria-label="Asset QR code"><rect width="100%" height="100%" fill="white"/><g fill="black">${cells.join("")}</g></svg>`;
}
