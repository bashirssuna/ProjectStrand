import "server-only";
import { q, one } from "@/server/db";
import { TOGGLEABLE_MODULES, CORE_MODULES, defaultModulesForType } from "@/lib/modules";

// Effective set of enabled modules for an organisation: explicit org_module overrides
// win, otherwise the organisation type's defaults apply. Core modules are always on.
export async function enabledModules(orgId: string): Promise<Set<string>> {
  const org = await one<{ orgType: string | null }>(`SELECT org_type AS "orgType" FROM organization WHERE id=$1`, [orgId]);
  const defaults = new Set<string>(defaultModulesForType(org?.orgType));
  const rows = await q<{ moduleKey: string; enabled: boolean }>(`SELECT module_key AS "moduleKey", enabled FROM org_module WHERE org_id=$1`, [orgId]);
  const explicit = new Map(rows.map((r) => [r.moduleKey, r.enabled]));
  const set = new Set<string>(CORE_MODULES);
  for (const m of TOGGLEABLE_MODULES) {
    const on = explicit.has(m.key) ? !!explicit.get(m.key) : defaults.has(m.key);
    if (on) set.add(m.key);
  }
  return set;
}

export async function isModuleEnabled(orgId: string, key: string): Promise<boolean> {
  if (CORE_MODULES.includes(key)) return true;
  return (await enabledModules(orgId)).has(key);
}
