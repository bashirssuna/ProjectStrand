// Lightweight in-process rate limiter for authentication attempts.
//
// This lives in memory, so it protects a single running instance — which is the
// deployment shape on Render's free tier. If you scale to multiple instances or
// want lockouts to survive a restart, back this with the database or Redis
// (keep the same check/record/clear interface).
//
// Policy: after MAX_ATTEMPTS failures within WINDOW_MS for a given key, the key
// is blocked for BLOCK_MS. A successful login clears the key.

type Bucket = { count: number; first: number; blockedUntil: number };

const buckets = new Map<string, Bucket>();

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_MS = 15 * 60 * 1000; // 15 minutes

// Returns the remaining lockout in whole seconds (0 = not blocked).
export function loginBlockedSeconds(key: string, now: number): number {
  const b = buckets.get(key);
  if (!b) return 0;
  if (b.blockedUntil > now) return Math.ceil((b.blockedUntil - now) / 1000);
  return 0;
}

export function recordLoginFailure(key: string, now: number): void {
  let b = buckets.get(key);
  if (!b || now - b.first > WINDOW_MS) {
    b = { count: 0, first: now, blockedUntil: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count >= MAX_ATTEMPTS) b.blockedUntil = now + BLOCK_MS;
  // Opportunistic cleanup so the map can't grow without bound.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.blockedUntil < now && now - v.first > WINDOW_MS) buckets.delete(k);
    }
  }
}

export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}
