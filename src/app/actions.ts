"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { PROJECT_STATUS, PROJECT_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type Permission, type ProjectRole } from "@/lib/enums";
import { createSession, destroySession, requireUser, verifyPassword } from "@/server/auth";
import { requirePermission, getProjectAccess, canCreateProjects } from "@/server/policy";
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
  let budgetId = String(formData.get("budgetId") || "");
  if (!budgetId) {
    budgetId = id("bud");
    await q(`INSERT INTO budget (id, project_id, name) VALUES ($1,$2,'Project budget')`, [budgetId, projectId]);
  }
  const unitCost = Number(formData.get("unitCost") || 0);
  const quantity = Number(formData.get("quantity") || 1);
  await q(`INSERT INTO budget_line (id, budget_id, code, description, unit, unit_cost, quantity, planned)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id("bl"), budgetId, String(formData.get("code") || "BL"), String(formData.get("description") || "Line"),
     String(formData.get("unit") || "unit"), unitCost, quantity, unitCost * quantity]);
  await writeAudit({ userId: user.id, action: "create", entity: "budget_line", entityId: budgetId });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function updateBudgetLineAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const lineId = String(formData.get("lineId"));
  const unitCost = Number(formData.get("unitCost") || 0);
  const quantity = Number(formData.get("quantity") || 1);
  // record the pre-change values so the previous figures stay queryable
  const prev = await one<{ code: string; description: string; unitCost: number; quantity: number; planned: number }>(
    `SELECT code, description, unit_cost AS "unitCost", quantity, planned FROM budget_line WHERE id=$1`, [lineId]);
  if (prev) {
    await q(`INSERT INTO budget_line_revision (id, project_id, budget_line_id, code, description, unit_cost, quantity, planned, action, changed_by, changed_by_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'updated',$9,$10)`,
      [id("blr"), projectId, lineId, prev.code, prev.description, prev.unitCost, prev.quantity, prev.planned, user.id, user.name]);
  }
  await q(`UPDATE budget_line SET code=$2, description=$3, unit_cost=$4, quantity=$5, planned=$6 WHERE id=$1`,
    [lineId, String(formData.get("code") || "BL"), String(formData.get("description") || "Line"), unitCost, quantity, unitCost * quantity]);
  await writeAudit({ userId: user.id, action: "update", entity: "budget_line", entityId: lineId,
    before: prev ? { planned: prev.planned, unitCost: prev.unitCost, quantity: prev.quantity } : undefined,
    after: { planned: unitCost * quantity, unitCost, quantity } });
  await evaluateProject(projectId);
  revalidatePath(`/projects/${projectId}/budget`);
}

export async function deleteBudgetLineAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const lineId = String(formData.get("lineId"));
  // preserve the final state in history before removing the line
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
  await requirePermission(projectId, "budget.manage");
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
  if (access.role !== "pi") throw new Error("FORBIDDEN — only the Principal Investigator can approve the SOW");
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
  await requirePermission(projectId, "project.edit");
  const docType = String(formData.get("docType") || "proposal");
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
  const { jobId } = await createExtractionJob({ projectId, userId: user.id, fileName, docType, text, rows });
  redirect(`/projects/${projectId}/import/${jobId}`);
}

export async function uploadDocumentAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "documents.manage");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { revalidatePath(`/projects/${projectId}/documents`); return; }
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
  revalidatePath(`/projects/${projectId}/documents`);
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

  await q(`UPDATE budget_line SET unit_cost = unit_cost * $2, planned = planned * $2
           WHERE budget_id IN (SELECT id FROM budget WHERE project_id=$1)`, [projectId, rate]);
  if (newCurrency) {
    await q(`UPDATE project SET currency=$2, updated_at=now() WHERE id=$1`, [projectId, newCurrency]);
    await q(`UPDATE budget SET currency=$2 WHERE project_id=$1`, [projectId, newCurrency]);
  }
  await evaluateProject(projectId);
  await writeAudit({ userId: user.id, action: "update", entity: "budget", entityId: projectId, after: { rate, newCurrency } });
  revalidatePath(`/projects/${projectId}/budget`);
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

export async function uploadObjectivesAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "project.edit");
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) { revalidatePath(`/projects/${projectId}/logframe`); return; }

  const buf = Buffer.from(await file.arrayBuffer());
  const { text, rows } = await extractFile(file.name, buf);
  const suggestions = parseDocument("proposal", text, rows);

  let order = (await one<{ m: number }>(`SELECT COALESCE(MAX("order"),0)::int m FROM objective WHERE project_id=$1`, [projectId]))?.m ?? 0;
  const objByCode = new Map<string, string>();
  let created = 0;

  for (const s of suggestions.filter((x) => x.kind === "objective")) {
    const p = s.payload as { code?: string; statement?: string };
    const oid = id("obj");
    await q(`INSERT INTO objective (id, project_id, level, code, statement, "order") VALUES ($1,$2,'objective',$3,$4,$5)`,
      [oid, projectId, p.code || `OBJ${++order}`, (p.statement || "Objective").slice(0, 500), ++order]);
    if (p.code) objByCode.set(p.code, oid);
    created++;
  }
  for (const s of suggestions.filter((x) => x.kind === "output")) {
    const p = s.payload as { code?: string; statement?: string; objectiveCode?: string };
    await q(`INSERT INTO output (id, project_id, objective_id, code, statement, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("out"), projectId, p.objectiveCode ? objByCode.get(p.objectiveCode) ?? null : null,
       p.code || `OUT${created + 1}`, (p.statement || "Output").slice(0, 500), ++order]);
    created++;
  }

  const docId = id("doc");
  const skey = await saveUpload(docId, file.name, buf);
  await q(`INSERT INTO project_document (id, project_id, name, doc_type, mime_type, storage_key, size_bytes, extracted_text)
           VALUES ($1,$2,$3,'proposal',$4,$5,$6,$7)`, [docId, projectId, file.name, mimeFor(file.name), skey, buf.length, text.slice(0, 20000)]);
  await writeAudit({ userId: user.id, action: "import", entity: "objective", entityId: projectId, after: { created } });
  revalidatePath(`/projects/${projectId}/logframe`);
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
  const projectId = String(formData.get("projectId") || "") || null;
  const purpose = String(formData.get("purpose") || "") || null;
  const reference = String(formData.get("reference") || "") || null;
  const method = String(formData.get("method") || "bank_transfer");
  const num = await nextNum(orgId, "voucher", "PV");
  const vid = id("pv");
  let entryId: string | null = null;
  try {
    const posted = await postJournal({
      orgId, entryDate: date, memo: `Voucher ${num} — ${payee}${purpose ? ` · ${purpose}` : ""}`,
      reference: num, sourceType: "voucher", sourceId: vid, projectId, postedBy: userId, postedByName: userName,
      lines: [
        { accountId: expenseAccountId, debit: amount, description: purpose ?? payee, projectId },
        { accountId, credit: amount, description: `Payment to ${payee}`, projectId },
      ],
    });
    entryId = posted.entryId;
  } catch (e) {
    redirect(`/finance/vouchers?err=${encodeURIComponent((e as Error).message).slice(0, 120)}`);
  }
  await q(`INSERT INTO payment_voucher (id, org_id, project_id, requisition_id, number, voucher_date, payee, amount, method, reference, purpose, account_id, expense_account_id, journal_entry_id, prepared_by, prepared_by_name, status)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'paid')`,
    [vid, orgId, projectId, num, date, payee, amount, method, reference, purpose, accountId, expenseAccountId, entryId, userId, userName]);
  await writeAudit({ orgId, userId, action: "create", entity: "payment_voucher", entityId: num, after: { payee, amount } });
  redirect(`/finance/vouchers?created=${num}`);
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

// Pay components (the configurable deduction/allowance rules)
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
import { decidePurchaseRequest, createPOFromRequest, createGRN, createBillFromPO, upsertProcurementConfig, getProcurementConfig, type ProcurementConfig } from "@/server/services/procurement";

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
  await writeAudit({ orgId, userId, action: "create", entity: "purchase_request", entityId: number, after: { title, amount, projectId, budgetLineId } });
  redirect("/procurement/requests?created=1");
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
