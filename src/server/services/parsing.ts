import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { writeAudit } from "@/server/services/audit";

export type SuggestionKind = "meta" | "sow_section" | "objective" | "output" | "activity" | "budget_line";
export type Suggestion = { kind: SuggestionKind; payload: Record<string, unknown>; confidence: number; sourceRef?: string };

// A pragmatic, dependency-free parser. In production AI_PROVIDER="anthropic"
// would swap this for an LLM extraction call behind the same interface.
export function parseDocument(docType: string, text: string, rows?: (string | number | Date)[][] | null): Suggestion[] {
  const out: Suggestion[] = [];

  // Spreadsheet path: budget files → budget lines; work plan / Gantt → activities.
  if (rows && rows.length) {
    if (docType === "workplan" || docType === "gantt" || docType === "timeline") {
      out.push(...parseWorkplan(rows));
    } else {
      out.push(...parseSpreadsheet(rows));
    }
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Title / meta
  const titleLine = lines.find((l) => /^(project title|title)\s*[:\-]/i.test(l));
  if (titleLine) out.push({ kind: "meta", payload: { field: "title", value: titleLine.split(/[:\-]/).slice(1).join(":").trim() }, confidence: 0.8 });
  const donorLine = lines.find((l) => /^(donor|funder|funding source)\s*[:\-]/i.test(l));
  if (donorLine) out.push({ kind: "meta", payload: { field: "donor", value: donorLine.split(/[:\-]/).slice(1).join(":").trim() }, confidence: 0.75 });

  // Objectives & outputs
  for (const l of lines) {
    const obj = l.match(/^(?:objective|goal)\s*(\d+)?\s*[:\-]\s*(.+)$/i);
    if (obj) out.push({ kind: "objective", payload: { code: `OBJ${obj[1] ?? out.filter(s=>s.kind==="objective").length + 1}`, statement: obj[2].trim() }, confidence: 0.78 });
    const op = l.match(/^(?:output|result)\s*(\d+(?:\.\d+)?)?\s*[:\-]\s*(.+)$/i);
    if (op) out.push({ kind: "output", payload: { code: `OUT${op[1] ?? ""}`.trim(), statement: op[2].trim() }, confidence: 0.7 });
  }

  // Activities (bulleted or "Activity x:")
  for (const l of lines) {
    const act = l.match(/^(?:activity|task)\s*([\d.]+)?\s*[:\-]\s*(.+)$/i);
    if (act) { out.push({ kind: "activity", payload: { code: act[1] ?? "", title: act[2].trim() }, confidence: 0.72 }); continue; }
    const bullet = l.match(/^[-*•]\s+(.{6,})$/);
    if (bullet && !/\$|budget|total/i.test(bullet[1])) out.push({ kind: "activity", payload: { title: bullet[1].trim() }, confidence: 0.5 });
  }

  // Budget lines: "Description .... 12,500" or "Item | qty | unit cost"
  for (const l of lines) {
    const m = l.match(/^(.+?)[\s.|]{2,}\$?\s*([\d,]+(?:\.\d+)?)\s*$/);
    if (m && /[a-z]/i.test(m[1]) && !/^total/i.test(m[1])) {
      const amount = parseFloat(m[2].replace(/,/g, ""));
      if (amount >= 50) out.push({ kind: "budget_line", payload: { description: m[1].trim(), planned: amount }, confidence: 0.6 });
    }
  }

  // SOW sections from headers (ALL CAPS or "1. Heading")
  const sowKeys = ["background", "scope", "deliverables", "methodology", "timeline", "reporting"];
  for (const key of sowKeys) {
    const idx = lines.findIndex((l) => new RegExp(`^\\d*\\.?\\s*${key}\\b`, "i").test(l));
    if (idx >= 0) {
      const body = lines.slice(idx + 1, idx + 6).filter(Boolean).join(" ");
      out.push({ kind: "sow_section", payload: { key, title: key[0].toUpperCase() + key.slice(1), content: body.slice(0, 600) }, confidence: 0.65 });
    }
  }

  return out;
}

// Reads budget spreadsheets shaped like real grant budgets: rows of
// "Activity Area N: ..." headers and "N.M Description ... <amounts> <total>"
// line items. Emits a budget_line per line item (planned = last numeric in row),
// and an activity suggestion per activity-area header.
function parseSpreadsheet(rows: (string | number | Date)[][]): Suggestion[] {
  const out: Suggestion[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const first = String(row[0] ?? "").trim();
    if (!first) continue;

    // skip totals / subtotals / headers
    if (/^(sub-?total|total|grand total|year|quarter|q[1-4]\b)/i.test(first)) continue;

    // Activity area header → activity suggestion
    const area = first.match(/^activity area\s*#?\s*\d+\s*[:\-]\s*(.+)$/i);
    if (area) {
      out.push({ kind: "activity", payload: { title: area[1].trim() }, confidence: 0.6, sourceRef: `row ${i + 1}` });
      continue;
    }

    // Line item: starts with a numbered code like "1.1" / "2.3.4"
    const item = first.match(/^(\d+(?:\.\d+)+)\s+(.+)$/);
    if (item) {
      const nums = row.slice(1).map((c) => (c instanceof Date ? NaN : Number(c))).filter((n) => Number.isFinite(n) && n > 0);
      const planned = nums.length ? Math.round(nums[nums.length - 1]) : 0; // last numeric = grand total
      if (planned >= 1) {
        out.push({
          kind: "budget_line",
          payload: { code: item[1], description: item[2].trim(), planned },
          confidence: 0.7, sourceRef: `row ${i + 1}`,
        });
      }
    }
  }
  return out;
}

// Reads a work plan / Gantt spreadsheet. Two shapes are supported:
//  (a) columnar — a header row with Activity/Task + Start + End columns;
//  (b) month/Gantt grid — a header row of month or "M1..Mn" columns, where the
//      first and last filled cells in a row imply the activity's span.
// Falls back to extracting activity names when dates can't be resolved.
function parseWorkplan(rows: (string | number | Date)[][]): Suggestion[] {
  const out: Suggestion[] = [];
  const cell = (r: (string | number | Date)[], i: number) => (i >= 0 && i < r.length ? r[i] : "");
  const asDate = (v: unknown): string | null => {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    if (typeof v === "string") { const d = new Date(v); if (!Number.isNaN(d.getTime()) && /\d/.test(v)) return d.toISOString().slice(0, 10); }
    return null;
  };

  // find header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => /^(activit|task|deliverable|work\s*package|milestone)/i.test(String(c)))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return out;

  const header = rows[headerIdx].map((c) => String(c).toLowerCase());
  const nameCol = header.findIndex((h) => /activit|task|deliverable|work\s*package|milestone|description/.test(h));
  const startCol = header.findIndex((h) => /\bstart|begin|from|commence/.test(h));
  const endCol = header.findIndex((h) => /\bend|finish|due|complete|\bto\b/.test(h));
  const monthCols = header
    .map((h, i) => ({ i, isMonth: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|m\s*\d+|month\s*\d+|q[1-4])/i.test(h) }))
    .filter((x) => x.isMonth).map((x) => x.i);

  // Map each month column to an absolute {year, month} when the header carries
  // one (e.g. "M1 May 26" / "Aug 2026"). Used to derive dates from Gantt shading.
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const colDate = new Map<number, { y: number; m: number }>();
  for (const ci of monthCols) {
    const mm = String(rows[headerIdx][ci]).toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\s*(\d{2,4})/);
    if (mm) { let y = parseInt(mm[2], 10); if (y < 100) y += 2000; colDate.set(ci, { y, m: MONTHS.indexOf(mm[1]) }); }
  }

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const title = String(cell(row, nameCol >= 0 ? nameCol : 0)).trim();
    if (!title || /^(sub-?total|total|grand total|activity area)/i.test(title)) continue;

    const payload: Record<string, unknown> = { title };
    const codeMatch = title.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    if (codeMatch) { payload.code = codeMatch[1]; payload.title = codeMatch[2].trim(); }

    let confidence = 0.55;
    if (startCol >= 0 || endCol >= 0) {
      const s = asDate(cell(row, startCol)); const e = asDate(cell(row, endCol));
      if (s) { payload.startDate = s; confidence = 0.8; }
      if (e) { payload.endDate = e; confidence = 0.8; }
    } else if (monthCols.length) {
      const filled = monthCols.filter((ci) => { const v = cell(row, ci); return v !== "" && v != null; });
      if (filled.length) {
        const dated = filled.map((ci) => colDate.get(ci)).filter(Boolean) as { y: number; m: number }[];
        if (dated.length) {
          dated.sort((a, b) => a.y - b.y || a.m - b.m);
          const s = dated[0], e = dated[dated.length - 1];
          payload.startDate = new Date(Date.UTC(s.y, s.m, 1)).toISOString().slice(0, 10);
          payload.endDate = new Date(Date.UTC(e.y, e.m + 1, 0)).toISOString().slice(0, 10); // month end
          confidence = 0.78;
        } else {
          confidence = 0.6; // names captured; relative columns (M1/Q1) → user sets dates
        }
      }
    }
    out.push({ kind: "activity", payload, confidence, sourceRef: `row ${i + 1}` });
  }
  return out;
}

