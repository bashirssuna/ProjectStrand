import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { signIn } from "@/app/actions";

const DEMO: [string, string][] = [
  ["admin@strand.dev", "Platform admin"],
  ["pi@strand.dev", "Principal Investigator"],
  ["pm@strand.dev", "Project Manager"],
  ["finance@strand.dev", "Finance Admin"],
  ["coord@strand.dev", "Coordinator"],
  ["assistant@strand.dev", "Assistant"],
];

const FEATURES: [string, string][] = [
  ["Plan", "Work plan, Gantt & logframe"],
  ["Fund", "Budgets, requisitions & e-signatures"],
  ["Assure", "Auto-flags for overspend & wrong-line charges"],
  ["Report", "Donor reports from live data → Word"],
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <div className="min-h-screen grid place-items-center p-4 sm:p-6"
      style={{ background: "radial-gradient(140% 120% at 0% 0%, #15151d 0%, #0c0c11 55%, #0a0a0f 100%)" }}>
      <div className="w-full max-w-5xl grid lg:grid-cols-2 rounded-2xl overflow-hidden"
        style={{ border: "1px solid var(--border)", boxShadow: "0 24px 70px rgba(0,0,0,0.55)" }}>

        {/* ---------- Hero ---------- */}
        <div className="relative hidden lg:flex flex-col justify-between p-10"
          style={{ background: "radial-gradient(120% 120% at 0% 0%, #20202c 0%, #15151d 50%, #101016 100%)", color: "#e8e8ec" }}>
          <div className="absolute inset-0 opacity-[0.05]"
            style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "28px 28px" }} />

          <div className="relative z-10 font-display text-xl font-semibold tracking-tight">Project Strand</div>

          <div className="relative z-10 my-6">
            <h1 className="font-display text-3xl xl:text-4xl leading-[1.1] font-semibold tracking-tight">
              From proposal to final report, one disciplined workspace.
            </h1>
            <p className="mt-4 text-sm leading-relaxed" style={{ color: "rgba(232,232,236,.72)" }}>
              Plan the work, track the budget, route requisitions for signature, and catch the
              inconsistencies that quietly sink grants — schedule slippage, overspend, wrong-line charges.
            </p>

            <div className="mt-6 rounded-xl p-3.5" style={{ background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.10)" }}>
              <div className="grid grid-cols-3 gap-2.5 mb-3">
                {[["Budget burn", "62%"], ["On track", "78%"], ["To sign", "3"]].map(([k, v]) => (
                  <div key={k} className="rounded-lg px-2.5 py-1.5" style={{ background: "rgba(255,255,255,.06)" }}>
                    <div className="text-[9px] uppercase tracking-wide" style={{ color: "rgba(232,232,236,.6)" }}>{k}</div>
                    <div className="font-display text-base font-semibold">{v}</div>
                  </div>
                ))}
              </div>
              <svg viewBox="0 0 360 76" className="w-full" role="img" aria-label="Gantt preview">
                {[
                  [6, "Baseline survey", 70, 95, "#d4a853"],
                  [25, "Seed procurement", 95, 120, "#e0bd72"],
                  [44, "Water pans", 130, 150, "#6b7fa3"],
                  [63, "Field schools", 165, 120, "#c4844b"],
                ].map(([y, lbl, x, w, color], i) => (
                  <g key={i}>
                    <text x={0} y={(y as number) + 8} fontSize="8" fill="rgba(232,232,236,.7)">{lbl as string}</text>
                    <rect x={x as number} y={y as number} width={w as number} height="10" rx="3" fill={color as string} opacity="0.9" />
                  </g>
                ))}
                <line x1="215" y1="2" x2="215" y2="76" stroke="#fff" strokeOpacity="0.45" strokeDasharray="3 3" />
              </svg>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3">
              {FEATURES.map(([t, d]) => (
                <div key={t} className="flex gap-2">
                  <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full grid place-items-center text-[10px]" style={{ background: "rgba(212,168,83,.18)", color: "#d4a853" }}>✓</span>
                  <div>
                    <div className="text-[13px] font-semibold">{t}</div>
                    <div className="text-[11px] leading-snug" style={{ color: "rgba(232,232,236,.6)" }}>{d}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 text-[11px]" style={{ color: "rgba(232,232,236,.5)" }}>
            Climate-resilient agriculture · Public health · Research consortia
          </div>
        </div>

        {/* ---------- Sign in ---------- */}
        <div className="flex items-center justify-center p-8 sm:p-10" style={{ background: "var(--panel)" }}>
          <div className="w-full max-w-sm">
            <div className="font-display text-lg font-semibold mb-5 lg:hidden" style={{ color: "var(--brand)" }}>Project Strand</div>
            <div className="font-display text-sm font-semibold mb-1 hidden lg:block" style={{ color: "var(--brand)" }}>Project Strand</div>
            <h2 className="font-display text-2xl font-semibold">Sign in</h2>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Use a demo account — password is <code className="font-mono">password123</code>.
            </p>

            {error && (
              <div className="mt-4 card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
                Incorrect email or password.
              </div>
            )}

            <form action={signIn} className="mt-5 space-y-4">
              <label className="block">
                <span className="label">Email</span>
                <input name="email" type="email" required defaultValue="pm@strand.dev" className="input" />
              </label>
              <label className="block">
                <span className="label">Password</span>
                <input name="password" type="password" required defaultValue="password123" className="input" />
              </label>
              <button type="submit" className="btn btn-primary w-full">Sign in</button>
              <div className="text-center">
                <Link href="/forgot" className="text-xs hover:underline" style={{ color: "var(--brand)" }}>Forgot your password?</Link>
              </div>
            </form>

            <div className="mt-6">
              <div className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: "var(--muted)" }}>Demo accounts</div>
              <div className="grid grid-cols-2 gap-2">
                {DEMO.map(([email, role]) => (
                  <div key={email} className="rounded-lg px-2.5 py-1.5" style={{ border: "1px solid var(--border)" }}>
                    <code className="font-mono text-[11px] block truncate">{email}</code>
                    <span className="text-[11px]" style={{ color: "var(--muted)" }}>{role}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-5 pt-4 text-center text-sm" style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}>
              New organisation? <Link href="/signup" className="hover:underline" style={{ color: "var(--brand)" }}>Start a free trial</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
