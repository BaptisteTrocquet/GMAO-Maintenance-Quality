import { NextResponse, type NextRequest } from "next/server";
import {
  FixedWindowRateLimiter,
  applyRateLimitHeaders,
  classifyRateLimitRequest,
  rateLimitForBucket,
  readRateLimitConfig,
  resolveRateLimitClient,
} from "@/lib/rate-limit";

const limiter = new FixedWindowRateLimiter();

export function middleware(request: NextRequest) {
  const rateLimitConfig = readRateLimitConfig();
  if (!rateLimitConfig.enabled) return NextResponse.next();

  const bucket = classifyRateLimitRequest(request.nextUrl.pathname, request.method);
  if (!bucket) return NextResponse.next();

  const directAddress = (request as NextRequest & { ip?: string }).ip ?? null;
  const client = resolveRateLimitClient({
    headers: request.headers,
    directAddress,
    trustedProxyHops: rateLimitConfig.trustedProxyHops,
  });
  const decision = limiter.check({
    key: `${bucket}:${client}`,
    limit: rateLimitForBucket(rateLimitConfig, bucket),
    windowMs: rateLimitConfig.windowMs,
    maxKeys: rateLimitConfig.maxKeys,
  });

  if (decision.allowed) {
    const response = NextResponse.next();
    applyRateLimitHeaders(response.headers, decision);
    return response;
  }

  const response = NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Retry after the indicated delay.",
      },
    },
    { status: 429 },
  );
  response.headers.set("Cache-Control", "no-store");
  applyRateLimitHeaders(response.headers, decision);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
