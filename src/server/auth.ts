import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac, timingSafeEqual } from "node:crypto";
import { one } from "@/server/db";
import { hashPassword, verifyPassword } from "@/lib/password";

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const COOKIE = "strand_session";
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 days — must match the cookie maxAge below

export { hashPassword, verifyPassword };

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
}

// Constant-time comparison of two hex signatures (avoids timing side-channels).
function sigEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export async function createSession(userId: string): Promise<void> {
  const payload = `${userId}.${Date.now()}`;
  const token = `${payload}.${sign(payload)}`;
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}

export async function destroySession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export type SessionUser = {
  id: string; email: string; name: string; isSuperAdmin: boolean; isStaff: boolean; isCollaborator: boolean;
};

export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!sigEqual(sign(payload), sig)) return null;
  const [userId, issuedAtStr] = payload.split(".");
  // Enforce expiry server-side too: a captured token must not outlive the window
  // even if the cookie's own maxAge is bypassed. Reject malformed/expired stamps.
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;
  return one<SessionUser>(
    `SELECT id, email, name, is_super_admin AS "isSuperAdmin", COALESCE(is_staff, false) AS "isStaff",
            COALESCE(is_collaborator, false) AS "isCollaborator"
     FROM app_user WHERE id = $1 AND status = 'active'`,
    [userId]
  );
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getCurrentUser();
  // Not logged in (or session expired): send them to the login page rather than
  // throwing a server error. This also covers invited users whose link expired.
  if (!u) redirect("/login");
  return u;
}
