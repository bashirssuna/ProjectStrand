import "server-only";
import { q, one } from "@/server/db";
import { postExpenditureToLedger } from "@/server/services/ledger";
import { id } from "@/lib/ids";
import { writeAudit, notify } from "@/server/services/audit";
import { evaluateProject } from "@/server/services/anomaly";

type Step = { step: number; role: "finance_admin" | "pm" | "pi" | "admin"; thresholdMin: number };
const PHASE: Record<Step["role"], string> = {
  finance_admin: "finance_review", pm: "pm_approval", pi: "pi_approval", admin: "admin_approval",
};

// The approval chain is built PER REQUISITION from who raised it (org policy):
//   ordinary member (coordinator, lab manager, RA…) → PM review → PI approval → Finance
//   the project manager                             → PI approval → Finance
//   the finance admin                               → PM review → PI approval
// The PI and finance admin are the standing approvers; the requester's own role
// is never part of their chain, and the PM review step only exists when the
// project actually has a project manager. PM and PI are SEPARATE steps — each
// is signable only by its own role. An org can still override with a custom
// approval_matrix row (doc_type 'requisition').
async function buildChain(projectId: string, requestedById: string): Promise<Step["role"][]> {
  const requesterRole = (await one<{ role: string }>(
    `SELECT role FROM project_member WHERE project_id=$1 AND user_id=$2`, [projectId, requestedById]))?.role ?? null;
  const hasPm = !!(await one<{ x: number }>(
    `SELECT 1 AS x FROM project_member WHERE project_id=$1 AND role='project_manager' LIMIT 1`, [projectId]));
  const chain: Step["role"][] = [];
  if (hasPm && requesterRole !== "project_manager") chain.push("pm");
  chain.push("pi");
  if (requesterRole !== "finance_admin") chain.push("finance_admin");
  return chain;
}

