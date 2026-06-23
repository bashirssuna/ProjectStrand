import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

function inParams(ids: string[], start: number) { return ids.map((_, i) => `$${start + i}`).join(","); }

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export type ItemRow = {
  id: string; code: string | null; name: string; category: string | null; itemType: string; unit: string;
  unitCost: number; reorderLevel: number; status: string; balance: number; currency: string | null;
};

// All stock items with current balance (signed sum of movements). Low-stock and
// valuation are derived in the caller from balance / reorderLevel / unitCost.
export async function listItems(orgId: string, f?: { search?: string; itemType?: string; status?: string }): Promise<ItemRow[]> {
  const where: string[] = [`i.org_id=$1`];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f?.itemType) { where.push(`i.item_type=$${n}`); params.push(f.itemType); n++; }
  if (f?.status) { where.push(`i.status=$${n}`); params.push(f.status); n++; }
  if (f?.search) { where.push(`(i.name ILIKE $${n} OR i.code ILIKE $${n} OR i.category ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return await q<ItemRow>(
    `SELECT i.id, i.code, i.name, i.category, i.item_type AS "itemType", i.unit,
            i.unit_cost::float8 AS "unitCost", i.reorder_level::float8 AS "reorderLevel", i.status, i.currency,
            COALESCE((SELECT SUM(m.qty) FROM stock_movement m WHERE m.item_id=i.id),0)::float8 AS balance
     FROM stock_item i WHERE ${where.join(" AND ")} ORDER BY i.name LIMIT 1000`, params
  );
}

export function isLow(it: { balance: number; reorderLevel: number; status: string }): boolean {
  return it.status === "active" && it.reorderLevel > 0 && it.balance <= it.reorderLevel;
}

export async function getItem(orgId: string, id: string): Promise<ItemRow | null> {
  return await one<ItemRow>(
    `SELECT i.id, i.code, i.name, i.category, i.item_type AS "itemType", i.unit,
            i.unit_cost::float8 AS "unitCost", i.reorder_level::float8 AS "reorderLevel", i.status, i.currency,
            COALESCE((SELECT SUM(m.qty) FROM stock_movement m WHERE m.item_id=i.id),0)::float8 AS balance
     FROM stock_item i WHERE i.id=$1 AND i.org_id=$2`, [id, orgId]
  );
}

export type MovementRow = { id: string; kind: string; qty: number; unitCost: number | null; reference: string | null; source: string; issuedTo: string | null; storeName: string | null; movementDate: string; note: string | null; by: string | null };
export async function itemMovements(itemId: string): Promise<MovementRow[]> {
  return await q<MovementRow>(
    `SELECT m.id, m.kind, m.qty::float8 AS qty, m.unit_cost::float8 AS "unitCost", m.reference, m.source, m.issued_to AS "issuedTo",
            s.name AS "storeName", m.movement_date::text AS "movementDate", m.note, m.created_by_name AS by
     FROM stock_movement m LEFT JOIN store s ON s.id=m.store_id WHERE m.item_id=$1 ORDER BY m.movement_date DESC, m.created_at DESC`, [itemId]
  );
}

export type StoreRow = { id: string; name: string; location: string | null; status: string };
export async function listStores(orgId: string): Promise<StoreRow[]> {
  return await q<StoreRow>(`SELECT id, name, location, status FROM store WHERE org_id=$1 ORDER BY name`, [orgId]);
}

/* ===================== Bulk import from spreadsheet ===================== */
// Importable target fields, in display order, for the column-mapping UI.
export type ImportFieldKey = "code" | "name" | "category" | "itemType" | "unit" | "openingQty" | "reorderLevel" | "unitCost" | "currency";
export const INVENTORY_IMPORT_FIELDS: { key: ImportFieldKey; label: string; required?: boolean }[] = [
  { key: "code", label: "Code / asset tag" },
  { key: "name", label: "Name", required: true },
  { key: "category", label: "Category" },
  { key: "itemType", label: "Type (asset / consumable / other)" },
  { key: "unit", label: "Unit of measure" },
  { key: "openingQty", label: "Opening quantity" },
  { key: "reorderLevel", label: "Reorder level" },
  { key: "unitCost", label: "Unit cost" },
  { key: "currency", label: "Currency" },
];

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[._\-/]+/g, " ").replace(/\s+/g, " ").trim();

// Ordered most-specific-first so multi-word headers (e.g. "unit cost") bind to the
// right field before a looser pattern ("unit") can claim that same column.
const COLUMN_MATCHERS: { key: ImportFieldKey; re: RegExp }[] = [
  { key: "unitCost", re: /(unit\s*cost|unit\s*price|unit\s*value|cost\s*per|^cost$|^price$|^rate$|^value$|^amount$)/ },
  { key: "openingQty", re: /(opening|on\s*hand|^qty$|quantity|balance|^stock$|^count$|qoh)/ },
  { key: "reorderLevel", re: /(reorder|re order|reorder\s*level|reorder\s*point|^minimum$|^min$|threshold|^par$)/ },
  { key: "itemType", re: /(item\s*type|^type$|^kind$)/ },
  { key: "code", re: /(^code$|item\s*code|sku|asset\s*(no|tag|code|number)|^tag$|barcode|^ref$|^reference$)/ },
  { key: "currency", re: /(currency|^ccy$|^curr$|^cur$)/ },
  { key: "category", re: /(category|categories|^group$|^class$|classification|item\s*group)/ },
  { key: "unit", re: /(^unit$|^units$|uom|unit\s*of\s*measure|^measure$)/ },
  { key: "name", re: /(item\s*name|asset\s*name|description|particular|^name$|^item$|equipment|^asset$|details)/ },
];

// Best-effort auto-mapping of spreadsheet columns to item fields. Each column is
// claimed by at most one field; unmatched fields get -1 (user maps them by hand).
export function detectInventoryColumns(header: unknown[]): Record<ImportFieldKey, number> {
  const cells = header.map(norm);
  const found: Partial<Record<ImportFieldKey, number>> = {};
  const used = new Set<number>();
  for (const { key, re } of COLUMN_MATCHERS) {
    if (found[key] != null) continue;
    for (let i = 0; i < cells.length; i++) {
      if (used.has(i) || !cells[i]) continue;
      if (re.test(cells[i])) { found[key] = i; used.add(i); break; }
    }
  }
  const out = {} as Record<ImportFieldKey, number>;
  for (const f of INVENTORY_IMPORT_FIELDS) out[f.key] = found[f.key] ?? -1;
  return out;
}

function normType(s: string): string {
  const t = s.toLowerCase();
  if (/asset|equip|capital|fixed|furniture|vehicle|machinery|computer|laptop/.test(t)) return "asset";
  if (/^other$|misc/.test(t)) return "other";
  return "consumable";
}

export type InventoryImport = {
  id: string; fileName: string; status: string; header: string[];
  mapping: Record<ImportFieldKey, number>; rows: (string | number)[][]; createdCount: number;
};

export async function createInventoryImport(orgId: string, by: { id: string; name: string }, fileName: string, header: unknown[], rows: unknown[][]): Promise<string> {
  const mapping = detectInventoryColumns(header);
  const impId = id("imp");
  await q(`INSERT INTO inventory_import (id, org_id, file_name, status, header_json, mapping_json, rows_json, created_by_id, created_by_name)
           VALUES ($1,$2,$3,'preview',$4,$5,$6,$7,$8)`,
    [impId, orgId, fileName, JSON.stringify(header), JSON.stringify(mapping), JSON.stringify(rows), by.id, by.name]);
  return impId;
}

export async function getInventoryImport(orgId: string, importId: string): Promise<InventoryImport | null> {
  const r = await one<{ id: string; fileName: string; status: string; header: string | null; mapping: string | null; rows: string | null; createdCount: number }>(
    `SELECT id, file_name AS "fileName", status, header_json AS header, mapping_json AS mapping, rows_json AS rows, created_count AS "createdCount"
     FROM inventory_import WHERE id=$1 AND org_id=$2`, [importId, orgId]);
  if (!r) return null;
  return {
    id: r.id, fileName: r.fileName, status: r.status, createdCount: r.createdCount,
    header: safeJson<string[]>(r.header, []), mapping: safeJson<Record<ImportFieldKey, number>>(r.mapping, {} as Record<ImportFieldKey, number>),
    rows: safeJson<(string | number)[][]>(r.rows, []),
  };
}

export async function cancelInventoryImport(orgId: string, importId: string): Promise<void> {
  await q(`UPDATE inventory_import SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status='preview'`, [importId, orgId]);
}

// Writes the staged rows as stock items using the (possibly user-adjusted) mapping.
// Rows with no name are skipped; an opening quantity creates a receipt movement so
// the item starts with a real on-hand balance. Idempotent guard: only runs once.
export async function applyInventoryImport(orgId: string, by: { id: string; name: string }, importId: string, mapping: Record<ImportFieldKey, number>): Promise<{ created: number; skipped: number }> {
  const imp = await one<{ status: string; rows: string | null; fileName: string }>(
    `SELECT status, rows_json AS rows, file_name AS "fileName" FROM inventory_import WHERE id=$1 AND org_id=$2`, [importId, orgId]);
  if (!imp) throw new Error("Import not found.");
  if (imp.status !== "preview") throw new Error("This import has already been processed.");
  const rows = safeJson<unknown[][]>(imp.rows, []);
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const at = (r: unknown[], k: ImportFieldKey): string => { const i = mapping[k]; return i != null && i >= 0 && i < r.length ? String(r[i] ?? "").trim() : ""; };
  const numAt = (r: unknown[], k: ImportFieldKey): number => { const n = parseFloat(at(r, k).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };
  const today = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0;
  for (const r of rows) {
    const name = at(r, "name");
    if (!name) { skipped++; continue; }
    const rawCcy = at(r, "currency").toUpperCase().replace(/[^A-Z]/g, "");
    const ccy = /^[A-Z]{3}$/.test(rawCcy) ? rawCcy : baseCur;
    const unitCost = numAt(r, "unitCost");
    const opening = numAt(r, "openingQty");
    const itemId = id("item");
    await q(`INSERT INTO stock_item (id, org_id, code, name, category, item_type, unit, unit_cost, reorder_level, currency, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`,
      [itemId, orgId, at(r, "code") || null, name, at(r, "category") || null, normType(at(r, "itemType")), at(r, "unit") || "unit", unitCost, numAt(r, "reorderLevel"), ccy]);
    if (opening > 0) {
      await q(`INSERT INTO stock_movement (id, org_id, item_id, kind, qty, unit_cost, reference, source, movement_date, note, created_by_id, created_by_name)
               VALUES ($1,$2,$3,'receipt',$4,$5,$6,'manual',$7,$8,$9,$10)`,
        [id("smov"), orgId, itemId, opening, unitCost || null, "Opening balance", today, `Imported from ${imp.fileName}`, by.id, by.name]);
    }
    created++;
  }
  await q(`UPDATE inventory_import SET status='applied', mapping_json=$2, created_count=$3 WHERE id=$1`, [importId, JSON.stringify(mapping), created]);
  return { created, skipped };
}
