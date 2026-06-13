import Link from "next/link";
import { setPasswordAction } from "@/app/actions";
import { consumePasswordToken } from "@/server/services/accounts";

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  const valid = token ? await consumePasswordToken(token) : null;

  return (
    <div className="min-h-screen grid place-items-center p-6" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm">
        <div className="font-display text-2xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>
        <h1 className="font-display text-xl font-semibold mt-4">Set your password</h1>

        {!token || !valid ? (
          <div className="card p-4 mt-4 text-sm">
            This link is invalid or has expired.
            <div className="mt-3"><Link href="/forgot" className="btn btn-sm">Request a new link</Link></div>
          </div>
        ) : (
          <>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>Setting a password for <strong>{valid.email}</strong>.</p>
            {error && <div className="card p-3 mt-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error === "short" ? "Password must be at least 8 characters." : error === "match" ? "Passwords don't match." : error === "invalid" ? "This link is invalid or has expired." : error === "policy" ? "Password must be at least 8 characters and include one capital letter and one special character." : "Please check your password and try again."}</div>}
            <form action={setPasswordAction} className="mt-5 space-y-4">
              <input type="hidden" name="token" value={token} />
              <label className="block">
                <span className="label">New password</span>
                <input name="password" type="password" required minLength={8} className="input" placeholder="Create a password" />
                <span className="text-xs mt-1 block" style={{ color: "var(--muted)" }}>At least 8 characters, one capital letter and one special character.</span>
              </label>
              <label className="block">
                <span className="label">Confirm password</span>
                <input name="confirmPassword" type="password" required minLength={8} className="input" placeholder="Re-enter your password" />
              </label>
              <button type="submit" className="btn btn-primary w-full">Set password &amp; sign in</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
