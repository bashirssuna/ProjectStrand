import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { writeAudit, notify } from "@/server/services/audit";
import { postVendorBillToLedger } from "@/server/services/ledger";

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

async function nextNum(orgId: string, table: string, prefix: string): Promise<string> {
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ${table} WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `${prefix}-${String(n + 1).padStart(4, "0")}`;
}

/* --------- Purchase requests --------- */
export type ProcurementConfig = {
  currency: string; directMax: number; microMax: number;
  quotesDirect: number; quotesMicro: number; quotesFormal: number; enforce: boolean;
};
const PROC_DEFAULTS: ProcurementConfig = {
  currency: "USD", directMax: 1000000, microMax: 5000000,
  quotesDirect: 1, quotesMicro: 3, quotesFormal: 3, enforce: true,
};

export async function getProcurementConfig(orgId: string): Promise<ProcurementConfig> {
  const row = await one<ProcurementConfig>(
    `SELECT currency, direct_max::float AS "directMax", micro_max::float AS "microMax",
            quotes_direct::int AS "quotesDirect", quotes_micro::int AS "quotesMicro",
            quotes_formal::int AS "quotesFormal", enforce
     FROM procurement_config WHERE org_id=$1`, [orgId]
  );
  if (row) return row;
  // No saved config yet — seed defaults but use the org's own base currency, not a fixed one.
  const base = (await one<{ b: string }>(`SELECT base_currency AS b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  return { ...PROC_DEFAULTS, currency: base };
}

export async function upsertProcurementConfig(orgId: string, c: ProcurementConfig): Promise<void> {
  await q(
    `INSERT INTO procurement_config (org_id, currency, direct_max, micro_max, quotes_direct, quotes_micro, quotes_formal, enforce, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (org_id) DO UPDATE SET currency=$2, direct_max=$3, micro_max=$4,
       quotes_direct=$5, quotes_micro=$6, quotes_formal=$7, enforce=$8, updated_at=now()`,
    [orgId, c.currency, c.directMax, c.microMax, c.quotesDirect, c.quotesMicro, c.quotesFormal, c.enforce]
  );
}

// How many quotations a purchase of this value needs, and which tier it is in.
export function requiredQuotations(cfg: ProcurementConfig, amount: number): { tier: "direct" | "micro" | "formal"; required: number; label: string } {
  if (amount <= cfg.directMax) return { tier: "direct", required: cfg.quotesDirect, label: "Direct procurement" };
  if (amount <= cfg.microMax) return { tier: "micro", required: cfg.quotesMicro, label: "Competitive quotation" };
  return { tier: "formal", required: cfg.quotesFormal, label: "Formal competitive bidding" };
}

export type QuotationGate = { tier: string; tierLabel: string; required: number; have: number; ok: boolean; hasSingleSource: boolean; enforce: boolean };

export async function quotationGate(orgId: string, prId: string): Promise<QuotationGate> {
  const cfg = await getProcurementConfig(orgId);
  const pr = await one<{ estimatedTotal: number; singleSource: string | null }>(
    `SELECT estimated_total::float AS "estimatedTotal", single_source_justification AS "singleSource"
     FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]
  );
  const amount = pr?.estimatedTotal ?? 0;
  const tier = requiredQuotations(cfg, amount);
  const have = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM pr_quotation WHERE request_id=$1`, [prId]))?.c ?? 0;
  const hasSingleSource = Boolean(pr?.singleSource && pr.singleSource.trim());
  return { tier: tier.tier, tierLabel: tier.label, required: tier.required, have, ok: have >= tier.required, hasSingleSource, enforce: cfg.enforce };
}

export async function listQuotations(prId: string) {
  return q<{ id: string; vendorName: string; amount: number; currency: string; leadTimeDays: number | null; notes: string | null; selected: boolean }>(
    `SELECT id, vendor_name AS "vendorName", amount::float AS amount, currency,
            lead_time_days AS "leadTimeDays", notes, selected
     FROM pr_quotation WHERE request_id=$1 ORDER BY selected DESC, amount ASC`, [prId]
  );
}

export async function decidePurchaseRequest(orgId: string, prId: string, decision: "approved" | "rejected", by: { id: string; name: string }, note?: string): Promise<void> {
  const pr = await one<{ status: string; projectId: string | null; budgetLineId: string | null; estimatedTotal: number; number: string; title: string }>(
    `SELECT status, project_id AS "projectId", budget_line_id AS "budgetLineId", estimated_total::float AS "estimatedTotal", number, title
     FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]
  );
  if (!pr) throw new Error("Purchase request not found.");
  if (pr.status !== "submitted") throw new Error("Only a submitted request can be decided.");

  // Competition gate (Procurement Policy §6): an approval needs the required
  // number of quotations on file, or a written single-source justification.
  if (decision === "approved") {
    const gate = await quotationGate(orgId, prId);
    if (gate.enforce && !gate.ok && !gate.hasSingleSource) {
      throw new Error(`${gate.tierLabel} needs ${gate.required} quotation(s); ${gate.have} on file. Add more quotations or record a single-source justification before approving.`);
    }
  }

  await q(`UPDATE purchase_request SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=now(), decision_note=$5 WHERE id=$1`,
    [prId, decision, by.id, by.name, note ?? null]);

  // On approval, reserve the estimated total against the chosen project budget
  // line as a commitment, so it reflects in the project's budget (reserved
  // funds, reducing remaining). Guarded by source_id so it can never double-post.
  if (decision === "approved" && pr.projectId && pr.budgetLineId && pr.estimatedTotal > 0) {
    const already = await one<{ id: string }>(`SELECT id FROM commitment WHERE source=$1 AND source_id=$2`, ["purchase_request", prId]);
    if (!already) {
      await q(
        `INSERT INTO commitment (id, project_id, budget_line_id, amount, date, note, source, source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id("cmt"), pr.projectId, pr.budgetLineId, pr.estimatedTotal, new Date().toISOString().slice(0, 10),
         `${pr.number}: ${pr.title}`, "purchase_request", prId]
      );
    }
  }
}

/* --------- Purchase request approval chain (signatures + email) --------- */
// Standard sign-off chain. A project-charged request adds a budget-holder / PI step
// between finance review and the authorising officer.
export function purchaseApprovalSteps(hasProject: boolean): { step: number; role: string }[] {
  return hasProject
    ? [{ step: 1, role: "Finance review" }, { step: 2, role: "Budget holder / PI" }, { step: 3, role: "Authorising officer" }]
    : [{ step: 1, role: "Finance review" }, { step: 2, role: "Authorising officer" }];
}

// Seed the approval steps for a request (idempotent — does nothing if steps exist).
export async function seedPurchaseApprovalChain(requestId: string, hasProject: boolean): Promise<void> {
  const existing = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM purchase_approval WHERE request_id=$1`, [requestId]))?.c ?? 0;
  if (existing > 0) return;
  for (const s of purchaseApprovalSteps(hasProject)) {
    await q(`INSERT INTO purchase_approval (id, request_id, step, role, decision) VALUES ($1,$2,$3,$4,'pending')`,
      [id("pa"), requestId, s.step, s.role]);
  }
}

