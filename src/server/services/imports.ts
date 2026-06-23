import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// Generic spreadsheet-import engine for register entities (vendors, contracts).
// Each entity declares its importable fields, header matchers (for auto-mapping),
// and an `apply` that writes one row. Inventory keeps its own dedicated flow because
// it also creates opening-stock movements; everything else routes through here.

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[._\-/]+/g, " ").replace(/\s+/g, " ").trim();
function safeJson<T>(s: string | null | undefined, fb: T): T { if (!s) return fb; try { return JSON.parse(s) as T; } catch { return fb; } }
function parseNum(s: string): number { const n = parseFloat((s || "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; }
function parseDate(s: string): string | null { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
function ccyOr(s: string, fallback: string): string { const c = (s || "").toUpperCase().replace(/[^A-Z]/g, ""); return /^[A-Z]{3}$/.test(c) ? c : fallback; }

export type ImportField = { key: string; label: string; required?: boolean };
type ApplyCtx = { orgId: string; by: { id: string; name: string }; baseCur: string };
type EntitySpec = {
  label: string;        // singular, for headings ("Vendor")
  plural: string;       // "Vendors"
  module: string | null;        // module that must be enabled, if any
  redirectTo: string;   // where to land after a successful import
  fields: ImportField[];
  matchers: { key: string; re: RegExp }[];
  // returns true if a record was created, false if the row was skipped (e.g. no name)
  apply: (ctx: ApplyCtx, v: Record<string, string>) => Promise<boolean>;
};

function normContractStatus(s: string): string {
  const t = norm(s);
  if (/complete|closed|finish/.test(t)) return "completed";
  if (/terminat|cancel/.test(t)) return "terminated";
  if (/suspend|hold|pause/.test(t)) return "suspended";
  if (/draft|pending/.test(t)) return "draft";
  if (/active|ongoing|running|signed/.test(t)) return "active";
  return "active";
}

const ENTITIES: Record<string, EntitySpec> = {
  vendor: {
    label: "Vendor", plural: "Vendors", module: "procurement", redirectTo: "/procurement/vendors",
    fields: [
      { key: "name", label: "Name", required: true },
      { key: "contactPerson", label: "Contact person" },
      { key: "email", label: "Email" },
      { key: "phone", label: "Phone" },
      { key: "taxId", label: "Tax ID / TIN" },
      { key: "bankAccount", label: "Bank account" },
      { key: "address", label: "Address" },
    ],
    matchers: [
      { key: "email", re: /e-?mail/ },
      { key: "taxId", re: /tax|^tin$|vat|^pin$/ },
      { key: "bankAccount", re: /bank|account|^acc\s*no$|iban/ },
      { key: "phone", re: /phone|tel|mobile|cell|contact\s*(no|number)/ },
      { key: "contactPerson", re: /contact\s*person|contact\s*name|focal|attention|^contact$/ },
      { key: "address", re: /address|location|physical|street/ },
      { key: "name", re: /vendor|supplier|company|business|organisation|organization|firm|^name$|provider/ },
    ],
    apply: async (ctx, v) => {
      if (!v.name) return false;
      await q(`INSERT INTO vendor (id, org_id, name, contact_person, email, phone, address, tax_id, bank_account)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id("ven"), ctx.orgId, v.name, v.contactPerson || null, v.email || null, v.phone || null, v.address || null, v.taxId || null, v.bankAccount || null]);
      return true;
    },
  },
  contract: {
    label: "Contract", plural: "Contracts", module: "public_procurement", redirectTo: "/procurement/contracts",
    fields: [
      { key: "reference", label: "Reference" },
      { key: "title", label: "Title", required: true },
      { key: "providerName", label: "Provider / vendor" },
      { key: "contractValue", label: "Contract value" },
      { key: "currency", label: "Currency" },
      { key: "startDate", label: "Start date" },
      { key: "endDate", label: "End date" },
      { key: "status", label: "Status" },
      { key: "scope", label: "Scope" },
    ],
    matchers: [
      { key: "reference", re: /reference|^ref$|contract\s*(no|number|code|id)|^code$/ },
      { key: "contractValue", re: /value|amount|contract\s*sum|^sum$|^total$|price|^cost$/ },
      { key: "currency", re: /currency|^ccy$|^curr$/ },
      { key: "startDate", re: /start|commenc|effective|from\s*date|^begin/ },
      { key: "endDate", re: /^end|expiry|expire|completion|to\s*date|finish|^due/ },
      { key: "status", re: /status|state/ },
      { key: "title", re: /title|contract\s*name|^name$|subject/ },
      { key: "providerName", re: /provider|vendor|supplier|contractor|company|party/ },
      { key: "scope", re: /scope|description|purpose|details/ },
    ],
    apply: async (ctx, v) => {
      if (!v.title) return false;
      let vendorId: string | null = null;
      const providerName = v.providerName || null;
      if (providerName) {
        const ven = await one<{ id: string }>(`SELECT id FROM vendor WHERE org_id=$1 AND lower(name)=lower($2) LIMIT 1`, [ctx.orgId, providerName]);
        if (ven) vendorId = ven.id;
      }
      await q(`INSERT INTO contract (id, org_id, reference, title, vendor_id, provider_name, contract_value, currency, start_date, end_date, status, scope, created_by_id, created_by_name)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id("ctr"), ctx.orgId, v.reference || null, v.title, vendorId, providerName, parseNum(v.contractValue), ccyOr(v.currency, ctx.baseCur),
         parseDate(v.startDate), parseDate(v.endDate), normContractStatus(v.status), v.scope || null, ctx.by.id, ctx.by.name]);
      return true;
    },
  },
};

export function importEntity(entity: string): EntitySpec | null { return ENTITIES[entity] ?? null; }

export function detectColumns(entity: string, header: unknown[]): Record<string, number> {
  const spec = ENTITIES[entity];
  if (!spec) return {};
  const cells = header.map(norm);
  const found: Record<string, number> = {};
  const used = new Set<number>();
  for (const { key, re } of spec.matchers) {
    if (found[key] != null) continue;
    for (let i = 0; i < cells.length; i++) {
      if (used.has(i) || !cells[i]) continue;
      if (re.test(cells[i])) { found[key] = i; used.add(i); break; }
    }
  }
  const out: Record<string, number> = {};
  for (const f of spec.fields) out[f.key] = found[f.key] ?? -1;
  return out;
}

export type ImportJob = { id: string; entity: string; fileName: string; status: string; header: string[]; mapping: Record<string, number>; rows: (string | number)[][]; createdCount: number };

export async function createImport(orgId: string, by: { id: string; name: string }, entity: string, fileName: string, header: unknown[], rows: unknown[][]): Promise<string> {
  const mapping = detectColumns(entity, header);
  const jobId = id("imp");
  await q(`INSERT INTO import_job (id, org_id, entity, file_name, status, header_json, mapping_json, rows_json, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,'preview',$5,$6,$7,$8,$9)`,
    [jobId, orgId, entity, fileName, JSON.stringify(header), JSON.stringify(mapping), JSON.stringify(rows), by.id, by.name]);
  return jobId;
}

export async function getImport(orgId: string, jobId: string): Promise<ImportJob | null> {
  const r = await one<{ id: string; entity: string; fileName: string; status: string; header: string | null; mapping: string | null; rows: string | null; createdCount: number }>(
    `SELECT id, entity, file_name AS "fileName", status, header_json AS header, mapping_json AS mapping, rows_json AS rows, created_count AS "createdCount"
     FROM import_job WHERE id=$1 AND org_id=$2`, [jobId, orgId]);
  if (!r) return null;
  return { id: r.id, entity: r.entity, fileName: r.fileName, status: r.status, createdCount: r.createdCount,
    header: safeJson<string[]>(r.header, []), mapping: safeJson<Record<string, number>>(r.mapping, {}), rows: safeJson<(string | number)[][]>(r.rows, []) };
}

export async function cancelImport(orgId: string, jobId: string): Promise<void> {
  await q(`UPDATE import_job SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status='preview'`, [jobId, orgId]);
}

export async function applyImport(orgId: string, by: { id: string; name: string }, jobId: string, mapping: Record<string, number>): Promise<{ created: number; skipped: number }> {
  const job = await one<{ entity: string; status: string; rows: string | null }>(`SELECT entity, status, rows_json AS rows FROM import_job WHERE id=$1 AND org_id=$2`, [jobId, orgId]);
  if (!job) throw new Error("Import not found.");
  if (job.status !== "preview") throw new Error("This import has already been processed.");
  const spec = ENTITIES[job.entity];
  if (!spec) throw new Error("Unknown import type.");
  const rows = safeJson<unknown[][]>(job.rows, []);
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const ctx: ApplyCtx = { orgId, by, baseCur };
  let created = 0, skipped = 0;
  for (const r of rows) {
    const v: Record<string, string> = {};
    for (const f of spec.fields) { const i = mapping[f.key]; v[f.key] = (i != null && i >= 0 && i < r.length) ? String(r[i] ?? "").trim() : ""; }
    const ok = await spec.apply(ctx, v);
    if (ok) created++; else skipped++;
  }
  await q(`UPDATE import_job SET status='applied', mapping_json=$2, created_count=$3 WHERE id=$1`, [jobId, JSON.stringify(mapping), created]);
  return { created, skipped };
}
