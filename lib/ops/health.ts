import { db } from "@/lib/db";

export const READINESS_TIMEOUT_MS = 2_000;

export type ReadinessResult = {
  ready: boolean;
  database: "ok" | "unavailable";
};

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Readiness check timed out")), ms);
    timer.unref?.();
  });
}

export async function checkReadiness(input: { timeoutMs?: number } = {}): Promise<ReadinessResult> {
  const timeoutMs = input.timeoutMs ?? READINESS_TIMEOUT_MS;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      timeout(timeoutMs),
    ]);
    return { ready: true, database: "ok" };
  } catch {
    return { ready: false, database: "unavailable" };
  }
}