// Reserve the estimated total against the project budget line as a commitment
// (idempotent by source_id). Called when the chain reaches full approval.
async function reservePurchaseCommitment(pr: { id: string; projectId: string | null; budgetLineId: string | null; estimatedTotal: number; number: string; title: string }): Promise<void> {
  if (!(pr.projectId && pr.budgetLineId && pr.estimatedTotal > 0)) return;
  const already = await one<{ id: string }>(`SELECT id FROM commitment WHERE source=$1 AND source_id=$2`, ["purchase_request", pr.id]);
  if (already) return;
  await q(`INSERT INTO commitment (id, project_id, budget_line_id, amount, date, note, source, source_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("cmt"), pr.projectId, pr.budgetLineId, pr.estimatedTotal, new Date().toISOString().slice(0, 10),
     `${pr.number}: ${pr.title}`, "purchase_request", pr.id]);
}

// Assign a specific person to an approval step and email them that their signature is needed.
export async function assignPurchaseApprover(orgId: string, requestId: string, step: number, approverId: string, by: { id: string; name: string }): Promise<void> {
  const pr = await one<{ number: string; title: string }>(`SELECT number, title FROM purchase_request WHERE id=$1 AND org_id=$2`, [requestId, orgId]);
  if (!pr) throw new Error("Purchase request not found.");
  const u = await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [approverId]);
  await q(`UPDATE purchase_approval SET approver_id=$3, approver_name=$4, notified_at=now() WHERE request_id=$1 AND step=$2 AND decision='pending'`,
    [requestId, step, approverId, u?.name ?? null]);
  await notify({ orgId, userId: approverId, type: "approval_request",
    title: `Signature needed: purchase request ${pr.number}`,
    body: `You have been asked to sign off purchase request "${pr.title}". Open it to review and sign.`,
    link: `/procurement/requests/${requestId}`, email: true });
  await writeAudit({ orgId, userId: by.id, action: "update", entity: "purchase_approval", entityId: `${pr.number}#${step}`, after: { assignedTo: approverId } });
}

// Sign (approve/reject) the current step. Steps must be signed in order. The final
// approval approves the request and reserves the budget commitment; any rejection rejects
// the whole request. The next pending approver (if already assigned) is emailed.
export async function signPurchaseApproval(orgId: string, requestId: string, step: number, by: { id: string; name: string }, decision: "approved" | "rejected", comment?: string, signatureData?: string): Promise<void> {
  const pr = await one<{ status: string; projectId: string | null; budgetLineId: string | null; estimatedTotal: number; number: string; title: string }>(
    `SELECT status, project_id AS "projectId", budget_line_id AS "budgetLineId", estimated_total::float AS "estimatedTotal", number, title FROM purchase_request WHERE id=$1 AND org_id=$2`, [requestId, orgId]);
  if (!pr) throw new Error("Purchase request not found.");
  if (pr.status !== "submitted") throw new Error("Only a submitted request can be signed.");
  const steps = await q<{ step: number; decision: string }>(
    `SELECT step, decision FROM purchase_approval WHERE request_id=$1 ORDER BY step ASC`, [requestId]);
  const current = steps.find((s) => s.decision === "pending");
  if (!current) throw new Error("This request has no pending approval step.");
  if (current.step !== step) throw new Error("Approval steps must be signed in order.");
  // Competition gate (Procurement Policy §6) checked at the first sign-off.
  if (decision === "approved" && current.step === steps[0].step) {
    const gate = await quotationGate(orgId, requestId);
    if (gate.enforce && !gate.ok && !gate.hasSingleSource) {
      throw new Error(`${gate.tierLabel} needs ${gate.required} quotation(s); ${gate.have} on file. Add more quotations or record a single-source justification before approving.`);
    }
  }
  const sig = await one<{ dataUrl: string }>(`SELECT data_url AS "dataUrl" FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [by.id]);
  const sigData = decision === "approved" ? ((signatureData && signatureData.length > 40 ? signatureData : null) ?? sig?.dataUrl ?? null) : null;
  await q(`UPDATE purchase_approval SET decision=$3, comment=$4, approver_id=COALESCE(approver_id,$5), approver_name=COALESCE(approver_name,$6), signature_data=$7, decided_at=now() WHERE request_id=$1 AND step=$2`,
    [requestId, step, decision, comment ?? null, by.id, by.name, sigData]);
  if (decision === "rejected") {
    await q(`UPDATE purchase_request SET status='rejected', decided_by=$2, decided_by_name=$3, decided_at=now(), decision_note=$4 WHERE id=$1`,
      [requestId, by.id, by.name, comment ?? null]);
    await writeAudit({ orgId, userId: by.id, action: "update", entity: "purchase_request", entityId: pr.number, after: { decision: "rejected", atStep: step } });
    return;
  }
  const remaining = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM purchase_approval WHERE request_id=$1 AND decision<>'approved'`, [requestId]))?.c ?? 0;
  if (remaining === 0) {
    await q(`UPDATE purchase_request SET status='approved', decided_by=$2, decided_by_name=$3, decided_at=now() WHERE id=$1`, [requestId, by.id, by.name]);
    await reservePurchaseCommitment({ id: requestId, projectId: pr.projectId, budgetLineId: pr.budgetLineId, estimatedTotal: pr.estimatedTotal, number: pr.number, title: pr.title });
    await writeAudit({ orgId, userId: by.id, action: "update", entity: "purchase_request", entityId: pr.number, after: { decision: "approved", fullySigned: true } });
  } else {
    const next = await one<{ approverId: string | null }>(`SELECT approver_id AS "approverId" FROM purchase_approval WHERE request_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`, [requestId]);
    if (next?.approverId) {
      await notify({ orgId, userId: next.approverId, type: "approval_request",
        title: `Signature needed: purchase request ${pr.number}`,
        body: `Purchase request "${pr.title}" has advanced and now needs your sign-off.`,
        link: `/procurement/requests/${requestId}`, email: true });
    }
    await writeAudit({ orgId, userId: by.id, action: "update", entity: "purchase_approval", entityId: `${pr.number}#${step}`, after: { decision: "approved" } });
  }
}