async function matrixFor(projectId: string): Promise<Step[] | null> {
  const m = await one<{ steps: string }>(
    `SELECT steps FROM approval_matrix
     WHERE doc_type='requisition' AND (project_id=$1 OR project_id IS NULL)
     ORDER BY project_id NULLS LAST LIMIT 1`,
    [projectId]
  );
  if (m?.steps) { try { return JSON.parse(m.steps) as Step[]; } catch {} }
  return null;
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
  const req = await one<{ projectId: string; amount: number; number: string; status: string; requestedById: string | null }>(
    `SELECT project_id AS "projectId", amount, number, status, requested_by_id AS "requestedById" FROM requisition WHERE id=$1`, [reqId]
  );
  if (!req || req.status !== "draft") throw new Error("Requisition not in draft");

  const custom = await matrixFor(req.projectId);
  const steps = custom
    ? custom.filter((s) => req.amount >= s.thresholdMin)
    : (await buildChain(req.projectId, req.requestedById ?? userId)).map((role, i) => ({ step: i + 1, role, thresholdMin: 0 }));
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

// The ONE role whose members are the current step's signatories. Only they are
// notified — no one else. The PI step in particular goes to the PI alone:
// Co-PIs may still sign it as deputies (canDecideStep), but they are only
// brought in when the project has no PI member, never spammed alongside one.
export function approverRolesFor(stepRole: Step["role"]): string[] {
  if (stepRole === "pm") return ["project_manager"];
  if (stepRole === "pi") return ["pi"];
  if (stepRole === "admin") return ["approver"];
  return ["finance_admin"];
}

// Notify ONLY the current step's signatories. Fallbacks, in order: a PI step
// with no PI member goes to the Co-PIs (they can sign as deputies); a step
// whose pool is still empty alerts the org admins that the requisition is
// stuck until someone with the role is added (org admins cannot sign pm/pi/
// finance steps themselves). Nobody outside the pending step is emailed.
async function notifyApprovers(projectId: string, role: Step["role"], reqId: string, number: string, email: boolean, reminder = false) {
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
  const ids = new Set<string>();
  const pool = async (roles: string[]) => (await q<{ userId: string }>(
    `SELECT user_id AS "userId" FROM project_member WHERE project_id=$1 AND role = ANY($2::text[])`,
    [projectId, roles]
  )).forEach((m) => ids.add(m.userId));
  await pool(approverRolesFor(role));
  if (ids.size === 0 && role === "pi") await pool(["co_pi"]); // deputy PIs step in only when there is no PI
  const poolEmpty = ids.size === 0;
  if (org && (role === "admin" || poolEmpty)) {
    (await q<{ userId: string }>(
      `SELECT m.user_id AS "userId" FROM org_membership m JOIN role r ON r.id=m.role_id
       WHERE m.org_id=$1 AND r.key='org_admin'`, [org.orgId]
    )).forEach((m) => ids.add(m.userId));
  }
  for (const uid of ids) {
    await notify({
      orgId: org?.orgId, userId: uid, type: "signature",
      title: poolEmpty && role !== "admin"
        ? `Requisition ${number} is stuck — no one holds the ${role === "pm" ? "project manager" : role === "pi" ? "PI / Co-PI" : "finance admin"} role on this project`
        : `${reminder ? "Reminder: " : ""}Requisition ${number} awaiting your approval`,
      body: poolEmpty && role !== "admin"
        ? `Add a team member with the required role so the requisition can be approved.`
        : `A requisition needs your review and signature.`,
      link: `/projects/${projectId}/requisitions/${reqId}`, email,
    });
  }
}

// The reminder nudges exactly the same pool as the original notification for
// whatever step is currently pending.
export async function remindCurrentApprovers(projectId: string, reqId: string, number: string): Promise<boolean> {
  const front = await one<{ role: Step["role"] }>(
    `SELECT role FROM requisition_approval WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`, [reqId]);
  if (!front) return false;
  await notifyApprovers(projectId, front.role, reqId, number, true, true);
  return true;
}

// Decides ONE SPECIFIC approval step — the caller signs the row belonging to
// their own role, so a signature always lands on the signer's position (a
// person with several roles signs as the role the step names). Steps are
// decided strictly IN ORDER along the chain built at submission (PM review →
// PI approval → Finance, minus the requester's own role). The requester can
// never decide their own requisition (segregation of duties, mirrors refunds).
export async function decideRequisition(input: {
  reqId: string; stepId: string; approverId: string; decision: "approved" | "rejected";
  comment?: string; signatureId?: string;
}): Promise<void> {
  const req = await one<{ projectId: string; number: string; amount: number; budgetLineId: string | null; requestedById: string | null }>(
    `SELECT project_id AS "projectId", number, amount, budget_line_id AS "budgetLineId",
            requested_by_id AS "requestedById" FROM requisition WHERE id=$1`,
    [input.reqId]
  );
  if (!req) throw new Error("Requisition not found");
  if (req.requestedById && req.requestedById === input.approverId)
    throw new Error("You cannot approve your own requisition");
  const target = await one<{ id: string; step: number; role: Step["role"] }>(
    `SELECT id, step, role FROM requisition_approval WHERE id=$1 AND requisition_id=$2`,
    [input.stepId, input.reqId]
  );
  if (!target) throw new Error("Approval step not found");
  const front = await one<{ id: string }>(
    `SELECT id FROM requisition_approval WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`,
    [input.reqId]
  );
  if (front && front.id !== target.id)
    throw new Error("Earlier steps must be decided first");

  // Conditional single-shot write: if a concurrent request decided this row
  // first, zero rows come back and we bail instead of double-deciding.
  const updated = await q<{ id: string }>(
    `UPDATE requisition_approval SET decision=$2, comment=$3, approver_id=$4, signature_id=$5, decided_at=now()
     WHERE id=$1 AND decision='pending' RETURNING id`,
    [target.id, input.decision, input.comment ?? null, input.approverId, input.signatureId ?? null]
  );
  if (updated.length === 0) throw new Error("This approval step was already decided");
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({
    orgId: org?.orgId, userId: input.approverId,
    action: input.decision === "approved" ? "approve" : "update",
    entity: "requisition", entityId: input.reqId,
    meta: { step: target.step, role: target.role, signed: Boolean(input.signatureId), comment: input.comment },
  });

  if (input.decision === "rejected") {
    await q(`UPDATE requisition SET status='rejected', updated_at=now() WHERE id=$1`, [input.reqId]);
    // Close out the untouched steps so a rejected requisition never
    // resurfaces on "awaiting approval" queues via stranded pending rows.
    await q(`UPDATE requisition_approval SET decision='skipped', decided_at=now() WHERE requisition_id=$1 AND decision='pending'`, [input.reqId]);
    if (req.requestedById) await notify({ orgId: org?.orgId, userId: req.requestedById, type: "approval_needed", title: `Requisition ${req.number} was rejected`, link: `/projects/${req.projectId}/requisitions/${input.reqId}`, email: true });
    return;
  }

  const next = await one<{ role: Step["role"] }>(
    `SELECT role FROM requisition_approval WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`,
    [input.reqId]
  );
  if (next) {
    await q(`UPDATE requisition SET status=$2, updated_at=now() WHERE id=$1`, [input.reqId, PHASE[next.role]]);
    // Only nudge the next pool when the FRONT of the chain advanced — an
    // out-of-order signature further down changes nothing for them.
    if (front && front.id === target.id) await notifyApprovers(req.projectId, next.role, input.reqId, req.number, true);
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

// Frees a decided step so the right person can sign it — the remedy when a
// signature landed on the wrong position (e.g. an org admin's approval consumed
// the finance slot). Org admins only, and never after money has moved (any
// approved voucher or disbursement locks the chain). Resetting a rejected
// requisition's step also revives the steps that were auto-skipped, and a
// fully-approved requisition loses its reservation commitment again.
export async function resetRequisitionStep(input: { reqId: string; stepId: string; byId: string }): Promise<void> {
  const req = await one<{ projectId: string; number: string; status: string; budgetLineId: string | null; disbursedAmount: number }>(
    `SELECT project_id AS "projectId", number, status, budget_line_id AS "budgetLineId",
            COALESCE(disbursed_amount,0)::float AS "disbursedAmount" FROM requisition WHERE id=$1`, [input.reqId]);
  if (!req) throw new Error("Requisition not found");
  const paid = await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM payment_voucher WHERE requisition_id=$1 AND status='approved'`, [input.reqId]);
  if ((paid?.c ?? 0) > 0 || req.disbursedAmount > 0)
    throw new Error("Money has already been paid out on this requisition — its approvals can no longer be reset");
  const step = await one<{ id: string; step: number; role: string; decision: string }>(
    `SELECT id, step, role, decision FROM requisition_approval WHERE id=$1 AND requisition_id=$2`, [input.stepId, input.reqId]);
  if (!step || step.decision === "pending") throw new Error("Approval step not found or still pending");

  await q(`UPDATE requisition_approval SET decision='pending', comment=NULL, approver_id=NULL, signature_id=NULL, decided_at=NULL WHERE id=$1`, [step.id]);
  if (req.status === "rejected") {
    // revive the steps that were auto-skipped when the rejection landed
    await q(`UPDATE requisition_approval SET decision='pending', decided_at=NULL WHERE requisition_id=$1 AND decision='skipped'`, [input.reqId]);
  }
  if (req.status === "approved" && req.budgetLineId) {
    // the full-approval reservation no longer holds
    await q(`DELETE FROM commitment WHERE budget_line_id=$1 AND note=$2`, [req.budgetLineId, `Commitment for ${req.number}`]);
  }
  const front = await one<{ role: Step["role"] }>(
    `SELECT role FROM requisition_approval WHERE requisition_id=$1 AND decision='pending' ORDER BY step ASC LIMIT 1`, [input.reqId]);
  await q(`UPDATE requisition SET status=$2, updated_at=now() WHERE id=$1`, [input.reqId, front ? PHASE[front.role] : "approved"]);
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [req.projectId]);
  await writeAudit({ orgId: org?.orgId, userId: input.byId, action: "update", entity: "requisition", entityId: input.reqId,
    meta: { resetStep: step.step, role: step.role, was: step.decision } });
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
  // 'accountability' (default): retiring an advance — skips the expenditure when
  // vouchers already deducted the budget line. 'disbursement': booking a brand-new
  // DIRECT payout — must ALWAYS create its expenditure, even if some other part of
  // this requisition was previously paid by voucher.
  mode?: "accountability" | "disbursement";
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
  const deductedAtDisbursement = input.mode !== "disbursement" && ((await one<{ c: number }>(
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
     FROM requisition WHERE project_id=$1 AND requested_by_id=$2 AND status IN ('submitted','finance_review','pm_approval','pi_approval','admin_approval')
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