export async function createExtractionJob(input: {
  projectId: string; userId: string; fileName: string; docType: string; text: string;
  rows?: (string | number | Date)[][] | null;
}): Promise<{ jobId: string; suggestions: number }> {
  const jobId = id("job");
  await q(
    `INSERT INTO extraction_job (id, project_id, file_name, doc_type, status, raw_text)
     VALUES ($1,$2,$3,$4,'parsed',$5)`,
    [jobId, input.projectId, input.fileName, input.docType, input.text.slice(0, 20000)]
  );
  const suggestions = parseDocument(input.docType, input.text, input.rows ?? null);
  for (const s of suggestions) {
    await q(
      `INSERT INTO parsing_suggestion (id, job_id, kind, payload, confidence, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("sug"), jobId, s.kind, JSON.stringify(s.payload), s.confidence, s.sourceRef ?? null]
    );
  }
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [input.projectId]);
  await writeAudit({ orgId: org?.orgId, userId: input.userId, action: "create", entity: "extraction_job", entityId: jobId, after: { fileName: input.fileName, suggestions: suggestions.length } });
  return { jobId, suggestions: suggestions.length };
}

// Materialize accepted suggestions into real project entities.
export async function applySuggestions(input: { jobId: string; userId: string; acceptIds: string[] }): Promise<void> {
  const job = await one<{ projectId: string }>(`SELECT project_id AS "projectId" FROM extraction_job WHERE id=$1`, [input.jobId]);
  if (!job) throw new Error("Job not found");
  const projectId = job.projectId;

  const sugs = await q<{ id: string; kind: string; payload: string }>(
    `SELECT id, kind, payload FROM parsing_suggestion WHERE job_id=$1`, [input.jobId]
  );

  // ensure a SOW + default budget exist when needed
  let sowId = (await one<{ id: string }>(`SELECT id FROM sow WHERE project_id=$1`, [projectId]))?.id ?? null;
  let budgetId = (await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version LIMIT 1`, [projectId]))?.id ?? null;

  let order = 0;
  for (const s of sugs) {
    if (!input.acceptIds.includes(s.id)) continue;
    const p = JSON.parse(s.payload) as Record<string, string | number>;

    if (s.kind === "meta") {
      const field = String(p.field);
      if (["title", "donor", "summary"].includes(field)) {
        await q(`UPDATE project SET ${field === "donor" ? "donor" : field}=$2, updated_at=now() WHERE id=$1`, [projectId, String(p.value)]);
      }
    } else if (s.kind === "sow_section") {
      if (!sowId) { sowId = id("sow"); await q(`INSERT INTO sow (id, project_id, status) VALUES ($1,$2,'draft')`, [sowId, projectId]); }
      await q(`INSERT INTO sow_section (id, sow_id, key, title, content, "order", source_ref)
               VALUES ($1,$2,$3,$4,$5,$6,'import')`,
        [id("sec"), sowId, String(p.key), String(p.title), String(p.content ?? ""), order++]);
    } else if (s.kind === "objective") {
      await q(`INSERT INTO objective (id, project_id, level, code, statement, "order") VALUES ($1,$2,'objective',$3,$4,$5)`,
        [id("obj"), projectId, String(p.code ?? "OBJ"), String(p.statement), order++]);
    } else if (s.kind === "output") {
      await q(`INSERT INTO output (id, project_id, code, statement, "order") VALUES ($1,$2,$3,$4,$5)`,
        [id("out"), projectId, String(p.code ?? "OUT"), String(p.statement), order++]);
    } else if (s.kind === "activity") {
      await q(`INSERT INTO activity (id, project_id, code, title, status, start_date, end_date, "order") VALUES ($1,$2,$3,$4,'not_started',$5,$6,$7)`,
        [id("act"), projectId, String(p.code ?? ""), String(p.title),
         p.startDate ? String(p.startDate) : null, p.endDate ? String(p.endDate) : null, order++]);
    } else if (s.kind === "budget_line") {
      if (!budgetId) { budgetId = id("bud"); await q(`INSERT INTO budget (id, project_id, name) VALUES ($1,$2,'Imported budget')`, [budgetId, projectId]); }
      const planned = Number(p.planned ?? 0);
      await q(`INSERT INTO budget_line (id, budget_id, code, description, unit, unit_cost, quantity, planned)
               VALUES ($1,$2,$3,$4,'unit',$5,1,$5)`,
        [id("bl"), budgetId, String(p.code ?? `BL-${String(order + 1).padStart(3, "0")}`), String(p.description), planned]);
      order++;
    }
    await q(`UPDATE parsing_suggestion SET accepted=true WHERE id=$1`, [s.id]);
  }
  const org = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [projectId]);
  await writeAudit({ orgId: org?.orgId, userId: input.userId, action: "apply", entity: "extraction_job", entityId: input.jobId, after: { applied: input.acceptIds.length } });
}