// Authorise (sign) a purchase order before it is issued to the vendor.
export async function authorisePurchaseOrder(orgId: string, poId: string, by: { id: string; name: string }, signatureData?: string): Promise<void> {
  const po = await one<{ number: string }>(`SELECT number FROM purchase_order WHERE id=$1 AND org_id=$2`, [poId, orgId]);
  if (!po) throw new Error("Purchase order not found.");
  const sig = await one<{ dataUrl: string }>(`SELECT data_url AS "dataUrl" FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [by.id]);
  const sigData = (signatureData && signatureData.length > 40 ? signatureData : null) ?? sig?.dataUrl ?? null;
  await q(`UPDATE purchase_order SET authorised_by=$2, authorised_by_name=$3, authorised_signature=$4, authorised_at=now() WHERE id=$1`,
    [poId, by.id, by.name, sigData]);
  await writeAudit({ orgId, userId: by.id, action: "update", entity: "purchase_order", entityId: po.number, after: { authorised: true } });
}

/* --------- Purchase order from request --------- */
// Creates a PO from an approved purchase request, copying its items.
export async function createPOFromRequest(orgId: string, prId: string, vendorId: string, by: { id: string; name: string }): Promise<string> {
  const pr = await one<{ status: string; projectId: string | null; budgetLineId: string | null; currency: string; title: string }>(
    `SELECT status, project_id AS "projectId", budget_line_id AS "budgetLineId", currency, title FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]
  );
  if (!pr) throw new Error("Purchase request not found.");
  if (pr.status !== "approved") throw new Error("The purchase request must be approved first.");

  const items = await q<{ description: string; quantity: number; unit: string | null; estimatedUnitCost: number }>(
    `SELECT description, quantity::float, unit, estimated_unit_cost::float AS "estimatedUnitCost" FROM purchase_request_item WHERE request_id=$1`, [prId]
  );
  const poId = id("po");
  const number = await nextNum(orgId, "purchase_order", "PO");
  let total = 0;
  await q(`INSERT INTO purchase_order (id, org_id, project_id, budget_line_id, request_id, vendor_id, number, order_date, currency, status, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11)`,
    [poId, orgId, pr.projectId, pr.budgetLineId, prId, vendorId, number, new Date().toISOString().slice(0, 10), pr.currency, by.id, by.name]);
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
  // Three-way match (Procurement Policy §9, §14.1): no bill/payment can be raised
  // for a purchase order until goods have been received against it (a GRN exists).
  const grn = await one<{ ok: number }>(`SELECT 1 AS ok FROM goods_received_note WHERE po_id=$1 LIMIT 1`, [poId]);
  if (!grn) throw new Error("Three-way match: record a Goods Received Note for this order before raising a bill — you cannot pay for goods that have not been received.");
  const billId = id("bill");
  const number = await nextNum(orgId, "vendor_bill", "BILL");
  await q(`INSERT INTO vendor_bill (id, org_id, project_id, po_id, vendor_id, number, bill_date, due_date, currency, total, status, expense_account_id, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unpaid',$11,$12,$13)`,
    [billId, orgId, po.projectId, poId, po.vendorId, number,
     opts?.billDate ?? new Date().toISOString().slice(0, 10), opts?.dueDate ?? null,
     po.currency, round2(po.total), opts?.expenseAccountId ?? null, by.id, by.name]);
  await q(`UPDATE purchase_order SET status='billed' WHERE id=$1`, [poId]);
  // Recognise the payable in the general ledger: DR expense / CR accounts payable
  // (no-op if the org hasn't enabled its chart of accounts yet).
  await postVendorBillToLedger({ orgId, billId, postedBy: by.id, postedByName: by.name });
  return billId;
}
