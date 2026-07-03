import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { listProjectsForUser } from "@/server/services/projects";
import { canCreateProjects } from "@/server/policy";
import { getUserOrg } from "@/server/services/accounts";
import { enabledModules } from "@/server/modules";
import { resolveUserOrg, unreadMessageCount } from "@/server/services/messaging";
import { q } from "@/server/db";
import { NavLink } from "@/components/nav";
import { Icon } from "@/components/icons";
import { ThemePicker } from "@/components/theme-picker";
import { signOut } from "@/app/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const projects = await listProjectsForUser(user.id, user.isSuperAdmin);
  const mayCreate = await canCreateProjects(user.id, user.isSuperAdmin);
  const org = await getUserOrg(user.id);
  const modules = org ? await enabledModules(org.id) : new Set<string>();
  const trialEnded = !!(org?.plan === "trial" && org.trialEndsAt && new Date(org.trialEndsAt) < new Date());
  const locked = !user.isSuperAdmin && !!org && (trialEnded || org.status === "suspended");
  if (locked) redirect("/upgrade");
  const trialDaysLeft = !user.isSuperAdmin && org?.plan === "trial" && org.trialEndsAt
    ? Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000) : null;
  const unread = await q<{ c: number }>(
    `SELECT COUNT(*)::int c FROM notification WHERE user_id=$1 AND read=false`, [user.id]
  );
  const msgOrg = await resolveUserOrg(user.id);
  const unreadMsgs = msgOrg ? await unreadMessageCount(msgOrg, user.id) : 0;
  const initials = user.name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 hidden md:flex flex-col border-r" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="px-4 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <span className="grid place-items-center shrink-0 font-display font-semibold" style={{ width: 34, height: 34, borderRadius: 9, background: "var(--brand)", color: "var(--brand-fg)", fontSize: 17, lineHeight: 1 }}>S</span>
            <span className="min-w-0">
              <span className="block font-display text-[1.05rem] font-semibold leading-none" style={{ color: "var(--fg)" }}>Project Strand</span>
              <span className="block text-[11px] mt-1 truncate" style={{ color: "var(--muted)" }}>{user.isSuperAdmin ? "Platform administrator" : user.isStaff ? "Staff portal" : user.isCollaborator ? "Collaborator access" : (org?.name ?? "")}</span>
            </span>
          </Link>
        </div>

        {user.isStaff ? (
          <nav className="p-3 space-y-0.5">
            <NavLink href="/portal" icon="home">Portal home</NavLink>
            <NavLink href="/messages" icon="message" badge={unreadMsgs}>Messages</NavLink>
            <NavLink href="/portal/timesheets" icon="clock">Timesheets</NavLink>
            <NavLink href="/portal/leave" icon="leave">Leave</NavLink>
            <NavLink href="/portal/requests" icon="procurement">Purchase requests</NavLink>
            <NavLink href="/portal/profile" icon="id">My profile &amp; CV</NavLink>
          </nav>
        ) : user.isCollaborator ? (
          <nav className="p-3 space-y-0.5">
            <NavLink href="/projects" icon="projects">My projects</NavLink>
            <NavLink href="/profile" icon="user">My Profile</NavLink>
          </nav>
        ) : (
          <nav className="p-3 space-y-0.5 overflow-y-auto">
            <NavLink href="/dashboard" icon="dashboard">Dashboard</NavLink>
            <NavLink href="/messages" icon="message" badge={unreadMsgs}>Messages</NavLink>
            <NavLink href="/projects" icon="projects">Projects</NavLink>
            {modules.has("research") && <NavLink href="/lab" icon="flask">Laboratory</NavLink>}
            {modules.has("research") && <NavLink href="/studies" icon="trial">Clinical trials</NavLink>}
            {(org?.isOrgAdmin || user.isSuperAdmin) && modules.has("subawards") && <NavLink href="/subawards" icon="subaward">Sub-awards</NavLink>}
            {(org?.isOrgAdmin || user.isSuperAdmin) && modules.has("collaborations") && <NavLink href="/collaborations" icon="collab">Collaborations</NavLink>}

            {(org?.isOrgAdmin || user.isSuperAdmin) && (
              <>
                <div className="nav-section">Institution</div>
                <NavLink href="/finance" icon="finance">Finance &amp; Accounting</NavLink>
                {modules.has("hr") && <NavLink href="/hr" icon="hr">Human Resources</NavLink>}
                {modules.has("procurement") && <NavLink href="/procurement" icon="procurement">Procurement</NavLink>}
                {modules.has("stores") && <NavLink href="/inventory" icon="inventory">Inventory &amp; stores</NavLink>}
              </>
            )}

            <div className="nav-section">Account</div>
            {(org?.isOrgAdmin || user.isSuperAdmin) && <NavLink href="/organization" icon="building">Organisation</NavLink>}
            {(org?.isOrgAdmin || user.isSuperAdmin) && <NavLink href="/organization/access" icon="access">Access &amp; permissions</NavLink>}
            {(org?.isOrgAdmin || user.isSuperAdmin) && <NavLink href="/organization/modules" icon="modules">Modules &amp; sector</NavLink>}
            {user.isSuperAdmin && <NavLink href="/admin" icon="admin">Admin Center</NavLink>}
            <NavLink href="/profile" icon="user">My Profile</NavLink>
          </nav>
        )}

        {!user.isStaff && <div className="px-3 mt-2">
          <div className="nav-section">Your projects</div>
          <nav className="space-y-1 max-h-[42vh] overflow-auto">
            {projects.length === 0 && <div className="px-3 py-2 text-xs" style={{ color: "var(--muted)" }}>No projects yet.</div>}
            {projects.map((p) => (
              <NavLink key={p.id} href={`/projects/${p.id}`}>
                <span className="truncate">{p.code}</span>
              </NavLink>
            ))}
          </nav>
        </div>}

        {mayCreate && !user.isStaff && (
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
            <Link href="/notifications" className="btn btn-sm btn-ghost relative" title="Notifications">
              <Icon name="bell" size={17} /> {unread[0]?.c ? <span className="ml-0.5 text-xs rounded-full px-1.5 font-semibold" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{unread[0].c}</span> : null}
            </Link>
            <ThemePicker />
            <div className="flex items-center gap-2 pl-2 ml-1 border-l" style={{ borderColor: "var(--border)" }}>
              <div className="h-8 w-8 rounded-full grid place-items-center text-xs font-semibold" style={{ background: "var(--brand)", color: "var(--brand-fg)" }}>{initials}</div>
              <div className="hidden sm:block leading-tight">
                <div className="text-sm font-medium">{user.name}</div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>{user.isSuperAdmin ? "Admin" : user.isCollaborator ? "Collaborator" : "Member"}</div>
              </div>
              <form action={signOut}><button className="btn btn-sm" type="submit" title="Sign out">Sign out</button></form>
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
                ? <>Free trial — <strong>{trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"}</strong> remaining{org?.isOrgAdmin ? <> · <a href="/upgrade" target="_blank" rel="noopener" className="underline">Upgrade</a></> : null}</>
                : <>Your free trial has ended. {org?.isOrgAdmin ? <a href="/upgrade" target="_blank" rel="noopener" className="underline">Upgrade to continue</a> : "Contact your organisation admin to upgrade."}</>}
            </div>
          )}
          <div className="max-w-[1600px] mx-auto px-6 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}
