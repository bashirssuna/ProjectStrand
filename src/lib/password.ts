import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Plain module (no "server-only") so it can be used by the seed script too.
export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(pw: string, stored?: string | null): boolean {
  if (!stored) return false;
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const candidate = scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, "hex");
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}
