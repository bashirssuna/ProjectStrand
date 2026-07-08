import "server-only";
import { q, one } from "@/server/db";
import { postExpenditureToLedger } from "@/server/services/ledger";
import { id } from "@/lib/ids";
import { writeAudit, notify } from "@/server/services/audit";
import { evaluateProject } from "@/server/services/anomaly";

type Step = { step: number; role: "finance_admin" | "pm" | "admin"; thresholdMin: number };
const PHASE: Record<Step["role"], string> = {
  finance_admin: "finance_review", pm: "pm_approval", admin: "admin_approval",
};

const DEFAULT_MATRIX: Step[] = [
  { step: 1, role: "finance_admin", thresholdMin: 0 },
  { step: 2, role: "pm", thresholdMin: 0 },
  { step: 3, role: "admin", thresholdMin: 5000 },
];

async function matrixFor(projectId: string): Promise<Step[]> {
  const m = await one<{ steps: string }>(
    `SELECT steps FROM approval_matrix
     WHERE doc_type='requisition' AND (project_id=$1 OR project_id IS NULL)
     ORDER BY project_id NULLS LAST LIMIT 1`,
    [projectId]
  );
  if (m?.steps) { try { return JSON.parse(m.steps) as Step[]; } catch {} }
  return DEFAULT_MATRIX;
}

export async function nextNumber(projectId: string): Promise<string> {
  const row = await one<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM requisition WHERE project_id = $1`, [projectId]
  );
  return `REQ-${String((row?.c ?? 0) + 1).padStart(4, "0")}`;
}

export async function createRequisition(input: {
  projectId: string; userId: string; title: string; amount: number;
  budgetLineId?: string; activityId?: string; justification?: string; neededBy?: string; payee?: string;
}): Promise<string> {
  const rid = id("req");
  const number = await nextNumber(input.projectId);
  await q(
    `INSERT INTO requisition (id, project_id, number, title, activity_id, budget_line_id,
       amount, justification, needed_by, payee, requested_by_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')`,
    [rid, input.projectId, number, input.title, input.activityId ?? null, input.budgetLineId ?? null,
     input.amount, input.justification ?? null, input.neededBy ?? null, input.payee ?? null, input.userId]
  );
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [input.projectId]);
  await writeAudit({ orgId: org?.orgId, userId: input.userId, action: "create", entity: "requisition", entityId: rid, after: { number, amount: input.amount } });
  return rid;
}

export async function submitRequisition(reqId: string, userId: string): Promise<void> {
  const req = await one<{ projectId: string; amount: number; number: string; status: string }>(
    `SELECT project_id AS "projectId", amount, number, status FROM requisition WHERE id=$1`, [reqId]
  );
  if (!req || req.status !== "draft") throw new Error("Requisition not in draft");

  const steps = (await matrixFor(req.projectId)).filter((s) => req.amount >= s.thresholdMin);
  for (const s of steps) {
    await q(
      `INSERT INTO requisition_approval (id, requisition_id, step, role, decision)
       VALUES ($1,$2,$3,$4,'pending')`,
      [id("rap"), reqId, s.step, s.role]
    );
  }
  const firstPhase = PHASE[steps[0].role];
  await q(`UPDATE requisition SET status=$2, updated_at=now() WHERE id=$1`, [reqId, firstPhase]);

  // notify the approver pool for the first step
  await notifyApprovers(req.projectId, steps[0].role, reqId, req.number, true);
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({ orgId: org?.orgId, userId, action: "update", entity: "requisition", entityId: reqId, before: { status: "draft" }, after: { status: firstPhase } });
}

async function notifyApprovers(projectId: string, role: Step["role"], reqId: string, number: string, email: boolean) {
  const memberRole = role === "pm" ? "project_manager" : role === "admin" ? "pi" : "finance_admin";
  const members = await q<{ userId: string }>(
    `SELECT user_id AS "userId" FROM project_member WHERE project_id=$1 AND role IN ($2,'pi','co_pi')`,
    [projectId, memberRole]
  );
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
  for (const m of members) {
    await notify({
      orgId: org?.orgId, userId: m.userId, type: "signature",
      title: `Requisition ${number} awaiting your approval`,
      body: `A requisition needs your review and signature.`,
      link: `/projects/${projectId}/requisitions/${reqId}`, email,
    });
  }
}

