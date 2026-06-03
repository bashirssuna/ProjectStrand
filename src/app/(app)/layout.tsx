import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { listProjectsForUser } from "@/server/services/projects";
import { canCreateProjects } from "@/server/policy";
import { getUserOrg } from "@/server/services/accounts";
import { q } from "@/server/db";
import { NavLink } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOut } from "@/app/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const projects = await listProjectsForUser(user.id, user.isSuperAdmin);
  const mayCreate = await canCreateProjects(user.id, user.isSuperAdmin);
  const org = user.isSuperAdmin ? null : await getUserOrg(user.id);
  const trialDaysLeft = org?.plan === "trial" && org.trialEndsAt
    ? Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000) : null;
  const unread = await q<{ c: number }>(
    `SELECT COUNT(*)::int c FROM notification WHERE user_id=$1 AND read=false`, [user.id]
  );
  const initials = user.name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 hidden md:flex flex-col border-r" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <Link href="/dashboard" className="block font-display text-lg font-semibold" style={{ color: "var(--brand)" }}>
            Project Strand
          </Link>
          <div className="text-xs mt-1.5" style={{ color: "var(--muted)" }}>Savanna Research Institute</div>
        </div>

        <nav className="p-3 space-y-1">
          <NavLink href="/dashboard">▣ Dashboard</NavLink>
          <NavLink href="/projects">❏ Projects</NavLink>
          {user.isSuperAdmin && <NavLink href="/admin">⚙ Admin Center</NavLink>}
          <NavLink href="/profile">◔ My Profile</NavLink>
        </nav>

        <div className="px-3 mt-2">
          <div className="text-xs font-medium uppercase tracking-wide px-3 mb-1" style={{ color: "var(--muted)" }}>Your projects</div>
          <nav className="space-y-1 max-h-[42vh] overflow-auto">
            {projects.length === 0 && <div className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>No projects yet.</div>}
            {projects.map((p) => (
              <NavLink key={p.id} href={`/projects/${p.id}`}>
                <span className="truncate">{p.code}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        {mayCreate && (
          <div className="mt-auto p-3 border-t" style={{ borderColor: "var(--border)" }}>
            <Link href="/projects/new" className="btn btn-primary w-full">+ New project</Link>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 shrink-0 border-b flex items-center justify-between px-5 gap-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="md:hidden font-display text-lg font-semibold">Strand</div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Link href="/dashboard" className="btn btn-sm relative" title="Notifications">
              ✉ {unread[0]?.c ? <span className="ml-1 text-xs rounded-full px-1.5" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{unread[0].c}</span> : null}
            </Link>
            <ThemeToggle />
            <div className="flex items-center gap-2 pl-2 ml-1 border-l" style={{ borderColor: "var(--border)" }}>
              <div className="h-8 w-8 rounded-full grid place-items-center text-xs font-semibold" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{initials}</div>
              <div className="hidden sm:block leading-tight">
                <div className="text-sm font-medium">{user.name}</div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>{user.isSuperAdmin ? "Admin" : "Member"}</div>
              </div>
              <form action={signOut}><button className="btn btn-sm" title="Sign out">⎋</button></form>
            </div>
          </div>
        </header>

        <main className="flex-1 min-w-0 overflow-auto">
          {trialDaysLeft !== null && (
            <div className="px-5 py-2 text-sm text-center" style={{
              background: trialDaysLeft > 0 ? "color-mix(in srgb, var(--brand) 14%, transparent)" : "color-mix(in srgb, var(--danger) 16%, transparent)",
              borderBottom: "1px solid var(--border)",
              color: trialDaysLeft > 0 ? "var(--fg)" : "var(--danger)",
            }}>
              {trialDaysLeft > 0
                ? <>Free trial — <strong>{trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"}</strong> remaining{org?.isOrgAdmin ? <> · <a href="mailto:sales@projectstrand.app?subject=Upgrade%20Project%20Strand" className="underline">Upgrade</a></> : null}</>
                : <>Your free trial has ended. {org?.isOrgAdmin ? <a href="mailto:sales@projectstrand.app?subject=Upgrade%20Project%20Strand" className="underline">Upgrade to continue</a> : "Contact your organisation admin to upgrade."}</>}
            </div>
          )}
          <div className="max-w-6xl mx-auto px-5 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}
