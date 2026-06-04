import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { requestUpgradeAction, signOut } from "@/app/actions";
import { CONTACT_EMAIL, OPERATOR_NAME } from "@/lib/config";

export default async function UpgradePage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const user = await requireUser();
  const { sent } = await searchParams;
  const org = user.isSuperAdmin ? null : await getUserOrg(user.id);

  // Platform admins don't have a tenant org; send them to the control center.
  if (user.isSuperAdmin) redirect("/admin");

  const ended = org?.plan === "trial" && org.trialEndsAt && new Date(org.trialEndsAt) < new Date();
  const suspended = org?.status === "suspended";
  const locked = ended || suspended;

  return (
    <div className="min-h-screen grid place-items-center p-6" style={{ background: "radial-gradient(140% 120% at 0% 0%, #15151d 0%, #0c0c11 55%, #0a0a0f 100%)" }}>
      <div className="w-full max-w-md">
        <div className="font-display text-xl font-semibold mb-1" style={{ color: "var(--brand)" }}>Project Strand</div>
        <div className="text-sm mb-5" style={{ color: "var(--muted)" }}>{org?.name}</div>

        <div className="card p-6">
          {sent ? (
            <>
              <h1 className="font-display text-xl font-semibold">Request received</h1>
              <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
                The administrator ({CONTACT_EMAIL}) has been notified and will activate or extend your
                plan shortly. <strong>Your data is preserved</strong> — nothing is deleted while you wait.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-display text-xl font-semibold">
                {locked ? (suspended ? "Account suspended" : "Your free trial has ended") : "Upgrade your plan"}
              </h1>
              <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
                {locked
                  ? "Access is paused until your plan is activated. Request an upgrade and the administrator will restore access — your projects, budgets and documents are all kept safe."
                  : "Request a paid plan or a trial extension. The administrator will action it without any loss of data."}
              </p>
              {org?.trialEndsAt && (
                <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
                  Trial end date: {new Date(org.trialEndsAt).toDateString()}
                </p>
              )}
              {org?.isOrgAdmin ? (
                <form action={requestUpgradeAction} className="mt-5">
                  <button type="submit" className="btn btn-primary w-full">Request upgrade</button>
                </form>
              ) : (
                <p className="text-sm mt-5" style={{ color: "var(--muted)" }}>
                  Please ask your organisation administrator to request an upgrade.
                </p>
              )}
            </>
          )}

          <div className="mt-5 pt-4 flex items-center justify-between text-sm" style={{ borderTop: "1px solid var(--border)" }}>
            {!locked ? <Link href="/dashboard" className="hover:underline" style={{ color: "var(--brand)" }}>← Back to app</Link> : <span style={{ color: "var(--muted)" }}>Locked</span>}
            <form action={signOut}><button className="hover:underline" style={{ color: "var(--muted)" }}>Sign out</button></form>
          </div>
        </div>

        <div className="text-center text-xs mt-6" style={{ color: "var(--muted)" }}>
          © {new Date().getFullYear()} {OPERATOR_NAME} · {CONTACT_EMAIL}
        </div>
      </div>
    </div>
  );
}
