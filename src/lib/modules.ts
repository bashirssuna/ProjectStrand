// Module registry for the multi-sector SaaS. Core modules (Projects, Documents,
// Finance) are always on. Everything below is toggleable per organisation, seeded
// from the organisation's sector/type and overridable by an admin.

export type ModuleKey = "hr" | "procurement" | "research" | "subawards" | "collaborations";

export const TOGGLEABLE_MODULES: { key: ModuleKey; label: string; group: string; desc: string }[] = [
  { key: "hr", label: "Human Resources", group: "Operations", desc: "Employees, payroll, leave, timesheets and the staff self-service portal." },
  { key: "procurement", label: "Procurement", group: "Operations", desc: "Vendors, requisitions, approval workflow, purchase orders, GRNs and bills." },
  { key: "research", label: "Research — Laboratory & Clinical trials", group: "Research", desc: "Biospecimen registry (LIMS) and clinical-trial / cohort management." },
  { key: "subawards", label: "Sub-awards", group: "Grants & partnerships", desc: "Sub-grant agreements, disbursements and reporting." },
  { key: "collaborations", label: "Collaborations", group: "Grants & partnerships", desc: "Partner and collaboration directory." },
];

export const CORE_MODULES = ["projects", "documents", "finance"];

// Organisation types (Uganda forms of organisation + research/health/education).
export const ORG_TYPES: { key: string; label: string; group: string }[] = [
  { key: "sole_proprietorship", label: "Sole proprietorship", group: "Business & corporate" },
  { key: "partnership", label: "Partnership", group: "Business & corporate" },
  { key: "private_company", label: "Private company limited by shares (Ltd)", group: "Business & corporate" },
  { key: "public_company", label: "Public limited company (PLC)", group: "Business & corporate" },
  { key: "foreign_branch", label: "Foreign branch", group: "Business & corporate" },
  { key: "ngo", label: "Non-governmental organisation (NGO)", group: "Non-profit & civil society" },
  { key: "cbo", label: "Community-based organisation (CBO)", group: "Non-profit & civil society" },
  { key: "cooperative", label: "Cooperative / SACCO", group: "Non-profit & civil society" },
  { key: "trust_foundation", label: "Trust or foundation", group: "Non-profit & civil society" },
  { key: "government_agency", label: "Government ministry / agency", group: "Public sector & statutory" },
  { key: "statutory_corporation", label: "Statutory corporation", group: "Public sector & statutory" },
  { key: "research_institute", label: "Research institute", group: "Research, health & education" },
  { key: "health_facility", label: "Health facility", group: "Research, health & education" },
  { key: "university_academic", label: "University / academic institution", group: "Research, health & education" },
  { key: "other", label: "Other", group: "Other" },
];

// Optional modules switched ON by default for each org type (core modules are always on).
export const TYPE_DEFAULTS: Record<string, ModuleKey[]> = {
  sole_proprietorship: [],
  partnership: ["procurement"],
  private_company: ["hr", "procurement"],
  public_company: ["hr", "procurement"],
  foreign_branch: ["hr", "procurement"],
  ngo: ["hr", "procurement", "subawards", "collaborations"],
  cbo: ["subawards"],
  cooperative: ["hr"],
  trust_foundation: ["subawards", "collaborations"],
  government_agency: ["hr", "procurement", "subawards"],
  statutory_corporation: ["hr", "procurement"],
  research_institute: ["hr", "procurement", "research", "subawards", "collaborations"],
  health_facility: ["hr", "procurement", "research"],
  university_academic: ["hr", "procurement", "research", "subawards", "collaborations"],
  other: [],
};

// Fallback for organisations with no type set yet (keeps existing tenants full-featured).
export const DEFAULT_ORG_TYPE = "research_institute";

export function defaultModulesForType(type: string | null | undefined): ModuleKey[] {
  return TYPE_DEFAULTS[type ?? DEFAULT_ORG_TYPE] ?? TYPE_DEFAULTS[DEFAULT_ORG_TYPE];
}
export function orgTypeLabel(type: string | null | undefined): string {
  return ORG_TYPES.find((t) => t.key === (type ?? ""))?.label ?? "Not set";
}
