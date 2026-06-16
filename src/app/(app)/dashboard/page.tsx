import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listProjectsForUser, getProjectSummary, healthScore } from "@/server/services/projects";
import { HBar, Donut } from "@/components/charts";
import { q } from "@/server/db";
import { getUserOrg } from "@/server/services/accounts";
import { PageHeader, Stat, Badge, StatusBadge, ProgressBar, Empty } from "@/components/ui";
import { money, pct, fmtDateTime, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { setDisplayCurrencyAction } from "@/app/actions";

export default async function DashboardPage() {
  const user = await requireUser();
  if (user.isStaff) { const { redirect } = await import("next/navigation"); redirect("/portal"); }
  if (user.isCollaborator) { const { redirect } = await import("next/navigation"); redirect("/projects"); }
  const org = user.isSuperAdmin ? null : await getUserOrg(user.id);
  const trialDaysLeft = org?.plan === "trial" && org.trialEndsAt
    ? Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000) : null;
  const subDaysLeft = org?.plan === "active" && org.subscriptionEndsAt
    ? Math.ceil((new Date(org.subscriptionEndsAt).getTime() - Date.now()) / 86400000) : null;
  const projects = await listProjectsForUser(user.id, user.isSuperAdmin);
  const summaries = await Promise.all(projects.map((p) => getProjectSummary(p.id)));

  // Aggregate budgets per currency (projects may be in different currencies).
  const byCurrency = new Map<string, { planned: number; actual: number }>();
  projects.forEach((p, i) => {
    const s = summaries[i];
    const cur = p.currency || "USD";
    const acc = byCurrency.get(cur) ?? { planned: 0, actual: 0 };
    acc.planned += s?.budget?.planned ?? 0;
    acc.actual += s?.budget?.actual ?? 0;
    byCurrency.set(cur, acc);
  });
  // Primary currency = the most common project currency (or org base).
  const primaryCurrency = [...byCurrency.entries()].sort((a, b) => b[1].planned - a[1].planned)[0]?.[0]
    ?? org?.baseCurrency ?? "USD";
  const totalPlanned = byCurrency.get(primaryCurrency)?.planned ?? 0;
  const totalSpent = byCurrency.get(primaryCurrency)?.actual ?? 0;
  const totalFlags = summaries.reduce((s, x) => s + (x?.counts.openFlags ?? 0), 0);

  // Optional secondary display currency (admin-chosen). Convert the primary
  // total into it using the latest FX rate, if one exists.
  let displayBudget: string | null = null;
  if (org && org.displayCurrency && org.displayCurrency !== primaryCurrency) {
    const { convertToBase } = await import("@/server/services/ledger");
    // convertToBase converts FROM a currency TO the org base; we need primary→display.
    // Look up a direct rate primary→display, else show nothing rather than mislead.
    const rate = await q<{ rate: number }>(
      `SELECT rate::float FROM exchange_rate WHERE org_id=$1 AND currency=$2 AND base_currency=$3 ORDER BY as_of DESC LIMIT 1`,
      [org.id, primaryCurrency, org.displayCurrency]
    );
    if (rate[0]) displayBudget = money(totalPlanned * rate[0].rate, org.displayCurrency);
  }

  const pendingSignatures = await q<{ id: string; number: string; title: string; projectId: string; amount: number; currency: string }>(
    `SELECT r.id, r.number, r.title, r.project_id AS "projectId", r.amount, p.currency
     FROM requisition r
     JOIN project p ON p.id=r.project_id
     JOIN requisition_approval ra ON ra.requisition_id=r.id AND ra.decision='pending'
     JOIN project_member pm ON pm.project_id=r.project_id AND pm.user_id=$1
     WHERE (ra.role='pm' AND pm.role IN ('project_manager','pi'))
        OR (ra.role='finance_admin' AND pm.role='finance_admin')
        OR (ra.role='admin' AND pm.role='pi')
     GROUP BY r.id, r.number, r.title, r.project_id, r.amount, p.currency`, [user.id]
  );

  const meetings = await q<{ id: string; title: string; startsAt: string; projectId: string; url: string | null }>(
    `SELECT m.id, m.title, m.starts_at AS "startsAt", m.project_id AS "projectId", m.meeting_url AS url
     FROM meeting m JOIN project_member pm ON pm.project_id=m.project_id AND pm.user_id=$1
     WHERE m.starts_at > now() ORDER BY m.starts_at LIMIT 5`, [user.id]
  );

  // ---- Institution-wide summaries (illustrations that link to detail pages) ----
  const projStatusDefs: [string, string][] = [["active", "var(--ok)"], ["on_hold", "var(--warn)"], ["completed", "var(--brand)"], ["draft", "#a8a29e"], ["archived", "#d6d3d1"]];
  const projSegments = projStatusDefs.map(([st, color]) => ({ label: label(st), value: projects.filter((p) => p.status === st).length, color }));

  const remaining = Math.max(0, totalPlanned - totalSpent);
  const burnPct = totalPlanned ? Math.round((totalSpent / totalPlanned) * 100) : 0;
  const budgetSegments = [
    { label: "Spent", value: Math.round(totalSpent), color: "var(--brand)" },
    { label: "Remaining", value: Math.round(remaining), color: "#e7e5e4" },
  ];

  const projIds = projects.map((p) => p.id);
  const reqRows = projIds.length
    ? await q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int n FROM requisition WHERE project_id = ANY($1) GROUP BY status`, [projIds])
    : [];
  const reqBucket = (statuses: string[]) => reqRows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.n, 0);
  const reqSegments = [
    { label: "In progress", value: reqBucket(["draft", "submitted", "finance_review", "pending", "manager_review", "admin_review", "partially_funded"]), color: "var(--warn)" },
    { label: "Approved / disbursed", value: reqBucket(["approved", "disbursed"]), color: "var(--ok)" },
    { label: "Retired / closed", value: reqBucket(["retired", "accounted", "closed"]), color: "var(--brand)" },
    { label: "Rejected", value: reqBucket(["rejected", "cancelled"]), color: "var(--danger)" },
  ];
  const reqTotal = reqRows.reduce((s, r) => s + r.n, 0);

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        subtitle="Your portfolio at a glance — schedule, spend, and anything that needs a signature."
        actions={<Link href="/projects/new" className="btn btn-primary">+ New project</Link>}
      />

      {subDaysLeft !== null && (
        <div className="card p-4 mb-5 flex flex-wrap items-center justify-between gap-3"
          style={{ borderColor: subDaysLeft <= 30 ? "var(--warn)" : subDaysLeft < 0 ? "var(--danger)" : "var(--border)" }}>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Subscription</div>
            <div className="font-display text-lg font-semibold">
              {subDaysLeft > 0
                ? <>{subDaysLeft} day{subDaysLeft === 1 ? "" : "s"} until renewal</>
                : <span style={{ color: "var(--danger)" }}>Subscription expired</span>}
            </div>
            {org?.subscriptionEndsAt && (
              <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {org.name} · {subDaysLeft >= 0 ? "renews" : "expired"} {fmtDate(org.subscriptionEndsAt)}
              </div>
            )}
          </div>
          {org?.isOrgAdmin
            ? <a href="/organization/subscription" className="btn btn-sm btn-primary">{subDaysLeft < 0 ? "Renew now" : "Manage subscription"}</a>
            : subDaysLeft <= 30 && <Badge tone={subDaysLeft < 0 ? "danger" : "warn"}>{subDaysLeft < 0 ? "Renew now" : "Renewal approaching"}</Badge>}
        </div>
      )}
      {trialDaysLeft !== null && (
        <div className="card p-4 mb-5 flex flex-wrap items-center justify-between gap-3"
          style={{ borderColor: trialDaysLeft <= 14 ? "var(--warn)" : "var(--border)" }}>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Free trial</div>
            <div className="font-display text-lg font-semibold">
              {trialDaysLeft > 0
                ? <>{trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} remaining</>
                : <span style={{ color: "var(--danger)" }}>Trial ended</span>}
            </div>
            {org?.trialEndsAt && (
              <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {org.name} · ends {fmtDate(org.trialEndsAt)}
              </div>
            )}
          </div>
          {org?.isOrgAdmin && (
            <a href="/organization/subscription" className="btn btn-primary">Renew / subscribe</a>
          )}
        </div>
      )}

      {totalPlanned > 0 && (
        <Link href="/finance/statements" className="card p-4 mb-7 block hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
          <div className="text-sm font-medium mb-1">Budget utilisation by project</div>
          {projects.map((p, i) => {
            const b = summaries[i]?.budget;
            if (!b || !b.planned) return null;
            return <HBar key={p.id} label={`${p.code} ${p.title}`} value={b.actual} max={b.planned}
              money={`${money(b.actual, p.currency)} / ${money(b.planned, p.currency)}`} />;
          })}
        </Link>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active projects" value={projects.filter((p) => p.status === "active").length} sub={`${projects.length} total`} />
        <Stat label="Portfolio budget" value={money(totalPlanned, primaryCurrency)} sub={displayBudget ? `≈ ${displayBudget} · ${pct(totalPlanned ? (totalSpent / totalPlanned) * 100 : 0)} spent` : `${pct(totalPlanned ? (totalSpent / totalPlanned) * 100 : 0)} spent`} />
        <Stat label="To sign" value={pendingSignatures.length} sub="requisitions awaiting you" tone={pendingSignatures.length ? "warn" : undefined} />
        <Stat label="Open flags" value={totalFlags} sub="across your projects" tone={totalFlags ? "danger" : "ok"} />
      </div>

      {/* Institution overview — linked summary illustrations */}
      <div className="mb-7">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display text-lg font-semibold">Institution overview</h2>
          <span className="text-xs" style={{ color: "var(--muted)" }}>Tap a card for detail →</span>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          <Link href="/projects" className="card p-4 hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
            <div className="text-sm font-medium mb-3">Projects by status</div>
            <Donut segments={projSegments} centerLabel={String(projects.length)} centerSub="projects" />
          </Link>
          <Link href="/finance/statements" className="card p-4 hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
            <div className="text-sm font-medium mb-3">Budget utilisation</div>
            <Donut segments={budgetSegments} centerLabel={`${burnPct}%`} centerSub="spent" />
            <div className="text-xs mt-2" style={{ color: "var(--muted)" }}>{money(totalSpent, primaryCurrency)} of {money(totalPlanned, primaryCurrency)}</div>
          </Link>
          <Link href="/projects" className="card p-4 hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
            <div className="text-sm font-medium mb-3">Requisitions pipeline</div>
            <Donut segments={reqSegments} centerLabel={String(reqTotal)} centerSub="total" />
          </Link>
        </div>
      </div>

      {org?.isOrgAdmin && (
        <div className="flex items-center gap-2 mb-7 text-xs" style={{ color: "var(--muted)" }}>
          <span>Dashboard secondary currency:</span>
          <form action={setDisplayCurrencyAction} className="flex items-center gap-2">
            <input name="displayCurrency" defaultValue={org.displayCurrency ?? ""} maxLength={3} placeholder="e.g. USD"
              className="input" style={{ width: 90, padding: "2px 8px", height: 28, textTransform: "uppercase" }} />
            <button className="btn btn-sm" type="submit" style={{ padding: "2px 10px", height: 28 }}>Set</button>
          </form>
          <span>· primary is {primaryCurrency}. {org.displayCurrency && !displayBudget ? `Add an FX rate (${primaryCurrency}→${org.displayCurrency}) under Finance → Currency to show the conversion.` : ""}</span>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div>
            <h2 className="font-display text-lg font-semibold mb-3">Projects</h2>
            {projects.length === 0 ? (
              <Empty title="No projects yet" hint="Create your first project to get started." />
            ) : (
              <div className="space-y-3">
                {projects.map((p, i) => {
                  const s = summaries[i];
                  const h = s ? healthScore(s) : null;
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} className="card p-4 block hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface)", color: "var(--muted)" }}>{p.code}</span>
                            <StatusBadge status={p.status} />
                            {h && <Badge tone={h.tone}>{h.label}</Badge>}
                          </div>
                          <div className="font-display text-base font-semibold mt-1.5 truncate">{p.title}</div>
                          <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{p.donor ?? "—"}</div>
                        </div>
                        {s?.budget && (
                          <div className="text-right shrink-0">
                            <div className="text-sm font-semibold tabular-nums">{money(s.budget.actual, p.currency)}</div>
                            <div className="text-xs" style={{ color: "var(--muted)" }}>of {money(s.budget.planned, p.currency)}</div>
                          </div>
                        )}
                      </div>
                      {s && (
                        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
                          <div>
                            <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Progress</span><span>{pct(s.progressPct)}</span></div>
                            <ProgressBar value={s.progressPct} tone="brand" />
                          </div>
                          <div>
                            <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Budget burn</span><span>{pct(s.budget?.burn ?? 0)}</span></div>
                            <ProgressBar value={s.budget?.burn ?? 0} tone={(s.budget?.burn ?? 0) > s.timePct + 15 ? "danger" : "ok"} />
                          </div>
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {pendingSignatures.length > 0 && (
            <div className="card p-4">
              <h3 className="font-display font-semibold mb-3">Awaiting your signature</h3>
              <div className="space-y-2">
                {pendingSignatures.map((r) => (
                  <Link key={r.id} href={`/projects/${r.projectId}/requisitions/${r.id}`} className="block text-sm hover:underline">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono text-xs">{r.number}</span>
                      <span className="tabular-nums">{money(r.amount, r.currency)}</span>
                    </div>
                    <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{r.title}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <h3 className="font-display font-semibold mb-3">Upcoming meetings</h3>
            {meetings.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing scheduled.</p> : (
              <div className="space-y-3">
                {meetings.map((m) => (
                  <div key={m.id} className="text-sm">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(m.startsAt)}</div>
                    {m.url && <a href={m.url} className="text-xs hover:underline" style={{ color: "var(--info)" }}>Join link</a>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
