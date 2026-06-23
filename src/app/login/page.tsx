import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { signIn } from "@/app/actions";
import { OPERATOR_NAME, CONTACT_EMAIL } from "@/lib/config";

// Institutional Management System login. Each demo card is its own form that
// signs in directly (all demo accounts share password "password123"), so a click
// lands you straight in that role — no typing.
const DEMO = [
  { email: "admin@strand.dev", role: "Platform Admin", initials: "PA", tint: "#a87d2e" },
  { email: "pi@strand.dev", role: "Research Management Head", initials: "RM", tint: "#8a5a78" },
  { email: "pm@strand.dev", role: "Project Management Lead", initials: "PM", tint: "#4f6b8f" },
  { email: "finance@strand.dev", role: "Finance Director", initials: "FD", tint: "#3f7a55" },
  { email: "coord@strand.dev", role: "Procurement Coordinator", initials: "PC", tint: "#b06a3c" },
  { email: "assistant@strand.dev", role: "HR Specialist", initials: "HS", tint: "#5a6b7a" },
];

const MODULES: { title: string; desc: string; icon: React.ReactNode }[] = [
  {
    title: "Accounts & Finance", desc: "Ledgers, budgeting, general journal, and reports.",
    icon: (<><ellipse cx="10" cy="6" rx="6" ry="2.4" /><path d="M4 6v4c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V6" /><path d="M4 10v4c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4v-4" /></>),
  },
  {
    title: "HR", desc: "Recruitment, payroll, and performance appraisals.",
    icon: (<><circle cx="7" cy="7" r="2.4" /><circle cx="14" cy="8" r="2" /><path d="M3 16c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8" /><path d="M12.6 12.3c1.7-.3 3.9.8 3.9 3.7" /></>),
  },
  {
    title: "Project Management", desc: "Track milestones, resource allocation, and Gantt charts.",
    icon: (<><path d="M4 4v12M4 16h12" /><path d="M6 7h5" strokeWidth="2" /><path d="M6 10h8" strokeWidth="2" /><path d="M6 13h4" strokeWidth="2" /></>),
  },
  {
    title: "Procurement", desc: "Requisitions, vendor management, and purchase orders.",
    icon: (<><circle cx="8" cy="16" r="1.2" /><circle cx="14" cy="16" r="1.2" /><path d="M3 4h2l1.8 8.2h8.4L17 7H6" /></>),
  },
  {
    title: "Research Management", desc: "Grant tracking, ethics reviews, and publications.",
    icon: (<><path d="M8 3v5l-3.6 6.4A1.5 1.5 0 005.7 17h8.6a1.5 1.5 0 001.3-2.6L12 8V3" /><path d="M7 3h6" /><path d="M6.6 12.5h6.8" /></>),
  },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <div className="min-h-screen grid place-items-center p-4 sm:p-6"
      style={{ background: "radial-gradient(120% 110% at 15% 0%, #1c2536 0%, #0f1422 55%, #090c14 100%)" }}>
      <div className="w-full max-w-5xl flex flex-col lg:flex-row rounded-2xl overflow-hidden shadow-2xl"
        style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.6)" }}>

        {/* ───────────── Left: informational ───────────── */}
        <div className="relative hidden lg:flex lg:w-1/2 flex-col justify-between p-12 bg-slate-900 text-white overflow-hidden">
          <div className="absolute inset-0 opacity-[0.04] pointer-events-none"
            style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "30px 30px" }} />
          <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(212,168,83,0.16), transparent 70%)" }} />

          <div className="relative z-10">
            <div className="text-sm font-bold tracking-tight">Project Strand</div>
            <div className="text-base text-slate-300">Institutional Management System</div>

            <h1 className="font-serif text-3xl xl:text-[2.5rem] leading-[1.12] font-medium mt-8">
              Integrate and empower every department with one comprehensive institutional workspace.
            </h1>
            <p className="mt-5 text-sm leading-relaxed text-gray-300 max-w-md">
              A unified platform to manage finances, streamline projects, oversee research, empower HR, and
              coordinate procurement. Ensure compliance, efficiency, and data-driven decisions.
            </p>

            <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5">
              {MODULES.map((m) => (
                <div key={m.title} className="flex gap-3">
                  <svg viewBox="0 0 20 20" width="22" height="22" fill="none" stroke="#d4a853" strokeWidth="1.4"
                    strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">{m.icon}</svg>
                  <div>
                    <div className="text-[13px] font-semibold leading-tight">{m.title}</div>
                    <div className="text-[11px] leading-snug text-slate-400 mt-0.5">{m.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* data-visualization flourish */}
            <div className="mt-9 rounded-xl px-4 pt-3 pb-2"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <svg viewBox="0 0 320 100" className="w-full" role="img" aria-label="Institutional activity overview">
                <defs>
                  <linearGradient id="gGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#d4a853" stopOpacity="0.42" />
                    <stop offset="100%" stopColor="#d4a853" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6b87b3" stopOpacity="0.30" />
                    <stop offset="100%" stopColor="#6b87b3" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* blue line + area */}
                <path d="M0,82 C50,72 80,58 120,64 S200,84 250,66 S310,57 320,61 L320,100 L0,100 Z" fill="url(#gBlue)" />
                <path d="M0,82 C50,72 80,58 120,64 S200,84 250,66 S310,57 320,61" fill="none" stroke="#6b87b3" strokeWidth="1.6" opacity="0.85" />
                {/* gold line + area */}
                <path d="M0,68 C40,40 72,30 110,46 S192,76 232,50 S300,22 320,36 L320,100 L0,100 Z" fill="url(#gGold)" />
                <path d="M0,68 C40,40 72,30 110,46 S192,76 232,50 S300,22 320,36" fill="none" stroke="#d4a853" strokeWidth="1.8" />
                {/* nodes */}
                {[[72, 30, "28.5%"], [192, 64, "16.6%"], [292, 26, "22.0%"]].map(([x, y, v], i) => (
                  <g key={i}>
                    <circle cx={x as number} cy={y as number} r="3" fill="#0f1422" stroke="#d4a853" strokeWidth="1.6" />
                    <rect x={(x as number) - 16} y={(y as number) - 19} width="32" height="13" rx="3" fill="rgba(255,255,255,0.08)" />
                    <text x={x as number} y={(y as number) - 9} fontSize="8" fill="#e8e8ec" textAnchor="middle">{v as string}</text>
                  </g>
                ))}
              </svg>
            </div>
          </div>

          <div className="relative z-10 text-[11px] text-slate-500 mt-8">
            Climate-resilient agriculture • Public health • Research consortia, and other critical research fields.
          </div>
        </div>

        {/* ───────────── Right: sign in ───────────── */}
        <div className="lg:w-1/2 p-8 sm:p-12 bg-stone-50 text-slate-900">
          <div className="lg:hidden mb-6">
            <div className="text-sm font-bold tracking-tight" style={{ color: "var(--brand)" }}>Project Strand</div>
            <div className="text-sm text-slate-500">Institutional Management System</div>
          </div>

          <h2 className="font-serif text-3xl font-medium">Sign in</h2>
          <p className="text-sm text-slate-500 mt-1">Use a pre-configured demo account below:</p>

          {error && (
            <div className="mt-4 rounded-lg px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200">
              Incorrect email or password.
            </div>
          )}

          <form action={signIn} className="mt-6 space-y-4">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Email</span>
              <input name="email" type="email" required defaultValue="pm@strand.dev"
                className="mt-1.5 w-full rounded-full bg-slate-800 text-white placeholder-slate-400 px-5 py-3 text-sm border border-slate-700 outline-none focus:ring-2 focus:ring-yellow-500/40" />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Password</span>
              <input name="password" type="password" required defaultValue="password123"
                className="mt-1.5 w-full rounded-full bg-slate-800 text-white placeholder-slate-400 px-5 py-3 text-sm border border-slate-700 outline-none focus:ring-2 focus:ring-yellow-500/40" />
            </label>
            <button type="submit"
              className="w-full rounded-full py-3 text-sm font-bold text-slate-900 transition hover:brightness-105"
              style={{ background: "linear-gradient(180deg, #e6c66a 0%, #c79a36 55%, #b0892f 100%)" }}>
              Sign in
            </button>
            <div className="text-center">
              <Link href="/forgot" className="text-xs text-yellow-700 hover:underline">Forgot your password?</Link>
            </div>
          </form>

          <div className="mt-7">
            <div className="text-[11px] font-medium uppercase tracking-wider text-slate-400 mb-2.5">Quick demo access</div>
            <div className="grid grid-cols-2 gap-2.5">
              {DEMO.map((d) => (
                <form key={d.email} action={signIn}>
                  <input type="hidden" name="email" value={d.email} />
                  <input type="hidden" name="password" value="password123" />
                  <button type="submit"
                    className="w-full text-left flex items-center gap-2.5 rounded-lg bg-white border border-stone-200 px-2.5 py-2 shadow-sm hover:border-yellow-400 hover:shadow transition">
                    <span className="h-8 w-8 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold"
                      style={{ background: `${d.tint}1f`, color: d.tint }}>{d.initials}</span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium text-slate-700 leading-tight truncate">{d.role}</span>
                      <span className="block font-mono text-[10px] text-slate-400 truncate">{d.email}</span>
                    </span>
                  </button>
                </form>
              ))}
            </div>
          </div>

          <div className="mt-7 pt-5 border-t border-stone-200 text-center">
            <p className="text-sm text-slate-600">
              New organisation? <Link href="/signup" className="text-yellow-700 font-medium hover:underline">Start a free trial</Link>
            </p>
            <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
              © {new Date().getFullYear()} {OPERATOR_NAME}
              <br />
              Contact: <a href={`mailto:${CONTACT_EMAIL}`} className="hover:underline">{CONTACT_EMAIL}</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
