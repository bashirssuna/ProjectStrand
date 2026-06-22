import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q } from "@/server/db";
import { enabledModules } from "@/server/modules";
import { ORG_TYPES, TOGGLEABLE_MODULES, CORE_MODULES, orgTypeLabel, defaultModulesForType } from "@/lib/modules";
import { PageHeader, SectionTitle, Field, Badge } from "@/components/ui";
import { setOrgTypeAction, toggleModuleAction } from "@/app/actions";

export default async function ModulesSettings({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  const sp = await searchParams;

  const row = await q<{ orgType: string | null }>(`SELECT org_type AS "orgType" FROM organization WHERE id=$1`, [org.id]);
  const orgType = row[0]?.orgType ?? null;
  const enabled = await enabledModules(org.id);
  const overrides = new Map((await q<{ moduleKey: string; enabled: boolean }>(`SELECT module_key AS "moduleKey", enabled FROM org_module WHERE org_id=$1`, [org.id])).map((r) => [r.moduleKey, r.enabled]));
  const typeDefaults = new Set<string>(defaultModulesForType(orgType));

  // group org types and modules
  const typeGroups = [...new Set(ORG_TYPES.map((t) => t.group))];
  const moduleGroups = [...new Set(TOGGLEABLE_MODULES.map((m) => m.group))];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Modules & sector" subtitle="Choose which parts of the platform this organisation uses" actions={<Link href="/organization" className="btn btn-sm">← Organisation</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{sp.saved === "type" ? "Sector updated — module defaults adjusted for anything you haven't set explicitly." : "Module updated."}</div>}

      <div className="card p-4 mb-5">
        <SectionTitle>Organisation sector</SectionTitle>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Your sector sets sensible defaults for which modules are on. You can override any module below — changing the sector only affects modules you haven&apos;t toggled yourself. Currently: <strong>{orgTypeLabel(orgType)}</strong>.</p>
        <form action={setOrgTypeAction} className="flex flex-wrap items-end gap-2">
          <Field label="Sector / type">
            <select name="orgType" defaultValue={orgType ?? ""} className="select" style={{ minWidth: 320 }}>
              <option value="">— select —</option>
              {typeGroups.map((g) => (
                <optgroup key={g} label={g}>
                  {ORG_TYPES.filter((t) => t.group === g).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <button className="btn btn-sm btn-primary" type="submit">Save sector</button>
        </form>
      </div>

      <div className="card p-4 mb-5">
        <SectionTitle>Always on</SectionTitle>
        <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Core modules every organisation gets.</p>
        <div className="flex flex-wrap gap-2">{CORE_MODULES.map((c) => <Badge key={c} tone="muted">{c[0].toUpperCase() + c.slice(1)}</Badge>)}</div>
      </div>

      {moduleGroups.map((g) => (
        <div key={g} className="card p-4 mb-5">
          <SectionTitle>{g}</SectionTitle>
          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {TOGGLEABLE_MODULES.filter((m) => m.group === g).map((m) => {
              const on = enabled.has(m.key);
              const isOverride = overrides.has(m.key);
              const followsDefault = !isOverride;
              return (
                <div key={m.key} className="flex items-start justify-between gap-3 py-3">
                  <div>
                    <div className="text-sm font-medium flex items-center gap-2">{m.label}<Badge tone={on ? "ok" : "muted"}>{on ? "On" : "Off"}</Badge>{followsDefault && <span className="text-xs" style={{ color: "var(--muted)" }}>· sector default{typeDefaults.has(m.key) ? " (on)" : " (off)"}</span>}{isOverride && <span className="text-xs" style={{ color: "var(--muted)" }}>· custom</span>}</div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{m.desc}</div>
                  </div>
                  <form action={toggleModuleAction} className="shrink-0">
                    <input type="hidden" name="moduleKey" value={m.key} />
                    <input type="hidden" name="enabled" value={on ? "false" : "true"} />
                    <button className="btn btn-sm" type="submit">{on ? "Disable" : "Enable"}</button>
                  </form>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="text-xs" style={{ color: "var(--muted)" }}>Disabling a module hides it from the sidebar and blocks its pages, but keeps any data so you can re-enable it later. Billing tiers can map onto these modules.</p>
    </div>
  );
}
