import Link from "next/link";
import { requestPasswordResetAction } from "@/app/actions";

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <div className="min-h-screen grid place-items-center p-6" style={{ background: "var(--bg)" }}>
      <div className="w-full max-w-sm">
        <div className="font-display text-2xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>
        <h1 className="font-display text-xl font-semibold mt-4">Reset your password</h1>
        {sent ? (
          <div className="card p-4 mt-4 text-sm">
            If an account exists for that email, we&apos;ve sent a link to set a new password.
            The link expires in 48 hours.
            <div className="mt-3"><Link href="/login" className="btn btn-sm">Back to sign in</Link></div>
          </div>
        ) : (
          <>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Enter your email and we&apos;ll send a link to set a new password.
            </p>
            <form action={requestPasswordResetAction} className="mt-5 space-y-4">
              <label className="block">
                <span className="label">Email</span>
                <input name="email" type="email" required className="input" placeholder="you@example.org" />
              </label>
              <button type="submit" className="btn btn-primary w-full">Send reset link</button>
            </form>
            <div className="mt-4 text-sm"><Link href="/login" className="hover:underline" style={{ color: "var(--brand)" }}>Back to sign in</Link></div>
          </>
        )}
      </div>
    </div>
  );
}
