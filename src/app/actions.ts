"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { PROJECT_STATUS } from "@/lib/enums";
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
  const current = String(formData.get("currentPassword") || "");
  const next = String(formData.get("newPassword") || "");
  const confirm = String(formData.get("confirmPassword") || "");
  const row = await one<{ passwordHash: string | null }>(`SELECT password_hash AS "passwordHash" FROM app_user WHERE id=$1`, [user.id]);
  if (!row || !verifyPassword(current, row.passwordHash)) redirect("/profile?pw=wrong");
  if (next !== confirm) redirect("/profile?pw=match");
  const pe = passwordError(next);
  if (pe) redirect(`/profile?pw=${encodeURIComponent(pe)}`);
  await q(`UPDATE app_user SET password_hash=$2, updated_at=now() WHERE id=$1`, [user.id, await hashPassword(next)]);
  await writeAudit({ userId: user.id, action: "update", entity: "app_user", entityId: user.id, meta: { passwordChanged: true } });
  redirect("/profile?pw=ok");
}

export async function uploadAvatarAction(formData: FormData) {
  const user = await requireUser();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) redirect("/profile");
  if (!file.type.startsWith("image/")) redirect("/profile?avatar=type");
  if (file.size > 2_000_000) redirect("/profile?avatar=size"); // 2 MB cap (stored inline)
  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${buf.toString("base64")}`;
  await q(`INSERT INTO user_profile (id, user_id, avatar_url) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET avatar_url=$3`, [id("up"), user.id, dataUrl]);
  await writeAudit({ userId: user.id, action: "update", entity: "user_profile", entityId: user.id, meta: { avatar: true } });
  redirect("/profile?avatar=ok");
}

export async function saveSignatureAction(formData: FormData) {
  const user = await requireUser();
  const dataUrl = String(formData.get("dataUrl") || "");
  if (dataUrl) {
    await q(`INSERT INTO signature_asset (id, user_id, data_url) VALUES ($1,$2,$3)`, [id("sig"), user.id, dataUrl]);
  }
  revalidatePath("/profile");
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

// Recomputes a requisition's disbursed amount + status from APPROVED vouchers only.
async function recomputeDisbursement(reqId: string) {
  const req = await one<{ amount: number }>(`SELECT amount FROM requisition WHERE id=$1`, [reqId]);
  const tot = (await one<{ s: number }>(`SELECT COALESCE(SUM(amount),0) s FROM payment_voucher WHERE requisition_id=$1 AND status='approved'`, [reqId]))?.s ?? 0;
  const status = tot <= 0 ? "approved" : req && tot >= req.amount ? "disbursed" : "partially_funded";
  await q(`UPDATE requisition SET disbursed_amount=$2, status=$3, updated_at=now() WHERE id=$1`, [reqId, tot, status]);
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