export async function decideRequisition(input: {
  reqId: string; approverId: string; decision: "approved" | "rejected";
  comment?: string; signatureId?: string;
}): Promise<void> {
  const req = await one<{ projectId: string; number: string; amount: number; budgetLineId: string | null; requestedById: string | null }>(
    `SELECT project_id AS "projectId", number, amount, budget_line_id AS "budgetLineId",
            requested_by_id AS "requestedById" FROM requisition WHERE id=$1`,
    [input.reqId]
  );
  if (!req) throw new Error("Requisition not found");
  // Segregation of duties: the requester can never approve their own
  // requisition, whatever approval permissions they hold (mirrors refunds).
  if (req.requestedById && req.requestedById === input.approverId)
    throw new Error("You cannot approve your own requisition");
  const pending = await one<{ id: string; step: number; role: Step["role"] }>(
    `SELECT id, step, role FROM requisition_approval
     WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`,
    [input.reqId]
  );
  if (!pending) throw new Error("No pending approval step");

  await q(
    `UPDATE requisition_approval SET decision=$2, comment=$3, approver_id=$4, signature_id=$5, decided_at=now()
     WHERE id=$1`,
    [pending.id, input.decision, input.comment ?? null, input.approverId, input.signatureId ?? null]
  );
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({
    orgId: org?.orgId, userId: input.approverId,
    action: input.decision === "approved" ? "approve" : "update",
    entity: "requisition", entityId: input.reqId,
    meta: { step: pending.step, role: pending.role, signed: Boolean(input.signatureId), comment: input.comment },
  });

  if (input.decision === "rejected") {
    await q(`UPDATE requisition SET status='rejected', updated_at=now() WHERE id=$1`, [input.reqId]);
    if (req.requestedById) await notify({ orgId: org?.orgId, userId: req.requestedById, type: "approval_needed", title: `Requisition ${req.number} was rejected`, link: `/projects/${req.projectId}/requisitions/${input.reqId}`, email: true });
    return;
  }

  const next = await one<{ role: Step["role"] }>(
    `SELECT role FROM requisition_approval WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`,
    [input.reqId]
  );
  if (next) {
    await q(`UPDATE requisition SET status=$2, updated_at=now() WHERE id=$1`, [input.reqId, PHASE[next.role]]);
    await notifyApprovers(req.projectId, next.role, input.reqId, req.number, true);
  } else {
    // fully approved → reserve funds via a commitment
    await q(`UPDATE requisition SET status='approved', updated_at=now() WHERE id=$1`, [input.reqId]);
    if (req.budgetLineId) {
      await q(
        `INSERT INTO commitment (id, project_id, budget_line_id, amount, date, note)
         VALUES ($1,$2,$3,$4,now(),$5)`,
        [id("cmt"), req.projectId, req.budgetLineId, req.amount, `Commitment for ${req.number}`]
      );
    }
    if (req.requestedById) await notify({ orgId: org?.orgId, userId: req.requestedById, type: "approval_needed", title: `Requisition ${req.number} approved`, body: "Your requisition has been fully approved.", link: `/projects/${req.projectId}/requisitions/${input.reqId}`, email: true });
    await evaluateProject(req.projectId);
  }
}

export async function disburse(reqId: string, userId: string, amount: number, ref: string): Promise<void> {
  const req = await one<{ projectId: string; amount: number }>(
    `SELECT project_id AS "projectId", amount FROM requisition WHERE id=$1`, [reqId]
  );
  if (!req) throw new Error("Requisition not found");
  const status = amount >= req.amount ? "disbursed" : "partially_funded";
  // Accountability clock starts at disbursement: 60 calendar days to account fully.
  await q(`UPDATE requisition
           SET status=$2, disbursed_amount=$3, disbursement_ref=$4,
               disbursed_on=now(), accountability_due=(CURRENT_DATE + INTERVAL '60 days')::date,
               updated_at=now()
           WHERE id=$1`,
    [reqId, status, amount, ref]);
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({ orgId: org?.orgId, userId, action: "update", entity: "requisition", entityId: reqId, after: { status, disbursed: amount, ref } });
}

