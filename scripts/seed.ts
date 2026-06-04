/* Seeds a realistic grant/research project. Run with: npm run db:seed
   Safe to re-run: it truncates app tables first. Imports only plain modules
   (no "server-only") so it runs under tsx. */
import { getDb, q, exec } from "../src/server/db";
import { id } from "../src/lib/ids";
import { hashPassword } from "../src/lib/password";
import { evaluateProject } from "../src/server/services/anomaly-core";

const DAY = 86400000;
const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * DAY));

async function reset() {
  // Order-independent wipe (CASCADE handles FKs).
  const tables = [
    "parsing_suggestion","extraction_job","anomaly_flag","comment","risk_issue",
    "audit_log","notification","reminder","calendar_event","meeting",
    "report_section","report","signature_asset","approval_matrix",
    "requisition_approval","requisition_item","requisition","commitment","expenditure",
    "budget_line","budget_category","budget_period","budget",
    "timeline_baseline","dependency","task","activity",
    "indicator_actual","indicator","output","objective",
    "sow_version","sow_section","sow","document_version","project_document","folder",
    "project_member","project","org_membership","role","user_profile","app_user","organization",
  ];
  await exec(`TRUNCATE ${tables.join(", ")} CASCADE;`);
}

async function main() {
  await getDb();
  await reset();
  const pw = hashPassword("password123");

  // ---- Organization ----
  const orgId = id("org");
  await q(`INSERT INTO organization (id, name, slug, brand_color, default_mode, plan, status) VALUES ($1,$2,$3,$4,'advanced','active','active')`,
    [orgId, "Demo Organisation", "demo-org", "#2f5d62"]);

  const orgAdminRole = id("role");
  const memberRole = id("role");
  await q(`INSERT INTO role (id, org_id, key, name, is_system, permissions) VALUES ($1,$2,'org_admin','Organisation Admin',true,'[]')`, [orgAdminRole, orgId]);
  await q(`INSERT INTO role (id, org_id, key, name, is_system, permissions) VALUES ($1,$2,'member','Member',true,'[]')`, [memberRole, orgId]);

  // ---- Users ----
  const users = {
    admin: { id: id("usr"), email: "admin@strand.dev", name: "System Admin", super: true, title: "Platform Administrator" },
    pi:    { id: id("usr"), email: "pi@strand.dev", name: "Dr. Amina Okello", super: false, title: "Principal Investigator" },
    pm:    { id: id("usr"), email: "pm@strand.dev", name: "James Mwangi", super: false, title: "Project Manager" },
    fin:   { id: id("usr"), email: "finance@strand.dev", name: "Grace Wanjiru", super: false, title: "Finance Administrator" },
    coord: { id: id("usr"), email: "coord@strand.dev", name: "Peter Otieno", super: false, title: "Project Coordinator" },
    asst:  { id: id("usr"), email: "assistant@strand.dev", name: "Lucy Achieng", super: false, title: "Research Assistant" },
  } as const;

  for (const u of Object.values(users)) {
    await q(`INSERT INTO app_user (id, email, name, password_hash, is_super_admin) VALUES ($1,$2,$3,$4,$5)`,
      [u.id, u.email, u.name, pw, u.super]);
    await q(`INSERT INTO user_profile (id, user_id, title, timezone) VALUES ($1,$2,$3,'Africa/Nairobi')`,
      [id("up"), u.id, u.title]);
    await q(`INSERT INTO org_membership (id, org_id, user_id, role_id) VALUES ($1,$2,$3,$4)`,
      [id("om"), orgId, u.id, u.email === "admin@strand.dev" ? orgAdminRole : memberRole]);
  }

  // a sample signature for the PM (used when signing requisitions)
  await q(`INSERT INTO signature_asset (id, user_id, data_url) VALUES ($1,$2,$3)`,
    [id("sig"), users.pm.id, "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="]);

  // ---- Project ----
  const projectId = id("prj");
  await q(
    `INSERT INTO project (id, org_id, code, title, summary, status, mode, donor, funding_source, grant_number, currency, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5,'active','advanced',$6,$7,$8,'USD',$9,$10)`,
    [projectId, orgId, "CRSA-2025",
     "Climate-Resilient Smallholder Agriculture in the Rift Valley",
     "A three-year programme helping 5,000 smallholder farmers adopt climate-smart practices, improve yields, and strengthen market access across three counties.",
     "Global Climate Fund", "GCF Window B", "GCF-2025-0142",
     iso(new Date("2025-01-01")), iso(new Date("2026-12-31"))]
  );

  const members = [
    { u: users.pi, role: "pi" },
    { u: users.pm, role: "project_manager" },
    { u: users.fin, role: "finance_admin" },
    { u: users.coord, role: "coordinator" },
    { u: users.asst, role: "assistant" },
  ];
  for (const m of members) {
    await q(`INSERT INTO project_member (id, project_id, user_id, role) VALUES ($1,$2,$3,$4)`,
      [id("pm"), projectId, m.u.id, m.role]);
  }

  // ---- SOW ----
  const sowId = id("sow");
  await q(`INSERT INTO sow (id, project_id, status, version, approved_by_id, approved_at) VALUES ($1,$2,'approved',2,$3,now())`,
    [sowId, projectId, users.pi.id]);
  const sowSections = [
    ["background", "Background & Justification", "Smallholder farmers in the Rift Valley face declining yields due to erratic rainfall and soil degradation. This programme builds climate resilience through proven agronomic practices, water management, and market linkages."],
    ["scope", "Scope of Work", "The project covers Nakuru, Baringo and Elgeyo-Marakwet counties. It delivers farmer training, demonstration plots, input subsidies, and a digital advisory service over 36 months."],
    ["deliverables", "Deliverables", "1) 200 trained lead farmers; 2) 40 demonstration plots; 3) a climate advisory SMS service; 4) quarterly progress reports; 5) an end-line impact study."],
    ["methodology", "Methodology", "A farmer field-school approach combined with participatory variety selection and a randomised rollout to enable impact measurement."],
    ["reporting", "Reporting & Governance", "Monthly internal reviews, quarterly donor reports, and an annual steering committee meeting chaired by the PI."],
  ];
  sowSections.forEach((s, i) =>
    q(`INSERT INTO sow_section (id, sow_id, key, title, content, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("sec"), sowId, s[0], s[1], s[2], i]));
  // need to await the loop above
  await q(`SELECT 1`);

  // ---- Logframe: objectives, outputs, indicators, actuals ----
  const obj1 = id("obj"), obj2 = id("obj");
  await q(`INSERT INTO objective (id, project_id, level, code, statement, "order") VALUES ($1,$2,'objective','OBJ1',$3,0)`,
    [obj1, projectId, "Increase agricultural productivity and incomes for smallholder farmers."]);
  await q(`INSERT INTO objective (id, project_id, level, code, statement, "order") VALUES ($1,$2,'objective','OBJ2',$3,1)`,
    [obj2, projectId, "Strengthen community resilience to climate variability."]);

  const out1 = id("out"), out2 = id("out"), out3 = id("out");
  await q(`INSERT INTO output (id, project_id, objective_id, code, statement, "order") VALUES ($1,$2,$3,'OUT1.1',$4,0)`,
    [out1, projectId, obj1, "Farmers trained in climate-smart agriculture."]);
  await q(`INSERT INTO output (id, project_id, objective_id, code, statement, "order") VALUES ($1,$2,$3,'OUT1.2',$4,1)`,
    [out2, projectId, obj1, "Demonstration plots established and operational."]);
  await q(`INSERT INTO output (id, project_id, objective_id, code, statement, "order") VALUES ($1,$2,$3,'OUT2.1',$4,2)`,
    [out3, projectId, obj2, "Digital climate advisory service deployed."]);

  const indicators = [
    { id: id("ind"), obj: obj1, out: out1, name: "Lead farmers trained", baseline: 0, target: 200, unit: "farmers", actuals: [["2025-Q1", 45], ["2025-Q2", 90], ["2025-Q3", 132]] },
    { id: id("ind"), obj: obj1, out: out2, name: "Demonstration plots established", baseline: 0, target: 40, unit: "plots", actuals: [["2025-Q1", 8], ["2025-Q2", 18], ["2025-Q3", 26]] },
    { id: id("ind"), obj: obj1, out: out1, name: "Average yield increase", baseline: 0, target: 30, unit: "%", actuals: [["2025-Q2", 8], ["2025-Q3", 14]] },
    { id: id("ind"), obj: obj2, out: out3, name: "Farmers receiving SMS advisories", baseline: 0, target: 5000, unit: "farmers", actuals: [["2025-Q2", 600], ["2025-Q3", 2100]] },
  ];
  for (const ind of indicators) {
    await q(`INSERT INTO indicator (id, objective_id, output_id, name, baseline, target, unit, means_of_verification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ind.id, ind.obj, ind.out, ind.name, ind.baseline, ind.target, ind.unit, "Training records / field survey"]);
    for (const [period, value] of ind.actuals) {
      await q(`INSERT INTO indicator_actual (id, indicator_id, period, value) VALUES ($1,$2,$3,$4)`,
        [id("ia"), ind.id, period, value]);
    }
  }

  // ---- Budget ----
  const budgetId = id("bud");
  await q(`INSERT INTO budget (id, project_id, name, kind, currency, period_type, status, version) VALUES ($1,$2,$3,'donor','USD','quarter','approved',1)`,
    [budgetId, projectId, "GCF Approved Budget Y1–Y3"]);

  const cats = {
    personnel: id("cat"), travel: id("cat"), training: id("cat"), equipment: id("cat"), ops: id("cat"),
  };
  await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,'Personnel','direct')`, [cats.personnel, budgetId]);
  await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,'Travel & Field Work','direct')`, [cats.travel, budgetId]);
  await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,'Training & Workshops','direct')`, [cats.training, budgetId]);
  await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,'Equipment & Inputs','direct')`, [cats.equipment, budgetId]);
  await q(`INSERT INTO budget_category (id, budget_id, name, cost_type) VALUES ($1,$2,'Operations','indirect')`, [cats.ops, budgetId]);

  for (let yr = 0; yr < 3; yr++) {
    for (let qn = 1; qn <= 4; qn++) {
      const start = new Date(Date.UTC(2025 + yr, (qn - 1) * 3, 1));
      const end = new Date(Date.UTC(2025 + yr, qn * 3, 0));
      await q(`INSERT INTO budget_period (id, budget_id, label, start_date, end_date) VALUES ($1,$2,$3,$4,$5)`,
        [id("bp"), budgetId, `${2025 + yr}-Q${qn}`, iso(start), iso(end)]);
    }
  }

  const lines = {
    fieldOfficers: id("bl"), piTime: id("bl"),
    fieldTravel: id("bl"), vehicleHire: id("bl"),
    farmerTraining: id("bl"), workshops: id("bl"),
    seeds: id("bl"), equipment: id("bl"),
    smsPlatform: id("bl"), admin: id("bl"),
  };
  const lineDefs: [string, string, string, string, string, number, number][] = [
    [lines.fieldOfficers, cats.personnel, "PER-001", "Field officers (3 FTE)", "month", 1800, 36],
    [lines.piTime, cats.personnel, "PER-002", "Principal Investigator (20% LOE)", "month", 1200, 36],
    [lines.fieldTravel, cats.travel, "TRV-001", "Field travel & per diem", "trip", 350, 120],
    [lines.vehicleHire, cats.travel, "TRV-002", "Vehicle hire & fuel", "month", 900, 36],
    [lines.farmerTraining, cats.training, "TRN-001", "Farmer field schools", "session", 450, 80],
    [lines.workshops, cats.training, "TRN-002", "County stakeholder workshops", "workshop", 2200, 9],
    [lines.seeds, cats.equipment, "EQP-001", "Certified seed & inputs", "kit", 35, 5000],
    [lines.equipment, cats.equipment, "EQP-002", "Weather stations & sensors", "unit", 4200, 6],
    [lines.smsPlatform, cats.equipment, "EQP-003", "SMS advisory platform & airtime", "month", 800, 30],
    [lines.admin, cats.ops, "OPS-001", "Office & administration", "month", 1500, 36],
  ];
  for (const [lid, catId, code, desc, unit, unitCost, qty] of lineDefs) {
    await q(`INSERT INTO budget_line (id, budget_id, category_id, code, description, unit, unit_cost, quantity, planned)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [lid, budgetId, catId, code, desc, unit, unitCost, qty, unitCost * qty]);
  }

  // ---- Activities / work plan (tree + milestones + dependencies) ----
  type A = { id: string; code: string; title: string; output?: string; owner?: string; parent?: string; status?: string; progress?: number; start: number; end: number; type?: string; line?: string };
  const A1 = id("act"), A1a = id("act"), A1b = id("act"), A2 = id("act"), A2a = id("act"), A3 = id("act"), A3a = id("act"), M1 = id("act"), M2 = id("act");
  const acts: A[] = [
    { id: A1, code: "1", title: "Farmer mobilisation & training", output: out1, owner: users.coord.id, status: "in_progress", progress: 65, start: -150, end: 120 },
    { id: A1a, code: "1.1", title: "Recruit & train lead farmers", output: out1, owner: users.asst.id, parent: A1, status: "in_progress", progress: 70, start: -150, end: 30, line: lines.farmerTraining },
    { id: A1b, code: "1.2", title: "Conduct farmer field schools", output: out1, owner: users.coord.id, parent: A1, status: "in_progress", progress: 55, start: -90, end: 120, line: lines.farmerTraining },
    { id: A2, code: "2", title: "Establish demonstration plots", output: out2, owner: users.pm.id, status: "in_progress", progress: 60, start: -120, end: 90 },
    { id: A2a, code: "2.1", title: "Procure seed & inputs", output: out2, owner: users.fin.id, parent: A2, status: "done", progress: 100, start: -120, end: -40, line: lines.seeds },
    { id: A3, code: "3", title: "Deploy digital advisory service", output: out3, owner: users.pm.id, status: "in_progress", progress: 40, start: -60, end: 200 },
    { id: A3a, code: "3.1", title: "Integrate SMS platform", output: out3, owner: users.asst.id, parent: A3, status: "blocked", progress: 25, start: -30, end: 60, line: lines.smsPlatform },
    { id: M1, code: "M1", title: "Milestone: 100 farmers trained", output: out1, type: "milestone", status: "done", progress: 100, start: -20, end: -20 },
    { id: M2, code: "M2", title: "Milestone: Advisory service live", output: out3, type: "milestone", status: "not_started", progress: 0, start: 60, end: 60 },
  ];
  for (const a of acts) {
    await q(`INSERT INTO activity (id, project_id, output_id, parent_id, code, title, type, owner_id, status, progress, start_date, end_date, budget_line_id, "order")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [a.id, projectId, a.output ?? null, a.parent ?? null, a.code, a.title, a.type ?? "activity",
       a.owner ?? null, a.status ?? "not_started", a.progress ?? 0, daysFromNow(a.start), daysFromNow(a.end), a.line ?? null, 0]);
  }
  // tasks under a couple activities
  await q(`INSERT INTO task (id, activity_id, title, owner_id, status, done) VALUES ($1,$2,'Draft training curriculum',$3,'done',true)`, [id("tsk"), A1a, users.asst.id]);
  await q(`INSERT INTO task (id, activity_id, title, owner_id, status, done) VALUES ($1,$2,'Print participant materials',$3,'in_progress',false)`, [id("tsk"), A1a, users.asst.id]);
  // dependency: field schools depend on lead-farmer training
  await q(`INSERT INTO dependency (id, from_id, to_id, type) VALUES ($1,$2,$3,'FS')`, [id("dep"), A1a, A1b]);
  await q(`INSERT INTO dependency (id, from_id, to_id, type) VALUES ($1,$2,$3,'FS')`, [id("dep"), A2a, A2]);

  // ---- Expenditures (incl. a deliberate wrong-line anomaly) ----
  const exps: [string, number, number, string, string, boolean][] = [
    [lines.seeds, 38500, -38, "INV-2025-0042", "AgroSupplies Ltd", true],
    [lines.farmerTraining, 9800, -30, "INV-2025-0051", "County Training Centre", true],
    [lines.fieldTravel, 6400, -20, "INV-2025-0058", "Field team reimbursement", true],
    [lines.vehicleHire, 3600, -15, "INV-2025-0061", "Rift Valley Motors", true],
    [lines.fieldOfficers, 16200, -10, "PAY-2025-09", "Payroll September", true],
    // recorded without approval → missing_approval flag
    [lines.workshops, 7200, -5, "INV-2025-0070", "Venue & catering", false],
    // pushes the workshops line over its planned budget → over_budget (critical)
    [lines.workshops, 14000, -3, "INV-2025-0071", "Additional workshop venues", true],
    // same reference as the seed procurement above → duplicate_ref flag
    [lines.fieldTravel, 350, -2, "INV-2025-0042", "Duplicate-referenced travel claim", true],
  ];
  for (const [line, amount, when, ref, payee, approved] of exps) {
    await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id("exp"), projectId, line, amount, daysFromNow(when), ref, payee, approved, users.fin.id]);
  }

  // ---- Requisitions ----
  // (1) Retired requisition with a recorded expenditure
  const req1 = id("req");
  await q(`INSERT INTO requisition (id, project_id, number, title, activity_id, budget_line_id, amount, justification, payee, requested_by_id, status)
           VALUES ($1,$2,'REQ-0001',$3,$4,$5,$6,$7,$8,$9,'retired')`,
    [req1, projectId, "Procure certified seed for demo plots", A2a, lines.seeds, 38500,
     "Inputs for 40 demonstration plots across three counties.", "AgroSupplies Ltd", users.coord.id]);
  for (const [stepRole, st] of [["finance_admin", 1], ["pm", 2]] as const) {
    await q(`INSERT INTO requisition_approval (id, requisition_id, step, role, approver_id, decision, decided_at) VALUES ($1,$2,$3,$4,$5,'approved',now())`,
      [id("rap"), req1, st, stepRole, stepRole === "finance_admin" ? users.fin.id : users.pm.id]);
  }

  // (2) In-flight requisition: finance approved, awaiting PM signature
  const req2 = id("req");
  await q(`INSERT INTO requisition (id, project_id, number, title, activity_id, budget_line_id, amount, justification, needed_by, payee, requested_by_id, status)
           VALUES ($1,$2,'REQ-0002',$3,$4,$5,$6,$7,$8,$9,$10,'pm_approval')`,
    [req2, projectId, "County stakeholder workshop — Baringo", A1b, lines.workshops, 2200,
     "Venue, catering and facilitation for the Q4 county workshop.", daysFromNow(14), "Baringo Conference Centre", users.coord.id]);
  await q(`INSERT INTO requisition_approval (id, requisition_id, step, role, approver_id, decision, decided_at) VALUES ($1,$2,1,'finance_admin',$3,'approved',now())`,
    [id("rap"), req2, users.fin.id]);
  await q(`INSERT INTO requisition_approval (id, requisition_id, step, role, decision) VALUES ($1,$2,2,'pm','pending')`,
    [id("rap"), req2]);
  // notify PM there's a pending signature
  await q(`INSERT INTO notification (id, org_id, user_id, type, title, body, link, email_status) VALUES ($1,$2,$3,'signature',$4,$5,$6,'sent')`,
    [id("ntf"), orgId, users.pm.id, "Requisition REQ-0002 awaiting your approval", "A requisition needs your review and signature.", `/projects/${projectId}/requisitions/${req2}`]);

  // (3) Draft requisition
  const req3 = id("req");
  await q(`INSERT INTO requisition (id, project_id, number, title, activity_id, budget_line_id, amount, justification, payee, requested_by_id, status)
           VALUES ($1,$2,'REQ-0003',$3,$4,$5,$6,$7,$8,$9,'draft')`,
    [req3, projectId, "Field travel — October data collection", A1b, lines.fieldTravel, 1750,
     "Per diem and transport for the October monitoring round.", "Field team", users.coord.id]);

  // ---- Report ----
  const reportId = id("rep");
  await q(`INSERT INTO report (id, project_id, type, title, period_label, status, generated_by_ai) VALUES ($1,$2,'quarterly',$3,'2025-Q3','final',true)`,
    [reportId, projectId, "Quarterly Report — 2025-Q3"]);
  const rsecs = [
    ["summary", "Executive Summary", "In Q3 2025 the programme trained 132 lead farmers (66% of target) and established 26 demonstration plots. Budget utilisation is tracking on plan at roughly one-third of the grant."],
    ["achievements", "Key Achievements", "• Completed procurement of certified seed for all demo plots\n• Reached 2,100 farmers with SMS advisories\n• Held two county stakeholder workshops"],
    ["challenges", "Challenges", "• SMS platform integration is delayed pending a vendor API change (activity blocked)\n• Late rains compressed the planting-window training schedule"],
    ["nextsteps", "Next Steps", "• Resolve SMS integration blocker\n• Scale field schools to remaining wards\n• Begin mid-line data collection"],
  ];
  rsecs.forEach((s, i) => q(`INSERT INTO report_section (id, report_id, key, title, content, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
    [id("rsec"), reportId, s[0], s[1], s[2], i]));
  await q(`SELECT 1`);

  // ---- Folders & documents ----
  const folders = {
    proposal: id("fld"), budgets: id("fld"), reports: id("fld"), contracts: id("fld"),
  };
  await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,'Proposal & Design','proposal')`, [folders.proposal, projectId]);
  await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,'Budgets','budget')`, [folders.budgets, projectId]);
  await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,'Reports','report')`, [folders.reports, projectId]);
  await q(`INSERT INTO folder (id, project_id, name, category) VALUES ($1,$2,'Contracts & MOUs','contract')`, [folders.contracts, projectId]);
  const docs: [string, string, string, number][] = [
    [folders.proposal, "CRSA Full Proposal.pdf", "proposal", 482000],
    [folders.proposal, "Logical Framework.xlsx", "logframe", 38000],
    [folders.budgets, "GCF Approved Budget.xlsx", "budget", 91000],
    [folders.reports, "Q3 2025 Progress Report.docx", "report", 120000],
    [folders.contracts, "Grant Agreement GCF-2025-0142.pdf", "contract", 540000],
  ];
  for (const [fld, name, type, size] of docs) {
    await q(`INSERT INTO project_document (id, project_id, folder_id, name, doc_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("doc"), projectId, fld, name, type, size]);
  }

  // ---- Meetings, calendar, reminders ----
  const meetId = id("mtg");
  await q(`INSERT INTO meeting (id, project_id, title, starts_at, ends_at, location, meeting_url, agenda, attendees) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [meetId, projectId, "Monthly project review", daysFromNow(5), daysFromNow(5), "Nakuru field office",
     "https://meet.example.com/crsa-monthly", "Review Q3 progress, SMS blocker, Q4 plan",
     JSON.stringify([users.pi.id, users.pm.id, users.coord.id])]);
  await q(`INSERT INTO calendar_event (id, project_id, title, kind, starts_at, ref_entity) VALUES ($1,$2,$3,'meeting',$4,$5)`,
    [id("cev"), projectId, "Monthly project review", daysFromNow(5), `meeting:${meetId}`]);
  await q(`INSERT INTO calendar_event (id, project_id, title, kind, starts_at, ref_entity) VALUES ($1,$2,'Deadline: Advisory service live','deadline',$3,$4)`,
    [id("cev"), projectId, daysFromNow(60), `activity:${M2}`]);
  await q(`INSERT INTO reminder (id, user_id, title, due_at, ref_entity) VALUES ($1,$2,'Sign requisition REQ-0002',$3,$4)`,
    [id("rem"), users.pm.id, daysFromNow(2), `requisition:${req2}`]);

  // ---- Risks ----
  await q(`INSERT INTO risk_issue (id, project_id, kind, title, detail, severity, likelihood, status, owner_id) VALUES ($1,$2,'risk',$3,$4,'high','medium','open',$5)`,
    [id("rsk"), projectId, "SMS vendor API change delays advisory rollout", "Vendor deprecated the legacy API; integration must be reworked.", users.pm.id]);
  await q(`INSERT INTO risk_issue (id, project_id, kind, title, detail, severity, likelihood, status, owner_id) VALUES ($1,$2,'risk',$3,$4,'medium','high','mitigating',$5)`,
    [id("rsk"), projectId, "Erratic rainfall disrupts training calendar", "Compressed planting windows reduce attendance.", users.coord.id]);

  // ---- Approval matrix (explicit, mirrors defaults) ----
  await q(`INSERT INTO approval_matrix (id, org_id, doc_type, steps) VALUES ($1,$2,'requisition',$3)`,
    [id("amx"), orgId, JSON.stringify([
      { step: 1, role: "finance_admin", thresholdMin: 0 },
      { step: 2, role: "pm", thresholdMin: 0 },
      { step: 3, role: "admin", thresholdMin: 5000 },
    ])]);

  // ---- Run the anomaly engine over the seeded data ----
  const flags = await evaluateProject(projectId);

  // ---- Summary ----
  const counts = await q<{ t: string; c: number }>(`
    SELECT 'users' t, COUNT(*)::int c FROM app_user
    UNION ALL SELECT 'projects', COUNT(*)::int FROM project
    UNION ALL SELECT 'activities', COUNT(*)::int FROM activity
    UNION ALL SELECT 'budget_lines', COUNT(*)::int FROM budget_line
    UNION ALL SELECT 'expenditures', COUNT(*)::int FROM expenditure
    UNION ALL SELECT 'requisitions', COUNT(*)::int FROM requisition
    UNION ALL SELECT 'anomaly_flags', COUNT(*)::int FROM anomaly_flag`);

  console.log("\n✓ Seed complete for project:", projectId);
  console.table(counts.reduce((acc, r) => ((acc[r.t] = r.c), acc), {} as Record<string, number>));
  console.log(`  Anomaly flags generated this run: ${flags}`);
  console.log("\n  Demo logins (password: password123):");
  console.log("    admin@strand.dev      — platform admin (sees all projects)");
  console.log("    pi@strand.dev         — Principal Investigator");
  console.log("    pm@strand.dev         — Project Manager (has REQ-0002 to sign)");
  console.log("    finance@strand.dev    — Finance Administrator");
  console.log("    coord@strand.dev      — Project Coordinator");
  console.log("    assistant@strand.dev  — Research Assistant\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
