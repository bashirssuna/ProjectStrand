import "server-only";
import { q, one } from "@/server/db";

function inParams(ids: string[], start: number) { return ids.map((_, i) => `$${start + i}`).join(","); }

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
