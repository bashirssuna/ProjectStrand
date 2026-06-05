import { NextRequest, NextResponse } from "next/server";
import { verifyEmailToken } from "@/server/services/accounts";
import { createSession } from "@/server/auth";

// Clicking the confirmation link in the signup email lands here: it activates
// the account, signs the user in, and sends them to their dashboard.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") || "";
  const base = req.nextUrl.origin;
  const res = await verifyEmailToken(token);
  if (!res) return NextResponse.redirect(`${base}/login?verify=invalid`);
  await createSession(res.userId);
  return NextResponse.redirect(`${base}/dashboard`);
}
