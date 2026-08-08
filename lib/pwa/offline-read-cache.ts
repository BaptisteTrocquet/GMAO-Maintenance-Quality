import { createHash } from "node:crypto";

export const OFFLINE_READ_PARTITION_HEADER = "x-opengmao-offline-partition";

export function offlineReadPartitionFromAuthorization(authorization: string | null | undefined) {
  if (!authorization?.startsWith("Bearer ")) return "";
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return "";

  return createHash("sha256")
    .update(`opengmao-offline-read:${token}`)
    .digest("hex")
    .slice(0, 32);
}
