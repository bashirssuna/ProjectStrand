import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { institutionalSnapshot } from "@/server/services/dashboard";
import { PageHeader, SectionTitle, Stat, Badge, Empty } from "@/components/ui";
import { money } from "@/lib/format";

const toneRank: Record<string, number> = { danger: 0, warn: 1, info: 2 };

export default async function OperationsPage() {
  const user = await requireUser();
  const org = user.isSuperAdmin ? null : await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin) redirect("/dashboard");
  const s = await institutionalSnapshot(org.id);
  const ccy = s.baseCurrency;

  const attention = [
    { c: s.approvals.pendingRequisitions, label: "Requisitions awaiting approval", href: "/projects", tone: "warn" },
    { c: s.finance.cashForecast.shortfallForecasts, label: "Cash forecasts projecting a shortfall", href: "/finance/cash-forecast", tone: "danger" },
    { c: s.governance.audit.overdue, label: "Audit findings past their target date", href: "/finance/audits", tone: "danger" },
    { c: s.governance.audit.highOpen, label: "High-risk audit findings open", href: "/finance/audits", tone: "warn" },
    { c: s.governance.whistleblower.critical, label: "Critical whistleblower reports", href: "/finance/whistleblower", tone: "danger" },
    { c: s.governance.whistleblower.open - s.governance.whistleblower.critical, label: "Whistleblower reports open", href: "/finance/whistleblower", tone: "warn" },
    { c: s.finance.pettyCash.lowCount, label: "Petty cash floats running low", href: "/finance/petty-cash", tone: "warn" },
    { c: s.finance.funding.overdueCount, label: "Funding tranches overdue", href: "/finance/funding", tone: "warn" },
    { c: s.finance.investments.maturedDue, label: "Investments matured & awaiting action", href: "/finance/treasury", tone: "warn" },
    { c: s.finance.investments.maturingSoon, label: "Investments maturing soon", href: "/finance/treasury", tone: "info" },
    { c: s.hr.er.overdue, label: "Employee-relations case actions overdue", href: "/hr/relations", tone: "danger" },
    { c: s.hr.er.grievanceOpen + s.hr.er.disciplinaryOpen, label: "Employee-relations cases open", href: "/hr/relations", tone: "warn" },
    { c: s.hr.checklists.overdue, label: "Onboarding / exit checklist items overdue", href: "/hr/checklists", tone: "warn" },
    { c: s.hr.recruitment.toReview, label: "Candidates awaiting review", href: "/hr/recruitment", tone: "info" },
    { c: s.projects.criticalFlags, label: "Critical finance flags unresolved", href: "/projects", tone: "danger" },
    { c: s.projects.overdueActivities, label: "Project activities overdue", href: "/projects", tone: "warn" },
  ].filter((x) => x.c > 0).sort((a, b) => toneRank[a.tone] - toneRank[b.tone] || b.c - a.c);

  const dot = (t: string) => (t === "danger" ? "var(--danger)" : t === "warn" ? "var(--warn)" : "var(--brand)");

  return (
    <div className="max-w-5xl">
      <PageHeader title="Institutional overview" subtitle={org.name} actions={<Link href="/dashboard" className="btn btn-sm">Project dashboard →</Link>} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Active projects" value={String(s.projects.active)} sub={`${s.projects.total} total`} />
        <Stat label="Staff" value={String(s.hr.employees)} />
        <Stat label="Items needing attention" value={String(attention.length)} tone={attention.some((a) => a.tone === "danger") ? "danger" : attention.length ? "warn" : "ok"} />
        <Stat label="Petty cash on hand" value={money(s.finance.pettyCash.onHand, ccy)} sub={`${s.finance.pettyCash.active} float${s.finance.pettyCash.active === 1 ? "" : "s"}`} />
      </div>

      {/* Needs attention */}
      <SectionTitle>Needs attention</SectionTitle>
      <div className="mt-2 mb-6">
        {attention.length === 0 ? <Empty title="All clear" hint="No outstanding exceptions across finance, HR or projects." /> : (
          <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
            {attention.map((a, i) => (
              <Link key={i} href={a.href} className="flex items-center gap-3 p-3 hover:bg-[var(--surface)]" style={{ display: "flex" }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: dot(a.tone), flex: "none" }} />
                <span className="text-sm flex-1">{a.label}</span>
                <Badge tone={a.tone as "danger" | "warn" | "info"}>{a.c}</Badge>
                <span className="text-xs" style={{ color: "var(--muted)" }}>View →</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Finance */}
      <SectionTitle>Finance position</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 mb-6">
        <Stat label="Funding outstanding" value={money(s.finance.funding.outstanding, ccy)} sub={s.finance.funding.overdueCount ? `${s.finance.funding.overdueCount} overdue` : `${s.finance.funding.active} active`} tone={s.finance.funding.overdueCount ? "warn" : undefined} />
        <Stat label="Reserves held" value={money(s.finance.reserves.total, ccy)} sub={`${s.finance.reserves.funds} fund${s.finance.reserves.funds === 1 ? "" : "s"}`} />
        <Stat label="Invested" value={money(s.finance.investments.invested, ccy)} sub={s.finance.investments.maturingSoon ? `${s.finance.investments.maturingSoon} maturing soon` : `${s.finance.investments.active} active`} />
        <Stat label="Lowest projected cash" value={s.finance.cashForecast.worstLowest != null ? money(s.finance.cashForecast.worstLowest, s.finance.cashForecast.worstCurrency) : "—"} sub={s.finance.cashForecast.active ? `${s.finance.cashForecast.active} forecast${s.finance.cashForecast.active === 1 ? "" : "s"}` : "no forecast"} tone={s.finance.cashForecast.worstLowest != null && s.finance.cashForecast.worstLowest < 0 ? "danger" : undefined} />
      </div>

      {/* Governance */}
      <SectionTitle>Governance &amp; assurance</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 mb-6">
        <Stat label="Audit findings open" value={String(s.governance.audit.openFindings)} sub={s.governance.audit.highOpen ? `${s.governance.audit.highOpen} high-risk` : `${s.governance.audit.active} engagement${s.governance.audit.active === 1 ? "" : "s"}`} tone={s.governance.audit.highOpen ? "warn" : undefined} />
        <Stat label="Remediation overdue" value={String(s.governance.audit.overdue)} tone={s.governance.audit.overdue ? "danger" : "ok"} />
        <Stat label="Whistleblower open" value={String(s.governance.whistleblower.open)} sub={s.governance.whistleblower.critical ? `${s.governance.whistleblower.critical} critical` : undefined} tone={s.governance.whistleblower.critical ? "danger" : s.governance.whistleblower.open ? "warn" : undefined} />
        <Stat label="Under investigation" value={String(s.governance.whistleblower.investigating)} />
      </div>

      {/* HR */}
      <SectionTitle>People</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 mb-6">
        <Stat label="Open recruitment" value={String(s.hr.recruitment.open)} sub={s.hr.recruitment.toReview ? `${s.hr.recruitment.toReview} to review` : `${s.hr.recruitment.candidates} candidate${s.hr.recruitment.candidates === 1 ? "" : "s"}`} />
        <Stat label="Appraisals in progress" value={String(s.hr.appraisals.inProgress)} sub={s.hr.appraisals.avgRating != null ? `avg ${s.hr.appraisals.avgRating.toFixed(1)}/5` : undefined} />
        <Stat label="ER cases open" value={String(s.hr.er.grievanceOpen + s.hr.er.disciplinaryOpen)} sub={`${s.hr.er.grievanceOpen} grievance · ${s.hr.er.disciplinaryOpen} disciplinary`} tone={s.hr.er.overdue ? "warn" : undefined} />
        <Stat label="Engagement score" value={s.hr.survey.latestScore != null ? `${s.hr.survey.latestScore}%` : "—"} sub={s.hr.survey.openSurveys ? `${s.hr.survey.openSurveys} survey open` : "latest survey"} tone={s.hr.survey.latestScore != null ? (s.hr.survey.latestScore >= 70 ? "ok" : s.hr.survey.latestScore >= 50 ? "warn" : "danger") : undefined} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href="/finance" className="btn btn-sm">Finance →</Link>
        <Link href="/hr" className="btn btn-sm">HR →</Link>
        <Link href="/projects" className="btn btn-sm">Projects →</Link>
        <Link href="/procurement" className="btn btn-sm">Procurement →</Link>
      </div>
    </div>
  );
}