// Record actual spend against the requisition's budget line, release the
// reserving commitment, then re-run the anomaly engine.
export async function recordExpenditureForRequisition(input: {
  reqId: string; userId: string; amount: number; reference: string; payee?: string; date?: string; approved?: boolean;
}): Promise<string> {
  const req = await one<{ projectId: string; budgetLineId: string | null; number: string }>(
    `SELECT project_id AS "projectId", budget_line_id AS "budgetLineId", number FROM requisition WHERE id=$1`,
    [input.reqId]
  );
  if (!req || !req.budgetLineId) throw new Error("Requisition has no budget line");
  // If the requisition was disbursed via payment vouchers, the budget line was already
  // deducted (and posted to the ledger) when each voucher was approved. In that case this
  // accountability step must NOT create a second expenditure or ledger entry — it only
  // records that the advance has been accounted for and releases any remaining commitment.
  // Legacy requisitions disbursed without voucher-linked expenditures keep the original
  // behaviour (the budget line is deducted here).
  const deductedAtDisbursement = ((await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM payment_voucher WHERE requisition_id=$1 AND expenditure_id IS NOT NULL`, [input.reqId]))?.c ?? 0) > 0;
  let eid = "";
  if (!deductedAtDisbursement) {
    eid = id("exp");
    await q(
      `INSERT INTO expenditure (id, project_id, budget_line_id, requisition_id, amount, date, reference, payee, approved, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [eid, req.projectId, req.budgetLineId, input.reqId, input.amount,
       input.date ?? new Date().toISOString(), input.reference, input.payee ?? null,
       input.approved ?? true, input.userId]
    );
    // Post the expenditure to the general ledger (no-op if GL not enabled).
    const exOrg = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
    if (exOrg) await postExpenditureToLedger({ orgId: exOrg.orgId, projectId: req.projectId, expenditureId: eid, amount: input.amount, date: (input.date ?? new Date().toISOString()), reference: input.reference, payee: input.payee ?? null, postedBy: input.userId });
  }
  // release the commitment now that money is actually spent/accounted
  await q(`DELETE FROM commitment WHERE budget_line_id=$1 AND note LIKE $2`,
    [req.budgetLineId, `Commitment for ${req.number}%`]);
  // Accountability: accumulate the accounted amount. Only mark fully retired once
  // the whole disbursed advance has been accounted for (supports partial returns).
  const acct = await one<{ disbursed: number; accounted: number }>(
    `SELECT disbursed_amount AS disbursed, accounted_amount AS accounted FROM requisition WHERE id=$1`, [input.reqId]
  );
  const newAccounted = (acct?.accounted ?? 0) + input.amount;
  const fully = newAccounted >= (acct?.disbursed ?? 0) - 0.001;
  await q(`UPDATE requisition SET accounted_amount=$2, status=$3, updated_at=now() WHERE id=$1`,
    [input.reqId, newAccounted, fully ? "retired" : "disbursed"]);
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({ orgId: org?.orgId, userId: input.userId,
    action: deductedAtDisbursement ? "update" : "create",
    entity: deductedAtDisbursement ? "requisition" : "expenditure",
    entityId: deductedAtDisbursement ? input.reqId : eid,
    after: { accountedFor: input.amount, reference: input.reference } });
  await evaluateProject(req.projectId);
  return eid;
}

/* ===================== ADVANCE ACCOUNTABILITY (Finance Policy §13.2, §15) ===================== */
// Policy constants: account fully within 60 days; no new advance while >25% of
// the previous disbursement is unaccounted; >14 days past due → personal liability.
export const ACCOUNTABILITY_DAYS = 60;
export const ADVANCE_OUTSTANDING_LIMIT = 0.25; // 25% — i.e. at least 75% must be accounted
export const LIABILITY_GRACE_DAYS = 14;

export type AdvanceItem = {
  id: string; number: string; title: string; requesterId: string | null; requesterName: string | null;
  disbursed: number; accounted: number; outstanding: number; due: string | null; daysOverdue: number;
  state: "open" | "overdue" | "liability";
};

// Open (disbursed but not fully accounted) advances for a project, newest first.
export async function outstandingAdvances(projectId: string): Promise<AdvanceItem[]> {
  const rows = await q<{ id: string; number: string; title: string; requesterId: string | null; requesterName: string | null; disbursed: number; accounted: number; due: string | null; daysOverdue: number }>(
    `SELECT r.id, r.number, r.title, r.requested_by_id AS "requesterId", u.name AS "requesterName",
            r.disbursed_amount AS disbursed, r.accounted_amount AS accounted, r.accountability_due AS due,
            GREATEST(0, (CURRENT_DATE - r.accountability_due))::int AS "daysOverdue"
     FROM requisition r LEFT JOIN app_user u ON u.id = r.requested_by_id
     WHERE r.project_id=$1 AND r.status IN ('disbursed','partially_funded')
       AND r.disbursed_amount > r.accounted_amount + 0.001
     ORDER BY r.accountability_due NULLS LAST, r.disbursed_on DESC`, [projectId]
  );
  return rows.map((r) => {
    const outstanding = r.disbursed - r.accounted;
    const state: AdvanceItem["state"] = r.daysOverdue > LIABILITY_GRACE_DAYS ? "liability" : r.daysOverdue > 0 ? "overdue" : "open";
    return { ...r, outstanding, state };
  });
}

export type AccountabilityGate = { outstanding: number; previousDisbursement: number; blocked: boolean; limit: number; openCount: number };

// The "75% rule" gate for a given requester on a project. Blocks a new advance
// when outstanding un-accounted advances exceed 25% of their previous disbursement.
export async function advanceGateFor(projectId: string, requesterId: string | null): Promise<AccountabilityGate> {
  const empty: AccountabilityGate = { outstanding: 0, previousDisbursement: 0, blocked: false, limit: ADVANCE_OUTSTANDING_LIMIT, openCount: 0 };
  if (!requesterId) return empty;
  const agg = await one<{ outstanding: number; openCount: number }>(
    `SELECT COALESCE(SUM(disbursed_amount - accounted_amount),0)::float AS outstanding, COUNT(*)::int AS "openCount"
     FROM requisition WHERE project_id=$1 AND requested_by_id=$2
       AND status IN ('disbursed','partially_funded') AND disbursed_amount > accounted_amount + 0.001`,
    [projectId, requesterId]
  );
  const prev = await one<{ amount: number }>(
    `SELECT disbursed_amount AS amount FROM requisition
     WHERE project_id=$1 AND requested_by_id=$2 AND disbursed_amount > 0
     ORDER BY disbursed_on DESC NULLS LAST LIMIT 1`, [projectId, requesterId]
  );
  const outstanding = agg?.outstanding ?? 0;
  const previousDisbursement = prev?.amount ?? 0;
  const blocked = previousDisbursement > 0 && outstanding > ADVANCE_OUTSTANDING_LIMIT * previousDisbursement + 0.001;
  return { outstanding, previousDisbursement, blocked, limit: ADVANCE_OUTSTANDING_LIMIT, openCount: agg?.openCount ?? 0 };
}

// Requisitions raised by a user that are still awaiting an approval decision.
export type PendingReq = { id: string; number: string; title: string; amount: number; status: string; createdAt: string; updatedAt: string; lastRemindedAt: string | null };
export async function myPendingRequisitions(projectId: string, userId: string): Promise<PendingReq[]> {
  return q<PendingReq>(
    `SELECT id, number, title, amount, status, created_at AS "createdAt", updated_at AS "updatedAt", last_reminded_at AS "lastRemindedAt"
     FROM requisition WHERE project_id=$1 AND requested_by_id=$2 AND status IN ('submitted','finance_review','pm_approval','admin_approval')
     ORDER BY created_at DESC`, [projectId, userId]);
}

// Per-step approval trail for a requisition: who is assigned each step, their
// decision (pending/approved/rejected), and when they decided.
export type ApprovalStep = { step: number; role: string; decision: string; approverName: string | null; decidedAt: string | null };
export async function requisitionTrail(reqId: string): Promise<ApprovalStep[]> {
  return q<ApprovalStep>(
    `SELECT a.step, a.role, a.decision, u.name AS "approverName", a.decided_at AS "decidedAt"
     FROM requisition_approval a LEFT JOIN app_user u ON u.id=a.approver_id
     WHERE a.requisition_id=$1 ORDER BY a.step`, [reqId]);
}
