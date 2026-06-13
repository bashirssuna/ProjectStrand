import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

async function nextNum(orgId: string, table: string, prefix: string): Promise<string> {
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ${table} WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `${prefix}-${String(n + 1).padStart(4, "0")}`;
}

/* --------- Purchase requests --------- */
export async function decidePurchaseRequest(orgId: string, prId: string, decision: "approved" | "rejected", by: { id: string; name: string }, note?: string): Promise<void> {
  const pr = await one<{ status: string }>(`SELECT status FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]);
  if (!pr) throw new Error("Purchase request not found.");
  if (pr.status !== "submitted") throw new Error("Only a submitted request can be decided.");
  await q(`UPDATE purchase_request SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=now(), decision_note=$5 WHERE id=$1`,
    [prId, decision, by.id, by.name, note ?? null]);
}

/* --------- Purchase orders --------- */
// Creates a PO from an approved purchase request, copying its items.
export async function createPOFromRequest(orgId: string, prId: string, vendorId: string, by: { id: string; name: string }): Promise<string> {
  const pr = await one<{ status: string; projectId: string | null; currency: string; title: string }>(
    `SELECT status, project_id AS "projectId", currency, title FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]
  );
  if (!pr) throw new Error("Purchase request not found.");
  if (pr.status !== "approved") throw new Error("The purchase request must be approved first.");

  const items = await q<{ description: string; quantity: number; unit: string | null; estimatedUnitCost: number }>(
    `SELECT description, quantity::float, unit, estimated_unit_cost::float AS "estimatedUnitCost" FROM purchase_request_item WHERE request_id=$1`, [prId]
  );
  const poId = id("po");
  const number = await nextNum(orgId, "purchase_order", "PO");
  let total = 0;
  await q(`INSERT INTO purchase_order (id, org_id, project_id, request_id, vendor_id, number, order_date, currency, status, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)`,
    [poId, orgId, pr.projectId, prId, vendorId, number, new Date().toISOString().slice(0, 10), pr.currency, by.id, by.name]);
  for (const it of items) {
    const amount = round2(Number(it.quantity) * Number(it.estimatedUnitCost));
    total += amount;
    await q(`INSERT INTO purchase_order_item (id, po_id, description, quantity, unit, unit_cost, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id("poi"), poId, it.description, it.quantity, it.unit, it.estimatedUnitCost, amount]);
  }
  await q(`UPDATE purchase_order SET total=$2 WHERE id=$1`, [poId, round2(total)]);
  await q(`UPDATE purchase_request SET status='ordered' WHERE id=$1`, [prId]);
  return poId;
}

/* --------- Goods received notes --------- */
// Records a GRN against a PO, incrementing received quantities and updating the
// PO status (partially_received / received).
export async function createGRN(orgId: string, poId: string, receipts: { poItemId: string; qty: number; note?: string }[], by: { id: string; name: string }, receivedDate?: string): Promise<string> {
  const po = await one<{ status: string }>(`SELECT status FROM purchase_order WHERE id=$1 AND org_id=$2`, [poId, orgId]);
  if (!po) throw new Error("Purchase order not found.");

  const grnId = id("grn");
  const number = await nextNum(orgId, "goods_received_note", "GRN");
  await q(`INSERT INTO goods_received_note (id, org_id, po_id, number, received_date, received_by, received_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [grnId, orgId, poId, number, receivedDate ?? new Date().toISOString().slice(0, 10), by.id, by.name]);

  for (const r of receipts) {
    if (!r.qty || r.qty <= 0) continue;
    await q(`INSERT INTO grn_item (id, grn_id, po_item_id, qty_received, condition_note) VALUES ($1,$2,$3,$4,$5)`,
      [id("grni"), grnId, r.poItemId, r.qty, r.note ?? null]);
    await q(`UPDATE purchase_order_item SET qty_received = qty_received + $2 WHERE id=$1`, [r.poItemId, r.qty]);
  }

  // recompute PO status
  const rows = await q<{ q: number; r: number }>(
    `SELECT quantity::float q, qty_received::float r FROM purchase_order_item WHERE po_id=$1`, [poId]
  );
  const fullyReceived = rows.every((x) => Number(x.r) >= Number(x.q));
  const anyReceived = rows.some((x) => Number(x.r) > 0);
  const status = fullyReceived ? "received" : anyReceived ? "partially_received" : "open";
  await q(`UPDATE purchase_order SET status=$2 WHERE id=$1`, [poId, status]);
  return grnId;
}

/* --------- Vendor bills --------- */
// Raises a vendor bill (payable) from a PO. Posting to the ledger is deferred to
// the Finance completion phase — the bill records the payable in the meantime.
export async function createBillFromPO(orgId: string, poId: string, by: { id: string; name: string }, opts?: { billDate?: string; dueDate?: string; expenseAccountId?: string }): Promise<string> {
  const po = await one<{ projectId: string | null; vendorId: string | null; currency: string; total: number; status: string }>(
    `SELECT project_id AS "projectId", vendor_id AS "vendorId", currency, total::float, status FROM purchase_order WHERE id=$1 AND org_id=$2`, [poId, orgId]
  );
  if (!po) throw new Error("Purchase order not found.");
  const billId = id("bill");
  const number = await nextNum(orgId, "vendor_bill", "BILL");
  await q(`INSERT INTO vendor_bill (id, org_id, project_id, po_id, vendor_id, number, bill_date, due_date, currency, total, status, expense_account_id, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unpaid',$11,$12,$13)`,
    [billId, orgId, po.projectId, poId, po.vendorId, number,
     opts?.billDate ?? new Date().toISOString().slice(0, 10), opts?.dueDate ?? null,
     po.currency, round2(po.total), opts?.expenseAccountId ?? null, by.id, by.name]);
  await q(`UPDATE purchase_order SET status='billed' WHERE id=$1`, [poId]);
  // FINANCE HOOK (deferred): post debit expense / credit accounts payable here.
  return billId;
}
