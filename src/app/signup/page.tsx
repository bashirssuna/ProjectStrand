import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { signupOrganizationAction } from "@/app/actions";
import { OPERATOR_NAME, CONTACT_EMAIL } from "@/lib/config";

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 90);

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  const months = Math.round(TRIAL_DAYS / 30);

  return (
    <div className="min-h-screen grid place-items-center p-4 sm:p-6"
      style={{ background: "radial-gradient(140% 120% at 0% 0%, #15151d 0%, #0c0c11 55%, #0a0a0f 100%)" }}>
      <div className="w-full max-w-md">
        <div className="font-display text-xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>
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
            <span className="label">Your name</span>
            <input name="adminName" required className="input" placeholder="Full name" />
          </label>
          <label className="block">
            <span className="label">Work email</span>
            <input name="adminEmail" type="email" required className="input" placeholder="you@org.org" />
          </label>
          <label className="block">
            <span className="label">Password</span>
            <input name="password" type="password" required minLength={8} className="input" placeholder="At least 8 characters" />
          </label>
          <button type="submit" className="btn btn-primary w-full">Create workspace &amp; start trial</button>
        </form>

        <div className="text-sm mt-4 text-center" style={{ color: "var(--muted)" }}>
          Already have an account? <Link href="/login" className="hover:underline" style={{ color: "var(--brand)" }}>Sign in</Link>
        </div>

        <div className="mt-6 pt-4 text-center text-xs" style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
          © {new Date().getFullYear()} {OPERATOR_NAME}. All rights reserved.<br />
          Contact: <a href={`mailto:${CONTACT_EMAIL}`} className="hover:underline" style={{ color: "var(--brand)" }}>{CONTACT_EMAIL}</a>
        </div>
      </div>
    </div>
  );
}
