import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createHmac } from "node:crypto";
import { one } from "@/server/db";
import { hashPassword, verifyPassword } from "@/lib/password";

const SECRET = process.env.AUTH_SECRET || "dev-secret-change-me";
const COOKIE = "strand_session";

export { hashPassword, verifyPassword };

function sign(value: string): string {
  return createHmac("sha256", SECRET).update(value).digest("hex");
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
  id: string; email: string; name: string; isSuperAdmin: boolean;
};

export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (sign(payload) !== sig) return null;
  const userId = payload.split(".")[0];
  return one<SessionUser>(
    `SELECT id, email, name, is_super_admin AS "isSuperAdmin"
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