/* ---------------- SOW section extraction ---------------- */
// Maps free-form document text onto the standard SOW section slots by scanning
// for headings (and their common synonyms) and capturing the text beneath each.
const SOW_KEYS: { key: string; title: string; re: RegExp }[] = [
  { key: "background", title: "Project Background", re: /\b(background|introduction|overview|context|definitions?)\b/i },
  { key: "goal", title: "Goal", re: /\b(goal|purpose|aim of the project)\b/i },
  { key: "objectives", title: "Objectives", re: /\b(objectives?|specific objectives|aims|research plan|scope of work|scope)\b/i },
  { key: "deliverables", title: "Deliverables", re: /\b(deliverables?|outputs?|outcomes?|milestones?)\b/i },
  { key: "reporting", title: "Reporting Requirements", re: /\b(reporting|reports?|monitoring)\b/i },
  { key: "payment", title: "Payment Schedule", re: /\b(payment|budget|compensation|financial|funding|fees?)\b/i },
  { key: "assumptions", title: "Assumptions", re: /\b(assumptions|risks?|dependencies|terms)\b/i },
];

export function parseSowSections(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const result: Record<string, string[]> = {};
  let current: string | null = null;

  const isHeading = (l: string): string | null => {
    if (!l || l.length > 90) return null;
    // headings tend to be short, may be numbered ("1.", "Section 2:") or ALL CAPS
    const cleaned = l.replace(/^(\d+(\.\d+)*|section|article|schedule|annex)[\s.:)-]*/i, "").trim();
    for (const s of SOW_KEYS) {
      if (s.re.test(cleaned) && cleaned.split(/\s+/).length <= 8) return s.key;
    }
    return null;
  };

  for (const l of lines) {
    const h = isHeading(l);
    if (h) { current = h; result[current] ||= []; continue; }
    if (current && l) result[current].push(l);
  }

  const out: Record<string, string> = {};
  for (const k of Object.keys(result)) out[k] = result[k].join("\n").slice(0, 4000);
  // if nothing matched, drop the whole document into Background so it isn't lost
  if (Object.keys(out).length === 0 && text.trim()) out.background = text.trim().slice(0, 4000);
  return out;
}

