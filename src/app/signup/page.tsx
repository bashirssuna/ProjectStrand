import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { signupOrganizationAction } from "@/app/actions";
import { OPERATOR_NAME, CONTACT_EMAIL } from "@/lib/config";
import { CURRENCIES } from "@/lib/currencies";

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 90);

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string; pending?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error, pending } = await searchParams;
  const months = Math.round(TRIAL_DAYS / 30);

  return (
    <div className="min-h-screen grid place-items-center p-4 sm:p-6"
      style={{ background: "radial-gradient(140% 120% at 0% 0%, #15151d 0%, #0c0c11 55%, #0a0a0f 100%)" }}>
      <div className="w-full max-w-md">
        <div className="font-display text-xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>

        {pending ? (
          <div className="card p-6 mt-4">
            <h1 className="font-display text-2xl font-semibold">Check your email</h1>
            <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
              We&apos;ve sent a confirmation link to your email address. Click it to activate your account and
              sign in. The link expires in 48 hours.
            </p>
            <p className="text-sm mt-3" style={{ color: "var(--muted)" }}>
              Didn&apos;t get it? Check spam, or <Link href="/signup" className="hover:underline" style={{ color: "var(--brand)" }}>try again</Link>.
            </p>
          </div>
        ) : (
          <>
            <h1 className="font-display text-2xl font-semibold">Start your {months}-month free trial</h1>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Create your organisation workspace. You&apos;ll be its admin — invite your team, add PIs, and
              manage projects. No card required.
            </p>

            {error && (
              <div className="card p-3 mt-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>
            )}

            <form action={signupOrganizationAction} className="card p-5 mt-5 space-y-4">
              <label className="block">
                <span className="label">Organisation name</span>
                <input name="orgName" required className="input" placeholder="e.g. African Center for Health Research" />
              </label>
              <label className="block">
                <span className="label">Reporting currency</span>
                <select name="baseCurrency" defaultValue="USD" className="select">
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <span className="text-xs mt-1 block" style={{ color: "var(--muted)" }}>
                  Your organisation&apos;s main currency. You can change this and add exchange rates later.
                </span>
              </label>
              <label className="block">
                <span className="label">Your name</span>
                <input name="adminName" required className="input" placeholder="Full name" />
              </label>
              <label className="block">
                <span className="label">Work email</span>
                <input name="adminEmail" type="email" required className="input" placeholder="you@org.org" />
              </label>
              <label className="block">
                <span className="label">Password</span>
                <input name="password" type="password" required minLength={8} className="input" placeholder="Create a password" />
                <span className="text-xs mt-1 block" style={{ color: "var(--muted)" }}>
                  At least 8 characters, with one capital letter and one special character.
                </span>
              </label>
              <label className="block">
                <span className="label">Confirm password</span>
                <input name="confirmPassword" type="password" required minLength={8} className="input" placeholder="Re-enter your password" />
              </label>
              <button type="submit" className="btn btn-primary w-full">Create workspace &amp; start trial</button>
            </form>

            <div className="text-sm mt-4 text-center" style={{ color: "var(--muted)" }}>
              Already have an account? <Link href="/login" className="hover:underline" style={{ color: "var(--brand)" }}>Sign in</Link>
            </div>
          </>
        )}

        <div className="mt-6 pt-4 text-center text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
          © {new Date().getFullYear()} {OPERATOR_NAME}. All rights reserved.<br />
          Contact: <a href={`mailto:${CONTACT_EMAIL}`} className="hover:underline" style={{ color: "var(--brand)" }}>{CONTACT_EMAIL}</a>
        </div>
      </div>
    </div>
  );
}
