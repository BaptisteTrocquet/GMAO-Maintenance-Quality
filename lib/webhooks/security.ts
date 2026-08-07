import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class WebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigurationError";
  }
}

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTargetError";
  }
}

function masterSecret() {
  const secret = process.env.WEBHOOK_SIGNING_MASTER_SECRET;
  if (!secret || secret.length < 32) {
    throw new WebhookConfigurationError(
      "WEBHOOK_SIGNING_MASTER_SECRET must contain at least 32 characters",
    );
  }
  return secret;
}

export function deriveWebhookSigningSecret(subscriptionId: string) {
  const digest = createHmac("sha256", masterSecret())
    .update(`opengmao:webhook:${subscriptionId}`)
    .digest("base64url");
  return `whsec_${digest}`;
}

export function signWebhookPayload(input: {
  subscriptionId: string;
  timestamp: string;
  body: string;
}) {
  return createHmac("sha256", deriveWebhookSigningSecret(input.subscriptionId))
    .update(`${input.timestamp}.${input.body}`)
    .digest("hex");
}

function blockedIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

function blockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 ? blockedIpv4(mapped) : true;
  }
  return false;
}

export function isPublicWebhookIp(address: string) {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4(address);
  if (family === 6) return !blockedIpv6(address);
  return false;
}

export function normalizeWebhookUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new WebhookTargetError("Webhook endpoints must use HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new WebhookTargetError("Webhook endpoints cannot include credentials or fragments");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new WebhookTargetError("Webhook hostname is not allowed");
  }
  if (isIP(hostname) && !isPublicWebhookIp(hostname)) {
    throw new WebhookTargetError("Webhook endpoint cannot use a private or reserved IP address");
  }
  return url;
}

export async function resolvePublicWebhookTarget(value: string) {
  const url = normalizeWebhookUrl(value);
  if (isIP(url.hostname)) {
    return { url, address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicWebhookIp(entry.address))) {
    throw new WebhookTargetError(
      "Webhook hostname must resolve exclusively to public IP addresses",
    );
  }

  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new WebhookTargetError("Webhook hostname did not resolve to a supported IP address");
  }
  return { url, address: selected.address, family: selected.family };
}