export const SOW_SECTION_TITLES: Record<string, string> = Object.fromEntries(SOW_KEYS.map((s) => [s.key, s.title]));

/* ---------------- Work-plan / schedule extraction ---------------- */
export type ScheduleItem = { code: string | null; title: string; start: string | null; end: string | null; progress: number | null };

function toISO(cell: unknown): string | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell.toISOString();
  if (typeof cell === "number" && cell > 30000 && cell < 70000) {
    // Excel serial date → JS date
    return new Date(Date.UTC(1899, 11, 30) + cell * 86400000).toISOString();
  }
  if (typeof cell === "string" && cell.trim()) {
    const d = new Date(cell.trim());
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// Reads a Gantt/schedule spreadsheet: finds the header row, locates the
// name/start/end/progress columns by keyword, and returns one item per data row.
export function parseScheduleRows(rows: (string | number | Date)[][]): ScheduleItem[] {
  if (!rows.length) return [];
  let headerIdx = -1;
  let cName = 0, cStart = -1, cEnd = -1, cProg = -1;
  let monthCols: number[] = [];
  const colMonth = new Map<number, { y: number; m: number }>();
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = rows[i].map((c) => String(c ?? "").toLowerCase());
    const nameIdx = cells.findIndex((c) => /(activity|task|deliverable|milestone|work\s*package|description|name)/.test(c));
    if (nameIdx >= 0) {
      headerIdx = i; cName = nameIdx;
      cStart = cells.findIndex((c) => /(start|begin|from)/.test(c));
      cEnd = cells.findIndex((c) => /(end|finish|due|to\b|completion)/.test(c));
      cProg = cells.findIndex((c) => /(progress|%|percent|complete|status)/.test(c));
      monthCols = cells.map((c, ci) => ({ c, ci }))
        .filter((x) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|m\s*\d+|month\s*\d+|q[1-4])/i.test(x.c))
        .map((x) => x.ci);
      for (const ci of monthCols) {
        const mm = cells[ci].match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*'?\s*(\d{2,4})/);
        if (mm) { let y = parseInt(mm[2], 10); if (y < 100) y += 2000; colMonth.set(ci, { y, m: MONTHS.indexOf(mm[1]) }); }
      }
      break;
    }
  }

  const out: ScheduleItem[] = [];
  const startRow = headerIdx >= 0 ? headerIdx + 1 : 0;
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const raw = String(row[cName] ?? "").trim();
    if (!raw || /^(sub-?total|total|grand total)/i.test(raw)) continue;
    const m = raw.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
    const code = m ? m[1] : null;
    const title = (m ? m[2] : raw).slice(0, 200);
    let start = cStart >= 0 ? toISO(row[cStart]) : null;
    let end = cEnd >= 0 ? toISO(row[cEnd]) : null;

    // Gantt with no start/end columns: derive the span from shaded month cells.
    if (!start && !end && monthCols.length) {
      const filled = monthCols.filter((ci) => { const v = row[ci]; return v !== "" && v != null; });
      const dated = filled.map((ci) => colMonth.get(ci)).filter(Boolean) as { y: number; m: number }[];
      if (dated.length) {
        dated.sort((a, b) => a.y - b.y || a.m - b.m);
        const s = dated[0], e = dated[dated.length - 1];
        start = new Date(Date.UTC(s.y, s.m, 1)).toISOString().slice(0, 10);
        end = new Date(Date.UTC(e.y, e.m + 1, 0)).toISOString().slice(0, 10);
      }
    }
    let progress: number | null = null;
    if (cProg >= 0) {
      const pv = row[cProg];
      if (typeof pv === "number") progress = pv <= 1 ? Math.round(pv * 100) : Math.round(pv);
      else if (typeof pv === "string") { const n = parseFloat(pv); if (Number.isFinite(n)) progress = Math.round(n); }
    }
    if (title.length >= 2) out.push({ code, title, start, end, progress });
  }
  return out;
}
