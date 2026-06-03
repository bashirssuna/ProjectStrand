"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { PROJECT_STATUS } from "@/lib/enums";
import { createSession, destroySession, requireUser, verifyPassword } from "@/server/auth";
import { requirePermission, getProjectAccess, canCreateProjects } from "@/server/policy";
import { createProject } from "@/server/services/projects";
import { addProjectMemberByEmail, createAdminAccount, issuePasswordToken, consumePasswordToken, markTokenUsed, signupOrganization, getUserOrg } from "@/server/services/accounts";
import { hashPassword } from "@/lib/password";
import { createExtractionJob, applySuggestions } from "@/server/services/parsing";
import { extractFile } from "@/server/services/extract";
import { saveUpload, mimeFor } from "@/server/services/storage";
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

export async function addExpenditureAction(formData: FormData) {
  const user = await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "budget.manage");
  const amount = Number(formData.get("amount") || 0);
  await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id("exp"), projectId, String(formData.get("budgetLineId")), amount,
     String(formData.get("date") || new Date().toISOString()), String(formData.get("reference") || ""),
     String(formData.get("payee") || ""), formData.get("approved") === "on", user.id]);
  await writeAudit({ userId: user.id, action: "create", entity: "expenditure", entityId: projectId, after: { amount } });
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
  await addProjectMemberByEmail(projectId, email, name, role, access.user.id);
  revalidatePath(`/projects/${projectId}/team`);
}

export async function updateMemberRoleAction(formData: FormData) {
  await requireUser();
  const projectId = String(formData.get("projectId"));
  await requirePermission(projectId, "members.manage");
  await q(`UPDATE project_member SET role=$3 WHERE project_id=$1 AND user_id=$2`,
    [projectId, String(formData.get("userId")), String(formData.get("role"))]);
  revalidatePath(`/projects/${projectId}/team`);
}

/* ---------------- Profile / signature ---------------- */
export async function updateProfileAction(formData: FormData) {
  const user = await requireUser();
  await q(`UPDATE app_user SET name=$2, updated_at=now() WHERE id=$1`, [user.id, String(formData.get("name") || user.name)]);
  await q(`INSERT INTO user_profile (id, user_id, title, phone, bio, avatar_url)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id) DO UPDATE SET title=$3, phone=$4, bio=$5, avatar_url=$6`,
    [id("up"), user.id, String(formData.get("title") || ""), String(formData.get("phone") || ""),
     String(formData.get("bio") || ""), String(formData.get("avatarUrl") || "")]);
  revalidatePath("/profile");
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
  if (password.length < 8) redirect(`/reset?token=${encodeURIComponent(token)}&error=short`);
  const valid = await consumePasswordToken(token);
  if (!valid) redirect(`/reset?error=invalid`);
  await q(`UPDATE app_user SET password_hash=$2, status='active', updated_at=now() WHERE id=$1`,
    [valid.userId, await hashPassword(password)]);
  await markTokenUsed(token);
  await createSession(valid.userId);
  redirect("/dashboard");
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
  });
  if ("error" in res) redirect(`/signup?error=${encodeURIComponent(res.error)}`);
  await createSession(res.userId);
  redirect("/dashboard");
}
