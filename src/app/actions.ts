"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { PROJECT_STATUS, PROJECT_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type Permission, type ProjectRole } from "@/lib/enums";
import { createSession, destroySession, requireUser, verifyPassword } from "@/server/auth";
import { requirePermission, getProjectAccess, canCreateProjects, requireBudgetBulk } from "@/server/policy";
import { createProject } from "@/server/services/projects";
import { addProjectMemberByEmail, removeProjectMember, createAdminAccount, issuePasswordToken, consumePasswordToken, markTokenUsed, signupOrganization, getUserOrg, createOrganizationWithAdmin, setOrgState, requestUpgrade } from "@/server/services/accounts";
import { hashPassword, passwordError } from "@/lib/password";
import { createExtractionJob, applySuggestions, parseDocument } from "@/server/services/parsing";
import { sendEmail } from "@/server/email";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/config";
import { extractFile } from "@/server/services/extract";
import { saveUpload, mimeFor, deleteUpload } from "@/server/services/storage";
import {
  createRequisition, submitRequisition, decideRequisition, disburse, recordExpenditureForRequisition,
  advanceGateFor,
} from "@/server/services/requisitions";
import { generateReport } from "@/server/services/reports";
import { recomputeRollups } from "@/server/services/activities";
import { evaluateProject } from "@/server/services/anomaly";
import { ensureStandardCategories } from "@/server/services/budget";
import { reDenominateProject } from "@/server/services/currency";
import { createInventoryImport, applyInventoryImport, cancelInventoryImport, INVENTORY_IMPORT_FIELDS, type ImportFieldKey } from "@/server/services/inventory";
import { createImport, applyImport, cancelImport, importEntity } from "@/server/services/imports";
import { newSignToken, linkExpired } from "@/server/services/payment-slips";
import { writeAudit, notify } from "@/server/services/audit";

/* ---------------- Auth ---------------- */
export async function signIn(formData: FormData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  const user = await one<{ id: string; passwordHash: string | null }>(
    `SELECT id, password_hash AS "passwordHash" FROM app_user WHERE email=$1 AND status='active'`, [email]
  );
  if (!user || !verifyPassword(password, user.passwordHash)) {
    redirect("/login?error=1");
  }
  await createSession(user!.id);
  redirect("/dashboard");
}

export async function signOut() {
  await destroySession();
  redirect("/login");
}

/* ---------------- Projects ---------------- */
export async function createProjectAction(formData: FormData) {
  const user = await requireUser();
  if (!(await canCreateProjects(user.id, user.isSuperAdmin))) {
    throw new Error("FORBIDDEN — only admins and PIs can create projects");
  }
  if (!user.isSuperAdmin) {
    const org = await getUserOrg(user.id);
    if (org && org.status !== "active") throw new Error("This organisation is suspended. Contact support.");
    if (org && org.plan === "trial" && org.trialEndsAt && new Date(org.trialEndsAt) < new Date()) {
      throw new Error("Your free trial has ended. Please upgrade to add new projects.");
    }
  }
  const org = await one<{ id: string }>(
    `SELECT o.id FROM organization o
     JOIN org_membership m ON m.org_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at LIMIT 1`, [user.id]
  ) ?? await one<{ id: string }>(`SELECT id FROM organization ORDER BY created_at LIMIT 1`);
  if (!org) throw new Error("No organization");

  const pid = await createProject({
    orgId: org.id, userId: user.id,
    code: String(formData.get("code") || "").trim(),
    title: String(formData.get("title") || "").trim(),
    summary: String(formData.get("summary") || "") || undefined,
    donor: String(formData.get("donor") || "") || undefined,
    grantNumber: String(formData.get("grantNumber") || "") || undefined,
    currency: String(formData.get("currency") || "USD"),
    mode: String(formData.get("mode") || "advanced"),
    startDate: String(formData.get("startDate") || "") || undefined,
    endDate: String(formData.get("endDate") || "") || undefined,
    addCreatorAsPi: !user.isSuperAdmin,
  });

  // Admin-created project: assign the named PI by email (creating an invited
  // account + set-password email if they don't exist yet).
  const piEmail = String(formData.get("piEmail") || "").trim().toLowerCase();
  if (user.isSuperAdmin && piEmail) {
    await addProjectMemberByEmail(pid, piEmail, String(formData.get("piName") || "").trim(), "pi", user.id);
  }

  // Co-PIs / Co-Investigators — same authority as the PI.
  const coPiEmails = String(formData.get("coPiEmails") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const email of coPiEmails) {
    await addProjectMemberByEmail(pid, email, "", "co_pi", user.id);
  }

  revalidatePath("/projects");
  const wantsImport = String(formData.get("withImport") || "") === "1";
  redirect(wantsImport ? `/projects/${pid}/import` : `/projects/${pid}`);
}

export async function parseDocAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const { jobId } = await createExtractionJob({
    projectId, userId: user.id,
    fileName: String(formData.get("fileName") || "pasted-text.txt"),
    docType: String(formData.get("docType") || "proposal"),
    text: String(formData.get("text") || ""),
  });
  redirect(`/projects/${projectId}/import/${jobId}`);
}

export async function applySuggestionsAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const jobId = String(formData.get("jobId"));
  await requirePermission(projectId, "project.edit");
  const acceptIds = formData.getAll("accept").map(String);
  // Creating budget lines (whatever document they were extracted from) is a
  // senior-only action, same as clearing or importing a budget.
  if (acceptIds.length) {
    const bl = await one(`SELECT 1 AS ok FROM parsing_suggestion WHERE job_id=$1 AND kind='budget_line' AND id = ANY($2::text[]) LIMIT 1`, [jobId, acceptIds]);
    if (bl) await requireBudgetBulk(projectId);
  }
  await applySuggestions({ jobId, userId: user.id, acceptIds });
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}`);
}

/* ---------------- Activities ---------------- */
export async function updateActivityAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const activityId = String(formData.get("activityId"));
  await requirePermission(projectId, "project.edit");
  const status = String(formData.get("status") || "");
  let progress = Number(formData.get("progress") || 0);
  // marking done/not-started snaps progress so completion is reflected automatically
  if (status === "done") progress = 100;
  else if (status === "not_started") progress = 0;
  await q(`UPDATE activity SET status=$2, progress=$3, updated_at=now() WHERE id=$1 AND project_id=$4`,
    [activityId, status, Math.max(0, Math.min(100, progress)), projectId]);
  await recomputeRollups(projectId);
  await writeAudit({ userId: user.id, action: "update", entity: "activity", entityId: activityId, after: { status, progress } });
  revalidatePath(`/projects/${projectId}/workplan`);
  revalidatePath(`/projects/${projectId}`);
}

export async function addActivityAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`INSERT INTO activity (id, project_id, code, title, status, start_date, end_date, "order")
           VALUES ($1,$2,$3,$4,'not_started',$5,$6,0)`,
    [id("act"), projectId, String(formData.get("code") || ""), String(formData.get("title") || "Untitled activity"),
     String(formData.get("startDate") || "") || null, String(formData.get("endDate") || "") || null]);
  await writeAudit({ userId: user.id, action: "create", entity: "activity", entityId: projectId });
  await recomputeRollups(projectId);
  revalidatePath(`/projects/${projectId}/workplan`);
}

export async function editActivityDetailsAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const activityId = String(formData.get("activityId"));
  await requirePermission(projectId, "project.edit");
  await q(`UPDATE activity SET code=$3, title=$4, start_date=$5, end_date=$6, updated_at=now() WHERE id=$1 AND project_id=$2`,
    [activityId, projectId, String(formData.get("code") || ""), String(formData.get("title") || "Untitled activity"),
     String(formData.get("startDate") || "") || null, String(formData.get("endDate") || "") || null]);
  await recomputeRollups(projectId);
  await writeAudit({ userId: user.id, action: "update", entity: "activity", entityId: activityId });
  revalidatePath(`/projects/${projectId}/workplan`);
  revalidatePath(`/projects/${projectId}/gantt`);
}

export async function deleteActivityAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const activityId = String(formData.get("activityId"));
  await requirePermission(projectId, "project.edit");
  // detach any requisitions pointing at this activity or its sub-activities
  // (the requisition is kept; only its activity link is cleared)
  await q(
    `WITH RECURSIVE sub AS (
       SELECT id FROM activity WHERE id=$1 AND project_id=$2
       UNION ALL SELECT a.id FROM activity a JOIN sub ON a.parent_id = sub.id
     )
     UPDATE requisition SET activity_id=NULL WHERE activity_id IN (SELECT id FROM sub)`,
    [activityId, projectId]
  );
  // delete the activity and any sub-activities; tasks & dependencies cascade
  await q(
    `WITH RECURSIVE sub AS (
       SELECT id FROM activity WHERE id=$1 AND project_id=$2
       UNION ALL SELECT a.id FROM activity a JOIN sub ON a.parent_id = sub.id
     )
     DELETE FROM activity WHERE id IN (SELECT id FROM sub)`,
    [activityId, projectId]
  );
  await recomputeRollups(projectId);
  await writeAudit({ userId: user.id, action: "delete", entity: "activity", entityId: activityId });
  revalidatePath(`/projects/${projectId}/workplan`);
  revalidatePath(`/projects/${projectId}/gantt`);
}

/* ---------------- Budget ---------------- */
export async function addBudgetLineAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  await assertBudgetEditable(projectId);
  let budgetId = String(formData.get("budgetId") || "");
  if (!budgetId) {
    budgetId = id("bud");
    await q(`INSERT INTO budget (id, project_id, name) VALUES ($1,$2,'Project budget')`, [budgetId, projectId]);
    await ensureStandardCategories(budgetId); // a fresh budget gets the standard sections
  }
  const unitCost = Number(formData.get("unitCost") || 0);
  const quantity = Number(formData.get("quantity") || 1);
  const frequency = Number(formData.get("frequency") || 1) || 1;
  const categoryId = String(formData.get("categoryId") || "") || null;
  const justification = String(formData.get("justification") || "") || null;
  await q(`INSERT INTO budget_line (id, budget_id, category_id, code, description, unit, unit_cost, quantity, frequency, planned, justification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id("bl"), budgetId, categoryId, String(formData.get("code") || "BL"), String(formData.get("description") || "Line"),
     String(formData.get("unit") || "unit"), unitCost, quantity, frequency, unitCost * quantity * frequency, justification]);
  await writeAudit({ userId: user.id, action: "create", entity: "budget_line", entityId: budgetId });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

// Create the standard donor-style sections (Personnel, Equipment, …) on the
// project's budget, creating the budget first if it doesn't exist yet.
export async function setupBudgetSectionsAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  let budgetId = String(formData.get("budgetId") || "");
  if (!budgetId) {
    budgetId = id("bud");
    await q(`INSERT INTO budget (id, project_id, name) VALUES ($1,$2,'Project budget')`, [budgetId, projectId]);
  }
  await ensureStandardCategories(budgetId);
  await writeAudit({ userId: user.id, action: "setup_sections", entity: "budget", entityId: budgetId });
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function updateBudgetLineAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  await assertBudgetEditable(projectId);
  const lineId = String(formData.get("lineId"));
  const unitCost = Number(formData.get("unitCost") || 0);
  const quantity = Number(formData.get("quantity") || 1);
  const frequency = Number(formData.get("frequency") || 1) || 1;
  const categoryId = String(formData.get("categoryId") || "") || null;
  const justification = String(formData.get("justification") || "") || null;
  const planned = unitCost * quantity * frequency;
  // record the pre-change values so the previous figures stay queryable
  const prev = await one<{ code: string; description: string; unitCost: number; quantity: number; frequency: number; planned: number }>(
    `SELECT code, description, unit_cost AS "unitCost", quantity, COALESCE(frequency,1) AS frequency, planned FROM budget_line WHERE id=$1`, [lineId]);
  if (prev) {
    await q(`INSERT INTO budget_line_revision (id, project_id, budget_line_id, code, description, unit_cost, quantity, frequency, planned, action, changed_by, changed_by_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'updated',$10,$11)`,
      [id("blr"), projectId, lineId, prev.code, prev.description, prev.unitCost, prev.quantity, prev.frequency, prev.planned, user.id, user.name]);
  }
  await q(`UPDATE budget_line SET code=$2, description=$3, category_id=$4, unit_cost=$5, quantity=$6, frequency=$7, planned=$8, justification=$9 WHERE id=$1`,
    [lineId, String(formData.get("code") || "BL"), String(formData.get("description") || "Line"), categoryId, unitCost, quantity, frequency, planned, justification]);
  await writeAudit({ userId: user.id, action: "update", entity: "budget_line", entityId: lineId,
    before: prev ? { planned: prev.planned, unitCost: prev.unitCost, quantity: prev.quantity } : undefined,
    after: { planned, unitCost, quantity, frequency } });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function deleteBudgetLineAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const lineId = String(formData.get("lineId"));
  // preserve the final state in history before removing the line
  await assertBudgetEditable(projectId);
  const prev = await one<{ code: string; description: string; unitCost: number; quantity: number; planned: number }>(
    `SELECT code, description, unit_cost AS "unitCost", quantity, planned FROM budget_line WHERE id=$1`, [lineId]);
  if (prev) {
    await q(`INSERT INTO budget_line_revision (id, project_id, budget_line_id, code, description, unit_cost, quantity, planned, action, changed_by, changed_by_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deleted',$9,$10)`,
      [id("blr"), projectId, lineId, prev.code, prev.description, prev.unitCost, prev.quantity, prev.planned, user.id, user.name]);
  }
  // unlink records that point at this line so the FK delete can proceed; the
  // requisition itself is preserved (financial record), just detached.
  await q(`UPDATE requisition SET budget_line_id=NULL WHERE budget_line_id=$1`, [lineId]);
  await q(`UPDATE activity SET budget_line_id=NULL WHERE budget_line_id=$1`, [lineId]);
  await q(`DELETE FROM commitment WHERE budget_line_id=$1`, [lineId]);
  await q(`DELETE FROM expenditure WHERE budget_line_id=$1`, [lineId]);
  await q(`DELETE FROM budget_line WHERE id=$1`, [lineId]);
  await writeAudit({ userId: user.id, action: "delete", entity: "budget_line", entityId: lineId });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function clearBudgetLinesAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requireBudgetBulk(projectId);
  await assertBudgetEditable(projectId);
  const inProject = `SELECT bl.id FROM budget_line bl JOIN budget b ON b.id=bl.budget_id WHERE b.project_id=$1`;
  await q(`UPDATE requisition SET budget_line_id=NULL WHERE budget_line_id IN (${inProject})`, [projectId]);
  await q(`UPDATE activity SET budget_line_id=NULL WHERE budget_line_id IN (${inProject})`, [projectId]);
  await q(`DELETE FROM commitment WHERE budget_line_id IN (${inProject})`, [projectId]);
  await q(`DELETE FROM expenditure WHERE budget_line_id IN (${inProject})`, [projectId]);
  await q(`DELETE FROM budget_line WHERE budget_id IN (SELECT id FROM budget WHERE project_id=$1)`, [projectId]);
  await writeAudit({ userId: user.id, action: "delete", entity: "budget_line", entityId: projectId, meta: { clearedAll: true } });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function addExpenditureAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const amount = Number(formData.get("amount") || 0);
  const expId = id("exp");
  const expDate = String(formData.get("date") || new Date().toISOString());
  const expRef = String(formData.get("reference") || "");
  const expPayee = String(formData.get("payee") || "");
  await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [expId, projectId, String(formData.get("budgetLineId")), amount,
     expDate, expRef, expPayee, formData.get("approved") === "on", user.id]);
  await writeAudit({ userId: user.id, action: "create", entity: "expenditure", entityId: projectId, after: { amount } });
  // Post to the general ledger (no-op if the org hasn't enabled it yet).
  const expOrg = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
  if (expOrg) await postExpenditureToLedger({ orgId: expOrg.orgId, projectId, expenditureId: expId, amount, date: expDate, reference: expRef, payee: expPayee, postedBy: user.id, postedByName: user.name });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/spending`);
  revalidatePath(`/projects/${projectId}/budget`);
}

/* ---------------- Requisitions ---------------- */
export async function createRequisitionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "requisitions.create");

  // allow a free-typed activity: create it on the fly and link it
  let activityId = String(formData.get("activityId") || "") || undefined;
  const newActivity = String(formData.get("newActivity") || "").trim();
  if (!activityId && newActivity) {
    const aid = id("act");
    const order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM activity WHERE project_id=$1`, [projectId]))?.m ?? 0;
    await q(`INSERT INTO activity (id, project_id, title, status, "order", budget_line_id) VALUES ($1,$2,$3,'not_started',$4,$5)`,
      [aid, projectId, newActivity.slice(0, 200), order + 1, String(formData.get("budgetLineId") || "") || null]);
    activityId = aid;
  }

  // multi-select: one requisition can cover several activities
  const activityIds = (formData.getAll("activityIds") as string[]).filter(Boolean);
  if (!activityId && activityIds.length) activityId = activityIds[0];

  const rid = await createRequisition({
    projectId, userId: user.id,
    title: String(formData.get("title") || "Requisition"),
    amount: Number(formData.get("amount") || 0),
    budgetLineId: String(formData.get("budgetLineId") || "") || undefined,
    activityId,
    justification: String(formData.get("justification") || "") || undefined,
    neededBy: String(formData.get("neededBy") || "") || undefined,
    payee: String(formData.get("payee") || "") || undefined,
  });
  const linked = new Set<string>([...activityIds, ...(activityId ? [activityId] : [])]);
  for (const aid of linked) {
    await q(`INSERT INTO requisition_activity (id, requisition_id, activity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [id("ra"), rid, aid]);
  }
  revalidatePath(`/projects/${projectId}/requisitions`);
  redirect(`/projects/${projectId}/requisitions/${rid}`);
}

export async function submitRequisitionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "requisitions.create");
  // Accountability gate (Finance Policy §13.2): no new advance while >25% of the
  // requester's previous disbursement is still unaccounted for.
  const req = await one<{ requesterId: string | null }>(`SELECT requested_by_id AS "requesterId" FROM requisition WHERE id=$1`, [reqId]);
  const gate = await advanceGateFor(projectId, req?.requesterId ?? user.id);
  if (gate.blocked) {
    redirect(`/projects/${projectId}/requisitions/${reqId}?blocked=accountability`);
  }
  await submitRequisition(reqId, user.id);
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  revalidatePath(`/projects/${projectId}/requisitions`);
}

export async function decideRequisitionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "requisitions.approve");
  const decision = String(formData.get("decision")) === "approved" ? "approved" : "rejected";
  // attach the approver's signature if they have one (signing the requisition)
  const sig = await one<{ id: string }>(`SELECT id FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [user.id]);
  await decideRequisition({
    reqId, approverId: user.id, decision,
    comment: String(formData.get("comment") || "") || undefined,
    signatureId: decision === "approved" && sig ? sig.id : undefined,
  });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  revalidatePath(`/projects/${projectId}/requisitions`);
}

export async function disburseAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "budget.manage");
  await disburse(reqId, user.id, Number(formData.get("amount") || 0), String(formData.get("ref") || ""));
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
}

export async function recordReqExpenditureAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "budget.manage");
  await recordExpenditureForRequisition({
    reqId, userId: user.id, amount: Number(formData.get("amount") || 0),
    reference: String(formData.get("reference") || ""), payee: String(formData.get("payee") || "") || undefined,
  });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  revalidatePath(`/projects/${projectId}/spending`);
}

/* ---------------- Reports ---------------- */
export async function generateReportAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const rid = await generateReport({
    projectId, userId: user.id,
    type: String(formData.get("type") || "monthly"),
    periodLabel: String(formData.get("periodLabel") || "Current period"),
  });
  revalidatePath(`/projects/${projectId}/reports`);
  redirect(`/projects/${projectId}/reports?r=${rid}`);
}

export async function emailReportAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const reportId = String(formData.get("reportId"));
  const members = await q<{ userId: string }>(`SELECT user_id AS "userId" FROM project_member WHERE project_id=$1`, [projectId]);
  const rep = await one<{ title: string }>(`SELECT title FROM report WHERE id=$1`, [reportId]);
  for (const m of members) {
    await notify({ userId: m.userId, type: "report", title: `Report shared: ${rep?.title ?? "Report"}`,
      body: "A project report has been shared with you.", link: `/projects/${projectId}/reports?r=${reportId}`, email: true });
  }
  revalidatePath(`/projects/${projectId}/reports`);
}

/* ---------------- Members / invites ---------------- */
export async function addMemberAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const access = await requirePermission(projectId, "members.manage");
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (!email) { revalidatePath(`/projects/${projectId}/team`); return; }
  const role = String(formData.get("role") || "member");
  const name = String(formData.get("name") || "");
  const res = await addProjectMemberByEmail(projectId, email, name, role, access.user.id);
  revalidatePath(`/projects/${projectId}/team`);
  if (res.emailStatus === "failed") {
    redirect(`/projects/${projectId}/team?invite=emailfailed&why=${encodeURIComponent((res.emailError || "unknown").slice(0, 180))}`);
  }
  redirect(`/projects/${projectId}/team?invite=${res.emailStatus === "sent" ? "sent" : "added"}`);
}

export async function updateMemberRoleAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "members.manage");
  await q(`UPDATE project_member SET role=$3 WHERE project_id=$1 AND user_id=$2`,
    [projectId, String(formData.get("userId")), String(formData.get("role"))]);
  revalidatePath(`/projects/${projectId}/team`);
}

export async function removeMemberAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "members.manage");
  const userId = String(formData.get("userId"));
  if (userId === user.id) throw new Error("You can't revoke your own access.");
  await removeProjectMember(projectId, userId, user.id);
  revalidatePath(`/projects/${projectId}/team`);
}

/* ---------------- Profile / signature ---------------- */
export async function updateProfileAction(formData: FormData) {
  const user = await requireUser();
  await q(`UPDATE app_user SET name=$2, updated_at=now() WHERE id=$1`, [user.id, String(formData.get("name") || user.name)]);
  await q(`INSERT INTO user_profile (id, user_id, title, phone, bio)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET title=$3, phone=$4, bio=$5`,
    [id("up"), user.id, String(formData.get("title") || ""), String(formData.get("phone") || ""),
     String(formData.get("bio") || "")]);
  revalidatePath("/profile");
}

export async function changePasswordAction(formData: FormData) {
  const user = await requireUser();
  const back = String(formData.get("back") || "/profile");
  const current = String(formData.get("currentPassword") || "");
  const next = String(formData.get("newPassword") || "");
  const confirm = String(formData.get("confirmPassword") || "");
  const row = await one<{ passwordHash: string | null }>(`SELECT password_hash AS "passwordHash" FROM app_user WHERE id=$1`, [user.id]);
  if (!row || !verifyPassword(current, row.passwordHash)) redirect(`${back}?pw=wrong`);
  if (next !== confirm) redirect(`${back}?pw=match`);
  const pe = passwordError(next);
  if (pe) redirect(`${back}?pw=${encodeURIComponent(pe)}`);
  await q(`UPDATE app_user SET password_hash=$2, updated_at=now() WHERE id=$1`, [user.id, await hashPassword(next)]);
  await writeAudit({ userId: user.id, action: "update", entity: "app_user", entityId: user.id, meta: { passwordChanged: true } });
  redirect(`${back}?pw=ok`);
}

export async function uploadAvatarAction(formData: FormData) {
  const user = await requireUser();
  const back = String(formData.get("back") || "/profile");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(back);
  if (!file.type.startsWith("image/")) redirect(`${back}?avatar=type`);
  if (file.size > 2_000_000) redirect(`${back}?avatar=size`); // 2 MB cap (stored inline)
  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${buf.toString("base64")}`;
  await q(`INSERT INTO user_profile (id, user_id, avatar_url) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET avatar_url=$3`, [id("up"), user.id, dataUrl]);
  await writeAudit({ userId: user.id, action: "update", entity: "user_profile", entityId: user.id, meta: { avatar: true } });
  redirect(`${back}?avatar=ok`);
}

export async function saveSignatureAction(formData: FormData) {
  const user = await requireUser();
  const dataUrl = String(formData.get("dataUrl") || "");
  if (dataUrl) {
    await q(`INSERT INTO signature_asset (id, user_id, data_url) VALUES ($1,$2,$3)`, [id("sig"), user.id, dataUrl]);
  }
  revalidatePath(String(formData.get("back") || "/profile"));
}

/* ---------------- Meetings ---------------- */
export async function createMeetingAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const mid = id("mtg");
  const starts = String(formData.get("startsAt") || new Date().toISOString());
  await q(`INSERT INTO meeting (id, project_id, title, starts_at, ends_at, location, meeting_url, agenda)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [mid, projectId, String(formData.get("title") || "Meeting"), starts, starts,
     String(formData.get("location") || ""), String(formData.get("meetingUrl") || ""), String(formData.get("agenda") || "")]);
  await q(`INSERT INTO calendar_event (id, project_id, title, kind, starts_at, ref_entity) VALUES ($1,$2,$3,'meeting',$4,$5)`,
    [id("cev"), projectId, String(formData.get("title") || "Meeting"), starts, `meeting:${mid}`]);
  const members = await q<{ userId: string }>(`SELECT user_id AS "userId" FROM project_member WHERE project_id=$1`, [projectId]);
  for (const m of members) {
    await notify({ userId: m.userId, type: "meeting", title: `Meeting scheduled: ${String(formData.get("title") || "Meeting")}`,
      body: "A new project meeting has been scheduled.", link: `/projects/${projectId}`, email: true });
  }
  await writeAudit({ userId: user.id, action: "create", entity: "meeting", entityId: mid });
  revalidatePath(`/projects/${projectId}/calendar`);
  revalidatePath(`/projects/${projectId}`);
}

/* ---------------- Documents / folders ---------------- */
export async function deleteDocumentAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  const docId = String(formData.get("docId"));
  const doc = await one<{ storageKey: string | null; name: string }>(
    `SELECT storage_key AS "storageKey", name FROM project_document WHERE id=$1 AND project_id=$2`, [docId, projectId]);
  if (doc?.storageKey) await deleteUpload(doc.storageKey);
  await q(`DELETE FROM project_document WHERE id=$1 AND project_id=$2`, [docId, projectId]); // versions cascade
  await writeAudit({ userId: user.id, action: "delete", entity: "project_document", entityId: docId, before: { name: doc?.name } });
  revalidatePath(`/projects/${projectId}/documents`);
}

export async function addFolderAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,$3,$4)`,
    [id("fld"), projectId, String(formData.get("name") || "New folder"), String(formData.get("category") || "general")]);
  revalidatePath(`/projects/${projectId}/documents`);
}

export async function addDocumentAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  await q(`INSERT INTO project_document (id, project_id, folder_id, name, doc_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("doc"), projectId, String(formData.get("folderId") || "") || null,
     String(formData.get("name") || "Document"), String(formData.get("docType") || "other"), Number(formData.get("sizeBytes") || 0)]);
  revalidatePath(`/projects/${projectId}/documents`);
}

// Archive / unarchive a document (soft-hide; reversible) — for documents.manage holders.
export async function archiveDocumentAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  const docId = String(formData.get("docId"));
  const archived = String(formData.get("archived")) === "true";
  await q(`UPDATE project_document SET archived=$1 WHERE id=$2 AND project_id=$3`, [archived, docId, projectId]);
  await writeAudit({ userId: user.id, action: archived ? "archive" : "unarchive", entity: "project_document", entityId: docId });
  revalidatePath(`/projects/${projectId}/documents`);
}

export async function resolveFlagAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  await q(`UPDATE anomaly_flag SET resolved=true WHERE id=$1 AND project_id=$2`, [String(formData.get("flagId")), projectId]);
  revalidatePath(`/projects/${projectId}`);
}

/* ---------------- SOW ---------------- */
export async function ensureSowAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const existing = await one<{ id: string }>(`SELECT id FROM sow WHERE project_id=$1`, [projectId]);
  if (!existing) {
    const sid = id("sow");
    await q(`INSERT INTO sow (id, project_id, status) VALUES ($1,$2,'draft')`, [sid, projectId]);
    const defaults: [string, string][] = [
      ["background", "Project Background"], ["goal", "Goal"], ["objectives", "Objectives"],
      ["deliverables", "Deliverables"], ["reporting", "Reporting Requirements"],
      ["payment", "Payment Schedule"], ["assumptions", "Assumptions"],
    ];
    let order = 0;
    for (const [key, title] of defaults) {
      await q(`INSERT INTO sow_section (id, sow_id, key, title, content, "order") VALUES ($1,$2,$3,$4,'',$5)`,
        [id("sec"), sid, key, title, order++]);
    }
  }
  revalidatePath(`/projects/${projectId}/sow`);
}

export async function updateSowSectionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const sectionId = String(formData.get("sectionId"));
  await q(`UPDATE sow_section SET title=$2, content=$3 WHERE id=$1`,
    [sectionId, String(formData.get("title") || "Section"), String(formData.get("content") || "")]);
  await writeAudit({ userId: user.id, action: "update", entity: "sow_section", entityId: sectionId });
  revalidatePath(`/projects/${projectId}/sow`);
}

export async function approveSowAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const access = await getProjectAccess(projectId);
  if (access.role !== "pi" && access.role !== "co_pi") throw new Error("FORBIDDEN — only the Principal Investigator or a Co-PI can approve the SOW");
  await q(`UPDATE sow SET status='approved', approved_by_id=$2, approved_at=now() WHERE project_id=$1`, [projectId, user.id]);
  await writeAudit({ userId: user.id, action: "approve", entity: "sow", entityId: projectId });
  revalidatePath(`/projects/${projectId}/sow`);
}

/* ---------------- File upload: import & parse ---------------- */
const FOLDER_FOR_DOCTYPE: Record<string, [string, string]> = {
  proposal: ["Proposals", "proposals"], sow: ["Statements of Work", "sows"],
  budget: ["Budgets", "budgets"], workplan: ["Work plans", "general"],
};

export async function uploadAndParseAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const docType = String(formData.get("docType") || "proposal");
  // Importing a budget is senior-only; other document types need edit rights.
  if (docType === "budget") await requireBudgetBulk(projectId);
  else await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  const pasted = String(formData.get("text") || "");

  let fileName = String(formData.get("fileName") || "pasted-text.txt");
  let text = pasted;
  let rows: (string | number | Date)[][] | null = null;

  if (file && file.size > 0) {
    fileName = file.name;
    const buf = Buffer.from(await file.arrayBuffer());
    const res = await extractFile(fileName, buf);
    text = res.text;
    rows = res.rows;
    // store the raw file + index it in the Documents repository
    const docId = id("doc");
    const key = await saveUpload(docId, fileName, buf);
    const [folderName, folderCat] = FOLDER_FOR_DOCTYPE[docType] ?? ["Imported", "general"];
    let folder = await one<{ id: string }>(`SELECT id FROM folder WHERE project_id=$1 AND name=$2`, [projectId, folderName]);
    if (!folder) {
      const fid = id("fld");
      await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,$3,$4)`, [fid, projectId, folderName, folderCat]);
      folder = { id: fid };
    }
    await q(`INSERT INTO project_document (id, project_id, folder_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docId, projectId, folder.id, fileName, docType, mimeFor(fileName), key, buf.length, text.slice(0, 20000)]);
    await writeAudit({ userId: user.id, action: "upload", entity: "project_document", entityId: docId, after: { fileName } });
  }

  if (!text.trim()) redirect(`/projects/${projectId}/import`);
  const currency = docType === "budget" ? String(formData.get("currency") || "").trim() : "";
  const { jobId } = await createExtractionJob({ projectId, userId: user.id, fileName, docType, text, rows, currency: currency || null });
  redirect(`/projects/${projectId}/import/${jobId}`);
}

export async function uploadDocumentAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/projects/${projectId}/documents?upload=nofile`);
  const buf = Buffer.from(await file.arrayBuffer());
  const docId = id("doc");
  const key = await saveUpload(docId, file.name, buf);
  // best-effort text extraction for search/preview
  let extracted = "";
  try { extracted = (await extractFile(file.name, buf)).text.slice(0, 20000); } catch {}
  await q(`INSERT INTO project_document (id, project_id, folder_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [docId, projectId, String(formData.get("folderId") || "") || null, file.name,
     String(formData.get("docType") || "other"), mimeFor(file.name), key, buf.length, extracted]);
  await writeAudit({ userId: user.id, action: "upload", entity: "project_document", entityId: docId, after: { fileName: file.name } });
  redirect(`/projects/${projectId}/documents?upload=ok`);
}

/* ---------------- SOW upload & populate ---------------- */
import { parseSowSections, SOW_SECTION_TITLES, parseScheduleRows } from "@/server/services/parsing";

export async function uploadSowAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { revalidatePath(`/projects/${projectId}/sow`); return; }

  const buf = Buffer.from(await file.arrayBuffer());
  const { text } = await extractFile(file.name, buf);
  const sections = parseSowSections(text);

  // ensure a SOW exists
  let sow = await one<{ id: string }>(`SELECT id FROM sow WHERE project_id=$1`, [projectId]);
  if (!sow) { const sid = id("sow"); await q(`INSERT INTO sow (id, project_id, status) VALUES ($1,$2,'draft')`, [sid, projectId]); sow = { id: sid }; }

  let order = 0;
  for (const [key, content] of Object.entries(sections)) {
    if (!content.trim()) continue;
    const title = SOW_SECTION_TITLES[key] ?? key;
    const existing = await one<{ id: string }>(`SELECT id FROM sow_section WHERE sow_id=$1 AND key=$2`, [sow.id, key]);
    if (existing) {
      await q(`UPDATE sow_section SET content=$2, source_ref='import' WHERE id=$1`, [existing.id, content]);
    } else {
      await q(`INSERT INTO sow_section (id, sow_id, key, title, content, "order", source_ref) VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [id("sec"), sow.id, key, title, content, order++]);
    }
  }
  // also file the uploaded document
  const docId = id("doc");
  const skey = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
           VALUES ($1,$2,$3,'sows',$4,$5,$6,$7)`, [docId, projectId, file.name, mimeFor(file.name), skey, buf.length, text.slice(0, 20000)]);
  await writeAudit({ userId: user.id, action: "import", entity: "sow", entityId: projectId, after: { sections: Object.keys(sections).length } });
  revalidatePath(`/projects/${projectId}/sow`);
}

/* ---------------- Work plan: upload document/Gantt & populate ---------------- */
export async function uploadWorkplanAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { revalidatePath(`/projects/${projectId}/workplan`); return; }

  const buf = Buffer.from(await file.arrayBuffer());
  const { text, rows } = await extractFile(file.name, buf);

  let created = 0;
  let order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM activity WHERE project_id=$1`, [projectId]))?.m ?? 0;

  if (rows && rows.length) {
    // spreadsheet Gantt / schedule
    const items = parseScheduleRows(rows);
    for (const it of items) {
      await q(`INSERT INTO activity (id, project_id, code, title, status, progress, start_date, end_date, "order")
               VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7,$8)`,
        [id("act"), projectId, it.code, it.title, it.progress ?? 0, it.start, it.end, ++order]);
      created++;
    }
  }
  if (created === 0) {
    // narrative document → pull activity lines
    const sugs = parseSowSectionsToActivities(text);
    for (const a of sugs) {
      await q(`INSERT INTO activity (id, project_id, code, title, status, "order") VALUES ($1,$2,$3,$4,'not_started',$5)`,
        [id("act"), projectId, a.code, a.title, ++order]);
      created++;
    }
  }

  const docId = id("doc");
  const skey = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
           VALUES ($1,$2,$3,'general',$4,$5,$6,$7)`, [docId, projectId, file.name, mimeFor(file.name), skey, buf.length, text.slice(0, 20000)]);
  await recomputeRollups(projectId);
  await writeAudit({ userId: user.id, action: "import", entity: "activity", entityId: projectId, after: { created } });
  revalidatePath(`/projects/${projectId}/workplan`);
}

// lightweight activity-line extraction from narrative text
function parseSowSectionsToActivities(text: string): { code: string | null; title: string }[] {
  const out: { code: string | null; title: string }[] = [];
  for (const raw of text.split(/\r?\n/).map((l) => l.trim())) {
    const act = raw.match(/^(?:activity|task)\s*([\d.]+)?\s*[:\-]\s*(.+)$/i);
    if (act) { out.push({ code: act[1] ?? null, title: act[2].trim().slice(0, 200) }); continue; }
    const num = raw.match(/^(\d+(?:\.\d+)+)\s+(.{4,})$/);
    if (num) out.push({ code: num[1], title: num[2].trim().slice(0, 200) });
  }
  return out.slice(0, 200);
}

/* ---------------- Work plan from budget lines ---------------- */
export async function workplanFromBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const lines = await q<{ code: string; description: string; id: string }>(
    `SELECT bl.code, bl.description, bl.id FROM budget_line bl
     JOIN budget b ON b.id=bl.budget_id WHERE b.project_id=$1 ORDER BY bl.code`, [projectId]
  );
  let order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM activity WHERE project_id=$1`, [projectId]))?.m ?? 0;
  let created = 0;
  for (const l of lines) {
    const title = l.description.length > 90 ? l.description.slice(0, 88) + "…" : l.description;
    await q(`INSERT INTO activity (id, project_id, code, title, status, "order", budget_line_id) VALUES ($1,$2,$3,$4,'not_started',$5,$6)`,
      [id("act"), projectId, l.code, title, ++order, l.id]);
    created++;
  }
  await recomputeRollups(projectId);
  await writeAudit({ userId: user.id, action: "create", entity: "activity", entityId: projectId, after: { fromBudget: created } });
  revalidatePath(`/projects/${projectId}/workplan`);
}

/* ---------------- Budget currency conversion ---------------- */
export async function convertBudgetCurrencyAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const rate = Number(formData.get("rate") || 0);
  const newCurrency = String(formData.get("newCurrency") || "").trim().toUpperCase();
  if (!rate || rate <= 0) { revalidatePath(`/projects/${projectId}/budget`); return; }

  // Convert the WHOLE project: budget plan, spending/commitments, requisitions,
  // vouchers, invoices/receipts, procurement, sub-awards, and the project's own
  // ledger postings (scaled whole-entry so each stays balanced).
  const res = await reDenominateProject(projectId, rate, newCurrency || undefined);
  await evaluateProject(projectId);
  await writeAudit({ userId: user.id, action: "update", entity: "project_currency", entityId: projectId, after: { rate, newCurrency: res?.newCurrency, counts: res?.counts } });

  for (const p of [
    `/projects/${projectId}/budget`, `/projects/${projectId}`,
    `/projects/${projectId}/requisitions`, `/projects/${projectId}/expenditure`,
    `/finance`, `/finance/statements`,
  ]) revalidatePath(p);
}

/* ---------------- Account & password flows ---------------- */
export async function requestPasswordResetAction(formData: FormData) {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  if (email) {
    const u = await one<{ id: string; name: string }>(`SELECT id, name FROM app_user WHERE email=$1`, [email]);
    if (u) await issuePasswordToken(u.id, "reset", email, u.name);
  }
  // never reveal whether the email exists
  redirect("/forgot?sent=1");
}

export async function setPasswordAction(formData: FormData) {
  const token = String(formData.get("token") || "");
  const password = String(formData.get("password") || "");
  const confirm = String(formData.get("confirmPassword") || "");
  if (confirm && password !== confirm) redirect(`/reset?token=${encodeURIComponent(token)}&error=match`);
  const pe = passwordError(password);
  if (pe) redirect(`/reset?token=${encodeURIComponent(token)}&error=policy`);
  const valid = await consumePasswordToken(token);
  if (!valid) redirect(`/reset?error=invalid`);
  await q(`UPDATE app_user SET password_hash=$2, status='active', updated_at=now() WHERE id=$1`,
    [valid.userId, await hashPassword(password)]);
  await markTokenUsed(token);
  await createSession(valid.userId);
  redirect("/dashboard");
}

export async function setSuperAdminAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN — only platform admins can change platform-admin access");
  const targetId = String(formData.get("userId"));
  const makeSuper = String(formData.get("value")) === "true";
  // You can't change your own platform-admin status (prevents self-lockout).
  if (targetId === user.id) redirect("/admin?su=self");
  await q(`UPDATE app_user SET is_super_admin=$2, updated_at=now() WHERE id=$1`, [targetId, makeSuper]);
  await writeAudit({ userId: user.id, action: "update", entity: "app_user", entityId: targetId, after: { isSuperAdmin: makeSuper } });
  revalidatePath("/admin");
  redirect("/admin?su=ok");
}

export async function createAdminAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN — only platform admins can create admins");
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const name = String(formData.get("name") || "");
  if (email) await createAdminAccount(email, name, user.id);
  revalidatePath("/admin");
}

/* ---------------- Archive ---------------- */
export async function setProjectStatusAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.administer");
  const requested = String(formData.get("status") || "");
  const status = (PROJECT_STATUS as readonly string[]).includes(requested) ? requested : "active";
  await q(`UPDATE project SET status=$2, updated_at=now() WHERE id=$1`, [projectId, status]);
  await writeAudit({ userId: user.id, action: "update", entity: "project", entityId: projectId, after: { status } });
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
}

// Backwards-compatible alias (older imports)
export async function archiveProjectAction(formData: FormData) {
  return setProjectStatusAction(formData);
}

// Permanently deletes a project and everything connected to it — including all payments.
// Most project-scoped tables cascade through their project foreign key. Three tables
// reference budget_line with RESTRICT (expenditure, commitment, requisition), and the
// org-scoped finance documents (receipts, invoices, slips, vouchers, fixed assets) plus
// the project's ledger entries are nullable / un-keyed — so those are removed explicitly
// first, in dependency order, before the project itself is deleted.
export async function deleteProjectAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.administer");
  const proj = await one<{ orgId: string; code: string; title: string }>(`SELECT org_id AS "orgId", code, title FROM project WHERE id=$1`, [projectId]);
  if (!proj) redirect("/projects");
  // Org-scoped finance documents (receipt → invoice is RESTRICT, so receipts first).
  await q(`DELETE FROM receipt WHERE project_id=$1 OR invoice_id IN (SELECT id FROM invoice WHERE project_id=$1)`, [projectId]);
  await q(`DELETE FROM invoice WHERE project_id=$1`, [projectId]);            // invoice lines cascade
  await q(`DELETE FROM payment_slip WHERE project_id=$1`, [projectId]);       // FK would only null these; payees cascade
  await q(`DELETE FROM payment_voucher WHERE project_id=$1`, [projectId]);    // standalone/requisition vouchers tagged to the project
  await q(`DELETE FROM fixed_asset WHERE project_id=$1`, [projectId]);
  // RESTRICT paths to budget_line — remove before the budgets cascade.
  await q(`DELETE FROM expenditure WHERE project_id=$1`, [projectId]);
  await q(`DELETE FROM commitment WHERE project_id=$1`, [projectId]);
  await q(`DELETE FROM requisition WHERE project_id=$1`, [projectId]);        // cascades approvals/activities + any remaining vouchers
  // Un-match any bank statement lines reconciled against this project's entries before
  // those entries are removed, so the bank reconciliation doesn't show phantom matches.
  await q(`UPDATE bank_statement_line SET matched_entry_id=NULL, reconciled=false WHERE matched_entry_id IN (SELECT id FROM journal_entry WHERE project_id=$1)`, [projectId]);
  // The project's ledger entries (journal lines cascade). Removing balanced project
  // entries keeps the rest of the ledger balanced.
  await q(`DELETE FROM journal_entry WHERE project_id=$1`, [projectId]);
  // Finally the project — cascades budgets, budget lines, activities, tasks, objectives,
  // SOW, reports, documents, members, risks, meetings, calendar, etc.
  await q(`DELETE FROM project WHERE id=$1`, [projectId]);
  await writeAudit({ orgId: proj.orgId, userId: user.id, action: "delete", entity: "project", entityId: proj.code, before: { title: proj.title, deletedConnectedRecords: true } });
  redirect(`/projects?deleted=${encodeURIComponent(proj.code)}`);
}

/* ---------------- Risks & issues ---------------- */
export async function addRiskAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`INSERT INTO risk_issue (id, project_id, kind, title, detail, severity, likelihood, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
    [id("risk"), projectId, String(formData.get("kind") || "risk"),
     String(formData.get("title") || "Risk"), String(formData.get("detail") || ""),
     String(formData.get("severity") || "medium"), String(formData.get("likelihood") || "medium")]);
  await writeAudit({ userId: user.id, action: "create", entity: "risk_issue", entityId: projectId });
  revalidatePath(`/projects/${projectId}/risks`);
  revalidatePath(`/projects/${projectId}`);
}

export async function updateRiskStatusAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const riskId = String(formData.get("riskId"));
  await q(`UPDATE risk_issue SET status=$2 WHERE id=$1 AND project_id=$3`,
    [riskId, String(formData.get("status") || "open"), projectId]);
  await writeAudit({ userId: user.id, action: "update", entity: "risk_issue", entityId: riskId });
  revalidatePath(`/projects/${projectId}/risks`);
}

/* ---------------- Commercial: org signup + trial ---------------- */
export async function signupOrganizationAction(formData: FormData) {
  const res = await signupOrganization({
    orgName: String(formData.get("orgName") || ""),
    adminName: String(formData.get("adminName") || ""),
    adminEmail: String(formData.get("adminEmail") || ""),
    password: String(formData.get("password") || ""),
    confirmPassword: String(formData.get("confirmPassword") || ""),
  });
  if ("error" in res) redirect(`/signup?error=${encodeURIComponent(res.error)}`);
  // Account created but not yet active — they must confirm via email first.
  redirect(`/signup?pending=1`);
}

/* ---------------- Operator: organisation provisioning & lifecycle ---------------- */
export async function sendTestEmailAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN — only the platform admin can send test emails");
  const to = String(formData.get("to") || "").trim() || SYSTEM_ADMIN_EMAIL;
  const provider = process.env.EMAIL_PROVIDER || "console";
  const res = await sendEmail({
    to,
    subject: "Project Strand — test email",
    html: `<p>This is a test email from Project Strand.</p><p>If you can read this, outbound email is working.</p>`,
  });
  if (res.status === "sent") redirect(`/admin?test=ok&to=${encodeURIComponent(to)}&via=${provider}`);
  redirect(`/admin?testerror=${encodeURIComponent(res.error || "unknown error")}&via=${provider}`);
}

export async function createOrganizationAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN — only the platform admin can create organisations");
  const res = await createOrganizationWithAdmin({
    orgName: String(formData.get("orgName") || ""),
    adminName: String(formData.get("adminName") || ""),
    adminEmail: String(formData.get("adminEmail") || ""),
    trialDays: Number(formData.get("trialDays") || 90),
  });
  if ("error" in res) redirect(`/admin?error=${encodeURIComponent(res.error)}`);
  revalidatePath("/admin");
  redirect("/admin?created=1");
}

export async function setOrgStateAction(formData: FormData) {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN");
  const action = String(formData.get("action")) as "activate" | "suspend" | "extend";
  await setOrgState(String(formData.get("orgId")), action, Number(formData.get("days") || 90));
  revalidatePath("/admin");
}

export async function requestUpgradeAction() {
  const user = await requireUser();
  await requestUpgrade(user.id);
  redirect("/upgrade?sent=1");
}

/* ---------------- Objectives / Logframe ---------------- */
export async function addObjectiveAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM objective WHERE project_id=$1`, [projectId]))?.m ?? 0;
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM objective WHERE project_id=$1`, [projectId]))?.c ?? 0;
  await q(`INSERT INTO objective (id, project_id, level, code, statement, narrative, "order") VALUES ($1,$2,'objective',$3,$4,$5,$6)`,
    [id("obj"), projectId, String(formData.get("code") || `OBJ${n + 1}`), String(formData.get("statement") || "Objective"),
     String(formData.get("narrative") || "") || null, order + 1]);
  await writeAudit({ userId: user.id, action: "create", entity: "objective", entityId: projectId });
  revalidatePath(`/projects/${projectId}/logframe`);
}

export async function deleteObjectiveAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const objectiveId = String(formData.get("objectiveId"));
  await requirePermission(projectId, "project.edit");
  await q(`DELETE FROM indicator WHERE output_id IN (SELECT id FROM output WHERE objective_id=$1)`, [objectiveId]);
  await q(`DELETE FROM output WHERE objective_id=$1`, [objectiveId]);
  await q(`DELETE FROM objective WHERE id=$1 AND project_id=$2`, [objectiveId, projectId]); // cascades its indicators + actuals
  await writeAudit({ userId: user.id, action: "delete", entity: "objective", entityId: objectiveId });
  revalidatePath(`/projects/${projectId}/logframe`);
}

export async function addIndicatorAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`INSERT INTO indicator (id, objective_id, name, unit, baseline, target, means_of_verification)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("ind"), String(formData.get("objectiveId")), String(formData.get("name") || "Indicator"),
     String(formData.get("unit") || ""), Number(formData.get("baseline") || 0), Number(formData.get("target") || 0),
     String(formData.get("mov") || "") || null]);
  await writeAudit({ userId: user.id, action: "create", entity: "indicator", entityId: projectId });
  revalidatePath(`/projects/${projectId}/logframe`);
}

export async function deleteIndicatorAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`DELETE FROM indicator WHERE id=$1`, [String(formData.get("indicatorId"))]); // actuals cascade
  await writeAudit({ userId: user.id, action: "delete", entity: "indicator", entityId: String(formData.get("indicatorId")) });
  revalidatePath(`/projects/${projectId}/logframe`);
}

// Edit an objective / goal in place.
export async function updateObjectiveAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const objectiveId = String(formData.get("objectiveId"));
  const before = await one(`SELECT code, statement, narrative, level FROM objective WHERE id=$1 AND project_id=$2`, [objectiveId, projectId]);
  const after = {
    code: String(formData.get("code") || "OBJ"),
    statement: String(formData.get("statement") || "Objective").slice(0, 500),
    narrative: String(formData.get("narrative") || "") || null,
    level: String(formData.get("level") || "objective") === "goal" ? "goal" : "objective",
  };
  await q(`UPDATE objective SET code=$1, statement=$2, narrative=$3, level=$4 WHERE id=$5 AND project_id=$6`,
    [after.code, after.statement, after.narrative, after.level, objectiveId, projectId]);
  await writeAudit({ userId: user.id, action: "update", entity: "objective", entityId: objectiveId, before, after });
  revalidatePath(`/projects/${projectId}/logframe`);
}

// Edit an indicator's definition (name, unit, baseline, target, verification, assumptions).
export async function updateIndicatorAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const indicatorId = String(formData.get("indicatorId"));
  await q(`UPDATE indicator SET name=$1, unit=$2, baseline=$3, target=$4, means_of_verification=$5, assumptions=$6 WHERE id=$7`,
    [String(formData.get("name") || "Indicator"), String(formData.get("unit") || ""),
     Number(formData.get("baseline") || 0), Number(formData.get("target") || 0),
     String(formData.get("mov") || "") || null, String(formData.get("assumptions") || "") || null, indicatorId]);
  await writeAudit({ userId: user.id, action: "update", entity: "indicator", entityId: indicatorId });
  revalidatePath(`/projects/${projectId}/logframe`);
}

// Record a periodic actual reading against an indicator — this is the monitoring log.
// The most recent reading (by recorded_at) becomes the indicator's "latest" value.
export async function recordIndicatorActualAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const indicatorId = String(formData.get("indicatorId"));
  const period = String(formData.get("period") || "").trim() || new Date().toISOString().slice(0, 10);
  const value = Number(formData.get("value") || 0);
  const note = String(formData.get("note") || "").trim() || null;
  await q(`INSERT INTO indicator_actual (id, indicator_id, period, value, note) VALUES ($1,$2,$3,$4,$5)`,
    [id("iact"), indicatorId, period, value, note]);
  await writeAudit({ userId: user.id, action: "record", entity: "indicator_actual", entityId: indicatorId, after: { period, value, note } });
  revalidatePath(`/projects/${projectId}/logframe`);
}

export async function deleteIndicatorActualAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`DELETE FROM indicator_actual WHERE id=$1`, [String(formData.get("actualId"))]);
  await writeAudit({ userId: user.id, action: "delete", entity: "indicator_actual", entityId: String(formData.get("actualId")) });
  revalidatePath(`/projects/${projectId}/logframe`);
}

// Connect (or disconnect) a work-plan activity to a logframe output, so the
// results framework shows the activities — and their live budget — under each output.
export async function linkActivityToOutputAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const activityId = String(formData.get("activityId"));
  if (!activityId) { revalidatePath(`/projects/${projectId}/logframe`); return; }
  const outputId = String(formData.get("outputId") || "") || null;
  await q(`UPDATE activity SET output_id=$2, updated_at=now() WHERE id=$1 AND project_id=$3`, [activityId, outputId, projectId]);
  await writeAudit({ userId: user.id, action: "update", entity: "activity", entityId: activityId, after: { output_id: outputId } });
  revalidatePath(`/projects/${projectId}/logframe`);
}

export async function uploadObjectivesAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/projects/${projectId}/logframe?imported=nofile`);

  const buf = Buffer.from(await file.arrayBuffer());
  const { text, rows } = await extractFile(file.name, buf);
  const suggestions = parseDocument("proposal", text, rows);

  let order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM objective WHERE project_id=$1`, [projectId]))?.m ?? 0;
  const objByCode = new Map<string, string>();
  let objN = 0, outN = 0, created = 0;

  for (const s of suggestions.filter((x) => x.kind === "objective")) {
    const p = s.payload as { code?: string; statement?: string };
    const oid = id("obj");
    objN++;
    const code = p.code || `OBJ${objN}`;
    await q(`INSERT INTO objective (id, project_id, level, code, statement, "order") VALUES ($1,$2,'objective',$3,$4,$5)`,
      [oid, projectId, code, (p.statement || "Objective").slice(0, 500), ++order]);
    objByCode.set(code, oid);
    if (p.code) objByCode.set(p.code, oid);
    created++;
  }
  for (const s of suggestions.filter((x) => x.kind === "output")) {
    const p = s.payload as { code?: string; statement?: string; objectiveCode?: string };
    outN++;
    await q(`INSERT INTO output (id, project_id, objective_id, code, statement, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("out"), projectId, p.objectiveCode ? objByCode.get(p.objectiveCode) ?? null : null,
       p.code || `OUT${outN}`, (p.statement || "Output").slice(0, 500), ++order]);
    created++;
  }

  const docId = id("doc");
  const skey = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
           VALUES ($1,$2,$3,'proposal',$4,$5,$6,$7)`, [docId, projectId, file.name, mimeFor(file.name), skey, buf.length, text.slice(0, 20000)]);
  await writeAudit({ userId: user.id, action: "import", entity: "objective", entityId: projectId, after: { created } });
  redirect(`/projects/${projectId}/logframe?imported=${created}`);
}

/* ---------------- Requisition attachments, vouchers ---------------- */
export async function addRequisitionAttachmentAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("requisitionId"));
  const access = await getProjectAccess(projectId);
  if (!access.permissions.has("requisitions.create") && !access.permissions.has("requisitions.approve"))
    throw new Error("FORBIDDEN");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/projects/${projectId}/requisitions/${reqId}`);
  const buf = Buffer.from(await file.arrayBuffer());
  const aid = id("ratt");
  const key = await saveUpload(aid, file.name, buf);
  await q(`INSERT INTO requisition_attachment (id, requisition_id, name, storage_key, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [aid, reqId, file.name, key, mimeFor(file.name), buf.length, user.id]);
  await writeAudit({ userId: user.id, action: "upload", entity: "requisition", entityId: reqId, after: { attachment: file.name } });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
}

export async function createVoucherAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("requisitionId"));
  await requirePermission(projectId, "budget.manage");
  const amount = Number(formData.get("amount") || 0);
  const payee = String(formData.get("payee") || "").trim();
  if (!payee || amount <= 0) redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=invalid`);

  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM payment_voucher WHERE project_id=$1`, [projectId]))?.c ?? 0;
  const vid = id("pv");
  // A new voucher starts at the 'prepared' stage — no payment is made yet.
  await q(`INSERT INTO payment_voucher (id, project_id, requisition_id, number, payee, amount, method, reference, purpose, prepared_by, prepared_by_name, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared')`,
    [vid, projectId, reqId, `PV-${String(n + 1).padStart(4, "0")}`, payee, amount,
     String(formData.get("method") || "bank_transfer"), String(formData.get("reference") || "") || null,
     String(formData.get("purpose") || "") || null, user.id, user.name]);

  await writeAudit({ userId: user.id, action: "create", entity: "payment_voucher", entityId: vid, after: { payee, amount, status: "prepared" } });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=ok`);
}

// Record a STANDALONE payment voucher (not tied to a requisition) and post it to the
// general ledger so it flows into the monthly bank reconciliation as a cash payment.
export async function createStandaloneVoucherAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const payee = String(formData.get("payee") || "").trim();
  const amount = Number(formData.get("amount") || 0);
  const accountId = String(formData.get("accountId") || "");          // cash/bank credited
  const expenseAccountId = String(formData.get("expenseAccountId") || ""); // debited
  const date = String(formData.get("voucherDate") || new Date().toISOString().slice(0, 10));
  if (!payee || amount <= 0 || !accountId || !expenseAccountId) redirect("/finance/vouchers?err=invalid");
  let projectId = String(formData.get("projectId") || "") || null;
  const purpose = String(formData.get("purpose") || "") || null;
  const reference = String(formData.get("reference") || "") || null;
  const method = String(formData.get("method") || "bank_transfer");
  // Optional budget line. Picking one ties the voucher to a project budget line so
  // it reduces that line; derive the project from the line so the ledger entry is
  // project-tagged before we post.
  const budgetLineId = String(formData.get("budgetLineId") || "") || null;
  if (budgetLineId) {
    const line = await one<{ projectId: string }>(
      `SELECT p.id AS "projectId" FROM budget_line bl JOIN budget b ON b.id=bl.budget_id JOIN project p ON p.id=b.project_id
       WHERE bl.id=$1 AND p.org_id=$2`, [budgetLineId, orgId]);
    if (line) projectId = projectId ?? line.projectId;
  }
  const num = await nextNum(orgId, "payment_voucher", "PV");
  const vid = id("pv");
  // Recorded as PREPARED and checked by Finance. It does NOT post to the ledger or
  // deduct the budget yet — both happen when an assigned approver approves it.
  await q(`INSERT INTO payment_voucher (id, org_id, project_id, requisition_id, number, voucher_date, payee, amount, method, reference, purpose, account_id, expense_account_id, prepared_by, prepared_by_name, checked_by, checked_by_name, checked_at, status, budget_line_id)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$14,now(),'prepared',$15)`,
    [vid, orgId, projectId, num, date, payee, amount, method, reference, purpose, accountId, expenseAccountId, userId, userName, budgetLineId]);
  await writeAudit({ orgId, userId, action: "create", entity: "payment_voucher", entityId: num, after: { payee, amount, status: "prepared" } });
  redirect(`/finance/vouchers/${vid}?created=${num}`);
}

// Loads a voucher in the caller's org or bounces back to the list.
async function loadVoucher(vid: string, orgId: string): Promise<{ id: string; status: string; projectId: string | null }> {
  const v = await one<{ id: string; status: string; projectId: string | null }>(
    `SELECT id, COALESCE(status,'prepared') AS status, project_id AS "projectId" FROM payment_voucher WHERE id=$1 AND org_id=$2`, [vid, orgId]);
  if (!v) redirect("/finance/vouchers");
  return v;
}

// Org admin OR the designated approver may approve/decline a voucher.
async function canApproveVoucher(userId: string, orgId: string, approverId: string | null): Promise<boolean> {
  const admin = await one(`SELECT 1 FROM org_membership m JOIN role r ON r.id=m.role_id
                           WHERE m.org_id=$1 AND m.user_id=$2 AND r.key='org_admin'`, [orgId, userId]);
  if (admin) return true;
  return approverId != null && approverId === userId;
}

// Posts an approved voucher to the ledger and (if linked) records the budget-line
// expenditure. Each side-effect is independently idempotent (guarded by
// journal_entry_id / expenditure_id), so it is safe to call more than once.
async function postApprovedVoucher(vid: string, by: { id: string; name: string }) {
  const v = await one<{
    orgId: string; projectId: string | null; budgetLineId: string | null; expenditureId: string | null;
    journalEntryId: string | null; number: string; payee: string; purpose: string | null;
    amount: number; date: string; accountId: string | null; expenseAccountId: string | null;
  }>(`SELECT org_id AS "orgId", project_id AS "projectId", budget_line_id AS "budgetLineId",
             expenditure_id AS "expenditureId", journal_entry_id AS "journalEntryId", number, payee, purpose,
             amount::float, COALESCE(voucher_date::text, created_at::text) AS date,
             account_id AS "accountId", expense_account_id AS "expenseAccountId"
        FROM payment_voucher WHERE id=$1`, [vid]);
  if (!v) return;
  // 1. Post the cash movement (debit expense, credit cash/bank) once.
  if (!v.journalEntryId && v.accountId && v.expenseAccountId && v.amount > 0) {
    const posted = await postJournal({
      orgId: v.orgId, entryDate: v.date.slice(0, 10),
      memo: `Voucher ${v.number} — ${v.payee}${v.purpose ? ` · ${v.purpose}` : ""}`,
      reference: v.number, sourceType: "voucher", sourceId: vid, projectId: v.projectId,
      postedBy: by.id, postedByName: by.name,
      lines: [
        { accountId: v.expenseAccountId, debit: v.amount, description: v.purpose ?? v.payee, projectId: v.projectId },
        { accountId: v.accountId, credit: v.amount, description: `Payment to ${v.payee}`, projectId: v.projectId },
      ],
    });
    await q(`UPDATE payment_voucher SET journal_entry_id=$2 WHERE id=$1`, [vid, posted.entryId]);
  }
  // 2. Record the budget-line expenditure once, WITHOUT re-posting to the ledger
  //    (the entry above already moved the cash). Drives the live budget deduction.
  if (v.budgetLineId && v.projectId && !v.expenditureId) {
    const expId = id("exp");
    await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
      [expId, v.projectId, v.budgetLineId, v.amount, v.date.slice(0, 10), v.number, v.payee, by.id]);
    await q(`UPDATE payment_voucher SET expenditure_id=$2 WHERE id=$1`, [vid, expId]);
    await writeAudit({ orgId: v.orgId, userId: by.id, action: "create", entity: "expenditure", entityId: expId, after: { amount: v.amount, fromVoucher: v.number, budgetLineId: v.budgetLineId } });
    await evaluateProject(v.projectId);
    revalidatePath(`/projects/${v.projectId}/budget`);
    revalidatePath(`/projects/${v.projectId}/spending`);
  }
  revalidatePath(`/finance/statements`);
}

// Finance edits a voucher (only while it is still prepared/declined — once approved
// and posted it is locked; delete & re-create instead).
export async function updateVoucherAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const vid = String(formData.get("voucherId"));
  const cur = await loadVoucher(vid, orgId);
  if (cur.status === "paid") redirect(`/finance/vouchers/${vid}?err=locked`);
  const payee = String(formData.get("payee") || "").trim();
  const amount = Number(formData.get("amount") || 0);
  const accountId = String(formData.get("accountId") || "");
  const expenseAccountId = String(formData.get("expenseAccountId") || "");
  if (!payee || amount <= 0 || !accountId || !expenseAccountId) redirect(`/finance/vouchers/${vid}?err=invalid`);
  const date = String(formData.get("voucherDate") || new Date().toISOString().slice(0, 10));
  let projectId = String(formData.get("projectId") || "") || null;
  const purpose = String(formData.get("purpose") || "") || null;
  const reference = String(formData.get("reference") || "") || null;
  const method = String(formData.get("method") || "bank_transfer");
  const budgetLineId = String(formData.get("budgetLineId") || "") || null;
  if (budgetLineId) {
    const line = await one<{ projectId: string }>(
      `SELECT p.id AS "projectId" FROM budget_line bl JOIN budget b ON b.id=bl.budget_id JOIN project p ON p.id=b.project_id
       WHERE bl.id=$1 AND p.org_id=$2`, [budgetLineId, orgId]);
    if (line) projectId = projectId ?? line.projectId;
  }
  await q(`UPDATE payment_voucher SET payee=$2, amount=$3, account_id=$4, expense_account_id=$5, voucher_date=$6,
           project_id=$7, purpose=$8, reference=$9, method=$10, budget_line_id=$11 WHERE id=$1`,
    [vid, payee, amount, accountId, expenseAccountId, date, projectId, purpose, reference, method, budgetLineId]);
  await writeAudit({ orgId, userId, action: "update", entity: "payment_voucher", entityId: vid, after: { payee, amount } });
  redirect(`/finance/vouchers/${vid}?updated=1`);
}

// Finance deletes a voucher. If it was already approved & posted, reverse its ledger
// entry and remove its budget expenditure first so the books stay balanced and the
// budget line is restored.
export async function deleteVoucherAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const vid = String(formData.get("voucherId"));
  const v = await one<{ number: string; payee: string; amount: number; status: string; journalEntryId: string | null; expenditureId: string | null; projectId: string | null }>(
    `SELECT number, payee, amount::float, COALESCE(status,'prepared') AS status, journal_entry_id AS "journalEntryId",
            expenditure_id AS "expenditureId", project_id AS "projectId" FROM payment_voucher WHERE id=$1 AND org_id=$2`, [vid, orgId]);
  if (!v) redirect("/finance/vouchers");
  if (v.journalEntryId) { try { await reverseJournal(orgId, v.journalEntryId, { id: userId, name: userName }); } catch { /* best effort */ } }
  if (v.expenditureId) {
    await q(`DELETE FROM expenditure WHERE id=$1`, [v.expenditureId]);
    if (v.projectId) { await evaluateProject(v.projectId); revalidatePath(`/projects/${v.projectId}/budget`); revalidatePath(`/projects/${v.projectId}/spending`); }
  }
  await q(`DELETE FROM payment_voucher WHERE id=$1 AND org_id=$2`, [vid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "payment_voucher", entityId: v.number, before: { payee: v.payee, amount: v.amount, status: v.status } });
  revalidatePath(`/finance/statements`);
  redirect(`/finance/vouchers?deleted=${v.number}`);
}

// Finance designates the approver (any employee) and notifies them to log in.
export async function assignVoucherApproverAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const vid = String(formData.get("voucherId"));
  await loadVoucher(vid, orgId);
  const approverId = String(formData.get("approverId") || "");
  if (!approverId) redirect(`/finance/vouchers/${vid}?err=approver`);
  const u = await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [approverId]);
  if (!u) redirect(`/finance/vouchers/${vid}?err=approver`);
  await q(`UPDATE payment_voucher SET approver_id=$2, approver_name=$3 WHERE id=$1`, [vid, approverId, u.name]);
  const meta = await one<{ payee: string; number: string }>(`SELECT payee, number FROM payment_voucher WHERE id=$1`, [vid]);
  await notify({
    orgId, userId: approverId, type: "approval_request",
    title: `Voucher approval needed: ${meta?.number ?? "payment"}`,
    body: `You have been asked to approve payment voucher ${meta?.number ?? ""} (payee ${meta?.payee ?? ""}). Please log in to approve or decline.`,
    link: `/finance/vouchers/${vid}`, email: true,
  });
  await writeAudit({ orgId, userId, action: "assign", entity: "payment_voucher", entityId: vid, after: { approverId } });
  redirect(`/finance/vouchers/${vid}?assigned=1`);
}

export async function remindVoucherApproverAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const vid = String(formData.get("voucherId"));
  await loadVoucher(vid, orgId);
  const v = await one<{ approverId: string | null; payee: string; number: string }>(
    `SELECT approver_id AS "approverId", payee, number FROM payment_voucher WHERE id=$1`, [vid]);
  if (v?.approverId) {
    await notify({
      orgId, userId: v.approverId, type: "approval_request",
      title: `Reminder — voucher approval needed: ${v.number}`,
      body: `Please log in to approve or decline payment voucher ${v.number} (payee ${v.payee}).`,
      link: `/finance/vouchers/${vid}`, email: true,
    });
  }
  redirect(`/finance/vouchers/${vid}?notified=1`);
}

// The designated approver (or an org admin) approves & signs a standalone payment
// voucher. On approval the voucher posts to the ledger and deducts the linked budget line.
export async function approvePaymentVoucherAction(formData: FormData) {
  const user = await requireUser();
  const vid = String(formData.get("voucherId"));
  const v = await one<{ orgId: string; approverId: string | null; status: string }>(
    `SELECT org_id AS "orgId", approver_id AS "approverId", COALESCE(status,'prepared') AS status FROM payment_voucher WHERE id=$1`, [vid]);
  if (!v) redirect("/dashboard");
  if (!(await canApproveVoucher(user.id, v.orgId, v.approverId))) redirect(`/finance/vouchers/${vid}?err=forbidden`);
  if (v.status === "paid") redirect(`/finance/vouchers/${vid}`);
  const signature = String(formData.get("signature") || "") || null;
  try {
    await postApprovedVoucher(vid, { id: user.id, name: user.name });
  } catch (e) {
    redirect(`/finance/vouchers/${vid}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`);
  }
  await q(`UPDATE payment_voucher SET approved_by=$2, approved_by_name=$3, approved_at=now(),
           approver_signature=COALESCE($4, approver_signature), status='paid' WHERE id=$1`,
    [vid, user.id, user.name, signature]);
  await writeAudit({ orgId: v.orgId, userId: user.id, action: "approve", entity: "payment_voucher", entityId: vid, after: { approved: true } });
  const prep = await one<{ preparedBy: string | null; number: string }>(`SELECT prepared_by AS "preparedBy", number FROM payment_voucher WHERE id=$1`, [vid]);
  if (prep?.preparedBy && prep.preparedBy !== user.id) {
    await notify({ orgId: v.orgId, userId: prep.preparedBy, type: "approval_decision", title: `Voucher ${prep.number} approved`, body: `${user.name} approved voucher ${prep.number}; it has been posted to the ledger.`, link: `/finance/vouchers/${vid}`, email: true });
  }
  redirect(`/finance/vouchers/${vid}?approved=1`);
}

export async function declineVoucherAction(formData: FormData) {
  const user = await requireUser();
  const vid = String(formData.get("voucherId"));
  const v = await one<{ orgId: string; approverId: string | null; status: string }>(
    `SELECT org_id AS "orgId", approver_id AS "approverId", COALESCE(status,'prepared') AS status FROM payment_voucher WHERE id=$1`, [vid]);
  if (!v) redirect("/dashboard");
  if (!(await canApproveVoucher(user.id, v.orgId, v.approverId))) redirect(`/finance/vouchers/${vid}?err=forbidden`);
  if (v.status === "paid") redirect(`/finance/vouchers/${vid}?err=alreadypaid`);
  const reason = String(formData.get("reason") || "").trim() || null;
  await q(`UPDATE payment_voucher SET status='declined', decline_reason=$2 WHERE id=$1`, [vid, reason]);
  await writeAudit({ orgId: v.orgId, userId: user.id, action: "decline", entity: "payment_voucher", entityId: vid, after: { declined: true, reason, by: user.name } });
  const prep = await one<{ preparedBy: string | null; number: string }>(`SELECT prepared_by AS "preparedBy", number FROM payment_voucher WHERE id=$1`, [vid]);
  if (prep?.preparedBy && prep.preparedBy !== user.id) {
    await notify({ orgId: v.orgId, userId: prep.preparedBy, type: "approval_decision", title: `Voucher ${prep.number} declined`, body: `${user.name} declined voucher ${prep.number}.${reason ? ` Reason: ${reason}` : ""}`, link: `/finance/vouchers/${vid}`, email: true });
  }
  redirect(`/finance/vouchers/${vid}?declined=1`);
}

/* ===================== PAYMENT SLIPS (bulk/individual + e-signing) ===================== */

async function loadSlip(slipId: string, orgId: string): Promise<{ id: string; projectId: string | null; status: string }> {
  const s = await one<{ id: string; projectId: string | null; status: string }>(
    `SELECT id, project_id AS "projectId", status FROM payment_slip WHERE id=$1 AND org_id=$2`, [slipId, orgId]);
  if (!s) redirect("/finance/payment-slips");
  return s;
}

async function canSignAsApprover(userId: string, orgId: string, approverId: string | null): Promise<boolean> {
  const admin = await one(`SELECT 1 FROM org_membership m JOIN role r ON r.id=m.role_id
                           WHERE m.org_id=$1 AND m.user_id=$2 AND r.key='org_admin'`, [orgId, userId]);
  if (admin) return true; // org admins / finance can always sign
  return approverId != null && approverId === userId; // otherwise only the designated second signatory
}

export async function createPaymentSlipAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect("/finance/payment-slips?err=title");
  const category = String(formData.get("category") || "").trim() || null;
  const slipDate = String(formData.get("slipDate") || new Date().toISOString().slice(0, 10));
  const projectId = String(formData.get("projectId") || "") || null;
  let currency = String(formData.get("currency") || "").trim().toUpperCase();
  if (!currency) currency = projectId
    ? ((await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [projectId]))?.currency ?? "UGX")
    : ((await one<{ baseCurrency: string }>(`SELECT COALESCE(base_currency,'UGX') AS "baseCurrency" FROM organization WHERE id=$1`, [orgId]))?.baseCurrency ?? "UGX");
  const note = String(formData.get("note") || "").trim() || null;
  const num = await nextNum(orgId, "payment_slip", "PS");
  const sid = id("pslip");
  await q(`INSERT INTO payment_slip (id, org_id, project_id, number, title, category, slip_date, currency, status, note, prepared_by, prepared_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10,$11)`,
    [sid, orgId, projectId, num, title, category, slipDate, currency, note, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "payment_slip", entityId: num, after: { title, category } });
  redirect(`/finance/payment-slips/${sid}`);
}

export async function addSlipPayeeAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect(`/finance/payment-slips/${slipId}?err=name`);
  const amount = Number(String(formData.get("amount") || "0").replace(/[^0-9.\-]/g, "")) || 0;
  const next = (await one<{ n: number }>(`SELECT COALESCE(MAX(idx),0)+1 AS n FROM payment_slip_payee WHERE slip_id=$1`, [slipId]))?.n ?? 1;
  await q(`INSERT INTO payment_slip_payee (id, slip_id, idx, name, phone, email, designation, payment_for, amount, sign_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("psp"), slipId, next, name,
     String(formData.get("phone") || "").trim() || null, String(formData.get("email") || "").trim() || null,
     String(formData.get("designation") || "").trim() || null, String(formData.get("paymentFor") || "").trim() || null,
     amount, newSignToken()]);
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

export async function bulkAddSlipPayeesAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const raw = String(formData.get("rows") || "");
  let idx = (await one<{ n: number }>(`SELECT COALESCE(MAX(idx),0) AS n FROM payment_slip_payee WHERE slip_id=$1`, [slipId]))?.n ?? 0;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    // tab-separated preferred (paste from a spreadsheet); fall back to comma.
    const cols = (line.includes("\t") ? line.split("\t") : line.split(",")).map((c) => c.trim());
    const [name, phone, email, designation, paymentFor, amountRaw] = cols;
    if (!name) continue;
    const amount = Number(String(amountRaw || "0").replace(/[^0-9.\-]/g, "")) || 0;
    idx += 1;
    await q(`INSERT INTO payment_slip_payee (id, slip_id, idx, name, phone, email, designation, payment_for, amount, sign_token)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id("psp"), slipId, idx, name, phone || null, email || null, designation || null, paymentFor || null, amount, newSignToken()]);
  }
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

export async function deleteSlipPayeeAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  await q(`DELETE FROM payment_slip_payee WHERE id=$1 AND slip_id=$2`, [String(formData.get("payeeId")), slipId]);
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

export async function signSlipFinanceAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const signature = String(formData.get("signature") || "");
  if (!signature) redirect(`/finance/payment-slips/${slipId}?err=sign`);
  await q(`UPDATE payment_slip SET finance_signed_by=$2, finance_signed_name=$3, finance_signature=$4, finance_signed_at=now(),
           status=CASE WHEN status='draft' THEN 'approved' ELSE status END WHERE id=$1`,
    [slipId, userId, userName, signature]);
  await writeAudit({ orgId, userId, action: "approve", entity: "payment_slip", entityId: slipId, after: { financeSigned: true } });
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

// Finance designates the second signatory (PI, manager, or anyone) and notifies them.
export async function assignSlipApproverAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const approverId = String(formData.get("approverId") || "");
  const approverTitle = String(formData.get("approverTitle") || "").trim() || "Authoriser";
  if (!approverId) redirect(`/finance/payment-slips/${slipId}?err=approver`);
  const u = await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [approverId]);
  if (!u) redirect(`/finance/payment-slips/${slipId}?err=approver`);
  await q(`UPDATE payment_slip SET approver_id=$2, approver_name=$3, approver_title=$4 WHERE id=$1`, [slipId, approverId, u.name, approverTitle]);
  const meta = await one<{ title: string; number: string }>(`SELECT title, number FROM payment_slip WHERE id=$1`, [slipId]);
  await notify({
    orgId, userId: approverId, type: "approval_request",
    title: `Payment approval needed: ${meta?.title ?? "payment"}`,
    body: `You have been asked to review and sign payment ${meta?.number ?? ""} as ${approverTitle}. Please log in to approve.`,
    link: `/finance/payment-slips/${slipId}`, email: true,
  });
  await writeAudit({ orgId, userId, action: "assign", entity: "payment_slip", entityId: slipId, after: { approverId, approverTitle } });
  redirect(`/finance/payment-slips/${slipId}?assigned=1`);
}

export async function notifySlipApproverAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const s = await one<{ approverId: string | null; approverTitle: string | null; title: string; number: string }>(
    `SELECT approver_id AS "approverId", approver_title AS "approverTitle", title, number FROM payment_slip WHERE id=$1`, [slipId]);
  if (s?.approverId) {
    await notify({
      orgId, userId: s.approverId, type: "approval_request",
      title: `Reminder — payment approval needed: ${s.title}`,
      body: `Please log in to review and sign payment ${s.number} as ${s.approverTitle ?? "Authoriser"}.`,
      link: `/finance/payment-slips/${slipId}`, email: true,
    });
  }
  redirect(`/finance/payment-slips/${slipId}?notified=1`);
}

// The designated second signatory (or an org admin) approves & signs the second slot.
export async function signSlipApproverAction(formData: FormData) {
  const user = await requireUser();
  const slipId = String(formData.get("slipId"));
  const s = await one<{ orgId: string; approverId: string | null }>(`SELECT org_id AS "orgId", approver_id AS "approverId" FROM payment_slip WHERE id=$1`, [slipId]);
  if (!s) redirect("/dashboard");
  if (!(await canSignAsApprover(user.id, s.orgId, s.approverId))) redirect(`/finance/payment-slips/${slipId}?err=forbidden`);
  const signature = String(formData.get("signature") || "");
  if (!signature) redirect(`/finance/payment-slips/${slipId}?err=sign`);
  await q(`UPDATE payment_slip SET pi_signed_by=$2, pi_signed_name=$3, pi_signature=$4, pi_signed_at=now(),
           status=CASE WHEN status='draft' THEN 'approved' ELSE status END WHERE id=$1`,
    [slipId, user.id, user.name, signature]);
  await writeAudit({ orgId: s.orgId, userId: user.id, action: "approve", entity: "payment_slip", entityId: slipId, after: { secondSigned: true } });
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

// Records the slip's total as an expenditure against its linked budget line and
// posts it to the ledger — but only once, and only when the slip is disbursed AND a
// line is linked. Safe to call from either "mark disbursed" or "link budget line",
// so the order the user does them in doesn't matter.
async function recordSlipExpenditureIfDue(slipId: string, orgId: string, userId: string, userName: string) {
  const s = await one<{ projectId: string | null; budgetLineId: string | null; expenditureId: string | null; status: string; number: string; title: string; slipDate: string }>(
    `SELECT project_id AS "projectId", budget_line_id AS "budgetLineId", expenditure_id AS "expenditureId", status,
            number, title, slip_date::text AS "slipDate" FROM payment_slip WHERE id=$1`, [slipId]);
  if (!s || s.status !== "disbursed" || !s.budgetLineId || !s.projectId || s.expenditureId) return;
  const tot = (await one<{ t: number }>(`SELECT COALESCE(SUM(amount),0)::float t FROM payment_slip_payee WHERE slip_id=$1`, [slipId]))?.t ?? 0;
  if (tot <= 0) return;
  const expId = id("exp");
  await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)`,
    [expId, s.projectId, s.budgetLineId, tot, s.slipDate, s.number, s.title, userId]);
  await q(`UPDATE payment_slip SET expenditure_id=$2 WHERE id=$1`, [slipId, expId]);
  await postExpenditureToLedger({ orgId, projectId: s.projectId, expenditureId: expId, amount: tot, date: s.slipDate, reference: s.number, payee: s.title, postedBy: userId, postedByName: userName });
  await writeAudit({ orgId, userId, action: "create", entity: "expenditure", entityId: expId, after: { amount: tot, fromSlip: s.number, budgetLineId: s.budgetLineId } });
  await evaluateProject(s.projectId);
  revalidatePath(`/projects/${s.projectId}/budget`);
  revalidatePath(`/projects/${s.projectId}/spending`);
  revalidatePath(`/finance/statements`);
}

// Finance links the slip to a project budget line. Picking a line also sets the
// slip's project (a line belongs to a project), so the two stay consistent.
export async function setSlipBudgetLineAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const budgetLineId = String(formData.get("budgetLineId") || "") || null;
  if (!budgetLineId) {
    await q(`UPDATE payment_slip SET budget_line_id=NULL WHERE id=$1`, [slipId]);
    await writeAudit({ orgId, userId, action: "update", entity: "payment_slip", entityId: slipId, after: { budgetLineId: null } });
    revalidatePath(`/finance/payment-slips/${slipId}`); return;
  }
  const line = await one<{ projectId: string }>(
    `SELECT p.id AS "projectId" FROM budget_line bl JOIN budget b ON b.id=bl.budget_id JOIN project p ON p.id=b.project_id
     WHERE bl.id=$1 AND p.org_id=$2`, [budgetLineId, orgId]);
  if (!line) redirect(`/finance/payment-slips/${slipId}?err=line`);
  await q(`UPDATE payment_slip SET budget_line_id=$2, project_id=$3 WHERE id=$1`, [slipId, budgetLineId, line.projectId]);
  await writeAudit({ orgId, userId, action: "update", entity: "payment_slip", entityId: slipId, after: { budgetLineId } });
  // If the slip was already disbursed, record the expenditure now that a line exists.
  await recordSlipExpenditureIfDue(slipId, orgId, userId, userName);
  revalidatePath(`/finance/payment-slips/${slipId}`);
}

export async function setSlipStatusAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const status = String(formData.get("status") || "");
  if (!["draft", "approved", "disbursed", "closed"].includes(status)) redirect(`/finance/payment-slips/${slipId}`);
  await q(`UPDATE payment_slip SET status=$2 WHERE id=$1`, [slipId, status]);
  if (status === "disbursed") await recordSlipExpenditureIfDue(slipId, orgId, userId, userName);
  await writeAudit({ orgId, userId, action: "update", entity: "payment_slip", entityId: slipId, after: { status } });
  revalidatePath(`/finance/payment-slips/${slipId}`);
  revalidatePath(`/finance/statements`);
}

export async function sendSlipSigningLinksAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const slipId = String(formData.get("slipId"));
  await loadSlip(slipId, orgId);
  const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000";
  const slip = await one<{ title: string; number: string; currency: string; orgName: string }>(
    `SELECT s.title, s.number, s.currency, o.name AS "orgName" FROM payment_slip s JOIN organization o ON o.id=s.org_id WHERE s.id=$1`, [slipId]);
  const payees = await q<{ id: string; name: string; email: string | null; amount: number; token: string; signed: boolean }>(
    `SELECT id, name, email, amount::float, sign_token AS token, signed FROM payment_slip_payee WHERE slip_id=$1`, [slipId]);
  let sent = 0;
  for (const p of payees) {
    if (!p.email || p.signed || !p.token) continue;
    const link = `${APP_URL}/sign/${p.token}`;
    const res = await sendEmail({
      to: p.email,
      subject: `Please sign for your payment — ${slip?.title ?? "Payment"} (${slip?.number ?? ""})`,
      html: `<p>Dear ${p.name},</p>`
        + `<p>${slip?.orgName ?? "Our organisation"} has prepared a payment of <strong>${slip?.currency ?? ""} ${p.amount.toLocaleString()}</strong> to you under "${slip?.title ?? ""}".</p>`
        + `<p>Please confirm receipt by signing against your name here — no account or sign-up is needed:</p>`
        + `<p><a href="${link}">${link}</a></p>`
        + `<p>Thank you.</p>`,
    });
    if (res.status === "sent") { await q(`UPDATE payment_slip_payee SET link_sent_at=now() WHERE id=$1`, [p.id]); sent += 1; }
    else { await q(`UPDATE payment_slip_payee SET link_sent_at=now() WHERE id=$1`, [p.id]); } // console provider: still mark attempted
  }
  redirect(`/finance/payment-slips/${slipId}?sent=${sent}`);
}

// PUBLIC (no login): a payee signs against their own name via their emailed token.
export async function recordPayeeSignatureAction(formData: FormData) {
  const token = String(formData.get("token") || "");
  const signature = String(formData.get("signature") || "");
  const signedName = String(formData.get("signedName") || "").trim();
  if (!token) redirect(`/sign/invalid`);
  const payee = await one<{ id: string; signed: boolean; name: string; linkSentAt: string | null }>(
    `SELECT id, signed, name, link_sent_at AS "linkSentAt" FROM payment_slip_payee WHERE sign_token=$1`, [token]);
  if (!payee) redirect(`/sign/${token}?err=notfound`);
  if (payee.signed) redirect(`/sign/${token}?done=1`);
  if (linkExpired(payee.linkSentAt)) redirect(`/sign/${token}?err=expired`);
  if (!signature) redirect(`/sign/${token}?err=sign`);
  await q(`UPDATE payment_slip_payee SET signed=true, signature=$2, signed_name=$3, signed_at=now() WHERE id=$1`,
    [payee.id, signature, signedName || payee.name]);
  redirect(`/sign/${token}?done=1`);
}

// Recomputes a requisition's disbursed amount + status from APPROVED vouchers only.
async function recomputeDisbursement(reqId: string) {
  const req = await one<{ amount: number }>(`SELECT amount FROM requisition WHERE id=$1`, [reqId]);
  const tot = (await one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM payment_voucher WHERE requisition_id=$1 AND status='approved'`, [reqId]))?.s ?? 0;
  const status = tot <= 0 ? "approved" : req && tot >= req.amount ? "disbursed" : "partially_funded";
  if (tot > 0) {
    // First actual disbursement starts the 60-day accountability clock.
    await q(`UPDATE requisition SET disbursed_amount=$2, status=$3,
               disbursed_on=COALESCE(disbursed_on, now()),
               accountability_due=COALESCE(accountability_due, (CURRENT_DATE + INTERVAL '60 days')::date),
               updated_at=now() WHERE id=$1`, [reqId, tot, status]);
  } else {
    await q(`UPDATE requisition SET disbursed_amount=$2, status=$3, updated_at=now() WHERE id=$1`, [reqId, tot, status]);
  }
}

export async function checkVoucherAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("requisitionId"));
  const vid = String(formData.get("voucherId"));
  await requirePermission(projectId, "budget.manage");
  const v = await one<{ status: string; preparedBy: string | null }>(
    `SELECT status, prepared_by AS "preparedBy" FROM payment_voucher WHERE id=$1 AND project_id=$2`, [vid, projectId]
  );
  if (!v || v.status !== "prepared") redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=stage`);
  // Separation of duties: the preparer cannot also check their own voucher.
  if (v.preparedBy === user.id) redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=sameprep`);
  await q(`UPDATE payment_voucher SET status='checked', checked_by=$2, checked_by_name=$3, checked_at=now() WHERE id=$1`,
    [vid, user.id, user.name]);
  await writeAudit({ userId: user.id, action: "update", entity: "payment_voucher", entityId: vid, after: { status: "checked" } });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=checked`);
}

export async function approveVoucherAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("requisitionId"));
  const vid = String(formData.get("voucherId"));
  // Approving a voucher releases the payment — requires sign-off authority.
  const access = await getProjectAccess(projectId);
  if (!access.permissions.has("requisitions.sign") && !access.permissions.has("requisitions.approve"))
    throw new Error("FORBIDDEN — only an authorised signatory can approve a payment voucher");
  const v = await one<{ status: string; checkedBy: string | null }>(
    `SELECT status, checked_by AS "checkedBy" FROM payment_voucher WHERE id=$1 AND project_id=$2`, [vid, projectId]
  );
  if (!v || v.status !== "checked") redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=stage`);
  // The checker cannot also approve their own check.
  if (v.checkedBy === user.id) redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=samecheck`);
  await q(`UPDATE payment_voucher SET status='approved', approved_by=$2, approved_by_name=$3, approved_at=now() WHERE id=$1`,
    [vid, user.id, user.name]);
  // payment is now made — recompute the requisition's disbursed total
  await recomputeDisbursement(reqId);
  // Deduct the requisition's linked budget line and post the payment to the general
  // ledger (debit expense, credit cash) so it flows into spending, the financial
  // statements and audit. Idempotent per voucher via expenditure_id; only when the
  // requisition has a budget line linked.
  const ded = await one<{ reqLine: string | null; amount: number; number: string; payee: string; expenditureId: string | null }>(
    `SELECT r.budget_line_id AS "reqLine", pv.amount::float AS amount, pv.number, pv.payee, pv.expenditure_id AS "expenditureId"
       FROM payment_voucher pv JOIN requisition r ON r.id=pv.requisition_id WHERE pv.id=$1`, [vid]);
  if (ded?.reqLine && !ded.expenditureId && ded.amount > 0) {
    const orgRow = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
    const expId = id("exp");
    const today = new Date().toISOString().slice(0, 10);
    await q(`INSERT INTO expenditure (id, project_id, budget_line_id, requisition_id, amount, date, reference, payee, approved, created_by_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
      [expId, projectId, ded.reqLine, reqId, ded.amount, today, ded.number, ded.payee, user.id]);
    await q(`UPDATE payment_voucher SET expenditure_id=$2, budget_line_id=$3 WHERE id=$1`, [vid, expId, ded.reqLine]);
    if (orgRow) await postExpenditureToLedger({ orgId: orgRow.orgId, projectId, expenditureId: expId, amount: ded.amount, date: today, reference: ded.number, payee: ded.payee, postedBy: user.id, postedByName: user.name });
    await writeAudit({ orgId: orgRow?.orgId, userId: user.id, action: "create", entity: "expenditure", entityId: expId, after: { amount: ded.amount, fromVoucher: ded.number, requisition: reqId, budgetLineId: ded.reqLine } });
    await evaluateProject(projectId);
    revalidatePath(`/projects/${projectId}/budget`);
    revalidatePath(`/projects/${projectId}/spending`);
    revalidatePath(`/finance/statements`);
  }
  await writeAudit({ userId: user.id, action: "update", entity: "payment_voucher", entityId: vid, after: { status: "approved", paymentMade: true } });
  revalidatePath(`/projects/${projectId}/requisitions/${reqId}`);
  redirect(`/projects/${projectId}/requisitions/${reqId}?voucher=approved`);
}

/* ---------------- Risk closure with evidence ---------------- */
export async function closeRiskAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const riskId = String(formData.get("riskId"));
  await requirePermission(projectId, "project.edit");
  let evidenceDocId: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) {
    const buf = Buffer.from(await file.arrayBuffer());
    evidenceDocId = id("doc");
    const key = await saveUpload(evidenceDocId, file.name, buf);
    await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes)
             VALUES ($1,$2,$3,'evidence',$4,$5,$6)`, [evidenceDocId, projectId, file.name, mimeFor(file.name), key, buf.length]);
  }
  await q(`UPDATE risk_issue SET status='closed', closed_at=now(), lessons=$3, evidence_document_id=COALESCE($4, evidence_document_id)
           WHERE id=$1 AND project_id=$2`,
    [riskId, projectId, String(formData.get("lessons") || "") || null, evidenceDocId]);
  await writeAudit({ userId: user.id, action: "update", entity: "risk_issue", entityId: riskId, after: { closed: true } });
  revalidatePath(`/projects/${projectId}/risks`);
}

/* ---------------- Activity completion evidence ---------------- */
export async function uploadActivityEvidenceAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const activityId = String(formData.get("activityId"));
  await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { revalidatePath(`/projects/${projectId}/workplan`); return; }
  const buf = Buffer.from(await file.arrayBuffer());
  const docId = id("doc");
  const key = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes)
           VALUES ($1,$2,$3,'evidence',$4,$5,$6)`, [docId, projectId, file.name, mimeFor(file.name), key, buf.length]);
  await q(`INSERT INTO activity_evidence (id, activity_id, document_id) VALUES ($1,$2,$3)`, [id("ae"), activityId, docId]);
  await writeAudit({ userId: user.id, action: "upload", entity: "activity", entityId: activityId, after: { evidence: file.name } });
  revalidatePath(`/projects/${projectId}/workplan`);
}

/* ---------------- Project abstract ---------------- */
export async function saveAbstractAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  await q(`UPDATE project SET summary=$2, updated_at=now() WHERE id=$1`,
    [projectId, String(formData.get("summary") || "") || null]);
  await writeAudit({ userId: user.id, action: "update", entity: "project", entityId: projectId, after: { summary: true } });
  revalidatePath(`/projects/${projectId}/sow`);
  revalidatePath(`/projects/${projectId}`);
}

/* ---------------- Notifications ---------------- */
export async function markNotificationsReadAction() {
  const user = await requireUser();
  await q(`UPDATE notification SET read=true WHERE user_id=$1 AND read=false`, [user.id]);
  revalidatePath("/notifications");
}

/* ---------------- Edit / retract a requisition (by the requester) ---------------- */
// The requester can edit a requisition while it is still a draft, and can
// retract a submitted one back to draft — but only before any approver has
// acted on it. Once a step is approved/rejected, it is locked.
export async function editRequisitionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "requisitions.create");

  const req = await one<{ status: string; requestedBy: string | null }>(
    `SELECT status, requested_by_id AS "requestedBy" FROM requisition WHERE id=$1 AND project_id=$2`, [reqId, projectId]
  );
  if (!req) redirect(`/projects/${projectId}/requisitions`);
  if (req.status !== "draft") redirect(`/projects/${projectId}/requisitions/${reqId}?edit=locked`);
  // only the person who raised it (or an org admin who can approve) may edit
  if (req.requestedBy && req.requestedBy !== user.id && !(await getProjectAccess(projectId)).permissions.has("requisitions.approve"))
    redirect(`/projects/${projectId}/requisitions/${reqId}?edit=forbidden`);

  const amount = Number(formData.get("amount") || 0);
  await q(`UPDATE requisition SET title=$2, amount=$3, budget_line_id=$4, justification=$5, needed_by=$6, payee=$7, updated_at=now()
           WHERE id=$1`,
    [reqId, String(formData.get("title") || "Requisition"), amount,
     String(formData.get("budgetLineId") || "") || null,
     String(formData.get("justification") || "") || null,
     String(formData.get("neededBy") || "") || null,
     String(formData.get("payee") || "") || null]);

  // refresh activity links
  const activityIds = (formData.getAll("activityIds") as string[]).filter(Boolean);
  await q(`DELETE FROM requisition_activity WHERE requisition_id=$1`, [reqId]);
  for (const aid of activityIds) {
    await q(`INSERT INTO requisition_activity (id, requisition_id, activity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id("ra"), reqId, aid]);
  }
  await q(`UPDATE requisition SET activity_id=$2 WHERE id=$1`, [reqId, activityIds[0] ?? null]);

  await writeAudit({ userId: user.id, action: "update", entity: "requisition", entityId: reqId, after: { edited: true } });
  redirect(`/projects/${projectId}/requisitions/${reqId}?edit=ok`);
}

export async function retractRequisitionAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const reqId = String(formData.get("reqId"));
  await requirePermission(projectId, "requisitions.create");

  const req = await one<{ status: string; requestedBy: string | null; number: string }>(
    `SELECT status, requested_by_id AS "requestedBy", number FROM requisition WHERE id=$1 AND project_id=$2`, [reqId, projectId]
  );
  if (!req) redirect(`/projects/${projectId}/requisitions`);
  if (req.requestedBy && req.requestedBy !== user.id && !(await getProjectAccess(projectId)).permissions.has("requisitions.approve"))
    redirect(`/projects/${projectId}/requisitions/${reqId}?retract=forbidden`);

  // Can only retract if it's awaiting approval and NOTHING has been decided yet.
  const decided = await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM requisition_approval WHERE requisition_id=$1 AND decision<>'pending'`, [reqId]
  );
  const inFlight = ["submitted", "finance_review", "pm_approval", "admin_approval"].includes(req.status);
  if (!inFlight || (decided?.c ?? 0) > 0) redirect(`/projects/${projectId}/requisitions/${reqId}?retract=locked`);

  await q(`DELETE FROM requisition_approval WHERE requisition_id=$1`, [reqId]);
  await q(`UPDATE requisition SET status='draft', updated_at=now() WHERE id=$1`, [reqId]);
  await writeAudit({ userId: user.id, action: "update", entity: "requisition", entityId: reqId, before: { status: req.status }, after: { status: "draft", retracted: true } });
  redirect(`/projects/${projectId}/requisitions/${reqId}?retract=ok`);
}

/* ============================ GENERAL LEDGER ============================ */
import {
  ensureChartOfAccounts, postJournal, reverseJournal,
  institutionalStatements, accountBalances, postExpenditureToLedger,
} from "@/server/services/ledger";

// Institution-level finance is restricted to organisation admins. Returns the
// caller's org id (or throws/redirects if they aren't entitled).
async function requireInstitutionFinance(): Promise<{ orgId: string; userId: string; userName: string }> {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name };
}

export async function initLedgerAction() {
  const { orgId } = await requireInstitutionFinance();
  await ensureChartOfAccounts(orgId);
  revalidatePath("/finance");
  revalidatePath("/finance/accounts");
  redirect("/finance/accounts?init=ok");
}

export async function addLedgerAccountAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const code = String(formData.get("code") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const type = String(formData.get("accountType") || "expense");
  if (!code || !name) redirect("/finance/accounts?err=missing");
  const side = type === "asset" || type === "expense" ? "debit" : "credit";
  const dup = await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code=$2`, [orgId, code]);
  if (dup) redirect("/finance/accounts?err=dup");
  await q(`INSERT INTO ledger_account (id, org_id, code, name, account_type, normal_side, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("acc"), orgId, code, name, type, side, String(formData.get("description") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "ledger_account", entityId: code, after: { code, name, type } });
  redirect("/finance/accounts?added=1");
}

export async function toggleLedgerAccountAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const accId = String(formData.get("accountId"));
  await q(`UPDATE ledger_account SET is_active = NOT is_active WHERE id=$1 AND org_id=$2`, [accId, orgId]);
  revalidatePath("/finance/accounts");
}

export async function setPostingRuleAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const debit = String(formData.get("debitAccountId") || "") || null;
  const credit = String(formData.get("creditAccountId") || "") || null;
  await q(`INSERT INTO gl_posting_rule (id, org_id, rule_key, debit_account_id, credit_account_id)
           VALUES ($1,$2,'expenditure',$3,$4)
           ON CONFLICT (org_id, rule_key) DO UPDATE SET debit_account_id=$3, credit_account_id=$4`,
    [id("glr"), orgId, debit, credit]);
  revalidatePath("/finance/accounts");
  redirect("/finance/accounts?rule=ok");
}

export async function postManualJournalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const debitAcc = String(formData.get("debitAccountId") || "");
  const creditAcc = String(formData.get("creditAccountId") || "");
  const amount = Number(formData.get("amount") || 0);
  const date = String(formData.get("entryDate") || new Date().toISOString().slice(0, 10));
  if (!debitAcc || !creditAcc || debitAcc === creditAcc || amount <= 0)
    redirect("/finance/journal?err=invalid");
  try {
    await postJournal({
      orgId, entryDate: date, memo: String(formData.get("memo") || "") || undefined,
      reference: String(formData.get("reference") || "") || null,
      sourceType: "manual", postedBy: userId, postedByName: userName,
      projectId: String(formData.get("projectId") || "") || null,
      lines: [
        { accountId: debitAcc, debit: amount, description: String(formData.get("memo") || "") || undefined },
        { accountId: creditAcc, credit: amount, description: String(formData.get("memo") || "") || undefined },
      ],
    });
  } catch (e) {
    redirect(`/finance/journal?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`);
  }
  redirect("/finance/journal?posted=1");
}

export async function reverseJournalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const entryId = String(formData.get("entryId"));
  await reverseJournal(orgId, entryId, { id: userId, name: userName });
  revalidatePath("/finance/journal");
  redirect("/finance/journal?reversed=1");
}

/* ===================== FINANCE OPS: invoices, receipts, assets, bank, FX ===================== */
import {
  issueInvoice, voidInvoice, recordReceipt,
  postAssetAcquisition, runDepreciation, reconciliationView,
} from "@/server/services/finance_ops";

// ---- Exchange rates ----
export async function setBaseCurrencyAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const base = String(formData.get("baseCurrency") || "USD").trim().toUpperCase().slice(0, 3);
  await q(`UPDATE organization SET base_currency=$2 WHERE id=$1`, [orgId, base]);
  revalidatePath("/finance/currency");
  redirect("/finance/currency?saved=1");
}
export async function addExchangeRateAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const currency = String(formData.get("currency") || "").trim().toUpperCase().slice(0, 3);
  const rate = Number(formData.get("rate") || 0);
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  if (!currency || rate <= 0 || currency === base) redirect("/finance/currency?err=1");
  await q(`INSERT INTO exchange_rate (id, org_id, currency, base_currency, rate, as_of) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("fx"), orgId, currency, base, rate, String(formData.get("asOf") || new Date().toISOString().slice(0, 10))]);
  redirect("/finance/currency?added=1");
}

// ---- Customers ----
export async function addCustomerAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/finance/invoices?err=cust");
  await q(`INSERT INTO finance_customer (id, org_id, name, email, phone, address, contact_name, contact_title, fax) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("cust"), orgId, name, String(formData.get("email") || "") || null, String(formData.get("phone") || "") || null, String(formData.get("address") || "") || null,
     String(formData.get("contactName") || "") || null, String(formData.get("contactTitle") || "") || null, String(formData.get("fax") || "") || null]);
  redirect("/finance/invoices?cust=ok");
}

// ---- Invoices ----
export async function createInvoiceAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const desc = String(formData.get("description") || "").trim();
  const qty = Number(formData.get("quantity") || 1);
  const unit = Number(formData.get("unitPrice") || 0);
  const total = round2cents(qty * unit);
  if (total <= 0) redirect("/finance/invoices?err=amount");
  const num = await nextNum(orgId, "invoice", "INV");
  const invId = id("inv");
  await q(`INSERT INTO invoice (id, org_id, project_id, customer_id, number, invoice_date, due_date, currency, income_account_id, description, total, award_number, awardee, signatory_name, signatory_title, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [invId, orgId, String(formData.get("projectId") || "") || null, String(formData.get("customerId") || "") || null,
     num, String(formData.get("invoiceDate") || new Date().toISOString().slice(0, 10)),
     String(formData.get("dueDate") || "") || null, String(formData.get("currency") || "USD"),
     String(formData.get("incomeAccountId") || "") || null, desc || "Invoice", total,
     String(formData.get("awardNumber") || "") || null, String(formData.get("awardee") || "") || null,
     String(formData.get("signatoryName") || "") || null, String(formData.get("signatoryTitle") || "") || null,
     userId, userName]);
  await q(`INSERT INTO invoice_line (id, invoice_id, description, quantity, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("invl"), invId, desc || "Services", qty, unit, total]);
  await writeAudit({ orgId, userId, action: "create", entity: "invoice", entityId: num, after: { total } });
  redirect(`/finance/invoices/${invId}?created=1`);
}

// Edit a DRAFT invoice's header (locked once issued).
export async function updateInvoiceAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  const inv = await one<{ status: string }>(`SELECT status FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]);
  if (!inv) redirect("/finance/invoices");
  if (inv.status !== "draft") redirect(`/finance/invoices/${invId}?err=locked`);
  await q(`UPDATE invoice SET customer_id=$2, project_id=$3, invoice_date=$4, due_date=$5, currency=$6, income_account_id=$7,
             description=$8, award_number=$9, awardee=$10, signatory_name=$11, signatory_title=$12 WHERE id=$1 AND org_id=$13`,
    [invId, String(formData.get("customerId") || "") || null, String(formData.get("projectId") || "") || null,
     String(formData.get("invoiceDate") || new Date().toISOString().slice(0, 10)), String(formData.get("dueDate") || "") || null,
     String(formData.get("currency") || "USD"), String(formData.get("incomeAccountId") || "") || null,
     String(formData.get("description") || "") || "Invoice", String(formData.get("awardNumber") || "") || null,
     String(formData.get("awardee") || "") || null, String(formData.get("signatoryName") || "") || null,
     String(formData.get("signatoryTitle") || "") || null, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "invoice", entityId: invId });
  redirect(`/finance/invoices/${invId}?saved=1`);
}

async function recomputeInvoiceTotal(invoiceId: string): Promise<void> {
  const r = await one<{ t: number }>(`SELECT COALESCE(SUM(amount),0)::float t FROM invoice_line WHERE invoice_id=$1`, [invoiceId]);
  await q(`UPDATE invoice SET total=$2 WHERE id=$1`, [invoiceId, round2cents(r?.t ?? 0)]);
}

// Add a line to a DRAFT invoice.
export async function addInvoiceLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  const inv = await one<{ status: string }>(`SELECT status FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]);
  if (!inv || inv.status !== "draft") redirect(`/finance/invoices/${invId}?err=locked`);
  const desc = String(formData.get("description") || "").trim();
  const qty = Number(formData.get("quantity") || 1);
  const unit = Number(formData.get("unitPrice") || 0);
  if (!desc) redirect(`/finance/invoices/${invId}?err=line`);
  await q(`INSERT INTO invoice_line (id, invoice_id, description, quantity, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("invl"), invId, desc, qty, unit, round2cents(qty * unit)]);
  await recomputeInvoiceTotal(invId);
  redirect(`/finance/invoices/${invId}?line=added`);
}

// Remove a line from a DRAFT invoice.
export async function deleteInvoiceLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  const lineId = String(formData.get("lineId"));
  const inv = await one<{ status: string }>(`SELECT status FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]);
  if (!inv || inv.status !== "draft") redirect(`/finance/invoices/${invId}?err=locked`);
  await q(`DELETE FROM invoice_line WHERE id=$1 AND invoice_id=$2`, [lineId, invId]);
  await recomputeInvoiceTotal(invId);
  redirect(`/finance/invoices/${invId}?line=removed`);
}
export async function issueInvoiceAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  try { await issueInvoice(invId, { id: userId, name: userName }); }
  catch (e) { redirect(`/finance/invoices?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath("/finance/invoices");
  redirect("/finance/invoices?issued=1");
}
// Re-run the financial control checks across every project in the org, so the
// Audit & Compliance view reflects the latest budgets, spend and approvals.
export async function recheckOrgComplianceAction() {
  const { orgId } = await requireInstitutionFinance();
  const projects = await q<{ id: string }>(`SELECT id FROM project WHERE org_id=$1`, [orgId]);
  for (const p of projects) { try { await evaluateProject(p.id); } catch {} }
  redirect("/finance/audit?rechecked=1");
}

export async function voidInvoiceAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  try { await voidInvoice(invId, { id: userId, name: userName }); }
  catch (e) { redirect(`/finance/invoices?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath("/finance/invoices");
  redirect("/finance/invoices?voided=1");
}

// Delete a draft or void invoice (these never affected the live ledger, so removal
// is safe). Issued/paid invoices can never be deleted — they must be voided.
export async function deleteInvoiceAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  const inv = await one<{ number: string; status: string; amountPaid: number }>(
    `SELECT number, status, amount_paid::float AS "amountPaid" FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]
  );
  if (!inv) redirect("/finance/invoices");
  if (!(inv.status === "draft" || inv.status === "void") || inv.amountPaid > 0) redirect("/finance/invoices?err=Only+draft+or+void+invoices+can+be+deleted");
  await q(`DELETE FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]); // invoice_line cascades
  await writeAudit({ orgId, userId, action: "delete", entity: "invoice", entityId: inv.number });
  redirect("/finance/invoices?deleted=1");
}

// Archive / unarchive a draft or void invoice (keeps the record but hides it).
export async function archiveInvoiceAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const invId = String(formData.get("invoiceId"));
  const archive = String(formData.get("archive") || "1") === "1";
  const inv = await one<{ number: string; status: string }>(`SELECT number, status FROM invoice WHERE id=$1 AND org_id=$2`, [invId, orgId]);
  if (!inv) redirect("/finance/invoices");
  if (archive && !(inv.status === "draft" || inv.status === "void")) redirect("/finance/invoices?err=Only+draft+or+void+invoices+can+be+archived");
  await q(`UPDATE invoice SET archived=$2 WHERE id=$1 AND org_id=$3`, [invId, archive, orgId]);
  await writeAudit({ orgId, userId, action: archive ? "archive" : "unarchive", entity: "invoice", entityId: inv.number });
  redirect(`/finance/invoices${archive ? "?archived_ok=1" : "?unarchived=1&showArchived=1"}`);
}

// ---- Receipts ----
export async function createReceiptAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const amount = Number(formData.get("amount") || 0);
  if (amount <= 0) redirect("/finance/receipts?err=amount");
  const num = await nextNum(orgId, "receipt", "RCT");
  const rid = id("rct");
  const invoiceId = String(formData.get("invoiceId") || "") || null;
  // derive project + customer from the invoice if one was chosen
  let projectId = String(formData.get("projectId") || "") || null;
  let customerId = String(formData.get("customerId") || "") || null;
  if (invoiceId) {
    const inv = await one<{ p: string | null; c: string | null }>(`SELECT project_id p, customer_id c FROM invoice WHERE id=$1`, [invoiceId]);
    if (inv) { projectId = projectId ?? inv.p; customerId = customerId ?? inv.c; }
  }
  await q(`INSERT INTO receipt (id, org_id, project_id, invoice_id, customer_id, number, receipt_date, amount, currency, method, reference, note, deposit_account_id, income_account_id, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [rid, orgId, projectId, invoiceId, customerId, num,
     String(formData.get("receiptDate") || new Date().toISOString().slice(0, 10)), amount,
     String(formData.get("currency") || "USD"), String(formData.get("method") || "bank_transfer"),
     String(formData.get("reference") || "") || null, String(formData.get("note") || "") || null,
     String(formData.get("depositAccountId") || "") || null, String(formData.get("incomeAccountId") || "") || null, userId, userName]);
  try { await recordReceipt(rid, { id: userId, name: userName }); }
  catch (e) { redirect(`/finance/receipts?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  await writeAudit({ orgId, userId, action: "create", entity: "receipt", entityId: num, after: { amount } });
  redirect(`/finance/receipts?created=${num}`);
}

// Loads a receipt in the caller's org or bounces to the list.
async function loadReceipt(rid: string, orgId: string): Promise<{ id: string; reconciled: boolean; journalEntryId: string | null; invoiceId: string | null }> {
  const r = await one<{ id: string; reconciled: boolean; journalEntryId: string | null; invoiceId: string | null }>(
    `SELECT id, reconciled, journal_entry_id AS "journalEntryId", invoice_id AS "invoiceId" FROM receipt WHERE id=$1 AND org_id=$2`, [rid, orgId]);
  if (!r) redirect("/finance/receipts");
  return r;
}

// Removes a receipt's posted effect: subtracts what it paid from its invoice (recomputing
// the invoice status) using the base amount actually posted to the ledger. Returns the entry id.
async function undoReceiptInvoiceEffect(receiptId: string, journalEntryId: string | null, invoiceId: string | null) {
  if (!journalEntryId) return;
  const base = (await one<{ t: number }>(`SELECT COALESCE(SUM(debit),0)::float t FROM journal_line WHERE entry_id=$1`, [journalEntryId]))?.t ?? 0;
  if (invoiceId && base > 0) {
    const inv = await one<{ total: number; paid: number }>(`SELECT total::float, amount_paid::float AS paid FROM invoice WHERE id=$1`, [invoiceId]);
    if (inv) {
      const paid = Math.max(0, Number(inv.paid) - base);
      const status = paid <= 0.0001 ? "issued" : paid >= inv.total - 0.0001 ? "paid" : "part_paid";
      await q(`UPDATE invoice SET amount_paid=$2, status=$3 WHERE id=$1`, [invoiceId, paid, status]);
    }
  }
}

// Finance edits a receipt (blocked once it has been reconciled). The old posting is
// removed and the receipt is re-posted with the new values so the ledger and the
// invoice's paid amount stay correct.
export async function editReceiptAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const rid = String(formData.get("receiptId"));
  const cur = await loadReceipt(rid, orgId);
  if (cur.reconciled) redirect(`/finance/receipts/${rid}?err=reconciled`);
  const amount = Number(formData.get("amount") || 0);
  if (amount <= 0) redirect(`/finance/receipts/${rid}?err=amount`);
  // undo the old posting + invoice effect, then clear the old entry
  await undoReceiptInvoiceEffect(rid, cur.journalEntryId, cur.invoiceId);
  if (cur.journalEntryId) await q(`DELETE FROM journal_entry WHERE id=$1`, [cur.journalEntryId]); // cascades its lines
  const invoiceId = String(formData.get("invoiceId") || "") || null;
  let projectId = String(formData.get("projectId") || "") || null;
  let customerId = String(formData.get("customerId") || "") || null;
  if (invoiceId) {
    const inv = await one<{ p: string | null; c: string | null }>(`SELECT project_id p, customer_id c FROM invoice WHERE id=$1`, [invoiceId]);
    if (inv) { projectId = projectId ?? inv.p; customerId = customerId ?? inv.c; }
  }
  await q(`UPDATE receipt SET invoice_id=$2, customer_id=$3, project_id=$4, receipt_date=$5, amount=$6, currency=$7, method=$8,
           reference=$9, note=$10, deposit_account_id=$11, income_account_id=$12, journal_entry_id=NULL WHERE id=$1`,
    [rid, invoiceId, customerId, projectId, String(formData.get("receiptDate") || new Date().toISOString().slice(0, 10)),
     amount, String(formData.get("currency") || "USD"), String(formData.get("method") || "bank_transfer"),
     String(formData.get("reference") || "") || null, String(formData.get("note") || "") || null,
     String(formData.get("depositAccountId") || "") || null, String(formData.get("incomeAccountId") || "") || null]);
  try { await recordReceipt(rid, { id: userId, name: userName }); }
  catch (e) { redirect(`/finance/receipts/${rid}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  await writeAudit({ orgId, userId, action: "update", entity: "receipt", entityId: rid, after: { amount } });
  redirect(`/finance/receipts/${rid}?updated=1`);
}

// Finance deletes a receipt: reverses its ledger entry (keeping an audit trail) and
// subtracts what it paid from its invoice, then removes the receipt.
export async function deleteReceiptAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const rid = String(formData.get("receiptId"));
  const r = await one<{ number: string; amount: number; journalEntryId: string | null; invoiceId: string | null }>(
    `SELECT number, amount::float, journal_entry_id AS "journalEntryId", invoice_id AS "invoiceId" FROM receipt WHERE id=$1 AND org_id=$2`, [rid, orgId]);
  if (!r) redirect("/finance/receipts");
  await undoReceiptInvoiceEffect(rid, r.journalEntryId, r.invoiceId);
  if (r.journalEntryId) { try { await reverseJournal(orgId, r.journalEntryId, { id: userId, name: userName }); } catch { /* best effort */ } }
  await q(`DELETE FROM receipt WHERE id=$1 AND org_id=$2`, [rid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "receipt", entityId: r.number, before: { amount: r.amount } });
  revalidatePath(`/finance/statements`);
  redirect(`/finance/receipts?deleted=${r.number}`);
}

// ---- Fixed assets ----
export async function createAssetAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  const cost = Number(formData.get("cost") || 0);
  if (!name || cost <= 0) redirect("/finance/assets?err=1");
  const aid = id("fa");
  await q(`INSERT INTO fixed_asset (id, org_id, project_id, tag, name, category, acquired_on, cost, currency, useful_life_months, salvage_value, location, custodian, note, condition)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [aid, orgId, String(formData.get("projectId") || "") || null, String(formData.get("tag") || "") || null, name,
     String(formData.get("category") || "") || null, String(formData.get("acquiredOn") || new Date().toISOString().slice(0, 10)),
     cost, String(formData.get("currency") || "USD"), Number(formData.get("usefulLifeMonths") || 36),
     Number(formData.get("salvageValue") || 0), String(formData.get("location") || "") || null,
     String(formData.get("custodian") || "") || null, String(formData.get("note") || "") || null,
     String(formData.get("condition") || "good")]);
  if (formData.get("postAcquisition") === "on") await postAssetAcquisition(aid, { id: userId, name: userName });
  await writeAudit({ orgId, userId, action: "create", entity: "fixed_asset", entityId: aid, after: { name, cost } });
  redirect("/finance/assets?created=1");
}
export async function depreciateAssetAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("assetId"));
  const period = String(formData.get("period") || new Date().toISOString().slice(0, 7));
  const res = await runDepreciation(aid, period, { id: userId, name: userName });
  revalidatePath("/finance/assets");
  redirect(`/finance/assets?dep=${res ? "ok" : "none"}`);
}
export async function disposeAssetAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("assetId"));
  await q(`UPDATE fixed_asset SET status='disposed', disposal_method=$3, disposal_proceeds=$4,
             disposal_approved_by=$5, disposal_note=$6, disposed_on=$7 WHERE id=$1 AND org_id=$2`,
    [aid, orgId, String(formData.get("disposalMethod") || "") || null,
     formData.get("disposalProceeds") ? Number(formData.get("disposalProceeds")) : null,
     String(formData.get("disposalApprovedBy") || "") || null, String(formData.get("disposalNote") || "") || null,
     String(formData.get("disposedOn") || "") || new Date().toISOString().slice(0, 10)]);
  await writeAudit({ orgId, userId, action: "update", entity: "fixed_asset", entityId: aid, after: { disposed: true } });
  redirect("/finance/assets?disposed=1");
}

export async function verifyAssetAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("assetId"));
  if (!(await one(`SELECT id FROM fixed_asset WHERE id=$1 AND org_id=$2`, [aid, orgId]))) redirect("/finance/assets");
  const conditionFound = String(formData.get("conditionFound") || "good");
  const on = String(formData.get("verifiedOn") || "") || new Date().toISOString().slice(0, 10);
  await q(`INSERT INTO asset_verification (id, asset_id, verified_on, verified_by, verified_by_name, condition_found, location_found, discrepancy_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("av"), aid, on, userId, userName, conditionFound,
     String(formData.get("locationFound") || "") || null, String(formData.get("discrepancyNote") || "") || null]);
  if (conditionFound === "missing") await q(`UPDATE fixed_asset SET last_verified_on=$2 WHERE id=$1`, [aid, on]);
  else await q(`UPDATE fixed_asset SET condition=$2, last_verified_on=$3 WHERE id=$1`, [aid, conditionFound, on]);
  await writeAudit({ orgId, userId, action: "update", entity: "asset_verification", entityId: aid, after: { conditionFound } });
  redirect("/finance/assets?verified=1");
}

// ---- Bank reconciliation ----
export async function addBankLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const accountId = String(formData.get("accountId"));
  const amount = Number(formData.get("amount") || 0);
  if (!accountId || amount === 0) redirect(`/finance/reconcile?account=${accountId}&err=1`);
  await q(`INSERT INTO bank_statement_line (id, org_id, account_id, txn_date, description, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("bsl"), orgId, accountId, String(formData.get("txnDate") || new Date().toISOString().slice(0, 10)),
     String(formData.get("description") || "") || null, amount]);
  redirect(`/finance/reconcile?account=${accountId}&added=1`);
}
export async function toggleBankLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const lineId = String(formData.get("lineId"));
  const accountId = String(formData.get("accountId"));
  await q(`UPDATE bank_statement_line SET reconciled = NOT reconciled WHERE id=$1 AND org_id=$2`, [lineId, orgId]);
  revalidatePath(`/finance/reconcile`);
  redirect(`/finance/reconcile?account=${accountId}`);
}

// ---- Monthly bank reconciliation (clear GL cash movements vs the statement) ----
export async function toggleClearedAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const lineId = String(formData.get("lineId"));
  const accountId = String(formData.get("accountId"));
  const period = String(formData.get("period"));
  await q(`UPDATE journal_line SET cleared = NOT cleared, cleared_at = CASE WHEN cleared THEN NULL ELSE now() END
           WHERE id=$1 AND entry_id IN (SELECT id FROM journal_entry WHERE org_id=$2)`, [lineId, orgId]);
  redirect(`/finance/reconcile?account=${accountId}&period=${period}`);
}
export async function saveBankRecAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const accountId = String(formData.get("accountId"));
  const period = String(formData.get("period"));
  const sc = formData.get("statementClosing");
  const statementClosing = sc === null || String(sc).trim() === "" ? null : Number(sc);
  await q(`INSERT INTO bank_reconciliation (id, org_id, account_id, period, statement_closing, note)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (org_id, account_id, period) DO UPDATE SET statement_closing=EXCLUDED.statement_closing, note=EXCLUDED.note`,
    [id("brec"), orgId, accountId, period, statementClosing, String(formData.get("note") || "") || null]);
  redirect(`/finance/reconcile?account=${accountId}&period=${period}&saved=1`);
}
export async function finalizeBankRecAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const accountId = String(formData.get("accountId"));
  const period = String(formData.get("period"));
  if (formData.get("reopen") === "1") {
    await q(`UPDATE bank_reconciliation SET status='open', finalized_by=NULL, finalized_by_name=NULL, finalized_at=NULL WHERE org_id=$1 AND account_id=$2 AND period=$3`, [orgId, accountId, period]);
    redirect(`/finance/reconcile?account=${accountId}&period=${period}&saved=1`);
  }
  await q(`INSERT INTO bank_reconciliation (id, org_id, account_id, period, status, finalized_by, finalized_by_name, finalized_at)
           VALUES ($1,$2,$3,$4,'finalized',$5,$6,now())
           ON CONFLICT (org_id, account_id, period) DO UPDATE SET status='finalized', finalized_by=EXCLUDED.finalized_by, finalized_by_name=EXCLUDED.finalized_by_name, finalized_at=EXCLUDED.finalized_at`,
    [id("brec"), orgId, accountId, period, userId, userName]);
  await writeAudit({ orgId, userId, action: "finalize", entity: "bank_reconciliation", entityId: `${accountId}:${period}` });
  redirect(`/finance/reconcile?account=${accountId}&period=${period}&finalized=1`);
}

// small local helpers (avoid clobbering existing ones)
function round2cents(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
async function nextNum(orgId: string, table: string, prefix: string): Promise<string> {
  const map: Record<string, string> = { invoice: "invoice", receipt: "receipt" };
  const t = map[table] ?? table;
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ${t} WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `${prefix}-${String(n + 1).padStart(4, "0")}`;
}

/* ============================ HUMAN RESOURCES ============================ */
import { leaveBalance, computePay, buildPayrollRun, finalisePayrollRun } from "@/server/services/hr";

// HR is institution-level (org admins / super admins), same gate as finance.
export async function addEmployeeAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const first = String(formData.get("firstName") || "").trim();
  const last = String(formData.get("lastName") || "").trim();
  if (!first || !last) redirect("/hr/employees?err=name");
  const eid = id("emp");
  // Department can be picked OR typed (combobox). A typed name is found-or-created.
  const deptNameInput = String(formData.get("departmentName") || "").trim();
  let deptId: string | null = String(formData.get("departmentId") || "") || null;
  let deptName: string | null = null;
  if (deptNameInput) {
    const dep = await ensureDepartment(orgId, deptNameInput);
    if (dep) { deptId = dep.id; deptName = dep.name; }
  } else if (deptId) {
    deptName = (await one<{ name: string }>(`SELECT name FROM department WHERE id=$1`, [deptId]))?.name ?? null;
  }
  await q(`INSERT INTO employee (id, org_id, user_id, staff_no, first_name, last_name, email, phone, job_title, department, department_id,
             contract_type, start_date, end_date, basic_salary, currency, pay_frequency, bank_name, bank_account, bank_branch, mobile_money, annual_leave_days, note, prefix,
             national_id, nssf_number, tin_number, next_of_kin, next_of_kin_relationship, next_of_kin_phone, next_of_kin_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [eid, orgId, String(formData.get("userId") || "") || null, String(formData.get("staffNo") || "") || null,
     first, last, String(formData.get("email") || "") || null, String(formData.get("phone") || "") || null,
     String(formData.get("jobTitle") || "") || null, deptName, deptId,
     String(formData.get("contractType") || "permanent"),
     String(formData.get("startDate") || "") || null, String(formData.get("endDate") || "") || null,
     Number(formData.get("basicSalary") || 0), String(formData.get("currency") || "USD"),
     String(formData.get("payFrequency") || "monthly"),
     String(formData.get("bankName") || "") || null, String(formData.get("bankAccount") || "") || null,
     String(formData.get("bankBranch") || "") || null, String(formData.get("mobileMoney") || "") || null,
     Number(formData.get("annualLeaveDays") || 21), String(formData.get("note") || "") || null,
     String(formData.get("prefix") || "") || null,
     String(formData.get("nationalId") || "") || null, String(formData.get("nssfNumber") || "") || null,
     String(formData.get("tinNumber") || "") || null, String(formData.get("nextOfKin") || "") || null,
     String(formData.get("nextOfKinRelationship") || "") || null, String(formData.get("nextOfKinPhone") || "") || null,
     String(formData.get("nextOfKinAddress") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "employee", entityId: eid, after: { name: `${first} ${last}` } });
  // optional: create a self-service login immediately
  if (formData.get("createLogin") === "on" && String(formData.get("email") || "").trim()) {
    try { await createEmployeeLogin(eid); } catch { /* surfaced on the employee page if needed */ }
    redirect(`/hr/employees/${eid}?login=sent`);
  }
  redirect("/hr/employees?created=1");
}

export async function updateEmployeeAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  await q(`UPDATE employee SET job_title=$2, department=$3, contract_type=$4, basic_salary=$5, currency=$6,
             bank_name=$7, bank_account=$8, bank_branch=$9, annual_leave_days=$10, status=$11,
             start_date=$12, end_date=$13, phone=$14, email=$15, staff_no=$16 WHERE id=$1 AND org_id=$17`,
    [eid, String(formData.get("jobTitle") || "") || null, String(formData.get("department") || "") || null,
     String(formData.get("contractType") || "permanent"), Number(formData.get("basicSalary") || 0),
     String(formData.get("currency") || "USD"), String(formData.get("bankName") || "") || null,
     String(formData.get("bankAccount") || "") || null, String(formData.get("bankBranch") || "") || null,
     Number(formData.get("annualLeaveDays") || 21),
     String(formData.get("status") || "active"), String(formData.get("startDate") || "") || null,
     String(formData.get("endDate") || "") || null, String(formData.get("phone") || "") || null,
     String(formData.get("email") || "") || null, String(formData.get("staffNo") || "") || null, orgId]);
  revalidatePath(`/hr/employees/${eid}`);
  redirect(`/hr/employees/${eid}?saved=1`);
}

// Terminate (dismiss) an employee from the organisation. This is stronger than pausing
// a contract (status 'on_leave') or letting it expire (end_date passes): it removes the
// person's access entirely and FREES THEIR EMAIL so that, if they are re-hired, they
// register a brand-new account from scratch. We tombstone the login (the email becomes
// available again) rather than hard-deleting it, so historical audit/document trails stay
// intact. Their employee record is kept but marked terminated.
export async function terminateEmployeeAction(formData: FormData) {
  const { orgId, userId: actorId, userName } = await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  const e = await one<{ userId: string | null; email: string | null; firstName: string; lastName: string }>(
    `SELECT user_id AS "userId", email, first_name AS "firstName", last_name AS "lastName" FROM employee WHERE id=$1 AND org_id=$2`, [eid, orgId]);
  if (!e) redirect("/hr/employees");
  const today = new Date().toISOString().slice(0, 10);

  if (e.userId) {
    const uid = e.userId;
    // 1. Revoke all access in this organisation and its projects.
    await q(`DELETE FROM org_membership WHERE user_id=$1 AND org_id=$2`, [uid, orgId]);
    await q(`DELETE FROM project_member WHERE user_id=$1 AND project_id IN (SELECT id FROM project WHERE org_id=$2)`, [uid, orgId]);
    // 2. Drop any approver designation they hold on payments in the org.
    await q(`UPDATE payment_slip SET approver_id=NULL, approver_name=NULL, approver_title=NULL WHERE approver_id=$1 AND org_id=$2`, [uid, orgId]);
    await q(`UPDATE payment_voucher SET approver_id=NULL, approver_name=NULL WHERE approver_id=$1 AND (org_id=$2 OR project_id IN (SELECT id FROM project WHERE org_id=$2))`, [uid, orgId]);
    // 3. Free their email + disable the login. The original address can now be used to
    //    register a fresh account. (Email is UNIQUE, so we tombstone it.)
    const u = await one<{ email: string }>(`SELECT email FROM app_user WHERE id=$1`, [uid]);
    if (u) await q(`UPDATE app_user SET email=$2, status='disabled', updated_at=now() WHERE id=$1`,
      [uid, `terminated+${uid}+${u.email}`.slice(0, 250)]);
    await writeAudit({ orgId, userId: actorId, action: "delete", entity: "app_user", entityId: uid, before: { email: u?.email }, meta: { terminated: true, emailFreed: true } });
  }
  // 4. Mark the employee record terminated and unlink the (now freed) login.
  await q(`UPDATE employee SET status='terminated', end_date=COALESCE(end_date, $2::date), user_id=NULL WHERE id=$1 AND org_id=$3`, [eid, today, orgId]);
  await writeAudit({ orgId, userId: actorId, action: "update", entity: "employee", entityId: eid, after: { status: "terminated", by: userName } });
  revalidatePath(`/hr/employees/${eid}`);
  revalidatePath(`/hr/employees`);
  redirect(`/hr/employees/${eid}?terminated=1`);
}
export async function addPayComponentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/hr/payroll?err=comp");
  await q(`INSERT INTO pay_component (id, org_id, name, kind, amount_type, rate, basis, applies_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("pcmp"), orgId, name, String(formData.get("kind") || "deduction"),
     String(formData.get("amountType") || "flat"), Number(formData.get("rate") || 0),
     String(formData.get("basis") || "basic"), formData.get("appliesDefault") === "on"]);
  redirect("/hr/payroll?comp=ok");
}
export async function togglePayComponentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`UPDATE pay_component SET active = NOT active WHERE id=$1 AND org_id=$2`, [String(formData.get("componentId")), orgId]);
  revalidatePath("/hr/payroll");
}

// Leave
export async function requestLeaveAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  const start = String(formData.get("startDate") || "");
  const end = String(formData.get("endDate") || "");
  const days = Number(formData.get("days") || 0);
  if (!start || !end || days <= 0) redirect(`/hr/leave?err=1`);
  await q(`INSERT INTO leave_request (id, org_id, employee_id, leave_type, start_date, end_date, days, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("lv"), orgId, empId, String(formData.get("leaveType") || "annual"), start, end, days, String(formData.get("reason") || "") || null]);
  redirect("/hr/leave?requested=1");
}
export async function decideLeaveAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const lvId = String(formData.get("leaveId"));
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  await q(`UPDATE leave_request SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=now(), decision_note=$6 WHERE id=$1 AND org_id=$5`,
    [lvId, decision, userId, userName, orgId, String(formData.get("decisionNote") || "") || null]);
  revalidatePath("/hr/leave");
  redirect("/hr/leave?decided=1");
}

// Timesheets
export async function addTimesheetAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  const hours = Number(formData.get("hours") || 0);
  if (!empId || hours <= 0) redirect("/hr/timesheets?err=1");
  await q(`INSERT INTO timesheet (id, org_id, employee_id, project_id, work_date, hours, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("ts"), orgId, empId, String(formData.get("projectId") || "") || null,
     String(formData.get("workDate") || new Date().toISOString().slice(0, 10)), hours, String(formData.get("description") || "") || null]);
  redirect("/hr/timesheets?added=1");
}
export async function decideTimesheetAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const tsId = String(formData.get("timesheetId"));
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  await q(`UPDATE timesheet SET status=$2, approved_by=$3, approved_by_name=$4, approved_at=now(), decision_note=$6 WHERE id=$1 AND org_id=$5`,
    [tsId, decision, userId, userName, orgId, String(formData.get("decisionNote") || "") || null]);
  revalidatePath("/hr/timesheets");
}

// Payroll
export async function buildPayrollAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const period = String(formData.get("period") || new Date().toISOString().slice(0, 7));
  try { await buildPayrollRun(orgId, period, { id: userId, name: userName }); }
  catch (e) { redirect(`/hr/payroll?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/hr/payroll?run=${period}`);
}
export async function finalisePayrollAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const runId = String(formData.get("runId"));
  await finalisePayrollRun(orgId, runId);
  revalidatePath("/hr/payroll");
  redirect("/hr/payroll?finalised=1");
}

/* ============================ PROCUREMENT ============================ */
import { decidePurchaseRequest, createPOFromRequest, createGRN, createBillFromPO, upsertProcurementConfig, getProcurementConfig, seedPurchaseApprovalChain, assignPurchaseApprover, signPurchaseApproval, authorisePurchaseOrder, type ProcurementConfig } from "@/server/services/procurement";

// Vendors
export async function addVendorAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/procurement/vendors?err=1");
  await q(`INSERT INTO vendor (id, org_id, name, contact_person, email, phone, address, tax_id, bank_account)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("ven"), orgId, name, String(formData.get("contactPerson") || "") || null, String(formData.get("email") || "") || null,
     String(formData.get("phone") || "") || null, String(formData.get("address") || "") || null,
     String(formData.get("taxId") || "") || null, String(formData.get("bankAccount") || "") || null]);
  redirect("/procurement/vendors?created=1");
}

// Purchase requests
export async function createPurchaseRequestAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const title = String(formData.get("title") || "").trim();
  const desc = String(formData.get("itemDescription") || "").trim();
  const qty = Number(formData.get("quantity") || 1);
  const unitCost = Number(formData.get("unitCost") || 0);
  if (!title || !desc) redirect("/procurement/requests?err=1");
  // A budget line, when chosen, charges this request to a specific project. The
  // line uniquely determines its project, so we derive project_id from it to
  // keep the two consistent (the line's project wins over the project select).
  let projectId = String(formData.get("projectId") || "") || null;
  const budgetLineId = String(formData.get("budgetLineId") || "") || null;
  if (budgetLineId) {
    const ln = await one<{ projectId: string }>(
      `SELECT b.project_id AS "projectId" FROM budget_line bl JOIN budget b ON b.id=bl.budget_id
       JOIN project p ON p.id=b.project_id WHERE bl.id=$1 AND p.org_id=$2`, [budgetLineId, orgId]
    );
    if (ln) projectId = ln.projectId;
  }
  const prId = id("pr");
  const number = await nextNumProc(orgId, "purchase_request", "PR");
  const amount = Math.round((qty * unitCost + Number.EPSILON) * 100) / 100;
  await q(`INSERT INTO purchase_request (id, org_id, project_id, budget_line_id, number, title, justification, needed_by, currency, estimated_total, status, requested_by, requested_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submitted',$11,$12)`,
    [prId, orgId, projectId, budgetLineId, number, title,
     String(formData.get("justification") || "") || null, String(formData.get("neededBy") || "") || null,
     String(formData.get("currency") || "USD"), amount, userId, userName]);
  await q(`INSERT INTO purchase_request_item (id, request_id, description, quantity, unit, estimated_unit_cost, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("pri"), prId, desc, qty, String(formData.get("unit") || "") || null, unitCost, amount]);
  // Seed the sign-off chain (finance review -> budget holder / PI -> authorising officer).
  await seedPurchaseApprovalChain(prId, !!projectId);
  await writeAudit({ orgId, userId, action: "create", entity: "purchase_request", entityId: number, after: { title, amount, projectId, budgetLineId } });
  redirect(`/procurement/requests/${prId}?created=1`);
}
export async function decidePurchaseRequestAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  try { await decidePurchaseRequest(orgId, prId, decision, { id: userId, name: userName }, String(formData.get("note") || "") || undefined); }
  catch (e) { redirect(`/procurement/requests?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath("/procurement/requests");
  redirect("/procurement/requests?decided=1");
}

// Purchase orders
export async function createPOAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  const vendorId = String(formData.get("vendorId"));
  if (!vendorId) redirect("/procurement/requests?err=vendor");
  let poId = "";
  try { poId = await createPOFromRequest(orgId, prId, vendorId, { id: userId, name: userName }); }
  catch (e) { redirect(`/procurement/requests?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/procurement/orders/${poId}`);
}

// Assign a person to a purchase-request approval step and email them for their signature.
export async function assignPurchaseApproverAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const requestId = String(formData.get("requestId"));
  const step = Number(formData.get("step") || 0);
  const approverId = String(formData.get("approverId") || "");
  if (!approverId || !step) redirect(`/procurement/requests/${requestId}?err=assign`);
  try { await assignPurchaseApprover(orgId, requestId, step, approverId, { id: userId, name: userName }); }
  catch (e) { redirect(`/procurement/requests/${requestId}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath(`/procurement/requests/${requestId}`);
  redirect(`/procurement/requests/${requestId}?assigned=1`);
}

// Sign (approve/reject) the current approval step. Allowed for the assigned approver of
// that step or an org admin — a chain signatory need not be an administrator.
export async function signPurchaseRequestAction(formData: FormData) {
  const user = await requireUser();
  const requestId = String(formData.get("requestId"));
  const step = Number(formData.get("step") || 0);
  const decision = String(formData.get("decision")) === "rejected" ? "rejected" : "approved";
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const pr = await one<{ id: string }>(`SELECT id FROM purchase_request WHERE id=$1 AND org_id=$2`, [requestId, org.id]);
  if (!pr) redirect("/procurement/requests");
  const stepRow = await one<{ approverId: string | null }>(`SELECT approver_id AS "approverId" FROM purchase_approval WHERE request_id=$1 AND step=$2`, [requestId, step]);
  if (!org.isOrgAdmin && stepRow?.approverId !== user.id) redirect(`/procurement/requests/${requestId}?err=notyou`);
  try { await signPurchaseApproval(org.id, requestId, step, { id: user.id, name: user.name }, decision, String(formData.get("comment") || "") || undefined, String(formData.get("sig") || "") || undefined); }
  catch (e) { redirect(`/procurement/requests/${requestId}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath(`/procurement/requests/${requestId}`);
  redirect(`/procurement/requests/${requestId}?signed=${decision}`);
}

// Authorise (sign) a purchase order before it is issued to the vendor.
export async function authorisePOAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const poId = String(formData.get("poId"));
  try { await authorisePurchaseOrder(orgId, poId, { id: userId, name: userName }, String(formData.get("sig") || "") || undefined); }
  catch (e) { redirect(`/procurement/orders/${poId}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  revalidatePath(`/procurement/orders/${poId}`);
  redirect(`/procurement/orders/${poId}?authorised=1`);
}

// Goods received notes
export async function createGRNAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const poId = String(formData.get("poId"));
  // collect qty inputs named qty_<poItemId>
  const receipts: { poItemId: string; qty: number; note?: string }[] = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith("qty_")) {
      const qty = Number(v || 0);
      if (qty > 0) receipts.push({ poItemId: k.slice(4), qty });
    }
  }
  if (receipts.length === 0) redirect(`/procurement/orders/${poId}?err=noqty`);
  try { await createGRN(orgId, poId, receipts, { id: userId, name: userName }, String(formData.get("receivedDate") || "") || undefined); }
  catch (e) { redirect(`/procurement/orders/${poId}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/procurement/orders/${poId}?grn=ok`);
}

// Vendor bills
export async function createBillAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const poId = String(formData.get("poId"));
  let billId = "";
  try {
    billId = await createBillFromPO(orgId, poId, { id: userId, name: userName }, {
      dueDate: String(formData.get("dueDate") || "") || undefined,
      expenseAccountId: String(formData.get("expenseAccountId") || "") || undefined,
    });
  } catch (e) { redirect(`/procurement/orders/${poId}?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/procurement/bills?created=1`);
}

// proc-local sequential numbering (distinct name to avoid collisions)
async function nextNumProc(orgId: string, table: string, prefix: string): Promise<string> {
  const allowed: Record<string, string> = { purchase_request: "purchase_request", purchase_order: "purchase_order", vendor_bill: "vendor_bill" };
  const t = allowed[table] ?? table;
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ${t} WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `${prefix}-${String(n + 1).padStart(4, "0")}`;
}

/* ==================== DEPARTMENTS + EMPLOYEE PORTAL ==================== */
import { createEmployeeLogin, employeeForUser } from "@/server/services/hr";

export async function addDepartmentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  // Accept either a typed custom name (takes precedence) or a chosen preset.
  const custom = String(formData.get("customName") || "").trim();
  const preset = String(formData.get("preset") || "").trim();
  const name = custom || (preset && preset !== "__other" ? preset : "");
  if (!name) redirect("/hr/departments?err=1");
  await q(`INSERT INTO department (id, org_id, name, head_employee_id, description) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, name) DO NOTHING`,
    [id("dept"), orgId, name, String(formData.get("headEmployeeId") || "") || null, String(formData.get("description") || "") || null]);
  redirect("/hr/departments?created=1");
}
export async function assignEmployeeDepartmentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  // Pick from existing OR type a new department name (found-or-created).
  const nameInput = String(formData.get("departmentName") || "").trim();
  let deptId: string | null = String(formData.get("departmentId") || "") || null;
  if (nameInput) { const dep = await ensureDepartment(orgId, nameInput); deptId = dep?.id ?? null; }
  await q(`UPDATE employee SET department_id=$2, department=(SELECT name FROM department WHERE id=$2) WHERE id=$1 AND org_id=$3`, [empId, deptId, orgId]);
  revalidatePath(`/hr/employees/${empId}`);
}

// Create the self-service login for an employee (the optional toggle / button).
export async function createEmployeeLoginAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  let res;
  try { res = await createEmployeeLogin(empId); }
  catch (e) { redirect(`/hr/employees/${empId}?loginerr=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/hr/employees/${empId}?login=${res.emailStatus}`);
}

/* ---- Employee self-service (the logged-in staff member acting on their OWN record) ---- */
async function requireOwnEmployee(): Promise<{ employeeId: string; orgId: string; userId: string; userName: string }> {
  const user = await requireUser();
  const emp = await employeeForUser(user.id);
  if (!emp) redirect("/dashboard");
  return { employeeId: emp.id, orgId: emp.orgId, userId: user.id, userName: user.name };
}

export async function updateMyProfileAction(formData: FormData) {
  const { employeeId } = await requireOwnEmployee();
  await q(`UPDATE employee SET phone=$2, address=$3, date_of_birth=$4, national_id=$5, emergency_contact=$6,
             cv_summary=$7, qualifications=$8, skills=$9, gender=$10, marital_status=$11, nationality=$12,
             nssf_number=$13, tin_number=$14, next_of_kin=$15, next_of_kin_relationship=$16, next_of_kin_phone=$17,
             next_of_kin_address=$18, alternative_email=$19 WHERE id=$1`,
    [employeeId, String(formData.get("phone") || "") || null, String(formData.get("address") || "") || null,
     String(formData.get("dateOfBirth") || "") || null, String(formData.get("nationalId") || "") || null,
     String(formData.get("emergencyContact") || "") || null, String(formData.get("cvSummary") || "") || null,
     String(formData.get("qualifications") || "") || null, String(formData.get("skills") || "") || null,
     String(formData.get("gender") || "") || null, String(formData.get("maritalStatus") || "") || null,
     String(formData.get("nationality") || "") || null, String(formData.get("nssfNumber") || "") || null,
     String(formData.get("tinNumber") || "") || null, String(formData.get("nextOfKin") || "") || null,
     String(formData.get("nextOfKinRelationship") || "") || null, String(formData.get("nextOfKinPhone") || "") || null,
     String(formData.get("nextOfKinAddress") || "") || null, String(formData.get("alternativeEmail") || "") || null]);
  redirect("/portal/profile?saved=1");
}

export async function uploadMyDocumentAction(formData: FormData) {
  const { employeeId, userId } = await requireOwnEmployee();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/portal/profile?err=file");
  const buf = Buffer.from(await file.arrayBuffer());
  const docId = id("edoc");
  const key = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO employee_document (id, employee_id, name, doc_type, storage_key, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [docId, employeeId, file.name, String(formData.get("docType") || "other"), key, mimeFor(file.name), buf.length, userId]);
  redirect("/portal/profile?uploaded=1");
}
export async function deleteMyDocumentAction(formData: FormData) {
  const { employeeId } = await requireOwnEmployee();
  // only allow deleting the employee's OWN documents
  await q(`DELETE FROM employee_document WHERE id=$1 AND employee_id=$2`, [String(formData.get("documentId")), employeeId]);
  revalidatePath("/portal/profile");
}

// Staff self-service versions of leave / timesheet / purchase request (scoped to self)
export async function myRequestLeaveAction(formData: FormData) {
  const { employeeId, orgId } = await requireOwnEmployee();
  const start = String(formData.get("startDate") || ""); const end = String(formData.get("endDate") || "");
  const days = Number(formData.get("days") || 0);
  if (!start || !end || days <= 0) redirect("/portal/leave?err=1");
  await q(`INSERT INTO leave_request (id, org_id, employee_id, leave_type, start_date, end_date, days, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("lv"), orgId, employeeId, String(formData.get("leaveType") || "annual"), start, end, days, String(formData.get("reason") || "") || null]);
  redirect("/portal/leave?requested=1");
}
export async function myAddTimesheetAction(formData: FormData) {
  const { employeeId, orgId } = await requireOwnEmployee();
  const hours = Number(formData.get("hours") || 0);
  if (hours <= 0) redirect("/portal/timesheets?err=1");
  await q(`INSERT INTO timesheet (id, org_id, employee_id, project_id, work_date, hours, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("ts"), orgId, employeeId, String(formData.get("projectId") || "") || null,
     String(formData.get("workDate") || new Date().toISOString().slice(0, 10)), hours, String(formData.get("description") || "") || null]);
  redirect("/portal/timesheets?added=1");
}
export async function myCreatePurchaseRequestAction(formData: FormData) {
  const { orgId, userId, userName } = await requireOwnEmployee();
  const title = String(formData.get("title") || "").trim();
  const desc = String(formData.get("itemDescription") || "").trim();
  const qty = Number(formData.get("quantity") || 1);
  const unitCost = Number(formData.get("unitCost") || 0);
  if (!title || !desc) redirect("/portal/requests?err=1");
  const prId = id("pr");
  const number = await nextNumProc(orgId, "purchase_request", "PR");
  const amount = Math.round((qty * unitCost + Number.EPSILON) * 100) / 100;
  await q(`INSERT INTO purchase_request (id, org_id, project_id, number, title, justification, needed_by, currency, estimated_total, status, requested_by, requested_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitted',$10,$11)`,
    [prId, orgId, String(formData.get("projectId") || "") || null, number, title,
     String(formData.get("justification") || "") || null, String(formData.get("neededBy") || "") || null,
     String(formData.get("currency") || "USD"), amount, userId, userName]);
  await q(`INSERT INTO purchase_request_item (id, request_id, description, quantity, unit, estimated_unit_cost, amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id("pri"), prId, desc, qty, String(formData.get("unit") || "") || null, unitCost, amount]);
  redirect("/portal/requests?created=1");
}

/* ---- Activity lead assignment (PI / coordinator / manager assign any member) ---- */
export async function assignActivityLeadAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  const activityId = String(formData.get("activityId"));
  await requirePermission(projectId, "project.edit");
  const ownerId = String(formData.get("ownerId") || "") || null;
  // Capture the previous owner + title so we only notify on an actual (new) assignment.
  const prev = await one<{ ownerId: string | null; title: string }>(
    `SELECT owner_id AS "ownerId", title FROM activity WHERE id=$1 AND project_id=$2`, [activityId, projectId]
  );
  await q(`UPDATE activity SET owner_id=$3, updated_at=now() WHERE id=$1 AND project_id=$2`, [activityId, projectId, ownerId]);
  await writeAudit({ userId: user.id, action: "update", entity: "activity", entityId: activityId, after: { ownerId } });
  // Notify the newly-assigned person — in-app AND by email — when this is a change.
  if (ownerId && ownerId !== prev?.ownerId) {
    const proj = await one<{ orgId: string; title: string; code: string }>(
      `SELECT org_id AS "orgId", title, code FROM project WHERE id=$1`, [projectId]
    );
    await notify({
      orgId: proj?.orgId ?? null,
      userId: ownerId,
      type: "assignment",
      title: `You've been assigned an activity${proj ? ` on ${proj.code}` : ""}`,
      body: `${user.name} assigned you as lead on "${prev?.title ?? "an activity"}"${proj ? ` in ${proj.title}` : ""}.`,
      link: `/projects/${projectId}/workplan`,
      email: true,
    });
  }
  revalidatePath(`/projects/${projectId}/workplan`);
}

/* ============ RICH EMPLOYEE PROFILE + EDUCATION + POLICY NUMBERS ============ */
import { executeHrAction } from "@/server/services/hr";

// HR updates the full demographic/statutory section of an employee record.
export async function updateEmployeeProfileAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  await q(`UPDATE employee SET prefix=$2, gender=$3, marital_status=$4, nationality=$5, date_of_birth=$6,
             national_id=$7, nssf_number=$8, tin_number=$9, address=$10, phone=$11, email=$12,
             next_of_kin=$13, next_of_kin_relationship=$14, next_of_kin_phone=$15, next_of_kin_address=$16
           WHERE id=$1 AND org_id=$17`,
    [eid, String(formData.get("prefix") || "") || null, String(formData.get("gender") || "") || null,
     String(formData.get("maritalStatus") || "") || null, String(formData.get("nationality") || "") || null,
     String(formData.get("dateOfBirth") || "") || null, String(formData.get("nationalId") || "") || null,
     String(formData.get("nssfNumber") || "") || null, String(formData.get("tinNumber") || "") || null,
     String(formData.get("address") || "") || null, String(formData.get("phone") || "") || null,
     String(formData.get("email") || "") || null, String(formData.get("nextOfKin") || "") || null,
     String(formData.get("nextOfKinRelationship") || "") || null, String(formData.get("nextOfKinPhone") || "") || null,
     String(formData.get("nextOfKinAddress") || "") || null, orgId]);
  revalidatePath(`/hr/employees/${eid}`);
  redirect(`/hr/employees/${eid}?saved=1`);
}

export async function addEmployeeEducationAction(formData: FormData) {
  await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  const qual = String(formData.get("qualification") || "").trim();
  if (!qual) redirect(`/hr/employees/${eid}?err=edu`);
  await q(`INSERT INTO employee_education (id, employee_id, kind, qualification, institution, year_obtained, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("edu"), eid, String(formData.get("kind") || "degree"), qual,
     String(formData.get("institution") || "") || null, String(formData.get("yearObtained") || "") || null,
     String(formData.get("note") || "") || null]);
  revalidatePath(`/hr/employees/${eid}`);
}
export async function deleteEmployeeEducationAction(formData: FormData) {
  await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  await q(`DELETE FROM employee_education WHERE id=$1`, [String(formData.get("educationId"))]);
  revalidatePath(`/hr/employees/${eid}`);
}
export async function addEmployeePolicyAction(formData: FormData) {
  await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  const lbl = String(formData.get("label") || "").trim();
  const val = String(formData.get("value") || "").trim();
  if (!lbl || !val) redirect(`/hr/employees/${eid}?err=policy`);
  await q(`INSERT INTO employee_policy_number (id, employee_id, label, value, note) VALUES ($1,$2,$3,$4,$5)`,
    [id("pol"), eid, lbl, val, String(formData.get("note") || "") || null]);
  revalidatePath(`/hr/employees/${eid}`);
}
export async function deleteEmployeePolicyAction(formData: FormData) {
  await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  await q(`DELETE FROM employee_policy_number WHERE id=$1`, [String(formData.get("policyId"))]);
  revalidatePath(`/hr/employees/${eid}`);
}

/* ============ TERMINATION / ACCESS-REVOCATION WORKFLOW ============ */
// HR submits a request (needs PI approval before it executes).
export async function requestHrActionAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const eid = String(formData.get("employeeId"));
  const actionType = String(formData.get("actionType")); // terminate | revoke_access
  if (actionType !== "terminate" && actionType !== "revoke_access") redirect(`/hr/employees/${eid}?err=action`);
  await q(`INSERT INTO hr_action_request (id, org_id, employee_id, action_type, reason, effective_date, status, requested_by, requested_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
    [id("hra"), orgId, eid, actionType, String(formData.get("reason") || "") || null,
     String(formData.get("effectiveDate") || "") || null, userId, userName]);
  await writeAudit({ orgId, userId, action: "request", entity: "hr_action_request", entityId: eid, after: { actionType } });
  redirect(`/hr/employees/${eid}?hra=requested`);
}
// PI / approver decides. On approval it executes immediately.
export async function decideHrActionAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const reqId = String(formData.get("requestId"));
  const eid = String(formData.get("employeeId"));
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  await q(`UPDATE hr_action_request SET status=$2, decided_by=$3, decided_by_name=$4, decided_at=now(), decision_note=$5 WHERE id=$1 AND org_id=$6`,
    [reqId, decision, userId, userName, String(formData.get("note") || "") || null, orgId]);
  if (decision === "approved") {
    try { await executeHrAction(reqId); }
    catch (e) { redirect(`/hr/employees/${eid}?hra=${encodeURIComponent((e as Error).message).slice(0, 100)}`); }
  }
  await writeAudit({ orgId, userId, action: decision, entity: "hr_action_request", entityId: eid });
  redirect(`/hr/employees/${eid}?hra=${decision}`);
}

/* ============ COLLABORATIONS ============ */
export async function addCollaboratorAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/collaborations?err=name");
  await q(`INSERT INTO collaborator (id, org_id, prefix, name, organisation, collaborator_type, email, phone, country, address, expertise, website, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id("collab"), orgId, String(formData.get("prefix") || "") || null, name,
     String(formData.get("organisation") || "") || null, String(formData.get("collaboratorType") || "institution"),
     String(formData.get("email") || "") || null, String(formData.get("phone") || "") || null,
     String(formData.get("country") || "") || null, String(formData.get("address") || "") || null,
     String(formData.get("expertise") || "") || null, String(formData.get("website") || "") || null,
     String(formData.get("note") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "collaborator", entityId: name });
  redirect("/collaborations?created=1");
}
export async function updateCollaboratorStatusAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("collaboratorId"));
  await q(`UPDATE collaborator SET status = CASE WHEN status='active' THEN 'inactive' ELSE 'active' END WHERE id=$1 AND org_id=$2`, [cid, orgId]);
  revalidatePath("/collaborations");
}
export async function linkCollaboratorToProjectAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("collaboratorId"));
  const projectId = String(formData.get("projectId"));
  if (!projectId) redirect(`/collaborations/${cid}?err=project`);
  await q(`INSERT INTO project_collaborator (id, project_id, collaborator_id, role, responsibilities)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, collaborator_id) DO UPDATE SET role=$4, responsibilities=$5`,
    [id("pcol"), projectId, cid, String(formData.get("role") || "collaborator"), String(formData.get("responsibilities") || "") || null]);
  revalidatePath(`/collaborations/${cid}`);
  redirect(`/collaborations/${cid}?linked=1`);
}
export async function unlinkCollaboratorFromProjectAction(formData: FormData) {
  await requireInstitutionFinance();
  const cid = String(formData.get("collaboratorId"));
  await q(`DELETE FROM project_collaborator WHERE id=$1`, [String(formData.get("linkId"))]);
  revalidatePath(`/collaborations/${cid}`);
}

/* ============ DUAL-CURRENCY DASHBOARD SETTING ============ */
export async function setDisplayCurrencyAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const disp = String(formData.get("displayCurrency") || "").trim().toUpperCase().slice(0, 3) || null;
  await q(`UPDATE organization SET display_currency=$2 WHERE id=$1`, [orgId, disp]);
  revalidatePath("/dashboard");
  redirect("/dashboard?ccy=1");
}

/* ============================ ORGANIZATION PROFILE ============================ */
// Org admins manage their organisation's profile. Logo + address feed the
// letterhead used on all printouts.
export async function updateOrgProfileAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  await q(`UPDATE organization SET name=$2, address=$3, email=$4, phone=$5, website=$6, slogan=$7,
             mission=$8, vision=$9, values_text=$10, objectives=$11, registration_no=$12,
             social_twitter=$13, social_linkedin=$14, social_facebook=$15, brand_color=$16, tin=$17, bank_details=$18, updated_at=now()
           WHERE id=$1`,
    [orgId, String(formData.get("name") || "").trim() || "Organisation",
     String(formData.get("address") || "") || null, String(formData.get("email") || "") || null,
     String(formData.get("phone") || "") || null, String(formData.get("website") || "") || null,
     String(formData.get("slogan") || "") || null, String(formData.get("mission") || "") || null,
     String(formData.get("vision") || "") || null, String(formData.get("valuesText") || "") || null,
     String(formData.get("objectives") || "") || null, String(formData.get("registrationNo") || "") || null,
     String(formData.get("twitter") || "") || null, String(formData.get("linkedin") || "") || null,
     String(formData.get("facebook") || "") || null, String(formData.get("brandColor") || "#2f5d62"),
     String(formData.get("tin") || "") || null, String(formData.get("bankDetails") || "") || null]);
  await writeAudit({ orgId, userId, action: "update", entity: "organization", entityId: orgId });
  redirect("/organization?saved=1");
}

export async function uploadOrgLogoAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) redirect("/organization?err=logo");
  if (file.size > 2 * 1024 * 1024) redirect("/organization?err=logosize");
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = mimeFor(file.name);
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  await q(`UPDATE organization SET logo_data_url=$2, updated_at=now() WHERE id=$1`, [orgId, dataUrl]);
  redirect("/organization?logo=ok");
}
export async function removeOrgLogoAction() {
  const { orgId } = await requireInstitutionFinance();
  await q(`UPDATE organization SET logo_data_url=NULL WHERE id=$1`, [orgId]);
  redirect("/organization?logo=removed");
}

// Admin password change from the organisation page (redirects back there).
export async function changeAdminPasswordAction(formData: FormData) {
  const user = await requireUser();
  const current = String(formData.get("current") || "");
  const next = String(formData.get("next") || "");
  const confirm = String(formData.get("confirm") || "");
  const row = await one<{ passwordHash: string | null }>(`SELECT password_hash AS "passwordHash" FROM app_user WHERE id=$1`, [user.id]);
  if (!row || !verifyPassword(current, row.passwordHash)) redirect("/organization?pw=wrong");
  if (next !== confirm) redirect("/organization?pw=Passwords%20do%20not%20match");
  const pe = passwordError(next);
  if (pe) redirect(`/organization?pw=${encodeURIComponent(pe)}`);
  await q(`UPDATE app_user SET password_hash=$2, updated_at=now() WHERE id=$1`, [user.id, await hashPassword(next)]);
  await writeAudit({ userId: user.id, action: "update", entity: "app_user", entityId: user.id, meta: { passwordChanged: true } });
  redirect("/organization?pw=changed");
}

/* ---------------- Collaborator portal login (view-only) ---------------- */
import { createCollaboratorLogin } from "@/server/services/collab";

export async function createCollaboratorLoginAction(formData: FormData) {
  await requireInstitutionFinance();
  const cid = String(formData.get("collaboratorId"));
  let res;
  try { res = await createCollaboratorLogin(cid); }
  catch (e) { redirect(`/collaborations/${cid}?loginerr=${encodeURIComponent((e as Error).message).slice(0, 120)}`); }
  redirect(`/collaborations/${cid}?login=${res.emailStatus}`);
}

/* ---------------- Compensation (grant-model payroll) ---------------- */
import { upsertCompConfig, upsertEmployeeComp, type CompConfigRow } from "@/server/services/compensation";

function parseNum(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function saveCompConfigAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const cfg: CompConfigRow = {
    nssfEmployerPct: parseNum(formData.get("nssfEmployerPct")) ?? 10,
    nssfEmployeePct: parseNum(formData.get("nssfEmployeePct")) ?? 5,
    consultantWhtPct: parseNum(formData.get("consultantWhtPct")) ?? 6,
    payeMethod: (String(formData.get("payeMethod") || "uganda") as CompConfigRow["payeMethod"]),
    payeFlatPct: parseNum(formData.get("payeFlatPct")) ?? 0,
    payeBands: null,
    nssfEmployerFromFringe: formData.get("nssfEmployerFromFringe") === "on",
    nssfEmployeeFromFringe: formData.get("nssfEmployeeFromFringe") === "on",
    lstEnabled: formData.get("lstEnabled") === "on",
    lstBands: null,
    lstDivisor: parseNum(formData.get("lstDivisor")) ?? 12,
  };
  await upsertCompConfig(orgId, cfg);
  await writeAudit({ orgId, userId, action: "update", entity: "comp_config", entityId: orgId, after: cfg });
  redirect("/hr/compensation?saved=1");
}

export async function upsertEmployeeCompAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const employeeId = String(formData.get("employeeId"));
  const employmentType = (String(formData.get("employmentType") || "staff") === "consultant" ? "consultant" : "staff") as "staff" | "consultant";
  // Other fringe benefits arrive as parallel benefitLabel[] / benefitAmount[] arrays.
  const lbls = formData.getAll("benefitLabel").map((v) => String(v));
  const amts = formData.getAll("benefitAmount").map((v) => Number(String(v)) || 0);
  const benefits = lbls.map((lbl, i) => ({ label: lbl.trim(), amount: amts[i] ?? 0 })).filter((b) => b.label);
  // Additional deductions/savings: deductionLabel[] / deductionValue[] / deductionKind[].
  const dLbls = formData.getAll("deductionLabel").map((v) => String(v));
  const dVals = formData.getAll("deductionValue").map((v) => Number(String(v)) || 0);
  const dKinds = formData.getAll("deductionKind").map((v) => String(v));
  const validKinds = ["pct_deduction", "pct_saving", "flat_deduction", "flat_saving"];
  const deductions = dLbls.map((lbl, i) => ({
    label: lbl.trim(),
    value: dVals[i] ?? 0,
    kind: (validKinds.includes(dKinds[i]) ? dKinds[i] : "pct_deduction") as "pct_deduction" | "pct_saving" | "flat_deduction" | "flat_saving",
  })).filter((d) => d.label);
  await upsertEmployeeComp(orgId, employeeId, {
    projectId: String(formData.get("projectId") || "") || null,
    employmentType,
    currency: String(formData.get("currency") || "USD").trim() || "USD",
    grossSalary: parseNum(formData.get("grossSalary")),
    baseSalary: parseNum(formData.get("baseSalary")),
    effortPct: parseNum(formData.get("effortPct")) ?? 100,
    calMonths: parseNum(formData.get("calMonths")),
    fringeAmount: parseNum(formData.get("fringeAmount")),
    fringeRatePct: parseNum(formData.get("fringeRatePct")),
    fringeBasis: (String(formData.get("fringeBasis") || "base") === "charged" ? "charged" : "base"),
    requestedFunds: parseNum(formData.get("requestedFunds")),
    benefits,
    payeOverridePct: parseNum(formData.get("payeOverridePct")),
    deductions,
    note: String(formData.get("note") || "") || null,
  });
  await writeAudit({ orgId, userId, action: "update", entity: "employee_compensation", entityId: employeeId });
  const back = String(formData.get("back") || `/hr/employees/${employeeId}`);
  redirect(`${back}?saved=1`);
}

/* ---------------- Departments (find-or-create helper) ---------------- */
async function ensureDepartment(orgId: string, rawName: string): Promise<{ id: string; name: string } | null> {
  const name = rawName.trim();
  if (!name) return null;
  const existing = await one<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 AND lower(name)=lower($2)`, [orgId, name]);
  if (existing) return existing;
  await q(`INSERT INTO department (id, org_id, name) VALUES ($1,$2,$3) ON CONFLICT (org_id, name) DO NOTHING`, [id("dept"), orgId, name]);
  return one<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 AND lower(name)=lower($2)`, [orgId, name]);
}

/* ---------------- Collaborator details & project roles ---------------- */
// HR / org admins edit a collaborator's master details.
export async function updateCollaboratorDetailsAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const cid = String(formData.get("collaboratorId"));
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect(`/collaborations/${cid}?err=name`);
  await q(
    `UPDATE collaborator SET prefix=$3, name=$4, organisation=$5, collaborator_type=$6, email=$7,
       phone=$8, country=$9, address=$10, expertise=$11, website=$12, note=$13
     WHERE id=$1 AND org_id=$2`,
    [cid, orgId, String(formData.get("prefix") || "") || null, name,
     String(formData.get("organisation") || "") || null, String(formData.get("collaboratorType") || "institution"),
     String(formData.get("email") || "") || null, String(formData.get("phone") || "") || null,
     String(formData.get("country") || "") || null, String(formData.get("address") || "") || null,
     String(formData.get("expertise") || "") || null, String(formData.get("website") || "") || null,
     String(formData.get("note") || "") || null]
  );
  await writeAudit({ orgId, userId, action: "update", entity: "collaborator", entityId: cid });
  redirect(`/collaborations/${cid}?saved=1`);
}

// Edit a collaborator's role/responsibilities on a specific project. Gated by
// project-level members.manage, so the PI (and org admins) can both use it.
export async function updateCollaboratorProjectRoleAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const access = await requirePermission(projectId, "members.manage");
  const linkId = String(formData.get("linkId"));
  await q(`UPDATE project_collaborator SET role=$2, responsibilities=$3 WHERE id=$1 AND project_id=$4`,
    [linkId, String(formData.get("role") || "collaborator"), String(formData.get("responsibilities") || "") || null, projectId]);
  await writeAudit({ userId: access.user.id, action: "update", entity: "project_collaborator", entityId: linkId });
  const back = String(formData.get("back") || `/projects/${projectId}/team`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

export async function removeCollaboratorProjectLinkAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "members.manage");
  await q(`DELETE FROM project_collaborator WHERE id=$1 AND project_id=$2`, [String(formData.get("linkId")), projectId]);
  const back = String(formData.get("back") || `/projects/${projectId}/team`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

/* ---------------- Staff ↔ project assignments (role & responsibilities) ---------------- */
// Assign an employee to a project (or update their role/responsibilities).
// Gated by project members.manage so HR/org admins (from the employee profile)
// and PIs (from the project Team page) can both manage staffing.
export async function upsertEmployeeProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const employeeId = String(formData.get("employeeId"));
  const access = await requirePermission(projectId, "members.manage");
  if (!projectId || !employeeId) redirect(String(formData.get("back") || "/hr/employees"));
  const role = String(formData.get("role") || "") || null;
  const responsibilities = String(formData.get("responsibilities") || "") || null;
  await q(
    `INSERT INTO employee_project (id, employee_id, project_id, role, responsibilities)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (employee_id, project_id) DO UPDATE SET role=$4, responsibilities=$5`,
    [id("epj"), employeeId, projectId, role, responsibilities]
  );
  await writeAudit({ userId: access.user.id, action: "update", entity: "employee_project", entityId: `${employeeId}:${projectId}`, after: { role } });
  const back = String(formData.get("back") || `/hr/employees/${employeeId}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

export async function removeEmployeeProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const employeeId = String(formData.get("employeeId"));
  await requirePermission(projectId, "members.manage");
  await q(`DELETE FROM employee_project WHERE employee_id=$1 AND project_id=$2`, [employeeId, projectId]);
  const back = String(formData.get("back") || `/hr/employees/${employeeId}`);
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

/* ===================== FINANCIAL YEARS ===================== */
export async function addFinancialYearAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  const start = String(formData.get("startDate") || "");
  const end = String(formData.get("endDate") || "");
  if (!name || !start || !end) redirect("/finance/years?err=fields");
  const makeCurrent = formData.get("isCurrent") === "on";
  if (makeCurrent) await q(`UPDATE financial_year SET is_current=false WHERE org_id=$1`, [orgId]);
  await q(`INSERT INTO financial_year (id, org_id, name, start_date, end_date, is_current, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, name) DO NOTHING`,
    [id("fy"), orgId, name, start, end, makeCurrent, String(formData.get("note") || "") || null]);
  redirect("/finance/years?saved=1");
}

export async function setCurrentFinancialYearAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const fyId = String(formData.get("yearId"));
  await q(`UPDATE financial_year SET is_current=false WHERE org_id=$1`, [orgId]);
  await q(`UPDATE financial_year SET is_current=true WHERE id=$1 AND org_id=$2`, [fyId, orgId]);
  redirect("/finance/years?saved=1");
}

export async function deleteFinancialYearAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM financial_year WHERE id=$1 AND org_id=$2`, [String(formData.get("yearId")), orgId]);
  redirect("/finance/years?saved=1");
}

/* ===================== SUB-AWARDS ===================== */
function subawardFields(formData: FormData) {
  return {
    projectId: String(formData.get("projectId") || "") || null,
    collaboratorId: String(formData.get("collaboratorId") || "") || null,
    granteeName: String(formData.get("granteeName") || "").trim(),
    title: String(formData.get("title") || "").trim(),
    reference: String(formData.get("reference") || "") || null,
    description: String(formData.get("description") || "") || null,
    deliverables: String(formData.get("deliverables") || "") || null,
    amount: Number(formData.get("amount") || 0),
    currency: String(formData.get("currency") || "USD").trim() || "USD",
    startDate: String(formData.get("startDate") || "") || null,
    endDate: String(formData.get("endDate") || "") || null,
    status: String(formData.get("status") || "draft"),
    contactName: String(formData.get("contactName") || "") || null,
    contactEmail: String(formData.get("contactEmail") || "") || null,
  };
}

export async function createSubawardAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const f = subawardFields(formData);
  if (!f.granteeName || !f.title) redirect("/subawards?err=fields");
  const sid = id("suba");
  await q(`INSERT INTO subaward (id, org_id, project_id, collaborator_id, grantee_name, title, reference, description,
             deliverables, amount, currency, start_date, end_date, status, contact_name, contact_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [sid, orgId, f.projectId, f.collaboratorId, f.granteeName, f.title, f.reference, f.description,
     f.deliverables, f.amount, f.currency, f.startDate, f.endDate, f.status, f.contactName, f.contactEmail]);
  await writeAudit({ orgId, userId, action: "create", entity: "subaward", entityId: sid, after: { granteeName: f.granteeName, amount: f.amount } });
  redirect(`/subawards/${sid}`);
}

export async function updateSubawardAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const sid = String(formData.get("subawardId"));
  const f = subawardFields(formData);
  if (!f.granteeName || !f.title) redirect(`/subawards/${sid}?err=fields`);
  await q(`UPDATE subaward SET project_id=$3, collaborator_id=$4, grantee_name=$5, title=$6, reference=$7, description=$8,
             deliverables=$9, amount=$10, currency=$11, start_date=$12, end_date=$13, status=$14, contact_name=$15, contact_email=$16
           WHERE id=$1 AND org_id=$2`,
    [sid, orgId, f.projectId, f.collaboratorId, f.granteeName, f.title, f.reference, f.description,
     f.deliverables, f.amount, f.currency, f.startDate, f.endDate, f.status, f.contactName, f.contactEmail]);
  await writeAudit({ orgId, userId, action: "update", entity: "subaward", entityId: sid });
  redirect(`/subawards/${sid}?saved=1`);
}

export async function deleteSubawardAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM subaward WHERE id=$1 AND org_id=$2`, [String(formData.get("subawardId")), orgId]);
  redirect("/subawards");
}

export async function addSubawardPaymentAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const sid = String(formData.get("subawardId"));
  const owner = await one<{ id: string }>(`SELECT id FROM subaward WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  if (!owner) redirect("/subawards");
  await q(`INSERT INTO subaward_payment (id, subaward_id, paid_on, amount, reference, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("subpay"), sid, String(formData.get("paidOn") || "") || new Date().toISOString().slice(0, 10),
     Number(formData.get("amount") || 0), String(formData.get("reference") || "") || null, String(formData.get("note") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "subaward_payment", entityId: sid });
  redirect(`/subawards/${sid}?saved=1`);
}

export async function deleteSubawardPaymentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const sid = String(formData.get("subawardId"));
  await q(`DELETE FROM subaward_payment WHERE id=$1 AND subaward_id IN (SELECT id FROM subaward WHERE org_id=$2)`,
    [String(formData.get("paymentId")), orgId]);
  redirect(`/subawards/${sid}?saved=1`);
}

/* ===================== HR EMPLOYEE DOCUMENTS ===================== */
// HR uploads documents (contracts etc.) onto an employee record.
export async function uploadEmployeeDocumentAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  const owner = await one<{ id: string }>(`SELECT id FROM employee WHERE id=$1 AND org_id=$2`, [empId, orgId]);
  if (!owner) redirect("/hr/employees");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/hr/employees/${empId}?docerr=file`);
  const buf = Buffer.from(await file.arrayBuffer());
  const docId = id("edoc");
  const key = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO employee_document (id, employee_id, name, doc_type, storage_key, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [docId, empId, file.name, String(formData.get("docType") || "contract"), key, mimeFor(file.name), buf.length, userId]);
  await writeAudit({ orgId, userId, action: "create", entity: "employee_document", entityId: docId, after: { name: file.name } });
  redirect(`/hr/employees/${empId}?docuploaded=1`);
}

export async function deleteEmployeeDocumentAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const empId = String(formData.get("employeeId"));
  const doc = await one<{ storageKey: string | null }>(
    `SELECT ed.storage_key AS "storageKey" FROM employee_document ed JOIN employee e ON e.id=ed.employee_id
     WHERE ed.id=$1 AND e.org_id=$2`, [String(formData.get("documentId")), orgId]);
  if (doc?.storageKey) await deleteUpload(doc.storageKey);
  await q(`DELETE FROM employee_document WHERE id=$1 AND employee_id IN (SELECT id FROM employee WHERE org_id=$2)`,
    [String(formData.get("documentId")), orgId]);
  redirect(`/hr/employees/${empId}?docdeleted=1`);
}

/* ===================== RESPONSIBILITIES FROM A WORD DOC ===================== */
import { extractResponsibilities } from "@/server/services/docparse";
// Upload a contract / ToR (.docx) and auto-populate the responsibilities for a
// staff project assignment. Always editable afterwards — never auto-finalised.
export async function generateResponsibilitiesFromDocAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const employeeId = String(formData.get("employeeId"));
  const access = await requirePermission(projectId, "members.manage");
  const back = String(formData.get("back") || `/hr/employees/${employeeId}`);
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { redirect(`${back}?generr=file`); }
  const name = file.name.toLowerCase();
  if (!name.endsWith(".docx")) { redirect(`${back}?generr=type`); }
  const buf = Buffer.from(await file.arrayBuffer());
  const items = await extractResponsibilities(buf);
  if (items.length === 0) { redirect(`${back}?generr=empty`); }
  const text = items.map((i) => `• ${i}`).join("\n");
  await q(
    `INSERT INTO employee_project (id, employee_id, project_id, responsibilities)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (employee_id, project_id) DO UPDATE SET responsibilities=$4`,
    [id("epj"), employeeId, projectId, text]
  );
  await writeAudit({ userId: access.user.id, action: "update", entity: "employee_project", entityId: `${employeeId}:${projectId}`, meta: { source: "docx", count: items.length } });
  redirect(`${back}?generated=${items.length}`);
}

/* ===================== STATUTORY REMITTANCES (Finance Policy §17) ===================== */
// Default statutory deadline: the 15th of the month following the pay period.
function remittanceDueDefault(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!m) return new Date().toISOString().slice(0, 10);
  let y = Number(m[1]); let mo = Number(m[2]); // 1..12
  mo += 1; if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}-15`;
}

export async function addStatutoryRemittanceAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const period = String(formData.get("period") || "").trim();
  const taxType = String(formData.get("taxType") || "paye");
  if (!period) redirect("/finance/remittances?err=fields");
  const due = String(formData.get("dueDate") || "").trim() || remittanceDueDefault(period);
  await q(`INSERT INTO statutory_remittance (id, org_id, period, tax_type, amount, currency, due_date, paid_on, reference, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("remit"), orgId, period, taxType, Number(formData.get("amount") || 0),
     String(formData.get("currency") || "UGX").trim() || "UGX", due,
     String(formData.get("paidOn") || "") || null, String(formData.get("reference") || "") || null,
     String(formData.get("note") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "statutory_remittance", entityId: period, after: { taxType, period } });
  redirect("/finance/remittances?saved=1");
}

export async function markRemittancePaidAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`UPDATE statutory_remittance SET paid_on=$3, reference=COALESCE($4, reference) WHERE id=$1 AND org_id=$2`,
    [String(formData.get("remittanceId")), orgId,
     String(formData.get("paidOn") || "") || new Date().toISOString().slice(0, 10),
     String(formData.get("reference") || "") || null]);
  redirect("/finance/remittances?saved=1");
}

export async function deleteStatutoryRemittanceAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM statutory_remittance WHERE id=$1 AND org_id=$2`, [String(formData.get("remittanceId")), orgId]);
  redirect("/finance/remittances?saved=1");
}

/* ===================== PROCUREMENT QUOTATIONS & CONFIG (Policy §6, §7) ===================== */
async function prOwnedBy(orgId: string, prId: string): Promise<boolean> {
  return Boolean(await one<{ id: string }>(`SELECT id FROM purchase_request WHERE id=$1 AND org_id=$2`, [prId, orgId]));
}

export async function addQuotationAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  if (!(await prOwnedBy(orgId, prId))) redirect("/procurement/requests");
  const vendorName = String(formData.get("vendorName") || "").trim();
  if (!vendorName) redirect(`/procurement/requests/${prId}?err=quotefields`);
  await q(`INSERT INTO pr_quotation (id, request_id, vendor_id, vendor_name, amount, currency, lead_time_days, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("quote"), prId, String(formData.get("vendorId") || "") || null, vendorName,
     Number(formData.get("amount") || 0), String(formData.get("currency") || "UGX").trim() || "UGX",
     formData.get("leadTimeDays") ? Number(formData.get("leadTimeDays")) : null,
     String(formData.get("notes") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "pr_quotation", entityId: prId });
  redirect(`/procurement/requests/${prId}?saved=1`);
}

export async function selectQuotationAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  if (!(await prOwnedBy(orgId, prId))) redirect("/procurement/requests");
  await q(`UPDATE pr_quotation SET selected=false WHERE request_id=$1`, [prId]);
  await q(`UPDATE pr_quotation SET selected=true WHERE id=$1 AND request_id=$2`, [String(formData.get("quotationId")), prId]);
  redirect(`/procurement/requests/${prId}?saved=1`);
}

export async function deleteQuotationAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  await q(`DELETE FROM pr_quotation WHERE id=$1 AND request_id IN (SELECT id FROM purchase_request WHERE org_id=$2)`,
    [String(formData.get("quotationId")), orgId]);
  redirect(`/procurement/requests/${prId}?saved=1`);
}

export async function saveSingleSourceJustificationAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const prId = String(formData.get("requestId"));
  await q(`UPDATE purchase_request SET single_source_justification=$3 WHERE id=$1 AND org_id=$2`,
    [prId, orgId, String(formData.get("justification") || "") || null]);
  redirect(`/procurement/requests/${prId}?saved=1`);
}

export async function saveProcurementConfigAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const cfg: ProcurementConfig = {
    currency: String(formData.get("currency") || "UGX").trim() || "UGX",
    directMax: Number(formData.get("directMax") || 0),
    microMax: Number(formData.get("microMax") || 0),
    quotesDirect: Number(formData.get("quotesDirect") || 1),
    quotesMicro: Number(formData.get("quotesMicro") || 3),
    quotesFormal: Number(formData.get("quotesFormal") || 3),
    enforce: formData.get("enforce") === "on",
  };
  await upsertProcurementConfig(orgId, cfg);
  await writeAudit({ orgId, userId, action: "update", entity: "procurement_config", entityId: orgId, after: cfg });
  redirect("/procurement/config?saved=1");
}

/* ===================== PER DIEM & TRAVEL (Finance Policy §14.2) ===================== */
export async function addPerdiemRateAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const category = String(formData.get("category") || "").trim();
  if (!category) redirect("/finance/perdiem?err=ratefields");
  await q(`INSERT INTO perdiem_rate (id, org_id, category, daily_rate, currency, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("pdr"), orgId, category, Number(formData.get("dailyRate") || 0),
     String(formData.get("currency") || "UGX").trim() || "UGX", String(formData.get("note") || "") || null]);
  redirect("/finance/perdiem?saved=1");
}
export async function deletePerdiemRateAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM perdiem_rate WHERE id=$1 AND org_id=$2`, [String(formData.get("rateId")), orgId]);
  redirect("/finance/perdiem?saved=1");
}
export async function createPerdiemClaimAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const traveller = String(formData.get("travellerName") || "").trim();
  if (!traveller) redirect("/finance/perdiem?err=claimfields");
  const days = Number(formData.get("days") || 0);
  const rate = Number(formData.get("dailyRate") || 0);
  const cid = id("pdc");
  await q(`INSERT INTO perdiem_claim (id, org_id, project_id, employee_id, traveller_name, purpose, destination,
             start_date, end_date, days, daily_rate, currency, total, status, activity_report, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft',$14,$15,$16)`,
    [cid, orgId, String(formData.get("projectId") || "") || null, String(formData.get("employeeId") || "") || null,
     traveller, String(formData.get("purpose") || "") || null, String(formData.get("destination") || "") || null,
     String(formData.get("startDate") || "") || null, String(formData.get("endDate") || "") || null,
     days, rate, String(formData.get("currency") || "UGX").trim() || "UGX", days * rate,
     String(formData.get("activityReport") || "") || null, userId, userName]);
  redirect(`/finance/perdiem/${cid}`);
}
export async function updatePerdiemReportAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  await q(`UPDATE perdiem_claim SET activity_report=$3, purpose=COALESCE($4,purpose), destination=COALESCE($5,destination),
             days=$6, daily_rate=$7, total=$6*$7 WHERE id=$1 AND org_id=$2 AND status IN ('draft','rejected')`,
    [cid, orgId, String(formData.get("activityReport") || "") || null,
     String(formData.get("purpose") || "") || null, String(formData.get("destination") || "") || null,
     Number(formData.get("days") || 0), Number(formData.get("dailyRate") || 0)]);
  redirect(`/finance/perdiem/${cid}?saved=1`);
}
export async function approvePerdiemAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  // Gate: per-diem cannot be approved without an activity report (Policy §14.2).
  const claim = await one<{ report: string | null; status: string }>(`SELECT activity_report AS report, status FROM perdiem_claim WHERE id=$1 AND org_id=$2`, [cid, orgId]);
  if (!claim) redirect("/finance/perdiem");
  if (!claim.report || !claim.report.trim()) redirect(`/finance/perdiem/${cid}?err=noreport`);
  await q(`UPDATE perdiem_claim SET status='approved', approved_by=$3, approved_by_name=$4, approved_at=now() WHERE id=$1 AND org_id=$2`,
    [cid, orgId, userId, userName]);
  await writeAudit({ orgId, userId, action: "approve", entity: "perdiem_claim", entityId: cid });
  redirect(`/finance/perdiem/${cid}?saved=1`);
}
export async function rejectPerdiemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  await q(`UPDATE perdiem_claim SET status='rejected' WHERE id=$1 AND org_id=$2`, [cid, orgId]);
  redirect(`/finance/perdiem/${cid}?saved=1`);
}
export async function markPerdiemPaidAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  await q(`UPDATE perdiem_claim SET status='paid', paid_on=$3, payment_ref=$4 WHERE id=$1 AND org_id=$2 AND status='approved'`,
    [cid, orgId, String(formData.get("paidOn") || "") || new Date().toISOString().slice(0, 10), String(formData.get("paymentRef") || "") || null]);
  redirect(`/finance/perdiem/${cid}?saved=1`);
}
export async function deletePerdiemClaimAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM perdiem_claim WHERE id=$1 AND org_id=$2`, [String(formData.get("claimId")), orgId]);
  redirect("/finance/perdiem");
}
export async function uploadPerdiemEvidenceAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  if (!(await one(`SELECT id FROM perdiem_claim WHERE id=$1 AND org_id=$2`, [cid, orgId]))) redirect("/finance/perdiem");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/finance/perdiem/${cid}?err=file`);
  const buf = Buffer.from(await file.arrayBuffer());
  const evId = id("pde");
  const key = await saveUpload(evId, file.name, buf);
  await q(`INSERT INTO perdiem_evidence (id, claim_id, name, storage_key, mime_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
    [evId, cid, file.name, key, mimeFor(file.name), buf.length]);
  redirect(`/finance/perdiem/${cid}?saved=1`);
}
export async function deletePerdiemEvidenceAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("claimId"));
  const ev = await one<{ storageKey: string | null }>(
    `SELECT pe.storage_key AS "storageKey" FROM perdiem_evidence pe JOIN perdiem_claim pc ON pc.id=pe.claim_id
     WHERE pe.id=$1 AND pc.org_id=$2`, [String(formData.get("evidenceId")), orgId]);
  if (ev?.storageKey) await deleteUpload(ev.storageKey);
  await q(`DELETE FROM perdiem_evidence WHERE id=$1 AND claim_id IN (SELECT id FROM perdiem_claim WHERE org_id=$2)`,
    [String(formData.get("evidenceId")), orgId]);
  redirect(`/finance/perdiem/${cid}?saved=1`);
}

/* ===================== PROCUREMENT PLAN (Procurement Policy §5) ===================== */
export async function addPlanItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const period = String(formData.get("period") || "").trim();
  const description = String(formData.get("description") || "").trim();
  if (!period || !description) redirect("/procurement/plan?err=fields");
  const qty = Number(formData.get("quantity") || 1);
  const unit = Number(formData.get("estUnitCost") || 0);
  await q(`INSERT INTO procurement_plan_item (id, org_id, project_id, period, description, category, quantity, est_unit_cost, est_total, currency, needed_by, department, status, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned',$13)`,
    [id("ppi"), orgId, String(formData.get("projectId") || "") || null, period, description,
     String(formData.get("category") || "") || null, qty, unit, qty * unit,
     String(formData.get("currency") || "UGX").trim() || "UGX", String(formData.get("neededBy") || "") || null,
     String(formData.get("department") || "") || null, String(formData.get("note") || "") || null]);
  redirect("/procurement/plan?saved=1");
}
export async function updatePlanItemStatusAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`UPDATE procurement_plan_item SET status=$3 WHERE id=$1 AND org_id=$2`,
    [String(formData.get("itemId")), orgId, String(formData.get("status") || "planned")]);
  redirect("/procurement/plan?saved=1");
}
export async function deletePlanItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM procurement_plan_item WHERE id=$1 AND org_id=$2`, [String(formData.get("itemId")), orgId]);
  redirect("/procurement/plan?saved=1");
}

/* ===================== ETHICS REGISTERS (Procurement Policy §7, §11) ===================== */
export async function addCoiAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const person = String(formData.get("personName") || "").trim();
  const nature = String(formData.get("nature") || "").trim();
  if (!person || !nature) redirect("/procurement/ethics?err=coifields");
  await q(`INSERT INTO coi_declaration (id, org_id, person_name, role, related_to, nature, action, declared_on, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("coi"), orgId, person, String(formData.get("role") || "") || null, String(formData.get("relatedTo") || "") || null,
     nature, String(formData.get("action") || "") || null,
     String(formData.get("declaredOn") || "") || new Date().toISOString().slice(0, 10), String(formData.get("note") || "") || null]);
  redirect("/procurement/ethics?saved=1");
}
export async function deleteCoiAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM coi_declaration WHERE id=$1 AND org_id=$2`, [String(formData.get("coiId")), orgId]);
  redirect("/procurement/ethics?saved=1");
}
export async function addGiftAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const person = String(formData.get("personName") || "").trim();
  const description = String(formData.get("description") || "").trim();
  if (!person || !description) redirect("/procurement/ethics?err=giftfields");
  await q(`INSERT INTO gift_log (id, org_id, person_name, supplier_name, description, est_value, currency, received_on, action_taken, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("gift"), orgId, person, String(formData.get("supplierName") || "") || null, description,
     formData.get("estValue") ? Number(formData.get("estValue")) : null,
     String(formData.get("currency") || "UGX").trim() || "UGX",
     String(formData.get("receivedOn") || "") || new Date().toISOString().slice(0, 10),
     String(formData.get("actionTaken") || "") || null, String(formData.get("note") || "") || null]);
  redirect("/procurement/ethics?saved=1");
}
export async function deleteGiftAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM gift_log WHERE id=$1 AND org_id=$2`, [String(formData.get("giftId")), orgId]);
  redirect("/procurement/ethics?saved=1");
}

/* ===================== ACCESS MANAGEMENT (org admin) ===================== */
// Ensures the organisation has an 'org_admin' role row and returns its id.
async function orgAdminRoleId(orgId: string): Promise<string> {
  const found = await one<{ id: string }>(`SELECT id FROM role WHERE org_id=$1 AND key='org_admin'`, [orgId]);
  if (found) return found.id;
  await q(`INSERT INTO role (id, org_id, key, name, is_system) VALUES ($1,$2,'org_admin','Organisation Admin', true)
           ON CONFLICT (org_id, key) DO NOTHING`, [id("role"), orgId]);
  return (await one<{ id: string }>(`SELECT id FROM role WHERE org_id=$1 AND key='org_admin'`, [orgId]))!.id;
}

// Set (or clear) a user's role + granular permission grants on one project.
// role='none' removes them from the project. Granular permissions are stored as
// the EXTRAS beyond what the role already grants, matching how policy resolves them.
export async function saveUserProjectAccessAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const targetId = String(formData.get("userId"));
  const projectId = String(formData.get("projectId"));
  const role = String(formData.get("role") || "none");
  if (!(await one(`SELECT id FROM project WHERE id=$1 AND org_id=$2`, [projectId, orgId]))) redirect(`/organization/access/${targetId}?err=proj`);

  if (role === "none") {
    await q(`DELETE FROM project_member WHERE project_id=$1 AND user_id=$2`, [projectId, targetId]);
  } else {
    if (!(PROJECT_ROLES as readonly string[]).includes(role)) redirect(`/organization/access/${targetId}?err=role`);
    const submitted = (formData.getAll("perms") as string[]).filter((p) => (PERMISSIONS as readonly string[]).includes(p));
    const roleGrants = new Set<Permission>(ROLE_PERMISSIONS[role as ProjectRole]);
    const extras = submitted.filter((p) => !roleGrants.has(p as Permission));
    await q(`INSERT INTO org_membership (id, org_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id("om"), orgId, targetId]);
    await q(`INSERT INTO project_member (id, project_id, user_id, role, permissions) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (project_id, user_id) DO UPDATE SET role=$4, permissions=$5`,
      [id("pm"), projectId, targetId, role, JSON.stringify(extras)]);
  }
  await writeAudit({ orgId, userId, action: "update", entity: "project_member", entityId: `${projectId}:${targetId}`, after: { role } });
  redirect(`/organization/access/${targetId}?saved=1`);
}

// Promote/demote an organisation administrator. Guarded against self-change and
// against removing the last remaining admin.
export async function setOrgAdminAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const targetId = String(formData.get("userId"));
  const makeAdmin = String(formData.get("makeAdmin")) === "1";
  if (targetId === userId) redirect(`/organization/access/${targetId}?err=self`);
  if (!makeAdmin) {
    const admins = await q(`SELECT m.user_id FROM org_membership m JOIN role r ON r.id=m.role_id
                            WHERE m.org_id=$1 AND r.key='org_admin'`, [orgId]);
    if (admins.length <= 1) redirect(`/organization/access/${targetId}?err=lastadmin`);
    await q(`UPDATE org_membership SET role_id=NULL WHERE org_id=$1 AND user_id=$2`, [orgId, targetId]);
  } else {
    const roleId = await orgAdminRoleId(orgId);
    await q(`INSERT INTO org_membership (id, org_id, user_id, role_id) VALUES ($1,$2,$3,$4)
             ON CONFLICT (org_id, user_id) DO UPDATE SET role_id=$4`, [id("om"), orgId, targetId, roleId]);
  }
  await writeAudit({ orgId, userId, action: "update", entity: "org_membership", entityId: targetId, after: { orgAdmin: makeAdmin } });
  redirect(`/organization/access/${targetId}?saved=1`);
}

// Apply a project role to every employee in a department in one action.
export async function bulkSetDepartmentAccessAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const department = String(formData.get("department") || "").trim();
  const projectId = String(formData.get("projectId"));
  const role = String(formData.get("role") || "none");
  if (!department || !projectId) redirect("/organization/access?err=fields");
  if (!(await one(`SELECT id FROM project WHERE id=$1 AND org_id=$2`, [projectId, orgId]))) redirect("/organization/access?err=proj");
  const emps = await q<{ userId: string }>(
    `SELECT user_id AS "userId" FROM employee
     WHERE org_id=$1 AND user_id IS NOT NULL
       AND (department=$2 OR department_id IN (SELECT id FROM department WHERE org_id=$1 AND name=$2))`, [orgId, department]
  );
  let n = 0;
  for (const e of emps) {
    if (role === "none") { await q(`DELETE FROM project_member WHERE project_id=$1 AND user_id=$2`, [projectId, e.userId]); n++; }
    else if ((PROJECT_ROLES as readonly string[]).includes(role)) {
      await q(`INSERT INTO org_membership (id, org_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id("om"), orgId, e.userId]);
      await q(`INSERT INTO project_member (id, project_id, user_id, role) VALUES ($1,$2,$3,$4)
               ON CONFLICT (project_id, user_id) DO UPDATE SET role=$4`, [id("pm"), projectId, e.userId, role]);
      n++;
    }
  }
  await writeAudit({ orgId, userId, action: "update", entity: "project_member", entityId: projectId, after: { department, role, count: n } });
  redirect(`/organization/access?saved=${n}`);
}

/* ===================== SUBSCRIPTIONS, RECEIPTS & ANNOUNCEMENTS (operator) ===================== */
import { activateSubscription, recordSubscriptionPayment, sendReceiptEmail, sendAnnouncement } from "@/server/services/billing";

async function requireOperator() {
  const user = await requireUser();
  if (!user.isSuperAdmin) throw new Error("FORBIDDEN");
  return user;
}

export async function activateSubscriptionAction(formData: FormData) {
  const user = await requireOperator();
  const orgId = String(formData.get("orgId"));
  const termMonths = Number(formData.get("termMonths") || 12);
  await activateSubscription(orgId, termMonths, { id: user.id, name: user.name });
  revalidatePath("/admin");
  redirect("/admin?sub=activated");
}

export async function recordPaymentAction(formData: FormData) {
  const user = await requireOperator();
  const orgId = String(formData.get("orgId"));
  const amount = Number(formData.get("amount") || 0);
  const termMonths = Number(formData.get("termMonths") || 12);
  const pid = await recordSubscriptionPayment({
    orgId, amount, termMonths,
    currency: String(formData.get("currency") || "USD").trim() || "USD",
    reference: String(formData.get("reference") || "") || undefined,
    paidOn: String(formData.get("paidOn") || "") || undefined,
    by: { id: user.id, name: user.name },
  });
  const res = await sendReceiptEmail(pid);
  revalidatePath("/admin");
  redirect(`/admin?receipt=${res.status === "sent" ? "sent" : "saved"}`);
}

export async function sendReceiptAction(formData: FormData) {
  await requireOperator();
  const res = await sendReceiptEmail(String(formData.get("paymentId")));
  revalidatePath("/admin");
  redirect(`/admin?receipt=${res.status === "sent" ? "sent" : "failed"}`);
}

export async function sendAnnouncementAction(formData: FormData) {
  const user = await requireOperator();
  const subject = String(formData.get("subject") || "").trim();
  const body = String(formData.get("body") || "").trim();
  if (!subject || !body) redirect("/admin?announce=fields");
  const audience = (String(formData.get("audience") || "all") as "all" | "active" | "trial");
  const res = await sendAnnouncement({ subject, body, audience, by: { id: user.id, name: user.name } });
  redirect(`/admin?announce=${res.sent}of${res.recipients}`);
}

/* ===================== SUBSCRIPTION RENEWAL REQUESTS ===================== */
import { requestRenewal, invoiceRequest, submitPaymentProof, approveRequest, rejectRequest, cancelRequest, upsertPlatformSettings, setIssuerLogo } from "@/server/services/billing";

// ----- Organisation side (org admin / finance) -----
export async function requestRenewalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const termMonths = Number(formData.get("termMonths") || 12);
  await requestRenewal({ orgId, termMonths, note: String(formData.get("note") || "") || undefined, by: { id: userId, name: userName } });
  redirect("/organization/subscription?requested=1");
}

export async function submitPaymentProofAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const requestId = String(formData.get("requestId"));
  // ensure the request belongs to this org and is awaiting payment
  const owns = await one<{ id: string }>(`SELECT id FROM subscription_request WHERE id=$1 AND org_id=$2 AND status='invoiced'`, [requestId, orgId]);
  if (!owns) redirect("/organization/subscription?err=state");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/organization/subscription?err=file");
  const f = file as File;
  const buf = Buffer.from(await f.arrayBuffer());
  const docId = id("subpay");
  const key = await saveUpload(docId, f.name, buf);
  await submitPaymentProof({
    requestId, storageKey: key, fileName: f.name, mime: f.type || mimeFor(f.name), size: buf.length,
    paymentRef: String(formData.get("paymentRef") || "") || undefined, note: String(formData.get("note") || "") || undefined,
  });
  redirect("/organization/subscription?paid=1");
}

export async function cancelRenewalAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await cancelRequest(String(formData.get("requestId")), orgId);
  redirect("/organization/subscription?cancelled=1");
}

// ----- Operator side (super admin) -----
export async function invoiceRequestAction(formData: FormData) {
  const user = await requireOperator();
  await invoiceRequest({
    requestId: String(formData.get("requestId")),
    subtotal: Number(formData.get("subtotal") || 0),
    vatRate: Number(formData.get("vatRate") || 0),
    currency: String(formData.get("currency") || "USD").trim() || "USD",
    bankDetails: String(formData.get("bankDetails") || ""),
    momoDetails: String(formData.get("momoDetails") || ""),
    note: String(formData.get("note") || "") || undefined,
    by: { id: user.id, name: user.name },
  });
  redirect("/admin?inv=sent");
}

export async function approveRenewalAction(formData: FormData) {
  const user = await requireOperator();
  await approveRequest({ requestId: String(formData.get("requestId")), by: { id: user.id, name: user.name } });
  redirect("/admin?renew=done");
}

export async function rejectRenewalAction(formData: FormData) {
  const user = await requireOperator();
  await rejectRequest({ requestId: String(formData.get("requestId")), reason: String(formData.get("reason") || "Not approved").trim(), by: { id: user.id, name: user.name } });
  redirect("/admin?renew=rejected");
}

export async function savePlatformSettingsAction(formData: FormData) {
  await requireOperator();
  await upsertPlatformSettings({
    currency: String(formData.get("currency") || "USD").trim() || "USD",
    vatRate: Number(formData.get("vatRate") || 0),
    rate1yr: Number(formData.get("rate1yr") || 0),
    rate3yr: Number(formData.get("rate3yr") || 0),
    rate5yr: Number(formData.get("rate5yr") || 0),
    bankDetails: String(formData.get("bankDetails") || "") || null,
    momoDetails: String(formData.get("momoDetails") || "") || null,
    issuerName: String(formData.get("issuerName") || "") || null,
    issuerTin: String(formData.get("issuerTin") || "") || null,
    issuerAddress: String(formData.get("issuerAddress") || "") || null,
    issuerEmail: String(formData.get("issuerEmail") || "") || null,
    issuerPhone: String(formData.get("issuerPhone") || "") || null,
    issuerWebsite: String(formData.get("issuerWebsite") || "") || null,
  });
  redirect("/admin?settings=saved");
}

export async function uploadIssuerLogoAction(formData: FormData) {
  await requireOperator();
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) redirect("/admin?settings=logoerr");
  if (file.size > 2 * 1024 * 1024) redirect("/admin?settings=logosize");
  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${mimeFor(file.name)};base64,${buf.toString("base64")}`;
  await setIssuerLogo(dataUrl);
  redirect("/admin?settings=logo");
}

export async function removeIssuerLogoAction() {
  await requireOperator();
  await setIssuerLogo(null);
  redirect("/admin?settings=logoremoved");
}

// Add a department to the org register directly from Access management, so it
// becomes selectable in the bulk tool without leaving the page.
export async function addDepartmentFromAccessAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/organization/access?dept=empty");
  await q(`INSERT INTO department (id, org_id, name) VALUES ($1,$2,$3) ON CONFLICT (org_id, name) DO NOTHING`, [id("dept"), orgId, name]);
  await writeAudit({ orgId, userId, action: "create", entity: "department", entityId: name, after: { name } });
  redirect("/organization/access?dept=added");
}

/* ============================ Laboratory (LIMS) ============================ */
import { nextSampleCode, calcAge, canSeePII, accessibleProjectIds, disposableIds } from "@/server/services/lab";

// Resolve the org for the current user (any member), returning admin status too.
async function requireLabActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name, isOrgAdmin: !!org.isOrgAdmin, isSuperAdmin: !!user.isSuperAdmin };
}

// Register a sample. Creates the participant inline if a new Study ID is supplied,
// auto-generates the sample code (PROJ-YYYY-NNNN) and the age at collection.
export async function createSampleAction(formData: FormData) {
  const { orgId, userId, userName, isSuperAdmin } = await requireLabActor();
  // Resolve the project. A manually-entered new project name takes precedence: if a
  // project with the derived code already exists it is reused, otherwise a lightweight
  // project is created (only for users allowed to create projects).
  let projectId = String(formData.get("projectId") || "");
  const newProjectName = String(formData.get("newProjectName") || "").trim();
  if (newProjectName) {
    if (!(await canCreateProjects(userId, isSuperAdmin))) redirect("/lab/samples/new?err=projectperm");
    const code = (newProjectName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24)) || "PROJECT";
    const existing = await one<{ id: string }>(`SELECT id FROM project WHERE org_id=$1 AND UPPER(code)=$2 LIMIT 1`, [orgId, code]);
    if (existing) projectId = existing.id;
    else {
      const orgCcy = (await one<{ c: string }>(`SELECT base_currency c FROM organization WHERE id=$1`, [orgId]))?.c ?? "USD";
      projectId = await createProject({ orgId, userId, code, title: newProjectName, currency: orgCcy, addCreatorAsPi: !isSuperAdmin });
    }
  }
  if (!projectId || !(await one(`SELECT id FROM project WHERE id=$1 AND org_id=$2`, [projectId, orgId]))) redirect("/lab/samples/new?err=project");
  const collectionDate = String(formData.get("collectionDate") || new Date().toISOString().slice(0, 10));

  // Resolve / create participant from Study ID.
  let participantId: string | null = null;
  let dob: string | null = null;
  const studyId = String(formData.get("studyId") || "").trim();
  if (studyId) {
    const existing = await one<{ id: string; dob: string | null }>(`SELECT id, date_of_birth AS dob FROM lab_participant WHERE org_id=$1 AND study_id=$2`, [orgId, studyId]);
    if (existing) { participantId = existing.id; dob = existing.dob; }
    else {
      const pid = id("lpar");
      dob = String(formData.get("participantDob") || "") || null;
      await q(`INSERT INTO lab_participant (id, org_id, study_id, name, date_of_birth, sex) VALUES ($1,$2,$3,$4,$5,$6)`,
        [pid, orgId, studyId, String(formData.get("participantName") || "") || null, dob, String(formData.get("participantSex") || "") || null]);
      participantId = pid;
    }
  }
  const age = calcAge(dob, collectionDate);

  // Resolve / create the visit (timepoint) for repeat sampling, keyed on participant + label.
  let visitId: string | null = null;
  const visitLabel = String(formData.get("visitLabel") || "").trim();
  if (participantId && visitLabel) {
    const exV = await one<{ id: string }>(`SELECT id FROM lab_visit WHERE participant_id=$1 AND LOWER(label)=LOWER($2)`, [participantId, visitLabel]);
    if (exV) visitId = exV.id;
    else {
      const vid = id("lvis");
      await q(`INSERT INTO lab_visit (id, org_id, participant_id, label, visit_date, sequence) VALUES ($1,$2,$3,$4,$5,$6)`,
        [vid, orgId, participantId, visitLabel, String(formData.get("visitDate") || "") || null, formData.get("visitSequence") ? Number(formData.get("visitSequence")) : null]);
      visitId = vid;
    }
  }

  // Resolve the sample type: a typed custom type is found (case-insensitive) or created
  // under the "Other" category, so labs can record specimens outside the standard list.
  let sampleTypeId = String(formData.get("sampleTypeId") || "") || null;
  const newType = String(formData.get("newSampleType") || "").trim();
  if (newType) {
    const existingType = await one<{ id: string }>(`SELECT id FROM lab_sample_type WHERE org_id=$1 AND LOWER(type)=LOWER($2) LIMIT 1`, [orgId, newType]);
    if (existingType) sampleTypeId = existingType.id;
    else { const tid = id("lst"); await q(`INSERT INTO lab_sample_type (id, org_id, category, type) VALUES ($1,$2,'Other',$3)`, [tid, orgId, newType]); sampleTypeId = tid; }
  }

  const numAliquots = Number(formData.get("numberOfAliquots") || 0);
  const aliquotVolume = formData.get("aliquotVolume") ? Number(formData.get("aliquotVolume")) : null;
  // Starting quantity on hand: total volume if volume-based, else the aliquot count.
  const startQty = aliquotVolume != null ? aliquotVolume * Math.max(numAliquots, 1) : (numAliquots > 0 ? numAliquots : null);

  const sampleId = id("lsmp");
  const code = await nextSampleCode(projectId);
  await q(`INSERT INTO lab_sample (id, org_id, project_id, sample_code, participant_id, sample_type_id, age_years, age_months,
             collection_date, collection_time, date_aliquoted, number_of_aliquots, aliquot_volume, aliquot_unit, quantity_remaining,
             storage_room, storage_equipment, storage_rack, storage_shelf, storage_box, storage_position, date_stored, storage_temp,
             stored_by_id, stored_by_name, condition_on_receipt, abnormalities, comments, status, created_by_id, created_by_name,
             visit_id, collection_facility, collection_district, collection_site, freezer_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,'active',$29,$30,$31,$32,$33,$34,$35)`,
    [sampleId, orgId, projectId, code, participantId, sampleTypeId,
     age.years, age.months, collectionDate, String(formData.get("collectionTime") || "") || null,
     String(formData.get("dateAliquoted") || "") || null, numAliquots, aliquotVolume, String(formData.get("aliquotUnit") || "µL"), startQty,
     String(formData.get("storageRoom") || "") || null, String(formData.get("storageEquipment") || "") || null,
     String(formData.get("storageRack") || "") || null, String(formData.get("storageShelf") || "") || null,
     String(formData.get("storageBox") || "") || null, String(formData.get("storagePosition") || "") || null,
     String(formData.get("dateStored") || "") || null, String(formData.get("storageTemp") || "") || null,
     userId, userName, String(formData.get("condition") || "intact"),
     String(formData.get("abnormalities") || "") || null, String(formData.get("comments") || "") || null,
     userId, userName,
     visitId, String(formData.get("collectionFacility") || "") || null, String(formData.get("collectionDistrict") || "") || null, String(formData.get("collectionSite") || "") || null, sNull(formData.get("freezerId"))]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_sample", entityId: code, after: { projectId, studyId: studyId || null } });
  if (formData.get("another") === "1") redirect(`/lab/samples/new?created=${encodeURIComponent(code)}&projectId=${projectId}`);
  redirect(`/lab/samples/${sampleId}?created=1`);
}

// Log a retrieval (removal) of sample material. Blocks if consent is withdrawn; updates
// the quantity on hand and marks the sample depleted when it reaches zero.
export async function retrieveSampleAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  const s = await one<{ id: string; status: string; qty: number | null; consent: string | null; code: string }>(
    `SELECT s.id, s.status, s.quantity_remaining AS qty, pa.consent_status AS consent, s.sample_code AS code
     FROM lab_sample s LEFT JOIN lab_participant pa ON pa.id=s.participant_id WHERE s.id=$1 AND s.org_id=$2`, [sid, orgId]);
  if (!s) redirect("/lab/samples");
  if (s.status === "disposed") redirect(`/lab/samples/${sid}?err=disposed`);
  if (s.consent === "withdrawn") redirect(`/lab/samples/${sid}?err=consent`);
  const removed = formData.get("quantityRemoved") ? Number(formData.get("quantityRemoved")) : null;
  const remaining = s.qty != null && removed != null ? Math.max(0, s.qty - removed) : s.qty;
  const thawed = formData.get("thawed") === "1";
  await q(`INSERT INTO lab_retrieval (id, sample_id, date_retrieved, quantity_removed, quantity_remaining, purpose, destination, retrieved_by_id, retrieved_by_name, authorized_by_id, authorized_by_name, thawed)
           VALUES ($1,$2,now(),$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id("lret"), sid, removed, remaining, String(formData.get("purpose") || "") || null, String(formData.get("destination") || "") || null,
     userId, userName, String(formData.get("authorizedById") || "") || null, String(formData.get("authorizedByName") || "") || null, thawed]);
  const depleted = remaining != null && remaining <= 0;
  await q(`UPDATE lab_sample SET quantity_remaining=$2, freeze_thaw_count = freeze_thaw_count + $4, status=CASE WHEN $3 THEN 'depleted' ELSE status END, updated_at=now() WHERE id=$1`,
    [sid, remaining, depleted, thawed ? 1 : 0]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_sample", entityId: s.code, after: { retrieved: removed, remaining, depleted, thawed } });
  redirect(`/lab/samples/${sid}?retrieved=1`);
}

// Record a freeze-thaw cycle on a sample without a full retrieval (e.g. thawed in place for QC).
export async function recordFreezeThawAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  const s = await one<{ code: string; status: string }>(`SELECT sample_code AS code, status FROM lab_sample WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  if (!s) redirect("/lab/samples");
  if (s.status === "disposed") redirect(`/lab/samples/${sid}?err=disposed`);
  await q(`UPDATE lab_sample SET freeze_thaw_count = freeze_thaw_count + 1, updated_at=now() WHERE id=$1`, [sid]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_sample", entityId: s.code, after: { freezeThaw: "incremented", by: userName } });
  redirect(`/lab/samples/${sid}?ft=1`);
}

// Record the return of a sample to storage (closes the latest open retrieval).
export async function returnSampleAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  const s = await one<{ code: string }>(`SELECT sample_code AS code FROM lab_sample WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  if (!s) redirect("/lab/samples");
  const open = await one<{ id: string }>(`SELECT id FROM lab_retrieval WHERE sample_id=$1 AND returned_date IS NULL ORDER BY date_retrieved DESC LIMIT 1`, [sid]);
  const shelf = String(formData.get("returnedToShelf") || "") || null;
  if (open) {
    await q(`UPDATE lab_retrieval SET returned_date=now(), returned_to_shelf=$2, temp_exposure_minutes=$3 WHERE id=$1`,
      [open.id, shelf, formData.get("tempExposureMinutes") ? Number(formData.get("tempExposureMinutes")) : null]);
  }
  if (shelf) await q(`UPDATE lab_sample SET storage_shelf=$2, updated_at=now() WHERE id=$1`, [sid, shelf]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_sample", entityId: s.code, after: { returned: true, by: userName } });
  redirect(`/lab/samples/${sid}?returned=1`);
}

// Dispose of a sample (lab managers only). Reason + witness are required and retained.
export async function disposeSampleAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab/samples?err=forbidden");
  const sid = String(formData.get("sampleId") || "");
  const s = await one<{ code: string }>(`SELECT sample_code AS code FROM lab_sample WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  if (!s) redirect("/lab/samples");
  const reason = String(formData.get("reason") || "").trim();
  if (!reason) redirect(`/lab/samples/${sid}?err=reason`);
  await q(`UPDATE lab_sample SET status='disposed', disposal_date=CURRENT_DATE, disposal_method=$2, disposal_reason=$3, disposal_witness=$4, disposed_by_id=$5, disposed_by_name=$6, updated_at=now() WHERE id=$1`,
    [sid, String(formData.get("method") || "") || null, reason, String(formData.get("witness") || "") || null, userId, userName]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_sample", entityId: s.code, before: { status: "active" }, after: { status: "disposed", reason } });
  redirect(`/lab/samples/${sid}?disposed=1`);
}

// Update consent status for a participant (e.g. record a withdrawal). Lab managers only.
export async function updateConsentAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  if (!(isOrgAdmin || isSuperAdmin)) redirect(`/lab/samples/${sid}?err=forbidden`);
  const participantId = String(formData.get("participantId") || "");
  const status = String(formData.get("consentStatus") || "valid");
  if (!participantId) redirect(`/lab/samples/${sid}`);
  await q(`UPDATE lab_participant SET consent_status=$2, withdrawal_date=CASE WHEN $2='withdrawn' THEN CURRENT_DATE ELSE withdrawal_date END WHERE id=$1 AND org_id=$3`, [participantId, status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_participant", entityId: participantId, after: { consentStatus: status } });
  redirect(`/lab/samples/${sid}?consent=1`);
}

// Reveal a participant's name (lab managers only) and log the PII access.
export async function revealParticipantNameAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  if (!canSeePII(isOrgAdmin, isSuperAdmin)) redirect(`/lab/samples/${sid}?err=forbidden`);
  const participantId = String(formData.get("participantId") || "") || null;
  await q(`INSERT INTO lab_pii_access (id, org_id, user_id, user_name, participant_id, sample_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("lpii"), orgId, userId, userName, participantId, sid]);
  redirect(`/lab/samples/${sid}?reveal=1`);
}

// Edit a sample record. Computes a field-level diff and records a single audit entry
// (before/after) so every change to a sample is traceable. Blocked once disposed.
export async function editSampleAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const s = await one<{
    code: string; projectId: string; status: string; sampleTypeId: string | null; typeName: string | null; participantId: string | null;
    collectionDate: string | null; collectionTime: string | null; dateAliquoted: string | null; numberOfAliquots: number; aliquotVolume: number | null; aliquotUnit: string;
    condition: string | null; abnormalities: string | null; comments: string | null;
    room: string | null; equipment: string | null; rack: string | null; shelf: string | null; box: string | null; position: string | null; dateStored: string | null; storageTemp: string | null;
    facility: string | null; district: string | null; site: string | null; visitId: string | null; visitLabel: string | null; freezerId: string | null; freezerName: string | null;
    pName: string | null; dob: string | null; pSex: string | null;
  }>(
    `SELECT s.sample_code AS code, s.project_id AS "projectId", s.status, s.sample_type_id AS "sampleTypeId", st.type AS "typeName", s.participant_id AS "participantId",
            s.collection_date::text AS "collectionDate", s.collection_time AS "collectionTime", s.date_aliquoted::text AS "dateAliquoted", s.number_of_aliquots AS "numberOfAliquots",
            s.aliquot_volume AS "aliquotVolume", s.aliquot_unit AS "aliquotUnit", s.condition_on_receipt AS condition, s.abnormalities, s.comments,
            s.storage_room AS room, s.storage_equipment AS equipment, s.storage_rack AS rack, s.storage_shelf AS shelf, s.storage_box AS box, s.storage_position AS position,
            s.date_stored::text AS "dateStored", s.storage_temp AS "storageTemp",
            s.collection_facility AS facility, s.collection_district AS district, s.collection_site AS site, s.visit_id AS "visitId", v.label AS "visitLabel", s.freezer_id AS "freezerId", fz.name AS "freezerName",
            pa.name AS "pName", pa.date_of_birth::text AS dob, pa.sex AS "pSex"
     FROM lab_sample s LEFT JOIN lab_sample_type st ON st.id=s.sample_type_id LEFT JOIN lab_participant pa ON pa.id=s.participant_id LEFT JOIN lab_visit v ON v.id=s.visit_id LEFT JOIN lab_freezer fz ON fz.id=s.freezer_id
     WHERE s.id=$1 AND s.org_id=$2`, [sid, orgId]
  );
  if (!s) redirect("/lab/samples");
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(s.projectId)) redirect("/lab/samples"); }
  if (s.status === "disposed") redirect(`/lab/samples/${sid}?err=disposed`);

  const orNull = (v: FormDataEntryValue | null) => { const x = String(v ?? "").trim(); return x || null; };
  const numOrNull = (v: FormDataEntryValue | null) => { const x = String(v ?? "").trim(); return x ? Number(x) : null; };

  // Resolve sample type (dropdown or typed custom — found/created under "Other").
  let sampleTypeId = String(formData.get("sampleTypeId") || "") || null;
  const newType = String(formData.get("newSampleType") || "").trim();
  if (newType) {
    const ex = await one<{ id: string }>(`SELECT id FROM lab_sample_type WHERE org_id=$1 AND LOWER(type)=LOWER($2) LIMIT 1`, [orgId, newType]);
    if (ex) sampleTypeId = ex.id;
    else { const tid = id("lst"); await q(`INSERT INTO lab_sample_type (id, org_id, category, type) VALUES ($1,$2,'Other',$3)`, [tid, orgId, newType]); sampleTypeId = tid; }
  }
  const newTypeName = sampleTypeId ? ((await one<{ type: string }>(`SELECT type FROM lab_sample_type WHERE id=$1`, [sampleTypeId]))?.type ?? null) : null;

  const collectionDate = String(formData.get("collectionDate") || s.collectionDate || new Date().toISOString().slice(0, 10));
  const collectionTime = orNull(formData.get("collectionTime"));
  const dateAliquoted = orNull(formData.get("dateAliquoted"));
  const numberOfAliquots = Number(formData.get("numberOfAliquots") || 0);
  const aliquotVolume = numOrNull(formData.get("aliquotVolume"));
  const aliquotUnit = String(formData.get("aliquotUnit") || s.aliquotUnit || "µL");
  const condition = String(formData.get("condition") || s.condition || "intact");
  const abnormalities = orNull(formData.get("abnormalities"));
  const comments = orNull(formData.get("comments"));
  const room = orNull(formData.get("storageRoom")), equipment = orNull(formData.get("storageEquipment")), rack = orNull(formData.get("storageRack"));
  const shelf = orNull(formData.get("storageShelf")), box = orNull(formData.get("storageBox")), position = orNull(formData.get("storagePosition"));
  const dateStored = orNull(formData.get("dateStored")), storageTemp = orNull(formData.get("storageTemp"));
  const facility = orNull(formData.get("collectionFacility")), district = orNull(formData.get("collectionDistrict")), site = orNull(formData.get("collectionSite"));
  const newFreezerId = orNull(formData.get("freezerId"));
  const newFreezerName = newFreezerId ? ((await one<{ name: string }>(`SELECT name FROM lab_freezer WHERE id=$1 AND org_id=$2`, [newFreezerId, orgId]))?.name ?? null) : null;
  // Status edit is limited to active <-> quarantined (depleted / in_transit / disposed are action-driven).
  const formStatus = String(formData.get("status") || s.status);
  const editable = (x: string) => x === "active" || x === "quarantined";
  const newStatus = editable(s.status) && editable(formStatus) ? formStatus : s.status;

  // Participant fields (only when a participant is linked).
  const pName = s.participantId ? orNull(formData.get("participantName")) : s.pName;
  const newDob = s.participantId ? orNull(formData.get("participantDob")) : s.dob;
  const pSex = s.participantId ? orNull(formData.get("participantSex")) : s.pSex;
  const age = calcAge(s.participantId ? newDob : s.dob, collectionDate);

  // Resolve / create visit (timepoint) if a label is provided for this participant.
  let visitId: string | null = s.visitId;
  const visitLabel = s.participantId ? orNull(formData.get("visitLabel")) : null;
  if (s.participantId) {
    if (!visitLabel) visitId = null;
    else if (!s.visitLabel || s.visitLabel.toLowerCase() !== visitLabel.toLowerCase()) {
      const exV = await one<{ id: string }>(`SELECT id FROM lab_visit WHERE participant_id=$1 AND LOWER(label)=LOWER($2)`, [s.participantId, visitLabel]);
      if (exV) visitId = exV.id;
      else { const vid = id("lvis"); await q(`INSERT INTO lab_visit (id, org_id, participant_id, label, visit_date) VALUES ($1,$2,$3,$4,$5)`, [vid, orgId, s.participantId, visitLabel, orNull(formData.get("visitDate"))]); visitId = vid; }
    }
  }

  // Build a readable diff.
  const changes: { k: string; from: string; to: string }[] = [];
  const track = (label: string, oldV: unknown, newV: unknown) => {
    const o = oldV == null || oldV === "" ? "" : String(oldV);
    const n = newV == null || newV === "" ? "" : String(newV);
    if (o !== n) changes.push({ k: label, from: o || "—", to: n || "—" });
  };
  track("Sample type", s.typeName, newTypeName);
  track("Collection date", s.collectionDate, collectionDate);
  track("Collection time", s.collectionTime, collectionTime);
  track("Date aliquoted", s.dateAliquoted, dateAliquoted);
  track("No. of aliquots", s.numberOfAliquots, numberOfAliquots);
  track("Volume each", s.aliquotVolume, aliquotVolume);
  track("Aliquot unit", s.aliquotUnit, aliquotUnit);
  track("Condition", s.condition, condition);
  track("Abnormalities", s.abnormalities, abnormalities);
  track("Comments", s.comments, comments);
  track("Storage room", s.room, room);
  track("Freezer/equipment", s.equipment, equipment);
  track("Rack", s.rack, rack);
  track("Shelf", s.shelf, shelf);
  track("Box", s.box, box);
  track("Position", s.position, position);
  track("Date stored", s.dateStored, dateStored);
  track("Storage temp", s.storageTemp, storageTemp);
  track("Collection facility", s.facility, facility);
  track("Collection district", s.district, district);
  track("Collection site", s.site, site);
  track("Visit", s.visitLabel, visitLabel);
  track("Freezer", s.freezerName, newFreezerName);
  track("Status", s.status, newStatus);
  if (s.participantId) { track("Participant name", s.pName, pName); track("Date of birth", s.dob, newDob); track("Sex", s.pSex, pSex); }

  await q(`UPDATE lab_sample SET sample_type_id=$2, collection_date=$3, collection_time=$4, date_aliquoted=$5, number_of_aliquots=$6, aliquot_volume=$7, aliquot_unit=$8,
             condition_on_receipt=$9, abnormalities=$10, comments=$11, storage_room=$12, storage_equipment=$13, storage_rack=$14, storage_shelf=$15, storage_box=$16, storage_position=$17,
             date_stored=$18, storage_temp=$19, age_years=$20, age_months=$21, status=$22, visit_id=$23, collection_facility=$24, collection_district=$25, collection_site=$26, freezer_id=$27, updated_at=now() WHERE id=$1`,
    [sid, sampleTypeId, collectionDate, collectionTime, dateAliquoted, numberOfAliquots, aliquotVolume, aliquotUnit, condition, abnormalities, comments,
     room, equipment, rack, shelf, box, position, dateStored, storageTemp, age.years, age.months, newStatus, visitId, facility, district, site, newFreezerId]);
  if (s.participantId && (s.pName !== pName || s.dob !== newDob || s.pSex !== pSex)) {
    await q(`UPDATE lab_participant SET name=$2, date_of_birth=$3, sex=$4 WHERE id=$1 AND org_id=$5`, [s.participantId, pName, newDob, pSex, orgId]);
  }
  if (changes.length > 0) {
    await writeAudit({
      orgId, userId, action: "update", entity: "lab_sample", entityId: s.code,
      before: Object.fromEntries(changes.map((c) => [c.k, c.from])),
      after: Object.fromEntries(changes.map((c) => [c.k, c.to])),
      meta: { editedBy: userName, fields: changes.length },
    });
  }
  redirect(`/lab/samples/${sid}?edited=${changes.length > 0 ? changes.length : 0}`);
}

/* ===================== Studies (Clinical Trials & Cohorts) ===================== */
async function requireStudyActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name, isOrgAdmin: !!org.isOrgAdmin, isSuperAdmin: !!user.isSuperAdmin };
}
// Load a study the actor may manage (admin = any org study; otherwise project membership).
async function loadStudyForActor(studyId: string, orgId: string, userId: string, isAdmin: boolean) {
  const st = await one<{ id: string; projectId: string; title: string }>(`SELECT id, project_id AS "projectId", title FROM study WHERE id=$1 AND org_id=$2`, [studyId, orgId]);
  if (!st) redirect("/studies");
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(st.projectId)) redirect("/studies"); }
  return st;
}
const sNull = (v: FormDataEntryValue | null) => { const x = String(v ?? "").trim(); return x || null; };
const sNum = (v: FormDataEntryValue | null) => { const x = String(v ?? "").trim(); return x ? Number(x) : null; };

export async function createStudyAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const projectId = String(formData.get("projectId") || "");
  const ok = isAdmin ? !!(await one(`SELECT id FROM project WHERE id=$1 AND org_id=$2`, [projectId, orgId])) : (await accessibleProjectIds(userId, orgId, false)).includes(projectId);
  if (!projectId || !ok) redirect("/studies/new?err=project");
  const sid = id("study");
  const piId = String(formData.get("piId") || "") || null;
  let piName = sNull(formData.get("piName"));
  if (piId && !piName) piName = (await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [piId]))?.name ?? null;
  await q(`INSERT INTO study (id, org_id, project_id, code, title, study_type, phase, design, blinding, randomized, allocation_ratio, registry, registration_number, sponsor, funder, pi_id, pi_name, target_enrollment, status, start_date, end_date, objectives, summary, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [sid, orgId, projectId, sNull(formData.get("code")), String(formData.get("title") || "Untitled study"), String(formData.get("studyType") || "clinical_trial"),
     sNull(formData.get("phase")), sNull(formData.get("design")), sNull(formData.get("blinding")), formData.get("randomized") === "on", sNull(formData.get("allocationRatio")),
     sNull(formData.get("registry")), sNull(formData.get("registrationNumber")), sNull(formData.get("sponsor")), sNull(formData.get("funder")), piId, piName,
     sNum(formData.get("targetEnrollment")), String(formData.get("status") || "planning"), sNull(formData.get("startDate")), sNull(formData.get("endDate")),
     sNull(formData.get("objectives")), sNull(formData.get("summary")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "study", entityId: sid, after: { title: String(formData.get("title") || ""), type: String(formData.get("studyType") || "") } });
  redirect(`/studies/${sid}?created=1`);
}

export async function updateStudyAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const piId = String(formData.get("piId") || "") || null;
  let piName = sNull(formData.get("piName"));
  if (piId && !piName) piName = (await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [piId]))?.name ?? null;
  await q(`UPDATE study SET code=$2, title=$3, study_type=$4, phase=$5, design=$6, blinding=$7, randomized=$8, allocation_ratio=$9, registry=$10, registration_number=$11, sponsor=$12, funder=$13, pi_id=$14, pi_name=$15, target_enrollment=$16, status=$17, start_date=$18, end_date=$19, objectives=$20, summary=$21, updated_at=now() WHERE id=$1 AND org_id=$22`,
    [sid, sNull(formData.get("code")), String(formData.get("title") || "Untitled study"), String(formData.get("studyType") || "clinical_trial"), sNull(formData.get("phase")), sNull(formData.get("design")),
     sNull(formData.get("blinding")), formData.get("randomized") === "on", sNull(formData.get("allocationRatio")), sNull(formData.get("registry")), sNull(formData.get("registrationNumber")),
     sNull(formData.get("sponsor")), sNull(formData.get("funder")), piId, piName, sNum(formData.get("targetEnrollment")), String(formData.get("status") || "planning"),
     sNull(formData.get("startDate")), sNull(formData.get("endDate")), sNull(formData.get("objectives")), sNull(formData.get("summary")), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "study", entityId: sid, after: { status: String(formData.get("status") || "") } });
  redirect(`/studies/${sid}?saved=1`);
}

export async function deleteStudyAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/studies?err=forbidden");
  const sid = String(formData.get("studyId") || "");
  const st = await one<{ title: string }>(`SELECT title FROM study WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  if (!st) redirect("/studies");
  await q(`DELETE FROM study WHERE id=$1 AND org_id=$2`, [sid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "study", entityId: sid, before: { title: st.title } });
  redirect("/studies?deleted=1");
}

export async function addStudySiteAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`INSERT INTO study_site (id, study_id, name, location, pi_name, status, activation_date, target_enrollment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("ssite"), sid, String(formData.get("name") || "Site"), sNull(formData.get("location")), sNull(formData.get("sitePiName")), String(formData.get("siteStatus") || "pending"), sNull(formData.get("activationDate")), sNum(formData.get("siteTarget"))]);
  redirect(`/studies/${sid}?added=site`);
}

export async function addStudyApprovalAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const aid = id("sappr");
  await q(`INSERT INTO study_approval (id, study_id, authority, authority_name, reference_number, approval_date, expiry_date, status, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [aid, sid, String(formData.get("authority") || "REC"), sNull(formData.get("authorityName")), sNull(formData.get("referenceNumber")), sNull(formData.get("approvalDate")), sNull(formData.get("expiryDate")), String(formData.get("apprStatus") || "approved"), sNull(formData.get("notes"))]);
  await writeAudit({ orgId, userId, action: "create", entity: "study_approval", entityId: aid, meta: { studyId: sid, authority: String(formData.get("authority") || "") } });
  redirect(`/studies/${sid}?added=approval`);
}

export async function updateStudyApprovalAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const aid = String(formData.get("approvalId") || "");
  await q(`UPDATE study_approval SET status=$2, approval_date=COALESCE($3, approval_date), expiry_date=COALESCE($4, expiry_date) WHERE id=$1 AND study_id=$5`,
    [aid, String(formData.get("apprStatus") || "approved"), sNull(formData.get("approvalDate")), sNull(formData.get("expiryDate")), sid]);
  await writeAudit({ orgId, userId, action: "update", entity: "study_approval", entityId: aid, after: { status: String(formData.get("apprStatus") || "") } });
  redirect(`/studies/${sid}?saved=approval`);
}

export async function addStudyVersionAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const vid = id("sver");
  await q(`INSERT INTO study_version (id, study_id, doc_type, version, version_date, language, status, summary) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [vid, sid, String(formData.get("docType") || "protocol"), String(formData.get("version") || "1.0"), sNull(formData.get("versionDate")), sNull(formData.get("language")), String(formData.get("verStatus") || "approved"), sNull(formData.get("verSummary"))]);
  await writeAudit({ orgId, userId, action: "create", entity: "study_version", entityId: vid, meta: { studyId: sid, docType: String(formData.get("docType") || ""), version: String(formData.get("version") || "") } });
  redirect(`/studies/${sid}?added=version`);
}

export async function addStudyEnrollmentAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`INSERT INTO study_enrollment (id, study_id, site_id, as_of_date, screened, enrolled, withdrawn, completed, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("senr"), sid, sNull(formData.get("siteId")), String(formData.get("asOfDate") || new Date().toISOString().slice(0, 10)),
     Number(formData.get("screened") || 0), Number(formData.get("enrolled") || 0), Number(formData.get("withdrawn") || 0), Number(formData.get("completed") || 0), sNull(formData.get("note"))]);
  redirect(`/studies/${sid}?added=enrollment`);
}

export async function addStudyMilestoneAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`INSERT INTO study_milestone (id, study_id, name, planned_date, actual_date, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("smile"), sid, String(formData.get("name") || "Milestone"), sNull(formData.get("plannedDate")), sNull(formData.get("actualDate")), String(formData.get("msStatus") || "pending"), sNull(formData.get("note"))]);
  redirect(`/studies/${sid}?added=milestone`);
}

export async function updateStudyMilestoneAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const mid = String(formData.get("milestoneId") || "");
  const status = String(formData.get("msStatus") || "done");
  await q(`UPDATE study_milestone SET status=$2, actual_date=CASE WHEN $2='done' AND actual_date IS NULL THEN CURRENT_DATE ELSE actual_date END WHERE id=$1 AND study_id=$3`, [mid, status, sid]);
  redirect(`/studies/${sid}?saved=milestone`);
}

// Generic delete for a study sub-record (correction tool), scoped to study access.
export async function deleteStudyItemAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const kind = String(formData.get("kind") || "");
  const itemId = String(formData.get("itemId") || "");
  const table = ({ site: "study_site", approval: "study_approval", version: "study_version", enrollment: "study_enrollment", milestone: "study_milestone", ae: "study_ae", deviation: "study_deviation", monitoring: "study_monitoring" } as Record<string, string>)[kind];
  if (!table) redirect(`/studies/${sid}`);
  await q(`DELETE FROM ${table} WHERE id=$1 AND study_id=$2`, [itemId, sid]);
  redirect(`/studies/${sid}?removed=${kind}`);
}

/* ===================== Per-tenant modules & sector ===================== */
import { ORG_TYPES, TOGGLEABLE_MODULES } from "@/lib/modules";

async function requireOrgAdminActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name };
}

export async function setOrgTypeAction(formData: FormData) {
  const { orgId, userId } = await requireOrgAdminActor();
  const type = String(formData.get("orgType") || "");
  if (!ORG_TYPES.find((t) => t.key === type)) redirect("/organization/modules");
  await q(`UPDATE organization SET org_type=$2, updated_at=now() WHERE id=$1`, [orgId, type]);
  await writeAudit({ orgId, userId, action: "update", entity: "organization", entityId: orgId, after: { orgType: type } });
  redirect("/organization/modules?saved=type");
}

export async function toggleModuleAction(formData: FormData) {
  const { orgId, userId } = await requireOrgAdminActor();
  const key = String(formData.get("moduleKey") || "");
  if (!TOGGLEABLE_MODULES.find((m) => m.key === key)) redirect("/organization/modules");
  const enabled = String(formData.get("enabled")) === "true";
  await q(`DELETE FROM org_module WHERE org_id=$1 AND module_key=$2`, [orgId, key]);
  await q(`INSERT INTO org_module (id, org_id, module_key, enabled) VALUES ($1,$2,$3,$4)`, [id("omod"), orgId, key, enabled]);
  await writeAudit({ orgId, userId, action: "update", entity: "org_module", entityId: key, after: { enabled } });
  redirect("/organization/modules?saved=module");
}

/* ===================== Procurement committees ===================== */
import { isModuleEnabled as _isModEnabled } from "@/server/modules";

async function requireProcGovActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  if (!(await _isModEnabled(org.id, "procurement")) || !(await _isModEnabled(org.id, "public_procurement"))) redirect("/procurement");
  return { orgId: org.id, userId: user.id, userName: user.name };
}
async function loadCommittee(orgId: string, committeeId: string) {
  const c = await one<{ id: string }>(`SELECT id FROM proc_committee WHERE id=$1 AND org_id=$2`, [committeeId, orgId]);
  if (!c) redirect("/procurement/committees");
  return c;
}

export async function createCommitteeAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const cid = id("pcom");
  await q(`INSERT INTO proc_committee (id, org_id, type, name, mandate, status, created_by_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [cid, orgId, String(formData.get("type") || "contracts"), String(formData.get("name") || "Committee"), String(formData.get("mandate") || "") || null, "active", userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "proc_committee", entityId: cid, after: { name: String(formData.get("name") || ""), type: String(formData.get("type") || "") } });
  redirect(`/procurement/committees/${cid}?created=1`);
}

export async function updateCommitteeAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("committeeId") || "");
  await loadCommittee(orgId, cid);
  await q(`UPDATE proc_committee SET type=$2, name=$3, mandate=$4, status=$5 WHERE id=$1 AND org_id=$6`,
    [cid, String(formData.get("type") || "contracts"), String(formData.get("name") || "Committee"), String(formData.get("mandate") || "") || null, String(formData.get("status") || "active"), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "proc_committee", entityId: cid });
  redirect(`/procurement/committees/${cid}?saved=1`);
}

export async function deleteCommitteeAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("committeeId") || "");
  await loadCommittee(orgId, cid);
  await q(`DELETE FROM proc_committee WHERE id=$1 AND org_id=$2`, [cid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "proc_committee", entityId: cid });
  redirect("/procurement/committees?deleted=1");
}

export async function addCommitteeMemberAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("committeeId") || "");
  await loadCommittee(orgId, cid);
  const memberUserId = String(formData.get("memberUserId") || "") || null;
  let memberName = String(formData.get("memberName") || "").trim();
  if (memberUserId && !memberName) memberName = (await one<{ name: string }>(`SELECT name FROM app_user WHERE id=$1`, [memberUserId]))?.name ?? "Member";
  await q(`INSERT INTO proc_committee_member (id, committee_id, user_id, member_name, title, committee_role, appointed_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("pcmem"), cid, memberUserId, memberName || "Member", String(formData.get("title") || "") || null, String(formData.get("committeeRole") || "member"), String(formData.get("appointedDate") || "") || null]);
  await writeAudit({ orgId, userId, action: "create", entity: "proc_committee_member", entityId: cid, meta: { member: memberName } });
  redirect(`/procurement/committees/${cid}?added=1`);
}

export async function removeCommitteeMemberAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("committeeId") || "");
  await loadCommittee(orgId, cid);
  const memberId = String(formData.get("memberId") || "");
  await q(`DELETE FROM proc_committee_member WHERE id=$1 AND committee_id=$2`, [memberId, cid]);
  await writeAudit({ orgId, userId, action: "delete", entity: "proc_committee_member", entityId: cid });
  redirect(`/procurement/committees/${cid}?removed=1`);
}

/* ===================== Inventory & stores ===================== */
async function requireInventoryActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  if (!(await _isModEnabled(org.id, "stores"))) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name };
}

export async function createStoreAction(formData: FormData) {
  const { orgId } = await requireInventoryActor();
  await q(`INSERT INTO store (id, org_id, name, location, status) VALUES ($1,$2,$3,$4,'active')`,
    [id("store"), orgId, String(formData.get("name") || "Store"), String(formData.get("location") || "") || null]);
  redirect("/inventory?added=store");
}

export async function createItemAction(formData: FormData) {
  const { orgId, userId } = await requireInventoryActor();
  const iid = id("item");
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  await q(`INSERT INTO stock_item (id, org_id, code, name, category, item_type, unit, unit_cost, reorder_level, currency, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')`,
    [iid, orgId, String(formData.get("code") || "") || null, String(formData.get("name") || "Item"), String(formData.get("category") || "") || null,
     String(formData.get("itemType") || "consumable"), String(formData.get("unit") || "unit"),
     Number(formData.get("unitCost") || 0), Number(formData.get("reorderLevel") || 0), String(formData.get("currency") || "") || baseCur]);
  await writeAudit({ orgId, userId, action: "create", entity: "stock_item", entityId: iid, after: { name: String(formData.get("name") || ""), type: String(formData.get("itemType") || "") } });
  redirect(`/inventory/items/${iid}?created=1`);
}

export async function updateItemAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInventoryActor();
  const iid = String(formData.get("itemId") || "");
  const cur = await one<{ code: string | null; name: string; category: string | null; itemType: string; unit: string; unitCost: number; reorderLevel: number; status: string; currency: string | null }>(
    `SELECT code, name, category, item_type AS "itemType", unit, unit_cost::float8 AS "unitCost", reorder_level::float8 AS "reorderLevel", status, currency FROM stock_item WHERE id=$1 AND org_id=$2`, [iid, orgId]);
  if (!cur) redirect("/inventory");
  const nv = {
    code: String(formData.get("code") || "") || null, name: String(formData.get("name") || "Item"), category: String(formData.get("category") || "") || null,
    itemType: String(formData.get("itemType") || "consumable"), unit: String(formData.get("unit") || "unit"), unitCost: Number(formData.get("unitCost") || 0),
    reorderLevel: Number(formData.get("reorderLevel") || 0), status: String(formData.get("status") || "active"), currency: String(formData.get("currency") || "") || cur.currency,
  };
  // Field-level diff for the change history.
  const changes: { k: string; from: string; to: string }[] = [];
  const track = (label: string, oldV: unknown, newV: unknown) => {
    const o = oldV == null || oldV === "" ? "" : String(oldV); const n = newV == null || newV === "" ? "" : String(newV);
    if (o !== n) changes.push({ k: label, from: o || "—", to: n || "—" });
  };
  track("Code", cur.code, nv.code); track("Name", cur.name, nv.name); track("Category", cur.category, nv.category);
  track("Type", cur.itemType, nv.itemType); track("Unit", cur.unit, nv.unit); track("Unit cost", cur.unitCost, nv.unitCost);
  track("Reorder level", cur.reorderLevel, nv.reorderLevel); track("Status", cur.status, nv.status); track("Currency", cur.currency, nv.currency);

  await q(`UPDATE stock_item SET code=$2, name=$3, category=$4, item_type=$5, unit=$6, unit_cost=$7, reorder_level=$8, status=$9, currency=$10 WHERE id=$1 AND org_id=$11`,
    [iid, nv.code, nv.name, nv.category, nv.itemType, nv.unit, nv.unitCost, nv.reorderLevel, nv.status, nv.currency, orgId]);
  if (changes.length > 0) {
    await writeAudit({ orgId, userId, action: "update", entity: "stock_item", entityId: iid,
      before: Object.fromEntries(changes.map((c) => [c.k, c.from])), after: Object.fromEntries(changes.map((c) => [c.k, c.to])), meta: { editedBy: userName, fields: changes.length } });
  }
  redirect(`/inventory/items/${iid}?saved=${changes.length}`);
}

export async function recordMovementAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInventoryActor();
  const itemId = String(formData.get("itemId") || "");
  const it = await one<{ id: string }>(`SELECT id FROM stock_item WHERE id=$1 AND org_id=$2`, [itemId, orgId]);
  if (!it) redirect("/inventory");
  const kind = String(formData.get("kind") || "receipt");
  const raw = Number(formData.get("qty") || 0);
  // receipts add, issues/disposals subtract, adjustments take the signed value as entered
  const signed = kind === "adjustment" ? raw : kind === "receipt" ? Math.abs(raw) : -Math.abs(raw);
  // Stock integrity: an issue or disposal cannot exceed what is on hand.
  if (kind === "issue" || kind === "disposal") {
    const bal = (await one<{ b: number }>(`SELECT COALESCE(SUM(qty),0)::float8 b FROM stock_movement WHERE item_id=$1`, [itemId]))?.b ?? 0;
    if (Math.abs(raw) > bal) redirect(`/inventory/items/${itemId}?err=insufficient`);
  }
  const unitCost = formData.get("unitCost") ? Number(formData.get("unitCost")) : null;
  await q(`INSERT INTO stock_movement (id, org_id, item_id, store_id, kind, qty, unit_cost, reference, source, issued_to, movement_date, note, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10,$11,$12,$13)`,
    [id("smov"), orgId, itemId, String(formData.get("storeId") || "") || null, kind, signed, unitCost, String(formData.get("reference") || "") || null,
     String(formData.get("issuedTo") || "") || null, String(formData.get("movementDate") || new Date().toISOString().slice(0, 10)), String(formData.get("note") || "") || null, userId, userName]);
  // a receipt with a unit cost refreshes the item's standard cost
  if (kind === "receipt" && unitCost != null) await q(`UPDATE stock_item SET unit_cost=$2 WHERE id=$1`, [itemId, unitCost]);
  await writeAudit({ orgId, userId, action: "create", entity: "stock_movement", entityId: itemId, meta: { kind, qty: signed } });
  redirect(`/inventory/items/${itemId}?moved=${kind}`);
}

export async function deleteItemAction(formData: FormData) {
  const { orgId, userId } = await requireInventoryActor();
  const iid = String(formData.get("itemId") || "");
  const it = await one<{ id: string }>(`SELECT id FROM stock_item WHERE id=$1 AND org_id=$2`, [iid, orgId]);
  if (!it) redirect("/inventory");
  await q(`DELETE FROM stock_item WHERE id=$1 AND org_id=$2`, [iid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "stock_item", entityId: iid });
  redirect("/inventory?deleted=1");
}

/* ===================== Disposal management ===================== */
async function loadDisposal(orgId: string, disposalId: string) {
  const d = await one<{ id: string; status: string; assetId: string | null; method: string; currency: string | null }>(
    `SELECT id, status, asset_id AS "assetId", method, currency FROM disposal WHERE id=$1 AND org_id=$2`, [disposalId, orgId]);
  if (!d) redirect("/procurement/disposals");
  return d;
}

export async function createDisposalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const did = id("disp");
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  await q(`INSERT INTO disposal (id, org_id, reference, description, method, asset_id, stock_item_id, quantity, estimated_value, currency, committee_id, reason, status, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,$14)`,
    [did, orgId, sNull(formData.get("reference")), String(formData.get("description") || "Disposal"), String(formData.get("method") || "sale"),
     sNull(formData.get("assetId")), sNull(formData.get("stockItemId")), sNum(formData.get("quantity")), Number(formData.get("estimatedValue") || 0),
     String(formData.get("currency") || "") || baseCur, sNull(formData.get("committeeId")), sNull(formData.get("reason")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "disposal", entityId: did, after: { description: String(formData.get("description") || ""), method: String(formData.get("method") || "") } });
  redirect(`/procurement/disposals/${did}?created=1`);
}

export async function submitDisposalAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const did = String(formData.get("disposalId") || "");
  const d = await loadDisposal(orgId, did);
  if (d.status !== "draft") redirect(`/procurement/disposals/${did}`);
  await q(`UPDATE disposal SET status='submitted' WHERE id=$1 AND org_id=$2`, [did, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "disposal", entityId: did, after: { status: "submitted" } });
  redirect(`/procurement/disposals/${did}?saved=1`);
}

export async function boardSurveyDisposalAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const did = String(formData.get("disposalId") || "");
  const d = await loadDisposal(orgId, did);
  if (d.status !== "submitted") redirect(`/procurement/disposals/${did}`);
  await q(`UPDATE disposal SET status='board_survey', board_survey_date=$3, committee_id=COALESCE($4, committee_id) WHERE id=$1 AND org_id=$2`,
    [did, orgId, String(formData.get("boardSurveyDate") || new Date().toISOString().slice(0, 10)), sNull(formData.get("committeeId"))]);
  await writeAudit({ orgId, userId, action: "update", entity: "disposal", entityId: did, after: { status: "board_survey" } });
  redirect(`/procurement/disposals/${did}?saved=1`);
}

export async function decideDisposalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const did = String(formData.get("disposalId") || "");
  const d = await loadDisposal(orgId, did);
  if (d.status !== "board_survey" && d.status !== "submitted") redirect(`/procurement/disposals/${did}`);
  const decision = String(formData.get("decision") || "approved") === "rejected" ? "rejected" : "approved";
  await q(`UPDATE disposal SET status=$3, decided_by=$4, decided_at=now() WHERE id=$1 AND org_id=$2`, [did, orgId, decision, userName]);
  await writeAudit({ orgId, userId, action: "update", entity: "disposal", entityId: did, after: { status: decision } });
  redirect(`/procurement/disposals/${did}?saved=1`);
}

export async function markDisposedAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const did = String(formData.get("disposalId") || "");
  const d = await loadDisposal(orgId, did);
  if (d.status !== "approved") redirect(`/procurement/disposals/${did}`);
  const proceeds = formData.get("proceeds") ? Number(formData.get("proceeds")) : null;
  const disposedDate = String(formData.get("disposedDate") || new Date().toISOString().slice(0, 10));
  await q(`UPDATE disposal SET status='disposed', disposed_date=$3, proceeds=$4 WHERE id=$1 AND org_id=$2`, [did, orgId, disposedDate, proceeds]);
  // If a fixed asset is linked, retire it in the asset register too.
  if (d.assetId) {
    await q(`UPDATE fixed_asset SET status='disposed', disposal_method=$3, disposal_proceeds=$4, disposed_on=$5 WHERE id=$1 AND org_id=$2`,
      [d.assetId, orgId, d.method, proceeds, disposedDate]);
  }
  await writeAudit({ orgId, userId, action: "update", entity: "disposal", entityId: did, after: { status: "disposed", proceeds: proceeds ?? 0 } });
  redirect(`/procurement/disposals/${did}?saved=1`);
}

export async function deleteDisposalAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const did = String(formData.get("disposalId") || "");
  await loadDisposal(orgId, did);
  await q(`DELETE FROM disposal WHERE id=$1 AND org_id=$2`, [did, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "disposal", entityId: did });
  redirect("/procurement/disposals?deleted=1");
}

/* ===================== Tender & bid management ===================== */
async function loadTender(orgId: string, tenderId: string) {
  const t = await one<{ id: string; status: string; currency: string | null }>(`SELECT id, status, currency FROM tender WHERE id=$1 AND org_id=$2`, [tenderId, orgId]);
  if (!t) redirect("/procurement/tenders");
  return t;
}

export async function createTenderAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const tid = id("tndr");
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  await q(`INSERT INTO tender (id, org_id, reference, title, description, method, category, estimated_value, currency, committee_id, note, status, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13)`,
    [tid, orgId, sNull(formData.get("reference")), String(formData.get("title") || "Tender"), sNull(formData.get("description")), String(formData.get("method") || "open_domestic"),
     String(formData.get("category") || "goods"), Number(formData.get("estimatedValue") || 0), String(formData.get("currency") || "") || baseCur, sNull(formData.get("committeeId")), sNull(formData.get("note")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "tender", entityId: tid, after: { title: String(formData.get("title") || ""), method: String(formData.get("method") || "") } });
  redirect(`/procurement/tenders/${tid}?created=1`);
}

export async function updateTenderAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  await loadTender(orgId, tid);
  await q(`UPDATE tender SET reference=$2, title=$3, description=$4, method=$5, category=$6, estimated_value=$7, currency=$8, committee_id=$9, note=$10 WHERE id=$1 AND org_id=$11`,
    [tid, sNull(formData.get("reference")), String(formData.get("title") || "Tender"), sNull(formData.get("description")), String(formData.get("method") || "open_domestic"),
     String(formData.get("category") || "goods"), Number(formData.get("estimatedValue") || 0), String(formData.get("currency") || "") || null, sNull(formData.get("committeeId")), sNull(formData.get("note")), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "tender", entityId: tid });
  redirect(`/procurement/tenders/${tid}?saved=1`);
}

export async function advanceTenderAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  const t = await loadTender(orgId, tid);
  const to = String(formData.get("to") || "");
  // allowed forward transitions
  const ok: Record<string, string[]> = { draft: ["advertised", "cancelled"], advertised: ["closed", "cancelled"], closed: ["evaluation", "cancelled"], evaluation: ["cancelled"] };
  if (!(ok[t.status] || []).includes(to)) redirect(`/procurement/tenders/${tid}`);
  if (to === "advertised") {
    await q(`UPDATE tender SET status='advertised', advertised_date=$3, closing_date=$4 WHERE id=$1 AND org_id=$2`,
      [tid, orgId, String(formData.get("advertisedDate") || new Date().toISOString().slice(0, 10)), sNull(formData.get("closingDate"))]);
  } else {
    await q(`UPDATE tender SET status=$3 WHERE id=$1 AND org_id=$2`, [tid, orgId, to]);
  }
  await writeAudit({ orgId, userId, action: "update", entity: "tender", entityId: tid, after: { status: to } });
  redirect(`/procurement/tenders/${tid}?saved=1`);
}

export async function deleteTenderAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  await loadTender(orgId, tid);
  await q(`DELETE FROM tender WHERE id=$1 AND org_id=$2`, [tid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "tender", entityId: tid });
  redirect("/procurement/tenders?deleted=1");
}

export async function addBidAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  const t = await loadTender(orgId, tid);
  const vendorId = sNull(formData.get("vendorId"));
  let bidderName = String(formData.get("bidderName") || "").trim();
  if (vendorId && !bidderName) bidderName = (await one<{ name: string }>(`SELECT name FROM vendor WHERE id=$1`, [vendorId]))?.name ?? "Bidder";
  await q(`INSERT INTO tender_bid (id, tender_id, vendor_id, bidder_name, bid_amount, currency, received_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'received')`,
    [id("bid"), tid, vendorId, bidderName || "Bidder", Number(formData.get("bidAmount") || 0), String(formData.get("currency") || "") || t.currency, String(formData.get("receivedDate") || new Date().toISOString().slice(0, 10))]);
  await writeAudit({ orgId, userId, action: "create", entity: "tender_bid", entityId: tid, meta: { bidder: bidderName } });
  redirect(`/procurement/tenders/${tid}?added=bid`);
}

export async function evaluateBidAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  await loadTender(orgId, tid);
  const bidId = String(formData.get("bidId") || "");
  await q(`UPDATE tender_bid SET status=$2, evaluation_score=$3, evaluation_notes=$4 WHERE id=$1 AND tender_id=$5`,
    [bidId, String(formData.get("bidStatus") || "responsive"), sNum(formData.get("score")), sNull(formData.get("notes")), tid]);
  redirect(`/procurement/tenders/${tid}?saved=bid`);
}

export async function removeBidAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  await loadTender(orgId, tid);
  const bidId = String(formData.get("bidId") || "");
  await q(`DELETE FROM tender_bid WHERE id=$1 AND tender_id=$2`, [bidId, tid]);
  // if this was the awarded bid, clear the award link
  await q(`UPDATE tender SET award_bid_id=NULL WHERE id=$1 AND award_bid_id=$2`, [tid, bidId]);
  redirect(`/procurement/tenders/${tid}?removed=bid`);
}

export async function awardTenderAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  const t = await loadTender(orgId, tid);
  if (t.status !== "evaluation") redirect(`/procurement/tenders/${tid}`);
  const bidId = String(formData.get("bidId") || "");
  const bid = await one<{ id: string; bidderName: string }>(`SELECT id, bidder_name AS "bidderName" FROM tender_bid WHERE id=$1 AND tender_id=$2`, [bidId, tid]);
  if (!bid) redirect(`/procurement/tenders/${tid}`);
  await q(`UPDATE tender_bid SET status='awarded' WHERE id=$1`, [bidId]);
  await q(`UPDATE tender SET status='awarded', award_bid_id=$3 WHERE id=$1 AND org_id=$2`, [tid, orgId, bidId]);
  await writeAudit({ orgId, userId, action: "update", entity: "tender", entityId: tid, after: { status: "awarded", awardedTo: bid.bidderName } });
  redirect(`/procurement/tenders/${tid}?saved=award`);
}

/* ===================== Contract register ===================== */
async function loadContract(orgId: string, contractId: string) {
  const c = await one<{ id: string; currency: string | null }>(`SELECT id, currency FROM contract WHERE id=$1 AND org_id=$2`, [contractId, orgId]);
  if (!c) redirect("/procurement/contracts");
  return c;
}

export async function createContractAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const cid = id("ctr");
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const vendorId = sNull(formData.get("vendorId"));
  let providerName = sNull(formData.get("providerName"));
  if (vendorId && !providerName) providerName = (await one<{ name: string }>(`SELECT name FROM vendor WHERE id=$1`, [vendorId]))?.name ?? null;
  await q(`INSERT INTO contract (id, org_id, reference, title, vendor_id, provider_name, tender_id, contract_value, currency, start_date, end_date, signed_date, status, scope, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [cid, orgId, sNull(formData.get("reference")), String(formData.get("title") || "Contract"), vendorId, providerName, sNull(formData.get("tenderId")),
     Number(formData.get("contractValue") || 0), String(formData.get("currency") || "") || baseCur, sNull(formData.get("startDate")), sNull(formData.get("endDate")), sNull(formData.get("signedDate")),
     String(formData.get("status") || "active"), sNull(formData.get("scope")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "contract", entityId: cid, after: { title: String(formData.get("title") || "") } });
  redirect(`/procurement/contracts/${cid}?created=1`);
}

// Create a contract directly from an awarded tender (prefilled from the winning bid).
export async function createContractFromTenderAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const tid = String(formData.get("tenderId") || "");
  const t = await one<{ id: string; title: string; reference: string | null; currency: string | null; awardBidId: string | null }>(
    `SELECT id, title, reference, currency, award_bid_id AS "awardBidId" FROM tender WHERE id=$1 AND org_id=$2`, [tid, orgId]);
  if (!t || !t.awardBidId) redirect(`/procurement/tenders/${tid}`);
  const bid = await one<{ vendorId: string | null; bidderName: string; bidAmount: number; currency: string | null }>(
    `SELECT vendor_id AS "vendorId", bidder_name AS "bidderName", bid_amount::float8 AS "bidAmount", currency FROM tender_bid WHERE id=$1`, [t.awardBidId]);
  if (!bid) redirect(`/procurement/tenders/${tid}`);
  const cid = id("ctr");
  await q(`INSERT INTO contract (id, org_id, reference, title, vendor_id, provider_name, tender_id, contract_value, currency, status, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11)`,
    [cid, orgId, t.reference, t.title, bid.vendorId, bid.bidderName, tid, bid.bidAmount, bid.currency ?? t.currency, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "contract", entityId: cid, meta: { fromTender: tid } });
  redirect(`/procurement/contracts/${cid}?created=1`);
}

export async function updateContractAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  const vendorId = sNull(formData.get("vendorId"));
  let providerName = sNull(formData.get("providerName"));
  if (vendorId && !providerName) providerName = (await one<{ name: string }>(`SELECT name FROM vendor WHERE id=$1`, [vendorId]))?.name ?? null;
  await q(`UPDATE contract SET reference=$2, title=$3, vendor_id=$4, provider_name=$5, contract_value=$6, currency=$7, start_date=$8, end_date=$9, signed_date=$10, scope=$11 WHERE id=$1 AND org_id=$12`,
    [cid, sNull(formData.get("reference")), String(formData.get("title") || "Contract"), vendorId, providerName, Number(formData.get("contractValue") || 0),
     String(formData.get("currency") || "") || null, sNull(formData.get("startDate")), sNull(formData.get("endDate")), sNull(formData.get("signedDate")), sNull(formData.get("scope")), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "contract", entityId: cid });
  redirect(`/procurement/contracts/${cid}?saved=1`);
}

export async function setContractStatusAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  const status = String(formData.get("status") || "active");
  await q(`UPDATE contract SET status=$2 WHERE id=$1 AND org_id=$3`, [cid, status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "contract", entityId: cid, after: { status } });
  redirect(`/procurement/contracts/${cid}?saved=1`);
}

export async function deleteContractAction(formData: FormData) {
  const { orgId, userId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  await q(`DELETE FROM contract WHERE id=$1 AND org_id=$2`, [cid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "contract", entityId: cid });
  redirect("/procurement/contracts?deleted=1");
}

export async function addContractMilestoneAction(formData: FormData) {
  const { orgId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  await q(`INSERT INTO contract_milestone (id, contract_id, name, due_date, amount, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("cms"), cid, String(formData.get("name") || "Milestone"), sNull(formData.get("dueDate")), sNum(formData.get("amount")), String(formData.get("msStatus") || "pending"), sNull(formData.get("note"))]);
  redirect(`/procurement/contracts/${cid}?added=milestone`);
}

export async function updateContractMilestoneAction(formData: FormData) {
  const { orgId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  const mid = String(formData.get("milestoneId") || "");
  const status = String(formData.get("msStatus") || "delivered");
  await q(`UPDATE contract_milestone SET status=$2, delivered_date=CASE WHEN $2 IN ('delivered','accepted') AND delivered_date IS NULL THEN CURRENT_DATE ELSE delivered_date END WHERE id=$1 AND contract_id=$3`, [mid, status, cid]);
  redirect(`/procurement/contracts/${cid}?saved=milestone`);
}

export async function addContractPaymentAction(formData: FormData) {
  const { orgId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  const c = await loadContract(orgId, cid);
  await q(`INSERT INTO contract_payment (id, contract_id, reference, amount, currency, payment_date, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("cpay"), cid, sNull(formData.get("reference")), Number(formData.get("amount") || 0), String(formData.get("currency") || "") || c.currency, String(formData.get("paymentDate") || new Date().toISOString().slice(0, 10)), sNull(formData.get("note"))]);
  redirect(`/procurement/contracts/${cid}?added=payment`);
}

export async function addContractAppraisalAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  await q(`INSERT INTO contract_appraisal (id, contract_id, period, quality, timeliness, compliance, comments, appraised_by, appraisal_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("capp"), cid, sNull(formData.get("period")), sNum(formData.get("quality")), sNum(formData.get("timeliness")), sNum(formData.get("compliance")), sNull(formData.get("comments")), userName, String(formData.get("appraisalDate") || new Date().toISOString().slice(0, 10))]);
  await writeAudit({ orgId, userId, action: "create", entity: "contract_appraisal", entityId: cid });
  redirect(`/procurement/contracts/${cid}?added=appraisal`);
}

// Generic delete for a contract sub-record.
export async function deleteContractItemAction(formData: FormData) {
  const { orgId } = await requireProcGovActor();
  const cid = String(formData.get("contractId") || "");
  await loadContract(orgId, cid);
  const kind = String(formData.get("kind") || "");
  const itemId = String(formData.get("itemId") || "");
  const table = ({ milestone: "contract_milestone", payment: "contract_payment", appraisal: "contract_appraisal" } as Record<string, string>)[kind];
  if (!table) redirect(`/procurement/contracts/${cid}`);
  await q(`DELETE FROM ${table} WHERE id=$1 AND contract_id=$2`, [itemId, cid]);
  redirect(`/procurement/contracts/${cid}?removed=${kind}`);
}

/* ===================== GRN -> inventory / asset posting ===================== */
async function requireProcActor() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  if (!(await _isModEnabled(org.id, "procurement"))) redirect("/dashboard");
  return { orgId: org.id, userId: user.id, userName: user.name };
}

// Post a received purchase-order line into stores (as a stock receipt) or the asset register.
export async function postReceivedItemAction(formData: FormData) {
  const { orgId, userId, userName } = await requireProcActor();
  const poItemId = String(formData.get("poItemId") || "");
  const it = await one<{ poId: string; description: string; unit: string | null; unitCost: number; qtyReceived: number; postedQty: number; poNumber: string | null; currency: string | null }>(
    `SELECT i.po_id AS "poId", i.description, i.unit, i.unit_cost::float8 AS "unitCost", i.qty_received::float8 AS "qtyReceived", i.posted_qty::float8 AS "postedQty",
            po.number AS "poNumber", po.currency
     FROM purchase_order_item i JOIN purchase_order po ON po.id=i.po_id WHERE i.id=$1 AND po.org_id=$2`, [poItemId, orgId]);
  if (!it) redirect("/procurement");
  const toPost = it.qtyReceived - it.postedQty;
  if (toPost <= 0) redirect(`/procurement/orders/${it.poId}?err=posted`);
  const destination = String(formData.get("destination") || "stores");
  const cur = it.currency ?? "USD";
  const today = new Date().toISOString().slice(0, 10);

  if (destination === "asset") {
    const aid = id("asset");
    await q(`INSERT INTO fixed_asset (id, org_id, name, category, acquired_on, cost, currency, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
      [aid, orgId, String(formData.get("assetName") || it.description), sNull(formData.get("category")), today, it.unitCost * toPost, cur, `From PO ${it.poNumber ?? ""} (qty ${toPost})`]);
    await q(`UPDATE purchase_order_item SET posted_qty=qty_received WHERE id=$1`, [poItemId]);
    await writeAudit({ orgId, userId, action: "create", entity: "fixed_asset", entityId: aid, meta: { fromPoItem: poItemId, qty: toPost } });
    redirect(`/procurement/orders/${it.poId}?posted=asset`);
  }

  // destination === "stores" -> needs the inventory module
  if (!(await _isModEnabled(orgId, "stores"))) redirect(`/procurement/orders/${it.poId}?err=stores_off`);
  let stockItemId = sNull(formData.get("stockItemId"));
  if (!stockItemId) {
    const name = String(formData.get("newItemName") || it.description).trim() || it.description;
    const ex = await one<{ id: string }>(`SELECT id FROM stock_item WHERE org_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [orgId, name]);
    if (ex) stockItemId = ex.id;
    else {
      stockItemId = id("item");
      await q(`INSERT INTO stock_item (id, org_id, name, category, item_type, unit, unit_cost, reorder_level, currency, status) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,'active')`,
        [stockItemId, orgId, name, sNull(formData.get("category")), String(formData.get("itemType") || "consumable"), it.unit || "unit", it.unitCost, cur]);
    }
  }
  await q(`INSERT INTO stock_movement (id, org_id, item_id, store_id, kind, qty, unit_cost, reference, source, movement_date, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,'receipt',$5,$6,$7,'grn',$8,$9,$10)`,
    [id("smov"), orgId, stockItemId, sNull(formData.get("storeId")), toPost, it.unitCost, `PO ${it.poNumber ?? ""}`, today, userId, userName]);
  await q(`UPDATE stock_item SET unit_cost=$2 WHERE id=$1`, [stockItemId, it.unitCost]);
  await q(`UPDATE purchase_order_item SET posted_qty=qty_received WHERE id=$1`, [poItemId]);
  await writeAudit({ orgId, userId, action: "create", entity: "stock_movement", entityId: stockItemId, meta: { fromPoItem: poItemId, kind: "receipt", qty: toPost } });
  redirect(`/procurement/orders/${it.poId}?posted=stores`);
}

/* ===================== Budget approval workflow + reallocations (virement) ===================== */
// An approved budget is locked: structural line edits require reopening it first.
async function assertBudgetEditable(projectId: string) {
  const b = await one<{ status: string }>(`SELECT status FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [projectId]);
  if (b && b.status === "approved") throw new Error("This budget is approved and locked. Reopen it for revision before editing lines.");
}

async function loadProjectBudget(projectId: string, budgetId: string) {
  const b = await one<{ id: string; status: string }>(`SELECT id, status FROM budget WHERE id=$1 AND project_id=$2`, [budgetId, projectId]);
  if (!b) redirect(`/projects/${projectId}/budget`);
  return b;
}

export async function submitBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const budgetId = String(formData.get("budgetId") || "");
  const b = await loadProjectBudget(projectId, budgetId);
  if (!["draft", "rejected"].includes(b.status)) redirect(`/projects/${projectId}/budget`);
  await q(`UPDATE budget SET status='submitted' WHERE id=$1`, [budgetId]);
  await q(`INSERT INTO budget_approval (id, budget_id, action, note, acted_by_id, acted_by_name) VALUES ($1,$2,'submitted',$3,$4,$5)`, [id("bap"), budgetId, sNull(formData.get("note")), user.id, user.name]);
  await writeAudit({ userId: user.id, action: "submit", entity: "budget", entityId: budgetId });
  redirect(`/projects/${projectId}/budget?bm=submitted`);
}

export async function approveBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requireBudgetBulk(projectId);
  const budgetId = String(formData.get("budgetId") || "");
  const b = await loadProjectBudget(projectId, budgetId);
  if (b.status !== "submitted") redirect(`/projects/${projectId}/budget`);
  await q(`UPDATE budget SET status='approved' WHERE id=$1`, [budgetId]);
  await q(`INSERT INTO budget_approval (id, budget_id, action, note, acted_by_id, acted_by_name) VALUES ($1,$2,'approved',$3,$4,$5)`, [id("bap"), budgetId, sNull(formData.get("note")), user.id, user.name]);
  await writeAudit({ userId: user.id, action: "approve", entity: "budget", entityId: budgetId });
  redirect(`/projects/${projectId}/budget?bm=approved`);
}

export async function rejectBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requireBudgetBulk(projectId);
  const budgetId = String(formData.get("budgetId") || "");
  const b = await loadProjectBudget(projectId, budgetId);
  if (b.status !== "submitted") redirect(`/projects/${projectId}/budget`);
  await q(`UPDATE budget SET status='rejected' WHERE id=$1`, [budgetId]);
  await q(`INSERT INTO budget_approval (id, budget_id, action, note, acted_by_id, acted_by_name) VALUES ($1,$2,'rejected',$3,$4,$5)`, [id("bap"), budgetId, sNull(formData.get("note")), user.id, user.name]);
  await writeAudit({ userId: user.id, action: "reject", entity: "budget", entityId: budgetId });
  redirect(`/projects/${projectId}/budget?bm=rejected`);
}

export async function reopenBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requireBudgetBulk(projectId);
  const budgetId = String(formData.get("budgetId") || "");
  const b = await loadProjectBudget(projectId, budgetId);
  if (!["approved", "rejected"].includes(b.status)) redirect(`/projects/${projectId}/budget`);
  await q(`UPDATE budget SET status='draft' WHERE id=$1`, [budgetId]);
  await q(`INSERT INTO budget_approval (id, budget_id, action, note, acted_by_id, acted_by_name) VALUES ($1,$2,'reopened',$3,$4,$5)`, [id("bap"), budgetId, sNull(formData.get("note")), user.id, user.name]);
  await writeAudit({ userId: user.id, action: "reopen", entity: "budget", entityId: budgetId });
  redirect(`/projects/${projectId}/budget?bm=reopened`);
}

// Reallocate (virement) planned funds from one budget line to another. The source
// line must have enough *available* (planned − committed − spent): you can never
// move money that is already committed or spent. Total budget is preserved.
export async function reallocateBudgetAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requireBudgetBulk(projectId);
  const budgetId = String(formData.get("budgetId") || "");
  const fromId = String(formData.get("fromLineId") || "");
  const toId = String(formData.get("toLineId") || "");
  const amount = Number(formData.get("amount") || 0);
  await loadProjectBudget(projectId, budgetId);
  if (!fromId || !toId || fromId === toId || !(amount > 0)) redirect(`/projects/${projectId}/budget?bm=badmove`);
  const lines = await q<{ id: string; code: string; description: string; planned: number; committed: number; actual: number }>(
    `SELECT bl.id, bl.code, bl.description, bl.planned,
            COALESCE((SELECT SUM(amount) FROM commitment WHERE budget_line_id=bl.id),0) AS committed,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=bl.id),0) AS actual
     FROM budget_line bl JOIN budget b ON b.id=bl.budget_id WHERE b.id=$1 AND b.project_id=$2 AND bl.id IN ($3,$4)`,
    [budgetId, projectId, fromId, toId]);
  const from = lines.find((l) => l.id === fromId);
  const to = lines.find((l) => l.id === toId);
  if (!from || !to) redirect(`/projects/${projectId}/budget?bm=badmove`);
  const available = from.planned - from.committed - from.actual;
  if (amount > available + 1e-9) redirect(`/projects/${projectId}/budget?bm=insufficient`);
  // snapshot both lines' pre-change figures into the per-line revision history
  for (const l of [from, to]) {
    await q(`INSERT INTO budget_line_revision (id, project_id, budget_line_id, code, description, unit_cost, quantity, planned, action, changed_by, changed_by_name)
             SELECT $1,$2,id,code,description,unit_cost,quantity,planned,'reallocated',$3,$4 FROM budget_line WHERE id=$5`,
      [id("blr"), projectId, user.id, user.name, l.id]);
  }
  await q(`UPDATE budget_line SET planned = planned - $2 WHERE id=$1`, [fromId, amount]);
  await q(`UPDATE budget_line SET planned = planned + $2 WHERE id=$1`, [toId, amount]);
  await q(`INSERT INTO budget_reallocation (id, budget_id, from_line_id, to_line_id, amount, reason, created_by_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("brl"), budgetId, fromId, toId, amount, sNull(formData.get("reason")), user.id, user.name]);
  await writeAudit({ userId: user.id, action: "reallocate", entity: "budget", entityId: budgetId, meta: { from: from.code, to: to.code, amount } });
  await evaluateProject(projectId);
  redirect(`/projects/${projectId}/budget?bm=reallocated`);
}

// Configure the acceptable freeze-thaw limit for a sample type (lab managers only).
export async function setSampleTypeMaxAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab?err=forbidden");
  const typeId = String(formData.get("typeId") || "");
  const raw = String(formData.get("maxFreezeThaw") || "").trim();
  const max = raw === "" ? null : Number(raw);
  await q(`UPDATE lab_sample_type SET max_freeze_thaw=$2 WHERE id=$1 AND org_id=$3`, [typeId, max, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_sample_type", entityId: typeId, after: { maxFreezeThaw: max } });
  redirect("/lab?ftset=1");
}

/* ===================== Lab: freezer register + temperature logs + incidents ===================== */
async function loadFreezer(orgId: string, freezerId: string) {
  const f = await one<{ id: string; minTemp: number | null; maxTemp: number | null }>(
    `SELECT id, min_temp AS "minTemp", max_temp AS "maxTemp" FROM lab_freezer WHERE id=$1 AND org_id=$2`, [freezerId, orgId]);
  if (!f) redirect("/lab/freezers");
  return f;
}

export async function createFreezerAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab/freezers?err=forbidden");
  const fid = id("frz");
  await q(`INSERT INTO lab_freezer (id, org_id, name, location, kind, set_point, min_temp, max_temp, status, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [fid, orgId, String(formData.get("name") || "Freezer"), sNull(formData.get("location")), String(formData.get("kind") || "freezer_-80"),
     sNum(formData.get("setPoint")), sNum(formData.get("minTemp")), sNum(formData.get("maxTemp")), String(formData.get("status") || "active"), sNull(formData.get("notes")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_freezer", entityId: fid, after: { name: String(formData.get("name") || "") } });
  redirect(`/lab/freezers/${fid}?created=1`);
}

export async function updateFreezerAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  await loadFreezer(orgId, fid);
  if (!(isOrgAdmin || isSuperAdmin)) redirect(`/lab/freezers/${fid}?err=forbidden`);
  await q(`UPDATE lab_freezer SET name=$2, location=$3, kind=$4, set_point=$5, min_temp=$6, max_temp=$7, status=$8, notes=$9 WHERE id=$1 AND org_id=$10`,
    [fid, String(formData.get("name") || "Freezer"), sNull(formData.get("location")), String(formData.get("kind") || "freezer_-80"),
     sNum(formData.get("setPoint")), sNum(formData.get("minTemp")), sNum(formData.get("maxTemp")), String(formData.get("status") || "active"), sNull(formData.get("notes")), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_freezer", entityId: fid });
  redirect(`/lab/freezers/${fid}?saved=1`);
}

export async function deleteFreezerAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  await loadFreezer(orgId, fid);
  if (!(isOrgAdmin || isSuperAdmin)) redirect(`/lab/freezers/${fid}?err=forbidden`);
  await q(`DELETE FROM lab_freezer WHERE id=$1 AND org_id=$2`, [fid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "lab_freezer", entityId: fid });
  redirect("/lab/freezers?deleted=1");
}

// Record a temperature reading; the in-range flag is computed against the freezer's acceptable range.
export async function recordTempAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  const f = await loadFreezer(orgId, fid);
  const temp = Number(formData.get("temperature") || 0);
  const ok = !((f.minTemp != null && temp < f.minTemp) || (f.maxTemp != null && temp > f.maxTemp));
  const at = String(formData.get("readingAt") || "").trim();
  await q(`INSERT INTO lab_temp_log (id, freezer_id, reading_at, temperature, min_reading, max_reading, in_range, note, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9,$10)`,
    [id("tmp"), fid, at || null, temp, sNum(formData.get("minReading")), sNum(formData.get("maxReading")), ok, sNull(formData.get("note")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_temp_log", entityId: fid, after: { temperature: temp, inRange: ok } });
  redirect(`/lab/freezers/${fid}?temp=${ok ? "ok" : "out"}`);
}

export async function addFreezerIncidentAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  await loadFreezer(orgId, fid);
  const at = String(formData.get("incidentAt") || "").trim();
  await q(`INSERT INTO lab_freezer_incident (id, freezer_id, incident_at, kind, severity, description, action_taken, reported_by_id, reported_by_name)
           VALUES ($1,$2,COALESCE($3::timestamptz, now()),$4,$5,$6,$7,$8,$9)`,
    [id("finc"), fid, at || null, String(formData.get("kind") || "other"), String(formData.get("severity") || "warning"),
     sNull(formData.get("description")), sNull(formData.get("actionTaken")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_freezer_incident", entityId: fid, after: { kind: String(formData.get("kind") || ""), severity: String(formData.get("severity") || "") } });
  redirect(`/lab/freezers/${fid}?incident=1`);
}

export async function resolveFreezerIncidentAction(formData: FormData) {
  const { orgId, userId } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  await loadFreezer(orgId, fid);
  const incId = String(formData.get("incidentId") || "");
  const reopen = formData.get("reopen") === "1";
  await q(`UPDATE lab_freezer_incident SET resolved=$2, resolved_at=CASE WHEN $2 THEN now() ELSE NULL END, action_taken=COALESCE($3, action_taken) WHERE id=$1 AND freezer_id=$4`,
    [incId, !reopen, sNull(formData.get("actionTaken")), fid]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_freezer_incident", entityId: fid, after: { resolved: !reopen } });
  redirect(`/lab/freezers/${fid}?incresolved=${reopen ? "0" : "1"}`);
}

export async function deleteFreezerIncidentAction(formData: FormData) {
  const { orgId } = await requireLabActor();
  const fid = String(formData.get("freezerId") || "");
  await loadFreezer(orgId, fid);
  await q(`DELETE FROM lab_freezer_incident WHERE id=$1 AND freezer_id=$2`, [String(formData.get("incidentId") || ""), fid]);
  redirect(`/lab/freezers/${fid}?incremoved=1`);
}

/* ===================== Lab: assay catalogue + tests/results ===================== */
async function loadSampleOrg(orgId: string, sampleId: string) {
  const s = await one<{ id: string }>(`SELECT id FROM lab_sample WHERE id=$1 AND org_id=$2`, [sampleId, orgId]);
  if (!s) redirect("/lab/samples");
  return s;
}
async function loadTest(orgId: string, testId: string) {
  const t = await one<{ id: string; sampleId: string }>(`SELECT id, sample_id AS "sampleId" FROM lab_test WHERE id=$1 AND org_id=$2`, [testId, orgId]);
  if (!t) redirect("/lab/tests");
  return t;
}

export async function addAssayAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab/tests?err=forbidden");
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/lab/tests");
  const ex = await one<{ id: string }>(`SELECT id FROM lab_assay WHERE org_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [orgId, name]);
  if (ex) { await q(`UPDATE lab_assay SET category=$2, method=$3, unit=$4, turnaround_days=$5, status='active' WHERE id=$1`, [ex.id, sNull(formData.get("category")), sNull(formData.get("method")), sNull(formData.get("unit")), sNum(formData.get("turnaroundDays"))]); }
  else { await q(`INSERT INTO lab_assay (id, org_id, name, category, method, unit, turnaround_days) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id("assay"), orgId, name, sNull(formData.get("category")), sNull(formData.get("method")), sNull(formData.get("unit")), sNum(formData.get("turnaroundDays"))]); }
  await writeAudit({ orgId, userId, action: "create", entity: "lab_assay", entityId: name });
  redirect("/lab/tests?assay=1");
}

export async function setAssayStatusAction(formData: FormData) {
  const { orgId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab/tests?err=forbidden");
  const aid = String(formData.get("assayId") || "");
  await q(`UPDATE lab_assay SET status=$2 WHERE id=$1 AND org_id=$3`, [aid, String(formData.get("status") || "active"), orgId]);
  redirect("/lab/tests?assay=1");
}

// Order a test/assay on a sample. The assay is taken from the catalogue, or a typed name is found/created.
export async function orderTestAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const sid = String(formData.get("sampleId") || "");
  await loadSampleOrg(orgId, sid);
  let assayId = sNull(formData.get("assayId"));
  let unit: string | null = null;
  const newAssay = String(formData.get("newAssay") || "").trim();
  if (newAssay) {
    const ex = await one<{ id: string }>(`SELECT id FROM lab_assay WHERE org_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [orgId, newAssay]);
    if (ex) assayId = ex.id;
    else { assayId = id("assay"); await q(`INSERT INTO lab_assay (id, org_id, name, category) VALUES ($1,$2,$3,'Other')`, [assayId, orgId, newAssay]); }
  }
  if (assayId) unit = (await one<{ unit: string | null }>(`SELECT unit FROM lab_assay WHERE id=$1`, [assayId]))?.unit ?? null;
  await q(`INSERT INTO lab_test (id, org_id, sample_id, assay_id, status, requested_by_id, requested_by_name, requested_date, method, unit, notes)
           VALUES ($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9,$10)`,
    [id("ltest"), orgId, sid, assayId, userId, userName, String(formData.get("requestedDate") || new Date().toISOString().slice(0, 10)), sNull(formData.get("method")), unit, sNull(formData.get("notes"))]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_test", entityId: sid });
  redirect(`/lab/samples/${sid}?test=ordered`);
}

export async function recordTestResultAction(formData: FormData) {
  const { orgId, userId, userName } = await requireLabActor();
  const testId = String(formData.get("testId") || "");
  const t = await loadTest(orgId, testId);
  const status = String(formData.get("status") || "completed");
  await q(`UPDATE lab_test SET result=$2, result_numeric=$3, unit=COALESCE($4, unit), interpretation=$5, method=COALESCE($6, method), performed_by_id=$7, performed_by_name=$8, result_date=$9, status=$10 WHERE id=$1 AND org_id=$11`,
    [testId, sNull(formData.get("result")), sNum(formData.get("resultNumeric")), sNull(formData.get("unit")), sNull(formData.get("interpretation")), sNull(formData.get("method")),
     userId, userName, String(formData.get("resultDate") || new Date().toISOString().slice(0, 10)), status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_test", entityId: t.sampleId, after: { status, result: sNull(formData.get("result")) } });
  const back = String(formData.get("back") || "");
  redirect(back === "tests" ? "/lab/tests?result=1" : `/lab/samples/${t.sampleId}?test=result`);
}

export async function updateTestStatusAction(formData: FormData) {
  const { orgId, userId } = await requireLabActor();
  const testId = String(formData.get("testId") || "");
  const t = await loadTest(orgId, testId);
  await q(`UPDATE lab_test SET status=$2 WHERE id=$1 AND org_id=$3`, [testId, String(formData.get("status") || "in_progress"), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_test", entityId: t.sampleId, after: { status: String(formData.get("status") || "") } });
  const back = String(formData.get("back") || "");
  redirect(back === "tests" ? "/lab/tests?status=1" : `/lab/samples/${t.sampleId}?test=status`);
}

export async function deleteTestAction(formData: FormData) {
  const { orgId } = await requireLabActor();
  const testId = String(formData.get("testId") || "");
  const t = await loadTest(orgId, testId);
  await q(`DELETE FROM lab_test WHERE id=$1 AND org_id=$2`, [testId, orgId]);
  const back = String(formData.get("back") || "");
  redirect(back === "tests" ? "/lab/tests?removed=1" : `/lab/samples/${t.sampleId}?test=removed`);
}

/* ===================== Lab: bulk sample disposal (by type / aliquot) ===================== */
// Dispose a filtered set or an explicit selection of samples in one event (managers only).
export async function bulkDisposeAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  if (!(isOrgAdmin || isSuperAdmin)) redirect("/lab/disposal?err=forbidden");
  const reason = String(formData.get("reason") || "").trim();
  if (!reason) redirect("/lab/disposal?err=reason");
  const method = sNull(formData.get("method"));
  const witness = sNull(formData.get("witness"));
  const mode = String(formData.get("mode") || "selected");
  const projectIds = await accessibleProjectIds(userId, orgId, true);
  if (projectIds.length === 0) redirect("/lab/disposal?err=none");

  let ids: string[];
  if (mode === "all") {
    ids = await disposableIds(orgId, projectIds, { projectId: sNull(formData.get("projectId")) ?? undefined, studyId: sNull(formData.get("studyId")) ?? undefined, sampleTypeId: sNull(formData.get("sampleTypeId")) ?? undefined, search: sNull(formData.get("search")) ?? undefined });
  } else {
    ids = formData.getAll("sampleIds").map(String).filter(Boolean);
  }
  if (ids.length === 0) redirect("/lab/disposal?err=none");

  const batch = id("ddb");
  const base: unknown[] = [method, reason, witness, userId, userName, batch, orgId];
  const ph = ids.map((_, i) => `$${i + 8}`).join(",");
  const disposed = await q<{ id: string }>(
    `UPDATE lab_sample SET status='disposed', disposal_date=CURRENT_DATE, disposal_method=$1, disposal_reason=$2, disposal_witness=$3, disposed_by_id=$4, disposed_by_name=$5, disposal_batch_id=$6, updated_at=now()
     WHERE org_id=$7 AND status<>'disposed' AND id IN (${ph}) RETURNING id`, [...base, ...ids]);
  await writeAudit({ orgId, userId, action: "bulk_dispose", entity: "lab_sample", entityId: batch, after: { count: disposed.length, reason, method, batch } });
  redirect(`/lab/disposal?disposed=${disposed.length}`);
}

/* ===================== Clinical trials: AE/SAE, deviations, monitoring ===================== */
export async function addStudyAEAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  const serious = formData.get("serious") === "1";
  await q(`INSERT INTO study_ae (id, study_id, participant_ref, term, onset_date, severity, serious, sae_criteria, causality, expectedness, outcome, action_taken, reported_date, reported_to, status, description, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id("sae"), sid, sNull(formData.get("participantRef")), String(formData.get("term") || "Event"), sNull(formData.get("onsetDate")), String(formData.get("severity") || "mild"), serious,
     serious ? sNull(formData.get("saeCriteria")) : null, sNull(formData.get("causality")), sNull(formData.get("expectedness")), sNull(formData.get("outcome")), sNull(formData.get("actionTaken")),
     sNull(formData.get("reportedDate")), sNull(formData.get("reportedTo")), String(formData.get("status") || "open"), sNull(formData.get("description")), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "study_ae", entityId: sid, after: { term: String(formData.get("term") || ""), serious } });
  redirect(`/studies/${sid}?added=ae`);
}
export async function updateStudyAEAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`UPDATE study_ae SET status=$2, outcome=COALESCE($3, outcome), reported_date=COALESCE($4, reported_date), reported_to=COALESCE($5, reported_to) WHERE id=$1 AND study_id=$6`,
    [String(formData.get("aeId") || ""), String(formData.get("status") || "open"), sNull(formData.get("outcome")), sNull(formData.get("reportedDate")), sNull(formData.get("reportedTo")), sid]);
  await writeAudit({ orgId, userId, action: "update", entity: "study_ae", entityId: sid });
  redirect(`/studies/${sid}?saved=ae`);
}

export async function addStudyDeviationAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`INSERT INTO study_deviation (id, study_id, participant_ref, deviation_date, kind, severity, description, root_cause, corrective_action, reported, reported_date, status, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id("dev"), sid, sNull(formData.get("participantRef")), sNull(formData.get("deviationDate")), String(formData.get("kind") || "other"), String(formData.get("severity") || "minor"),
     String(formData.get("description") || "Deviation"), sNull(formData.get("rootCause")), sNull(formData.get("correctiveAction")), formData.get("reported") === "1", sNull(formData.get("reportedDate")), String(formData.get("status") || "open"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "study_deviation", entityId: sid, after: { severity: String(formData.get("severity") || "") } });
  redirect(`/studies/${sid}?added=deviation`);
}
export async function updateStudyDeviationAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`UPDATE study_deviation SET status=$2, corrective_action=COALESCE($3, corrective_action), reported=$4 WHERE id=$1 AND study_id=$5`,
    [String(formData.get("deviationId") || ""), String(formData.get("status") || "open"), sNull(formData.get("correctiveAction")), formData.get("reported") === "1", sid]);
  await writeAudit({ orgId, userId, action: "update", entity: "study_deviation", entityId: sid });
  redirect(`/studies/${sid}?saved=deviation`);
}

export async function addStudyMonitoringAction(formData: FormData) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`INSERT INTO study_monitoring (id, study_id, visit_date, kind, monitor_name, site, findings, action_items, report_received, status, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id("smon"), sid, sNull(formData.get("visitDate")), String(formData.get("kind") || "imv"), sNull(formData.get("monitorName")), sNull(formData.get("site")),
     sNull(formData.get("findings")), sNull(formData.get("actionItems")), formData.get("reportReceived") === "1", String(formData.get("status") || "open"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "study_monitoring", entityId: sid });
  redirect(`/studies/${sid}?added=monitoring`);
}
export async function updateStudyMonitoringAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudyActor();
  const sid = String(formData.get("studyId") || "");
  await loadStudyForActor(sid, orgId, userId, isOrgAdmin || isSuperAdmin);
  await q(`UPDATE study_monitoring SET status=$2, report_received=$3 WHERE id=$1 AND study_id=$4`,
    [String(formData.get("monitoringId") || ""), String(formData.get("status") || "open"), formData.get("reportReceived") === "1", sid]);
  await writeAudit({ orgId, userId, action: "update", entity: "study_monitoring", entityId: sid });
  redirect(`/studies/${sid}?saved=monitoring`);
}

/* ===================== Lab: participant & visit management ===================== */
async function loadParticipantOrg(orgId: string, participantId: string) {
  const p = await one<{ id: string }>(`SELECT id FROM lab_participant WHERE id=$1 AND org_id=$2`, [participantId, orgId]);
  if (!p) redirect("/lab/participants");
  return p;
}

export async function addParticipantVisitAction(formData: FormData) {
  const { orgId, userId } = await requireLabActor();
  const pid = String(formData.get("participantId") || "");
  await loadParticipantOrg(orgId, pid);
  const labelV = String(formData.get("label") || "").trim();
  if (!labelV) redirect(`/lab/participants/${pid}?err=label`);
  const ex = await one<{ id: string }>(`SELECT id FROM lab_visit WHERE participant_id=$1 AND LOWER(label)=LOWER($2)`, [pid, labelV]);
  if (ex) redirect(`/lab/participants/${pid}?err=dupvisit`);
  await q(`INSERT INTO lab_visit (id, org_id, participant_id, label, visit_date, sequence, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id("lvis"), orgId, pid, labelV, sNull(formData.get("visitDate")), sNum(formData.get("sequence")), sNull(formData.get("notes"))]);
  await writeAudit({ orgId, userId, action: "create", entity: "lab_visit", entityId: pid, after: { label: labelV } });
  redirect(`/lab/participants/${pid}?added=visit`);
}

export async function updateParticipantVisitAction(formData: FormData) {
  const { orgId, userId } = await requireLabActor();
  const pid = String(formData.get("participantId") || "");
  await loadParticipantOrg(orgId, pid);
  await q(`UPDATE lab_visit SET visit_date=$2, sequence=$3, notes=$4 WHERE id=$1 AND participant_id=$5`,
    [String(formData.get("visitId") || ""), sNull(formData.get("visitDate")), sNum(formData.get("sequence")), sNull(formData.get("notes")), pid]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_visit", entityId: pid });
  redirect(`/lab/participants/${pid}?saved=visit`);
}

export async function deleteParticipantVisitAction(formData: FormData) {
  const { orgId, userId } = await requireLabActor();
  const pid = String(formData.get("participantId") || "");
  await loadParticipantOrg(orgId, pid);
  // samples keep their record; their visit link is cleared by the FK (ON DELETE SET NULL)
  await q(`DELETE FROM lab_visit WHERE id=$1 AND participant_id=$2`, [String(formData.get("visitId") || ""), pid]);
  await writeAudit({ orgId, userId, action: "delete", entity: "lab_visit", entityId: pid });
  redirect(`/lab/participants/${pid}?removed=visit`);
}

export async function updateParticipantAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const pid = String(formData.get("participantId") || "");
  await loadParticipantOrg(orgId, pid);
  if (!(isOrgAdmin || isSuperAdmin)) redirect(`/lab/participants/${pid}?err=forbidden`);
  await q(`UPDATE lab_participant SET name=$2, date_of_birth=$3, sex=$4, enrollment_date=COALESCE($5, enrollment_date) WHERE id=$1 AND org_id=$6`,
    [pid, sNull(formData.get("name")), sNull(formData.get("dob")), sNull(formData.get("sex")), sNull(formData.get("enrollmentDate")), orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_participant", entityId: pid });
  redirect(`/lab/participants/${pid}?saved=info`);
}

export async function updateParticipantConsentAction(formData: FormData) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabActor();
  const pid = String(formData.get("participantId") || "");
  await loadParticipantOrg(orgId, pid);
  if (!(isOrgAdmin || isSuperAdmin)) redirect(`/lab/participants/${pid}?err=forbidden`);
  const status = String(formData.get("consentStatus") || "valid");
  await q(`UPDATE lab_participant SET consent_status=$2, withdrawal_date=CASE WHEN $2='withdrawn' THEN CURRENT_DATE ELSE withdrawal_date END WHERE id=$1 AND org_id=$3`, [pid, status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "lab_participant", entityId: pid, after: { consentStatus: status } });
  redirect(`/lab/participants/${pid}?saved=consent`);
}

/* ===================== Report sections: manual edits + finalize ===================== */
async function loadReportForProject(projectId: string, reportId: string) {
  const r = await one<{ id: string; status: string }>(`SELECT id, status FROM report WHERE id=$1 AND project_id=$2`, [reportId, projectId]);
  if (!r) redirect(`/projects/${projectId}/reports`);
  return r;
}

export async function updateReportSectionAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const reportId = String(formData.get("reportId"));
  await loadReportForProject(projectId, reportId);
  const sectionId = String(formData.get("sectionId"));
  await q(`UPDATE report_section SET title=$2, content=$3 WHERE id=$1 AND report_id=$4`,
    [sectionId, String(formData.get("title") || "Section"), String(formData.get("content") || ""), reportId]);
  revalidatePath(`/projects/${projectId}/reports`);
  redirect(`/projects/${projectId}/reports?r=${reportId}&edited=1`);
}

export async function addReportSectionAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const reportId = String(formData.get("reportId"));
  await loadReportForProject(projectId, reportId);
  const maxOrder = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),-1)::int m FROM report_section WHERE report_id=$1`, [reportId]))?.m ?? -1;
  await q(`INSERT INTO report_section (id, report_id, key, title, content, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("rsec"), reportId, "custom", String(formData.get("title") || "New section"), String(formData.get("content") || ""), maxOrder + 1]);
  redirect(`/projects/${projectId}/reports?r=${reportId}&added=1`);
}

export async function deleteReportSectionAction(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const reportId = String(formData.get("reportId"));
  await loadReportForProject(projectId, reportId);
  await q(`DELETE FROM report_section WHERE id=$1 AND report_id=$2`, [String(formData.get("sectionId")), reportId]);
  redirect(`/projects/${projectId}/reports?r=${reportId}&removed=1`);
}

export async function finalizeReportAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "reports.manage");
  const reportId = String(formData.get("reportId"));
  const r = await loadReportForProject(projectId, reportId);
  const next = r.status === "final" ? "draft" : "final";
  await q(`UPDATE report SET status=$2 WHERE id=$1 AND project_id=$3`, [reportId, next, projectId]);
  const orgId = (await one<{ o: string }>(`SELECT org_id o FROM project WHERE id=$1`, [projectId]))?.o;
  await writeAudit({ orgId, userId: user.id, action: next === "final" ? "finalize" : "reopen", entity: "report", entityId: reportId });
  redirect(`/projects/${projectId}/reports?r=${reportId}&${next === "final" ? "finalized" : "reopened"}=1`);
}

/* ===================== Inventory: bulk import from spreadsheet ===================== */
export async function importInventoryUploadAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInventoryActor();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/inventory/import?err=nofile");
  const buf = Buffer.from(await file.arrayBuffer());
  const { rows } = await extractFile(file.name, buf);
  if (!rows || rows.length === 0) redirect("/inventory/import?err=parse");
  // Drop fully-blank rows; the first remaining row is treated as the header.
  const nonEmpty = rows.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length < 2) redirect("/inventory/import?err=empty");
  const header = nonEmpty[0];
  const dataRows = nonEmpty.slice(1);
  const impId = await createInventoryImport(orgId, { id: userId, name: userName }, file.name, header, dataRows);
  await writeAudit({ orgId, userId, action: "upload", entity: "inventory_import", entityId: impId, after: { fileName: file.name, rows: dataRows.length } });
  redirect(`/inventory/import?job=${impId}`);
}

export async function confirmInventoryImportAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInventoryActor();
  const importId = String(formData.get("importId") || "");
  const mapping = {} as Record<ImportFieldKey, number>;
  for (const f of INVENTORY_IMPORT_FIELDS) {
    const v = parseInt(String(formData.get(`map_${f.key}`) ?? "-1"), 10);
    mapping[f.key] = Number.isFinite(v) ? v : -1;
  }
  if (mapping.name == null || mapping.name < 0) redirect(`/inventory/import?job=${importId}&err=name`);
  const res = await applyInventoryImport(orgId, { id: userId, name: userName }, importId, mapping);
  await writeAudit({ orgId, userId, action: "import", entity: "inventory_import", entityId: importId, after: { created: res.created, skipped: res.skipped } });
  redirect(`/inventory?imported=${res.created}${res.skipped ? `&skipped=${res.skipped}` : ""}`);
}

export async function cancelInventoryImportAction(formData: FormData) {
  const { orgId } = await requireInventoryActor();
  await cancelInventoryImport(orgId, String(formData.get("importId") || ""));
  redirect("/inventory/import?cancelled=1");
}

/* ===================== Generic register import (vendors, contracts) ===================== */
// Vendors are gated to org-admin finance; contracts additionally require the public
// procurement module (same guards as manually creating each).
async function requireImportActor(entity: string) {
  if (entity === "contract") return requireProcGovActor();
  return requireInstitutionFinance();
}

export async function importRegisterUploadAction(formData: FormData) {
  const entity = String(formData.get("entity") || "");
  if (!importEntity(entity)) redirect("/procurement");
  const { orgId, userId, userName } = await requireImportActor(entity);
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect(`/procurement/import/${entity}?err=nofile`);
  const buf = Buffer.from(await file.arrayBuffer());
  const { rows } = await extractFile(file.name, buf);
  if (!rows || rows.length === 0) redirect(`/procurement/import/${entity}?err=parse`);
  const nonEmpty = rows.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (nonEmpty.length < 2) redirect(`/procurement/import/${entity}?err=empty`);
  const jobId = await createImport(orgId, { id: userId, name: userName }, entity, file.name, nonEmpty[0], nonEmpty.slice(1));
  await writeAudit({ orgId, userId, action: "upload", entity: "import_job", entityId: jobId, after: { entity, fileName: file.name, rows: nonEmpty.length - 1 } });
  redirect(`/procurement/import/${entity}?job=${jobId}`);
}

export async function confirmRegisterImportAction(formData: FormData) {
  const entity = String(formData.get("entity") || "");
  const spec = importEntity(entity);
  if (!spec) redirect("/procurement");
  const { orgId, userId, userName } = await requireImportActor(entity);
  const jobId = String(formData.get("importId") || "");
  const mapping: Record<string, number> = {};
  for (const f of spec!.fields) {
    const n = parseInt(String(formData.get(`map_${f.key}`) ?? "-1"), 10);
    mapping[f.key] = Number.isFinite(n) ? n : -1;
  }
  const requiredKey = spec!.fields.find((f) => f.required)?.key;
  if (requiredKey && (mapping[requiredKey] == null || mapping[requiredKey] < 0)) redirect(`/procurement/import/${entity}?job=${jobId}&err=required`);
  const res = await applyImport(orgId, { id: userId, name: userName }, jobId, mapping);
  await writeAudit({ orgId, userId, action: "import", entity: "import_job", entityId: jobId, after: { entity, created: res.created, skipped: res.skipped } });
  redirect(`${spec!.redirectTo}?imported=${res.created}${res.skipped ? `&skipped=${res.skipped}` : ""}`);
}

export async function cancelRegisterImportAction(formData: FormData) {
  const entity = String(formData.get("entity") || "");
  if (!importEntity(entity)) redirect("/procurement");
  const { orgId } = await requireImportActor(entity);
  await cancelImport(orgId, String(formData.get("importId") || ""));
  redirect(`/procurement/import/${entity}?cancelled=1`);
}

/* ===================== Recruitment / ATS ===================== */
// employment_type (opening) -> contract_type (employee) when a candidate is hired.
const EMP_TO_CONTRACT: Record<string, string> = {
  full_time: "permanent", part_time: "permanent", fixed_term: "fixed_term",
  contract: "fixed_term", internship: "intern", consultant: "consultant",
};
const _rstr = (fd: FormData, k: string) => (String(fd.get(k) ?? "").trim() || null);
const _rnum = (fd: FormData, k: string) => { const v = parseFloat(String(fd.get(k) ?? "")); return Number.isFinite(v) ? v : null; };

export async function createJobOpeningAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect("/hr/recruitment?err=title");
  const deptNameInput = String(formData.get("departmentName") || "").trim();
  let deptId: string | null = String(formData.get("departmentId") || "") || null;
  let deptName: string | null = null;
  if (deptNameInput) { const dep = await ensureDepartment(orgId, deptNameInput); if (dep) { deptId = dep.id; deptName = dep.name; } }
  else if (deptId) { deptName = (await one<{ name: string }>(`SELECT name FROM department WHERE id=$1`, [deptId]))?.name ?? null; }
  const oid = id("job");
  await q(`INSERT INTO job_opening (id, org_id, reference, title, department_id, department, project_id, employment_type, location, positions,
             description, responsibilities, requirements, salary_min, salary_max, currency, hiring_manager, status, opened_date, closing_date, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19, CURRENT_DATE),$20,$21,$22)`,
    [oid, orgId, _rstr(formData, "reference"), title, deptId, deptName, _rstr(formData, "projectId"),
     String(formData.get("employmentType") || "full_time"), _rstr(formData, "location"), parseInt(String(formData.get("positions") || "1"), 10) || 1,
     _rstr(formData, "description"), _rstr(formData, "responsibilities"), _rstr(formData, "requirements"),
     _rnum(formData, "salaryMin"), _rnum(formData, "salaryMax"), _rstr(formData, "currency"), _rstr(formData, "hiringManager"),
     "open", _rstr(formData, "openedDate"), _rstr(formData, "closingDate"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "job_opening", entityId: oid, after: { title } });
  redirect(`/hr/recruitment/${oid}`);
}

export async function updateJobOpeningAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const oid = String(formData.get("openingId") || "");
  await q(`UPDATE job_opening SET title=$2, employment_type=$3, location=$4, positions=$5, description=$6, responsibilities=$7,
             requirements=$8, salary_min=$9, salary_max=$10, currency=$11, hiring_manager=$12, closing_date=$13
           WHERE id=$1 AND org_id=$14`,
    [oid, String(formData.get("title") || "").trim() || "Untitled", String(formData.get("employmentType") || "full_time"),
     _rstr(formData, "location"), parseInt(String(formData.get("positions") || "1"), 10) || 1, _rstr(formData, "description"),
     _rstr(formData, "responsibilities"), _rstr(formData, "requirements"), _rnum(formData, "salaryMin"), _rnum(formData, "salaryMax"),
     _rstr(formData, "currency"), _rstr(formData, "hiringManager"), _rstr(formData, "closingDate"), orgId]);
  redirect(`/hr/recruitment/${oid}?saved=1`);
}

export async function setOpeningStatusAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const oid = String(formData.get("openingId") || "");
  const status = String(formData.get("status") || "open");
  await q(`UPDATE job_opening SET status=$2 WHERE id=$1 AND org_id=$3`, [oid, status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "job_opening", entityId: oid, after: { status } });
  redirect(`/hr/recruitment/${oid}`);
}

export async function addCandidateApplicationAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const oid = String(formData.get("openingId") || "");
  const name = String(formData.get("fullName") || "").trim();
  if (!name) redirect(`/hr/recruitment/${oid}?err=cand`);
  const candId = id("cand");
  let cvKey: string | null = null, cvName: string | null = null;
  const file = formData.get("cv") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); cvName = file.name; cvKey = await saveUpload(candId, file.name, buf); }
  await q(`INSERT INTO candidate (id, org_id, full_name, email, phone, gender, location, current_title, current_employer, highest_qualification, years_experience, source, cv_key, cv_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [candId, orgId, name, _rstr(formData, "email"), _rstr(formData, "phone"), _rstr(formData, "gender"), _rstr(formData, "location"),
     _rstr(formData, "currentTitle"), _rstr(formData, "currentEmployer"), _rstr(formData, "highestQualification"),
     _rnum(formData, "yearsExperience"), _rstr(formData, "source"), cvKey, cvName]);
  const appId = id("app");
  await q(`INSERT INTO job_application (id, org_id, opening_id, candidate_id, stage, applied_date, cover_note, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,'applied',CURRENT_DATE,$5,$6,$7)`,
    [appId, orgId, oid, candId, _rstr(formData, "coverNote"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "job_application", entityId: appId, after: { candidate: name, opening: oid } });
  redirect(`/hr/recruitment/${oid}?added=1`);
}

export async function moveApplicationStageAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  const stage = String(formData.get("stage") || "applied");
  await q(`UPDATE job_application SET stage=$2, rejection_reason=NULL, rejected_stage=NULL WHERE id=$1 AND org_id=$3`, [appId, stage, orgId]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function rejectApplicationAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  const cur = (await one<{ stage: string }>(`SELECT stage FROM job_application WHERE id=$1 AND org_id=$2`, [appId, orgId]))?.stage ?? null;
  await q(`UPDATE job_application SET stage='rejected', rejection_reason=$2, rejected_stage=$3 WHERE id=$1 AND org_id=$4`,
    [appId, _rstr(formData, "reason"), cur, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "job_application", entityId: appId, after: { stage: "rejected" } });
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function withdrawApplicationAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  await q(`UPDATE job_application SET stage='withdrawn' WHERE id=$1 AND org_id=$2`, [appId, orgId]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function scheduleInterviewAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  const iid = id("intv");
  await q(`INSERT INTO interview (id, org_id, application_id, round, kind, mode, scheduled_at, location, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9)`,
    [iid, orgId, appId, parseInt(String(formData.get("round") || "1"), 10) || 1, String(formData.get("kind") || "panel"),
     String(formData.get("mode") || "in_person"), _rstr(formData, "scheduledAt"), _rstr(formData, "location"), _rstr(formData, "notes")]);
  // advance the pipeline to interview if it is still earlier
  await q(`UPDATE job_application SET stage='interview' WHERE id=$1 AND org_id=$2 AND stage IN ('applied','screening','shortlisted')`, [appId, orgId]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function setInterviewStatusAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const iid = String(formData.get("interviewId") || "");
  const appId = String(formData.get("applicationId") || "");
  await q(`UPDATE interview SET status=$2 WHERE id=$1 AND org_id=$3`, [iid, String(formData.get("status") || "completed"), orgId]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function addInterviewScoreAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const iid = String(formData.get("interviewId") || "");
  const appId = String(formData.get("applicationId") || "");
  const panelist = String(formData.get("panelist") || "").trim();
  if (!panelist) redirect(`/hr/recruitment/application/${appId}?err=panelist`);
  await q(`INSERT INTO interview_score (id, org_id, interview_id, panelist, technical, experience, communication, motivation, recommendation, coi_declared, comments)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id("isc"), orgId, iid, panelist, _rnum(formData, "technical"), _rnum(formData, "experience"), _rnum(formData, "communication"),
     _rnum(formData, "motivation"), _rstr(formData, "recommendation"), formData.get("coiDeclared") === "on", _rstr(formData, "comments")]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function createOfferAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  const send = formData.get("send") === "1";
  await q(`INSERT INTO job_offer (id, org_id, application_id, salary, currency, employment_type, start_date, status, offer_date, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE,$9)`,
    [id("offer"), orgId, appId, _rnum(formData, "salary"), _rstr(formData, "currency"), _rstr(formData, "employmentType"),
     _rstr(formData, "startDate"), send ? "sent" : "draft", _rstr(formData, "notes")]);
  await q(`UPDATE job_application SET stage='offer' WHERE id=$1 AND org_id=$2 AND stage NOT IN ('hired','rejected','withdrawn')`, [appId, orgId]);
  await writeAudit({ orgId, userId, action: "create", entity: "job_offer", entityId: appId, after: { status: send ? "sent" : "draft" } });
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function setOfferStatusAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const offerId = String(formData.get("offerId") || "");
  const appId = String(formData.get("applicationId") || "");
  const status = String(formData.get("status") || "sent");
  await q(`UPDATE job_offer SET status=$2, response_date=CASE WHEN $2 IN ('accepted','declined') THEN CURRENT_DATE ELSE response_date END WHERE id=$1 AND org_id=$3`,
    [offerId, status, orgId]);
  redirect(`/hr/recruitment/application/${appId}`);
}

export async function hireApplicantAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const appId = String(formData.get("applicationId") || "");
  const app = await one<{ candidateId: string; openingId: string; fullName: string; email: string | null; phone: string | null;
    title: string; deptId: string | null; deptName: string | null; empType: string; offerSalary: number | null; offerCcy: string | null; offerStart: string | null }>(
    `SELECT a.candidate_id AS "candidateId", a.opening_id AS "openingId", c.full_name AS "fullName", c.email, c.phone,
            o.title, o.department_id AS "deptId", o.department AS "deptName", o.employment_type AS "empType",
            (SELECT salary::float8 FROM job_offer jo WHERE jo.application_id=a.id ORDER BY created_at DESC LIMIT 1) AS "offerSalary",
            (SELECT currency FROM job_offer jo WHERE jo.application_id=a.id ORDER BY created_at DESC LIMIT 1) AS "offerCcy",
            (SELECT start_date::text FROM job_offer jo WHERE jo.application_id=a.id ORDER BY created_at DESC LIMIT 1) AS "offerStart"
     FROM job_application a JOIN candidate c ON c.id=a.candidate_id JOIN job_opening o ON o.id=a.opening_id
     WHERE a.id=$1 AND a.org_id=$2`, [appId, orgId]);
  if (!app) redirect("/hr/recruitment");
  const parts = app.fullName.split(/\s+/);
  const first = parts[0]; const last = parts.slice(1).join(" ") || first;
  const eid = id("emp");
  await q(`INSERT INTO employee (id, org_id, first_name, last_name, email, phone, job_title, department, department_id, contract_type, start_date, basic_salary, currency, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')`,
    [eid, orgId, first, last, app.email, app.phone, app.title, app.deptName, app.deptId,
     EMP_TO_CONTRACT[app.empType] ?? "permanent", app.offerStart, app.offerSalary ?? 0, app.offerCcy ?? "USD"]);
  await q(`UPDATE job_application SET stage='hired', hired_employee_id=$2 WHERE id=$1 AND org_id=$3`, [appId, eid, orgId]);
  if (formData.get("fillOpening") === "on") await q(`UPDATE job_opening SET status='filled' WHERE id=$1 AND org_id=$2`, [app.openingId, orgId]);
  await writeAudit({ orgId, userId, action: "create", entity: "employee", entityId: eid, after: { from: "recruitment", application: appId, name: app.fullName } });
  redirect(`/hr/employees/${eid}?hired=1`);
}

/* ===================== Performance Appraisals ===================== */
export async function createCycleAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/hr/appraisals?err=name");
  const cid = id("cyc");
  await q(`INSERT INTO appraisal_cycle (id, org_id, name, kind, period_start, period_end, due_date, rating_max, status, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)`,
    [cid, orgId, name, String(formData.get("kind") || "annual"), _rstr(formData, "periodStart"), _rstr(formData, "periodEnd"),
     _rstr(formData, "dueDate"), parseInt(String(formData.get("ratingMax") || "5"), 10) || 5, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "appraisal_cycle", entityId: cid, after: { name } });
  redirect(`/hr/appraisals/${cid}`);
}

export async function setCycleStatusAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const cid = String(formData.get("cycleId") || "");
  await q(`UPDATE appraisal_cycle SET status=$2 WHERE id=$1 AND org_id=$3`, [cid, String(formData.get("status") || "open"), orgId]);
  redirect(`/hr/appraisals/${cid}`);
}

export async function createAppraisalAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const cid = String(formData.get("cycleId") || "");
  const empId = String(formData.get("employeeId") || "");
  if (!empId) redirect(`/hr/appraisals/${cid}?err=emp`);
  const existing = await one<{ id: string }>(`SELECT id FROM appraisal WHERE cycle_id=$1 AND employee_id=$2`, [cid, empId]);
  if (existing) redirect(`/hr/appraisals/record/${existing.id}`);
  const aid = id("appr");
  await q(`INSERT INTO appraisal (id, org_id, cycle_id, employee_id, appraiser_employee_id, appraiser_name, status)
           VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
    [aid, orgId, cid, empId, _rstr(formData, "appraiserEmployeeId"), _rstr(formData, "appraiserName")]);
  await writeAudit({ orgId, userId, action: "create", entity: "appraisal", entityId: aid, after: { employee: empId, cycle: cid } });
  redirect(`/hr/appraisals/record/${aid}`);
}

export async function addAppraisalItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const aid = String(formData.get("appraisalId") || "");
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect(`/hr/appraisals/record/${aid}?err=item`);
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM appraisal_item WHERE appraisal_id=$1`, [aid]))?.c ?? 0;
  await q(`INSERT INTO appraisal_item (id, org_id, appraisal_id, kind, title, description, weight, target, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("ai"), orgId, aid, String(formData.get("kind") || "objective"), title, _rstr(formData, "description"),
     _rnum(formData, "weight"), _rstr(formData, "target"), n]);
  redirect(`/hr/appraisals/record/${aid}`);
}

export async function updateAppraisalItemAction(formData: FormData) {
  const aid = String(formData.get("appraisalId") || "");
  const acc = await appraisalAccess(aid);
  const itemId = String(formData.get("itemId") || "");
  if (acc.isOrgAdmin || acc.isAppraiser)
    await q(`UPDATE appraisal_item SET manager_rating=$2, manager_comment=$3, result=$4 WHERE id=$1 AND appraisal_id=$5`,
      [itemId, _rnum(formData, "managerRating"), _rstr(formData, "managerComment"), _rstr(formData, "result"), aid]);
  if (acc.isAppraisee || acc.isOrgAdmin)
    await q(`UPDATE appraisal_item SET self_rating=$2, self_comment=$3 WHERE id=$1 AND appraisal_id=$4`,
      [itemId, _rnum(formData, "selfRating"), _rstr(formData, "selfComment"), aid]);
  redirect(apprReturn(formData, aid));
}

export async function deleteAppraisalItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const itemId = String(formData.get("itemId") || "");
  const aid = String(formData.get("appraisalId") || "");
  await q(`DELETE FROM appraisal_item WHERE id=$1 AND org_id=$2`, [itemId, orgId]);
  redirect(`/hr/appraisals/record/${aid}`);
}

export async function saveAppraisalReviewAction(formData: FormData) {
  const aid = String(formData.get("appraisalId") || "");
  const acc = await appraisalAccess(aid);
  if (acc.isOrgAdmin || acc.isAppraiser)
    await q(`UPDATE appraisal SET manager_comments=$2, development_plan=$3, overall_rating=$4 WHERE id=$1 AND org_id=$5`,
      [aid, _rstr(formData, "managerComments"), _rstr(formData, "developmentPlan"), _rnum(formData, "overallRating"), acc.orgId]);
  if (acc.isOrgAdmin)
    await q(`UPDATE appraisal SET hr_comments=$2 WHERE id=$1 AND org_id=$3`, [aid, _rstr(formData, "hrComments"), acc.orgId]);
  if (acc.isAppraisee || acc.isOrgAdmin)
    await q(`UPDATE appraisal SET employee_comments=$2 WHERE id=$1 AND org_id=$3`, [aid, _rstr(formData, "employeeComments"), acc.orgId]);
  redirect(apprReturn(formData, aid) + "?saved=1");
}

// Relationship-aware access for appraisal forms: HR (org admin), the appraiser, or the appraisee.
async function appraisalAccess(appraisalId: string) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const a = await one<{ orgId: string; employeeId: string; appraiserId: string | null }>(
    `SELECT org_id AS "orgId", employee_id AS "employeeId", appraiser_employee_id AS "appraiserId" FROM appraisal WHERE id=$1`, [appraisalId]);
  if (!a || a.orgId !== org.id) redirect("/dashboard");
  const myEmp = await employeeForUser(user.id);
  const isOrgAdmin = !!org.isOrgAdmin || !!user.isSuperAdmin;
  const isAppraisee = !!myEmp && myEmp.id === a.employeeId;
  const isAppraiser = !!myEmp && !!a.appraiserId && myEmp.id === a.appraiserId;
  if (!isOrgAdmin && !isAppraisee && !isAppraiser) redirect("/dashboard");
  return { user, orgId: org.id, userName: user.name, isOrgAdmin, isAppraisee, isAppraiser };
}
function apprReturn(formData: FormData, aid: string): string {
  return String(formData.get("returnTo") || "") === "portal" ? `/portal/appraisals/${aid}` : `/hr/appraisals/record/${aid}`;
}

export async function signAppraisalAction(formData: FormData) {
  const aid = String(formData.get("appraisalId") || "");
  const role = String(formData.get("role") || "");
  const acc = await appraisalAccess(aid);
  const ok = (role === "employee" && (acc.isAppraisee || acc.isOrgAdmin))
    || (role === "appraiser" && (acc.isAppraiser || acc.isOrgAdmin))
    || (role === "hr" && acc.isOrgAdmin);
  if (!ok) redirect(apprReturn(formData, aid));
  const sig = await one<{ dataUrl: string | null }>(`SELECT data_url AS "dataUrl" FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [acc.user.id]);
  if (!sig?.dataUrl) redirect(apprReturn(formData, aid) + "?err=nosig");
  const col = role === "appraiser" ? "appraiser" : role === "hr" ? "hr" : "employee";
  await q(`UPDATE appraisal SET ${col}_signature=$2, ${col}_signed_at=now(), ${col}_signed_name=$3 WHERE id=$1 AND org_id=$4`,
    [aid, sig.dataUrl, acc.userName, acc.orgId]);
  await writeAudit({ orgId: acc.orgId, userId: acc.user.id, action: "sign", entity: "appraisal", entityId: aid, after: { role } });
  redirect(apprReturn(formData, aid) + "?signed=1");
}

export async function archiveAppraisalAction(formData: FormData) {
  const aid = String(formData.get("appraisalId") || "");
  const acc = await appraisalAccess(aid);
  if (!acc.isOrgAdmin && !acc.isAppraiser) redirect(apprReturn(formData, aid));
  const archived = formData.get("archived") === "1";
  await q(`UPDATE appraisal SET archived=$2 WHERE id=$1 AND org_id=$3`, [aid, archived, acc.orgId]);
  await writeAudit({ orgId: acc.orgId, userId: acc.user.id, action: archived ? "archive" : "unarchive", entity: "appraisal", entityId: aid });
  redirect(apprReturn(formData, aid));
}

export async function deleteAppraisalAction(formData: FormData) {
  const aid = String(formData.get("appraisalId") || "");
  const acc = await appraisalAccess(aid);
  if (!acc.isOrgAdmin && !acc.isAppraiser) redirect(apprReturn(formData, aid));
  const cycleId = String(formData.get("cycleId") || "");
  await q(`DELETE FROM appraisal WHERE id=$1 AND org_id=$2`, [aid, acc.orgId]);
  await writeAudit({ orgId: acc.orgId, userId: acc.user.id, action: "delete", entity: "appraisal", entityId: aid });
  redirect(String(formData.get("returnTo") || "") === "portal" ? "/portal/appraisals" : (cycleId ? `/hr/appraisals/${cycleId}` : "/hr/appraisals"));
}

export async function setAppraisalStatusAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("appraisalId") || "");
  const status = String(formData.get("status") || "draft");
  await q(`UPDATE appraisal SET status=$2,
             overall_rating = CASE WHEN $2='completed' AND overall_rating IS NULL
               THEN (SELECT ROUND(AVG(manager_rating),1) FROM appraisal_item WHERE appraisal_id=$1) ELSE overall_rating END
           WHERE id=$1 AND org_id=$3`, [aid, status, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "appraisal", entityId: aid, after: { status } });
  redirect(`/hr/appraisals/record/${aid}`);
}

export async function acknowledgeAppraisalAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("appraisalId") || "");
  await q(`UPDATE appraisal SET status='acknowledged', acknowledged_at=now() WHERE id=$1 AND org_id=$2`, [aid, orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "appraisal", entityId: aid, after: { status: "acknowledged" } });
  redirect(`/hr/appraisals/record/${aid}`);
}

/* ===================== Employee Relations (Grievance & Disciplinary) ===================== */
export async function createCaseAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const type = String(formData.get("type") || "grievance");
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect("/hr/relations?err=title");
  // case_no: GRV-YYYY-NNN / DSC-YYYY-NNN
  const prefix = type === "grievance" ? "GRV" : "DSC";
  const year = new Date().getFullYear();
  const seq = ((await one<{ c: number }>(`SELECT COUNT(*)::int c FROM er_case WHERE org_id=$1 AND type=$2 AND EXTRACT(YEAR FROM created_at)=$3`, [orgId, type, year]))?.c ?? 0) + 1;
  const caseNo = `${prefix}-${year}-${String(seq).padStart(3, "0")}`;
  const cid = id("erc");
  await q(`INSERT INTO er_case (id, org_id, case_no, type, employee_id, counterparty, category, title, description, severity, confidential, status, assigned_to, opened_date, due_date, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,CURRENT_DATE,$13,$14,$15)`,
    [cid, orgId, caseNo, type, _rstr(formData, "employeeId"), _rstr(formData, "counterparty"), _rstr(formData, "category"),
     title, _rstr(formData, "description"), String(formData.get("severity") || "medium"), formData.get("confidential") === "on",
     _rstr(formData, "assignedTo"), _rstr(formData, "dueDate"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "er_case", entityId: cid, after: { caseNo, type, title } });
  redirect(`/hr/relations/${cid}`);
}

export async function setCaseStatusAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const cid = String(formData.get("caseId") || "");
  const status = String(formData.get("status") || "open");
  await q(`UPDATE er_case SET status=$2 WHERE id=$1 AND org_id=$3`, [cid, status, orgId]);
  await q(`INSERT INTO er_case_event (id, org_id, case_id, kind, summary, event_date, author) VALUES ($1,$2,$3,'status_change',$4,CURRENT_DATE,$5)`,
    [id("erce"), orgId, cid, `Stage changed to ${status.replace(/_/g, " ")}`, userName]);
  await writeAudit({ orgId, userId, action: "update", entity: "er_case", entityId: cid, after: { status } });
  redirect(`/hr/relations/${cid}`);
}

export async function recordCaseOutcomeAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const cid = String(formData.get("caseId") || "");
  const outcome = String(formData.get("outcome") || "");
  await q(`UPDATE er_case SET outcome=$2, outcome_notes=$3, status='closed', closed_date=CURRENT_DATE WHERE id=$1 AND org_id=$4`,
    [cid, outcome || null, _rstr(formData, "outcomeNotes"), orgId]);
  await q(`INSERT INTO er_case_event (id, org_id, case_id, kind, summary, detail, event_date, author) VALUES ($1,$2,$3,'decision',$4,$5,CURRENT_DATE,$6)`,
    [id("erce"), orgId, cid, `Outcome: ${outcome.replace(/_/g, " ")}`, _rstr(formData, "outcomeNotes"), userName]);
  await writeAudit({ orgId, userId, action: "update", entity: "er_case", entityId: cid, after: { outcome, status: "closed" } });
  redirect(`/hr/relations/${cid}`);
}

export async function addCaseEventAction(formData: FormData) {
  const { orgId, userName } = await requireInstitutionFinance();
  const cid = String(formData.get("caseId") || "");
  const summary = String(formData.get("summary") || "").trim();
  if (!summary) redirect(`/hr/relations/${cid}?err=event`);
  const evId = id("erce");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(evId, file.name, buf); }
  await q(`INSERT INTO er_case_event (id, org_id, case_id, kind, summary, detail, event_date, author, file_key, file_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [evId, orgId, cid, String(formData.get("kind") || "note"), summary, _rstr(formData, "detail"),
     _rstr(formData, "eventDate") ?? new Date().toISOString().slice(0, 10), String(formData.get("author") || userName), fileKey, fileName]);
  redirect(`/hr/relations/${cid}`);
}

/* ===================== Onboarding / Exit Checklists ===================== */
export async function createChecklistTemplateAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/hr/checklists?err=name");
  const tid = id("clt");
  await q(`INSERT INTO checklist_template (id, org_id, type, name, description, created_by_id, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tid, orgId, String(formData.get("type") || "onboarding"), name, _rstr(formData, "description"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "checklist_template", entityId: tid, after: { name } });
  redirect(`/hr/checklists/template/${tid}`);
}
export async function addTemplateItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const tid = String(formData.get("templateId") || "");
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect(`/hr/checklists/template/${tid}?err=title`);
  const so = (await one<{ m: number }>(`SELECT COALESCE(MAX(sort_order),0)+1 m FROM checklist_template_item WHERE template_id=$1`, [tid]))?.m ?? 1;
  await q(`INSERT INTO checklist_template_item (id, org_id, template_id, category, title, description, assignee_role, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("clti"), orgId, tid, _rstr(formData, "category"), title, _rstr(formData, "description"), _rstr(formData, "assigneeRole"), so]);
  redirect(`/hr/checklists/template/${tid}`);
}
export async function deleteTemplateItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const tid = String(formData.get("templateId") || "");
  await q(`DELETE FROM checklist_template_item WHERE id=$1 AND org_id=$2`, [String(formData.get("itemId") || ""), orgId]);
  redirect(`/hr/checklists/template/${tid}`);
}
export async function deleteChecklistTemplateAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  await q(`DELETE FROM checklist_template WHERE id=$1 AND org_id=$2`, [String(formData.get("templateId") || ""), orgId]);
  redirect(`/hr/checklists`);
}

export async function startChecklistAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const templateId = String(formData.get("templateId") || "");
  const employeeId = String(formData.get("employeeId") || "") || null;
  const tpl = await one<{ name: string; type: string }>(`SELECT name, type FROM checklist_template WHERE id=$1 AND org_id=$2`, [templateId, orgId]);
  if (!tpl) redirect("/hr/checklists?err=tpl");
  const emp = employeeId ? await one<{ n: string }>(`SELECT (first_name || ' ' || last_name) n FROM employee WHERE id=$1`, [employeeId]) : null;
  const instId = id("cli");
  await q(`INSERT INTO checklist_instance (id, org_id, employee_id, template_id, type, title, started_date, due_date, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9)`,
    [instId, orgId, employeeId, templateId, tpl.type, `${tpl.name}${emp ? ` — ${emp.n}` : ""}`, _rstr(formData, "dueDate"), userId, userName]);
  const items = await q<{ category: string | null; title: string; description: string | null; assigneeRole: string | null }>(
    `SELECT category, title, description, assignee_role AS "assigneeRole" FROM checklist_template_item WHERE template_id=$1 AND org_id=$2 ORDER BY sort_order, created_at`, [templateId, orgId]);
  let i = 0;
  for (const it of items) {
    await q(`INSERT INTO checklist_instance_item (id, org_id, instance_id, category, title, description, assignee, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id("cii"), orgId, instId, it.category, it.title, it.description, it.assigneeRole, i++]);
  }
  await writeAudit({ orgId, userId, action: "create", entity: "checklist_instance", entityId: instId, after: { template: tpl.name, items: items.length } });
  redirect(`/hr/checklists/${instId}`);
}

export async function addInstanceItemAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const instId = String(formData.get("instanceId") || "");
  const title = String(formData.get("title") || "").trim();
  if (!title) redirect(`/hr/checklists/${instId}?err=title`);
  const so = (await one<{ m: number }>(`SELECT COALESCE(MAX(sort_order),0)+1 m FROM checklist_instance_item WHERE instance_id=$1`, [instId]))?.m ?? 1;
  await q(`INSERT INTO checklist_instance_item (id, org_id, instance_id, category, title, assignee, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("cii"), orgId, instId, _rstr(formData, "category"), title, _rstr(formData, "assignee"), _rstr(formData, "dueDate"), so]);
  redirect(`/hr/checklists/${instId}`);
}

// Relationship-aware: HR (org admin) or the employee whose checklist it is.
async function checklistAccess(instanceId: string) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const c = await one<{ orgId: string; employeeId: string | null }>(`SELECT org_id AS "orgId", employee_id AS "employeeId" FROM checklist_instance WHERE id=$1`, [instanceId]);
  if (!c || c.orgId !== org.id) redirect("/dashboard");
  const myEmp = await employeeForUser(user.id);
  const isOrgAdmin = !!org.isOrgAdmin || !!user.isSuperAdmin;
  const isOwner = !!myEmp && !!c.employeeId && myEmp.id === c.employeeId;
  if (!isOrgAdmin && !isOwner) redirect("/dashboard");
  return { user, orgId: org.id, userName: user.name, isOrgAdmin, isOwner };
}
function checklistReturn(formData: FormData, instId: string): string {
  return String(formData.get("returnTo") || "") === "portal" ? `/portal/onboarding/${instId}` : `/hr/checklists/${instId}`;
}

export async function toggleChecklistItemAction(formData: FormData) {
  const instId = String(formData.get("instanceId") || "");
  const acc = await checklistAccess(instId);
  const itemId = String(formData.get("itemId") || "");
  const status = String(formData.get("status") || "pending");
  await q(`UPDATE checklist_instance_item
           SET status=$2, notes=COALESCE($3,notes),
               done_by = CASE WHEN $2 IN ('done','na') THEN $4 ELSE NULL END,
               done_at = CASE WHEN $2 IN ('done','na') THEN now() ELSE NULL END
           WHERE id=$1 AND instance_id=$5 AND org_id=$6`,
    [itemId, status, _rstr(formData, "notes"), acc.userName, instId, acc.orgId]);
  redirect(checklistReturn(formData, instId));
}

export async function completeChecklistAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const instId = String(formData.get("instanceId") || "");
  await q(`UPDATE checklist_instance SET status='completed', completed_date=CURRENT_DATE WHERE id=$1 AND org_id=$2`, [instId, orgId]);
  await writeAudit({ orgId, userId, action: "complete", entity: "checklist_instance", entityId: instId });
  redirect(`/hr/checklists/${instId}`);
}
export async function reopenChecklistAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const instId = String(formData.get("instanceId") || "");
  await q(`UPDATE checklist_instance SET status='open', completed_date=NULL WHERE id=$1 AND org_id=$2`, [instId, orgId]);
  redirect(`/hr/checklists/${instId}`);
}
export async function deleteChecklistInstanceAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const instId = String(formData.get("instanceId") || "");
  await q(`DELETE FROM checklist_instance WHERE id=$1 AND org_id=$2`, [instId, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "checklist_instance", entityId: instId });
  redirect(`/hr/checklists`);
}

/* ===================== Petty Cash / Imprest ===================== */
const _pcBal = async (orgId: string, accountId: string): Promise<number> =>
  (await one<{ b: number }>(`SELECT COALESCE(SUM(CASE WHEN type='expense' THEN -amount ELSE amount END),0)::float8 b FROM petty_cash_txn WHERE account_id=$1 AND org_id=$2`, [accountId, orgId]))?.b ?? 0;

export async function createPettyCashAccountAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/finance/petty-cash?err=name");
  const aid = id("pca");
  const limit = _rnum(formData, "floatLimit") ?? 0;
  await q(`INSERT INTO petty_cash_account (id, org_id, name, custodian, custodian_employee_id, project_id, currency, float_limit, opened_date, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE,$9,$10,$11)`,
    [aid, orgId, name, _rstr(formData, "custodian"), _rstr(formData, "custodianEmployeeId"), _rstr(formData, "projectId"), String(formData.get("currency") || "UGX"), limit, _rstr(formData, "notes"), userId, userName]);
  // optional opening float establishes the imprest
  const opening = _rnum(formData, "opening") ?? 0;
  if (opening > 0)
    await q(`INSERT INTO petty_cash_txn (id, org_id, account_id, txn_date, type, amount, description, recorded_by_id, recorded_by_name)
             VALUES ($1,$2,$3,CURRENT_DATE,'top_up',$4,'Opening float',$5,$6)`, [id("pct"), orgId, aid, opening, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "petty_cash_account", entityId: aid, after: { name, limit, opening } });
  redirect(`/finance/petty-cash/${aid}`);
}

export async function recordPettyCashExpenseAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("accountId") || "");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/petty-cash/${aid}?err=amount`);
  if (amount > await _pcBal(orgId, aid)) redirect(`/finance/petty-cash/${aid}?err=insufficient`);
  const txnId = id("pct");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(txnId, file.name, buf); }
  const approved = formData.get("approved") === "on";
  await q(`INSERT INTO petty_cash_txn (id, org_id, account_id, txn_date, type, amount, description, payee, category, reference, project_id, file_key, file_name, approved_by, approved_at, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,'expense',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [txnId, orgId, aid, _rstr(formData, "txnDate") ?? new Date().toISOString().slice(0, 10), amount, _rstr(formData, "description"),
     _rstr(formData, "payee"), _rstr(formData, "category"), _rstr(formData, "reference"), _rstr(formData, "projectId"), fileKey, fileName,
     approved ? userName : null, approved ? new Date().toISOString() : null, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "petty_cash_txn", entityId: txnId, after: { type: "expense", amount } });
  redirect(`/finance/petty-cash/${aid}`);
}

export async function replenishPettyCashAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("accountId") || "");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/petty-cash/${aid}?err=amount`);
  await q(`INSERT INTO petty_cash_txn (id, org_id, account_id, txn_date, type, amount, description, reference, approved_by, approved_at, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,'top_up',$5,'Replenishment',$6,$7,$8,$9,$10)`,
    [id("pct"), orgId, aid, _rstr(formData, "txnDate") ?? new Date().toISOString().slice(0, 10), amount, _rstr(formData, "reference"), userName, new Date().toISOString(), userId, userName]);
  await writeAudit({ orgId, userId, action: "replenish", entity: "petty_cash_account", entityId: aid, after: { amount } });
  redirect(`/finance/petty-cash/${aid}`);
}

export async function reconcilePettyCashAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("accountId") || "");
  const counted = _rnum(formData, "counted");
  if (counted == null) redirect(`/finance/petty-cash/${aid}?err=amount`);
  const book = await _pcBal(orgId, aid);
  const variance = Math.round((counted - book) * 100) / 100;
  if (variance !== 0) {
    const note = `Cash count reconciliation: counted ${counted}, book ${book}, variance ${variance}${_rstr(formData, "note") ? ` — ${_rstr(formData, "note")}` : ""}`;
    await q(`INSERT INTO petty_cash_txn (id, org_id, account_id, txn_date, type, amount, description, recorded_by_id, recorded_by_name)
             VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7,$8)`,
      [id("pct"), orgId, aid, _rstr(formData, "txnDate") ?? new Date().toISOString().slice(0, 10), variance, note, userId, userName]);
  }
  await writeAudit({ orgId, userId, action: "reconcile", entity: "petty_cash_account", entityId: aid, after: { counted, book, variance } });
  redirect(`/finance/petty-cash/${aid}?reconciled=1`);
}

export async function closePettyCashAccountAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("accountId") || "");
  const reopen = formData.get("reopen") === "1";
  await q(`UPDATE petty_cash_account SET status=$2 WHERE id=$1 AND org_id=$3`, [aid, reopen ? "active" : "closed", orgId]);
  await writeAudit({ orgId, userId, action: reopen ? "reopen" : "close", entity: "petty_cash_account", entityId: aid });
  redirect(`/finance/petty-cash/${aid}`);
}

export async function deletePettyCashAccountAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("accountId") || "");
  await q(`DELETE FROM petty_cash_account WHERE id=$1 AND org_id=$2`, [aid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "petty_cash_account", entityId: aid });
  redirect(`/finance/petty-cash`);
}

/* ===================== Grant Agreements / Income Register ===================== */
export async function createAgreementAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const donor = String(formData.get("donor") || "").trim();
  const title = String(formData.get("title") || "").trim();
  if (!donor || !title) redirect("/finance/funding?err=req");
  const aid = id("fag");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(aid, file.name, buf); }
  await q(`INSERT INTO funding_agreement (id, org_id, donor, title, reference, project_id, currency, total_amount, signed_date, start_date, end_date, focal_person, file_key, file_name, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [aid, orgId, donor, title, _rstr(formData, "reference"), _rstr(formData, "projectId"), String(formData.get("currency") || "UGX"),
     _rnum(formData, "totalAmount") ?? 0, _rstr(formData, "signedDate"), _rstr(formData, "startDate"), _rstr(formData, "endDate"),
     _rstr(formData, "focalPerson"), fileKey, fileName, _rstr(formData, "notes"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "funding_agreement", entityId: aid, after: { donor, title } });
  redirect(`/finance/funding/${aid}`);
}

export async function addTrancheAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  const label = String(formData.get("label") || "").trim();
  if (!label) redirect(`/finance/funding/${aid}?err=label`);
  const so = (await one<{ m: number }>(`SELECT COALESCE(MAX(sort_order),0)+1 m FROM funding_tranche WHERE agreement_id=$1`, [aid]))?.m ?? 1;
  await q(`INSERT INTO funding_tranche (id, org_id, agreement_id, label, expected_date, amount, condition, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("ftr"), orgId, aid, label, _rstr(formData, "expectedDate"), _rnum(formData, "amount") ?? 0, _rstr(formData, "condition"), so]);
  redirect(`/finance/funding/${aid}`);
}
export async function deleteTrancheAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  await q(`DELETE FROM funding_tranche WHERE id=$1 AND org_id=$2`, [String(formData.get("trancheId") || ""), orgId]);
  redirect(`/finance/funding/${aid}`);
}

export async function recordReceiptAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/funding/${aid}?err=amount`);
  const rid = id("frc");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(rid, file.name, buf); }
  await q(`INSERT INTO funding_receipt (id, org_id, agreement_id, tranche_id, receipt_date, amount, reference, method, file_key, file_name, notes, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [rid, orgId, aid, _rstr(formData, "trancheId"), _rstr(formData, "receiptDate") ?? new Date().toISOString().slice(0, 10), amount,
     _rstr(formData, "reference"), _rstr(formData, "method"), fileKey, fileName, _rstr(formData, "notes"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "funding_receipt", entityId: rid, after: { agreementId: aid, amount } });
  redirect(`/finance/funding/${aid}`);
}
export async function deleteFundingReceiptAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  const rid = String(formData.get("receiptId") || "");
  await q(`DELETE FROM funding_receipt WHERE id=$1 AND org_id=$2`, [rid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "funding_receipt", entityId: rid });
  redirect(`/finance/funding/${aid}`);
}

export async function closeAgreementAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  const reopen = formData.get("reopen") === "1";
  await q(`UPDATE funding_agreement SET status=$2 WHERE id=$1 AND org_id=$3`, [aid, reopen ? "active" : "closed", orgId]);
  await writeAudit({ orgId, userId, action: reopen ? "reopen" : "close", entity: "funding_agreement", entityId: aid });
  redirect(`/finance/funding/${aid}`);
}
export async function deleteAgreementAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const aid = String(formData.get("agreementId") || "");
  await q(`DELETE FROM funding_agreement WHERE id=$1 AND org_id=$2`, [aid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "funding_agreement", entityId: aid });
  redirect(`/finance/funding`);
}

/* ===================== Reserves & Investments (Treasury) ===================== */
const _resBal = async (orgId: string, fundId: string): Promise<number> =>
  (await one<{ b: number }>(`SELECT COALESCE(SUM(CASE WHEN type='utilization' THEN -amount ELSE amount END),0)::float8 b FROM reserve_movement WHERE fund_id=$1 AND org_id=$2`, [fundId, orgId]))?.b ?? 0;
const _invOut = async (orgId: string, invId: string): Promise<number> =>
  (await one<{ o: number }>(`SELECT (i.principal + COALESCE((SELECT SUM(CASE WHEN type IN ('withdrawal','maturity') THEN -amount WHEN type='interest' THEN 0 ELSE amount END) FROM investment_movement WHERE investment_id=i.id),0))::float8 o FROM investment i WHERE i.id=$1 AND i.org_id=$2`, [invId, orgId]))?.o ?? 0;

export async function createReserveFundAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/finance/treasury?err=resname");
  const fid = id("rsv");
  await q(`INSERT INTO reserve_fund (id, org_id, name, type, purpose, currency, target_amount, opened_date, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9,$10)`,
    [fid, orgId, name, String(formData.get("type") || "general"), _rstr(formData, "purpose"), String(formData.get("currency") || "UGX"),
     _rnum(formData, "targetAmount"), _rstr(formData, "notes"), userId, userName]);
  const opening = _rnum(formData, "opening") ?? 0;
  if (opening > 0)
    await q(`INSERT INTO reserve_movement (id, org_id, fund_id, movement_date, type, amount, description, recorded_by_id, recorded_by_name)
             VALUES ($1,$2,$3,CURRENT_DATE,'allocation',$4,'Opening allocation',$5,$6)`, [id("rmv"), orgId, fid, opening, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "reserve_fund", entityId: fid, after: { name, opening } });
  redirect(`/finance/treasury/reserve/${fid}`);
}

export async function recordReserveMovementAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const fid = String(formData.get("fundId") || "");
  const type = String(formData.get("type") || "allocation");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/treasury/reserve/${fid}?err=amount`);
  if (type === "utilization" && amount > await _resBal(orgId, fid)) redirect(`/finance/treasury/reserve/${fid}?err=insufficient`);
  await q(`INSERT INTO reserve_movement (id, org_id, fund_id, movement_date, type, amount, description, reference, project_id, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id("rmv"), orgId, fid, _rstr(formData, "movementDate") ?? new Date().toISOString().slice(0, 10), type, amount,
     _rstr(formData, "description"), _rstr(formData, "reference"), _rstr(formData, "projectId"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "reserve_movement", entityId: fid, after: { type, amount } });
  redirect(`/finance/treasury/reserve/${fid}`);
}
export async function closeReserveFundAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const fid = String(formData.get("fundId") || "");
  const reopen = formData.get("reopen") === "1";
  await q(`UPDATE reserve_fund SET status=$2 WHERE id=$1 AND org_id=$3`, [fid, reopen ? "active" : "closed", orgId]);
  await writeAudit({ orgId, userId, action: reopen ? "reopen" : "close", entity: "reserve_fund", entityId: fid });
  redirect(`/finance/treasury/reserve/${fid}`);
}
export async function deleteReserveFundAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const fid = String(formData.get("fundId") || "");
  await q(`DELETE FROM reserve_fund WHERE id=$1 AND org_id=$2`, [fid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "reserve_fund", entityId: fid });
  redirect(`/finance/treasury`);
}

export async function createInvestmentAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/finance/treasury?err=invname");
  const iid = id("inv");
  await q(`INSERT INTO investment (id, org_id, name, institution, instrument_type, currency, principal, interest_rate, placement_date, maturity_date, expected_value, reference, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [iid, orgId, name, _rstr(formData, "institution"), String(formData.get("instrumentType") || "fixed_deposit"), String(formData.get("currency") || "UGX"),
     _rnum(formData, "principal") ?? 0, _rnum(formData, "interestRate"), _rstr(formData, "placementDate"), _rstr(formData, "maturityDate"),
     _rnum(formData, "expectedValue"), _rstr(formData, "reference"), _rstr(formData, "notes"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "investment", entityId: iid, after: { name, principal: _rnum(formData, "principal") } });
  redirect(`/finance/treasury/investment/${iid}`);
}

export async function recordInvestmentMovementAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const iid = String(formData.get("investmentId") || "");
  const type = String(formData.get("type") || "interest");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/treasury/investment/${iid}?err=amount`);
  if ((type === "withdrawal" || type === "maturity") && amount > await _invOut(orgId, iid)) redirect(`/finance/treasury/investment/${iid}?err=insufficient`);
  await q(`INSERT INTO investment_movement (id, org_id, investment_id, movement_date, type, amount, description, reference, recorded_by_id, recorded_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("imv"), orgId, iid, _rstr(formData, "movementDate") ?? new Date().toISOString().slice(0, 10), type, amount, _rstr(formData, "description"), _rstr(formData, "reference"), userId, userName]);
  // a maturity movement that clears the principal marks the investment matured
  if (type === "maturity" && await _invOut(orgId, iid) <= 0)
    await q(`UPDATE investment SET status='matured' WHERE id=$1 AND org_id=$2`, [iid, orgId]);
  await writeAudit({ orgId, userId, action: "create", entity: "investment_movement", entityId: iid, after: { type, amount } });
  redirect(`/finance/treasury/investment/${iid}`);
}
export async function setInvestmentStatusAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const iid = String(formData.get("investmentId") || "");
  const status = String(formData.get("status") || "active");
  await q(`UPDATE investment SET status=$2 WHERE id=$1 AND org_id=$3`, [iid, status, orgId]);
  await writeAudit({ orgId, userId, action: "status", entity: "investment", entityId: iid, after: { status } });
  redirect(`/finance/treasury/investment/${iid}`);
}
export async function deleteInvestmentAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const iid = String(formData.get("investmentId") || "");
  await q(`DELETE FROM investment WHERE id=$1 AND org_id=$2`, [iid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "investment", entityId: iid });
  redirect(`/finance/treasury`);
}

/* ===================== Rolling Cash Forecast ===================== */
export async function createForecastAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const name = String(formData.get("name") || "").trim();
  if (!name) redirect("/finance/cash-forecast?err=name");
  const fid = id("cfc");
  const months = Math.max(1, Math.min(_rnum(formData, "months") ?? 6, 36));
  await q(`INSERT INTO cash_forecast (id, org_id, name, currency, opening_balance, start_date, months, include_funding, include_investments, notes, created_by_id, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [fid, orgId, name, String(formData.get("currency") || "UGX"), _rnum(formData, "openingBalance") ?? 0,
     _rstr(formData, "startDate") ?? new Date().toISOString().slice(0, 10), months,
     formData.get("includeFunding") === "on", formData.get("includeInvestments") === "on", _rstr(formData, "notes"), userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "cash_forecast", entityId: fid, after: { name, months } });
  redirect(`/finance/cash-forecast/${fid}`);
}

export async function updateForecastAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const fid = String(formData.get("forecastId") || "");
  const months = Math.max(1, Math.min(_rnum(formData, "months") ?? 6, 36));
  await q(`UPDATE cash_forecast SET opening_balance=$2, start_date=$3, months=$4, include_funding=$5, include_investments=$6 WHERE id=$1 AND org_id=$7`,
    [fid, _rnum(formData, "openingBalance") ?? 0, _rstr(formData, "startDate") ?? new Date().toISOString().slice(0, 10), months,
     formData.get("includeFunding") === "on", formData.get("includeInvestments") === "on", orgId]);
  await writeAudit({ orgId, userId, action: "update", entity: "cash_forecast", entityId: fid });
  redirect(`/finance/cash-forecast/${fid}`);
}

export async function addForecastLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const fid = String(formData.get("forecastId") || "");
  const amount = _rnum(formData, "amount") ?? 0;
  if (amount <= 0) redirect(`/finance/cash-forecast/${fid}?err=amount`);
  await q(`INSERT INTO cash_forecast_line (id, org_id, forecast_id, line_date, direction, category, description, amount, recurring, recur_until)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id("cfl"), orgId, fid, _rstr(formData, "lineDate") ?? new Date().toISOString().slice(0, 10), String(formData.get("direction") || "outflow"),
     _rstr(formData, "category"), _rstr(formData, "description"), amount, String(formData.get("recurring") || "none"), _rstr(formData, "recurUntil")]);
  redirect(`/finance/cash-forecast/${fid}`);
}
export async function deleteForecastLineAction(formData: FormData) {
  const { orgId } = await requireInstitutionFinance();
  const fid = String(formData.get("forecastId") || "");
  await q(`DELETE FROM cash_forecast_line WHERE id=$1 AND org_id=$2`, [String(formData.get("lineId") || ""), orgId]);
  redirect(`/finance/cash-forecast/${fid}`);
}

export async function archiveForecastAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const fid = String(formData.get("forecastId") || "");
  const reopen = formData.get("reopen") === "1";
  await q(`UPDATE cash_forecast SET status=$2 WHERE id=$1 AND org_id=$3`, [fid, reopen ? "active" : "archived", orgId]);
  await writeAudit({ orgId, userId, action: reopen ? "reopen" : "archive", entity: "cash_forecast", entityId: fid });
  redirect(`/finance/cash-forecast/${fid}`);
}
export async function deleteForecastAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const fid = String(formData.get("forecastId") || "");
  await q(`DELETE FROM cash_forecast WHERE id=$1 AND org_id=$2`, [fid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "cash_forecast", entityId: fid });
  redirect(`/finance/cash-forecast`);
}

/* ===================== Whistleblower / Confidential Reporting ===================== */
// Public submission — intentionally unauthenticated (the channel must be open).
// Resolves the org from its slug; only ever inserts a report. No data is read back.
export async function submitWhistleblowerReportAction(formData: FormData) {
  const slug = String(formData.get("slug") || "").trim();
  const org = await one<{ id: string }>(`SELECT id FROM organization WHERE slug=$1`, [slug]);
  if (!org) redirect(`/report/track?err=org`);
  const title = String(formData.get("title") || "").trim();
  const description = String(formData.get("description") || "").trim();
  if (!title || !description) redirect(`/report/${slug}?err=req`);
  const isAnon = formData.get("anonymous") === "on";
  const code = (globalThis.crypto?.randomUUID?.() ?? id("wb")).replace(/-/g, "").slice(0, 12).toUpperCase();
  const rid = id("wbr");
  await q(`INSERT INTO whistleblower_report (id, org_id, tracking_code, category, title, description, is_anonymous, reporter_name, reporter_contact, incident_date, location, persons_involved, retaliation_concern)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [rid, org.id, code, _rstr(formData, "category"), title.slice(0, 300), description.slice(0, 8000), isAnon,
     isAnon ? null : _rstr(formData, "reporterName"), isAnon ? null : _rstr(formData, "reporterContact"),
     _rstr(formData, "incidentDate"), _rstr(formData, "location"), _rstr(formData, "personsInvolved"), formData.get("retaliation") === "on"]);
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) {
    const mid = id("wbm"); const buf = Buffer.from(await file.arrayBuffer());
    const key = await saveUpload(mid, file.name, buf);
    await q(`INSERT INTO whistleblower_message (id, org_id, report_id, sender, body, file_key, file_name) VALUES ($1,$2,$3,'reporter','Attachment provided at submission',$4,$5)`, [mid, org.id, rid, key, file.name]);
  }
  redirect(`/report/${slug}/submitted?code=${code}`);
}

// Public follow-up — add information to an existing report using the tracking code.
export async function addReporterMessageAction(formData: FormData) {
  const code = String(formData.get("code") || "").trim();
  const r = await one<{ id: string; orgId: string }>(`SELECT id, org_id AS "orgId" FROM whistleblower_report WHERE tracking_code=$1`, [code]);
  if (!r) redirect(`/report/track?err=code`);
  const body = String(formData.get("body") || "").trim();
  if (!body) redirect(`/report/track?code=${encodeURIComponent(code)}`);
  const mid = id("wbm");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(mid, file.name, buf); }
  await q(`INSERT INTO whistleblower_message (id, org_id, report_id, sender, body, file_key, file_name) VALUES ($1,$2,$3,'reporter',$4,$5,$6)`,
    [mid, r.orgId, r.id, body.slice(0, 8000), fileKey, fileName]);
  redirect(`/report/track?code=${encodeURIComponent(code)}&sent=1`);
}

// ---- Reviewer side (org admins / designated officers) ----
export async function setWhistleblowerStatusAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const rid = String(formData.get("reportId") || "");
  const status = String(formData.get("status") || "submitted");
  const closing = ["resolved", "dismissed", "closed"].includes(status);
  await q(`UPDATE whistleblower_report SET status=$2, closed_at = CASE WHEN $3 THEN COALESCE(closed_at, now()) ELSE NULL END WHERE id=$1 AND org_id=$4`,
    [rid, status, closing, orgId]);
  await writeAudit({ orgId, userId, action: "status", entity: "whistleblower_report", entityId: rid, after: { status } });
  redirect(`/finance/whistleblower/${rid}`);
}
export async function triageWhistleblowerAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const rid = String(formData.get("reportId") || "");
  await q(`UPDATE whistleblower_report SET handler=$2, severity=$3 WHERE id=$1 AND org_id=$4`,
    [rid, _rstr(formData, "handler"), String(formData.get("severity") || "medium"), orgId]);
  await writeAudit({ orgId, userId, action: "triage", entity: "whistleblower_report", entityId: rid });
  redirect(`/finance/whistleblower/${rid}`);
}
export async function recordWhistleblowerOutcomeAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const rid = String(formData.get("reportId") || "");
  await q(`UPDATE whistleblower_report SET outcome=$2, outcome_notes=$3, status='closed', closed_at=COALESCE(closed_at, now()) WHERE id=$1 AND org_id=$4`,
    [rid, _rstr(formData, "outcome"), _rstr(formData, "outcomeNotes"), orgId]);
  await writeAudit({ orgId, userId, action: "outcome", entity: "whistleblower_report", entityId: rid });
  redirect(`/finance/whistleblower/${rid}`);
}
export async function addReviewerMessageAction(formData: FormData) {
  const { orgId, userId, userName } = await requireInstitutionFinance();
  const rid = String(formData.get("reportId") || "");
  const body = String(formData.get("body") || "").trim();
  if (!body) redirect(`/finance/whistleblower/${rid}?err=body`);
  const mid = id("wbm");
  let fileKey: string | null = null, fileName: string | null = null;
  const file = formData.get("file") as File | null;
  if (file && file.size > 0) { const buf = Buffer.from(await file.arrayBuffer()); fileName = file.name; fileKey = await saveUpload(mid, file.name, buf); }
  await q(`INSERT INTO whistleblower_message (id, org_id, report_id, sender, author_name, body, internal, file_key, file_name) VALUES ($1,$2,$3,'reviewer',$4,$5,$6,$7,$8)`,
    [mid, orgId, rid, userName, body, formData.get("internal") === "on", fileKey, fileName]);
  await writeAudit({ orgId, userId, action: "message", entity: "whistleblower_report", entityId: rid, after: { internal: formData.get("internal") === "on" } });
  redirect(`/finance/whistleblower/${rid}`);
}
export async function deleteWhistleblowerReportAction(formData: FormData) {
  const { orgId, userId } = await requireInstitutionFinance();
  const rid = String(formData.get("reportId") || "");
  await q(`DELETE FROM whistleblower_report WHERE id=$1 AND org_id=$2`, [rid, orgId]);
  await writeAudit({ orgId, userId, action: "delete", entity: "whistleblower_report", entityId: rid });
  redirect(`/finance/whistleblower`);
}
