import "server-only";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

// In-memory fixed-window limiter behind the RateLimiter interface, so
// swapping to Upstash's Redis-backed limiter later is a one-file change.
//
// Known gap: these counters live in process memory. They don't persist or
// stay consistent across multiple server instances/serverless function
// invocations. Fine for local dev and a single-process deployment — flagged
// here as the thing to close before any multi-instance production deploy.
class InMemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    this.sweep(now);

    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return { success: true, remaining: this.limit - 1, resetAt: now + this.windowMs };
    }

    entry.count += 1;
    const resetAt = entry.windowStart + this.windowMs;
    if (entry.count > this.limit) {
      return { success: false, remaining: 0, resetAt };
    }
    return { success: true, remaining: this.limit - entry.count, resetAt };
  }

  private sweep(now: number) {
    if (this.hits.size < 5000) return;
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

// 5 attempts per IP per 15 minutes on the login route.
export const loginRateLimiter: RateLimiter = new InMemoryRateLimiter(
  5,
  15 * 60 * 1000
);

// Same shape, applied to password-reset requests so the email-sending path
// can't be used to spam an inbox or enumerate accounts by timing.
export const resetRequestRateLimiter: RateLimiter = new InMemoryRateLimiter(
  5,
  15 * 60 * 1000
);

export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
