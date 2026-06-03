import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetSummary } from "@/server/services/budget";
import { money, pct } from "@/lib/format";

const TONE_HEX = { ok: "2E7D32", brand: "2F5D62", info: "1565C0", warn: "B26A00", danger: "B3261E", muted: "9AA0A6" };
function toneFor(p: number): keyof typeof TONE_HEX {
  if (p >= 100) return "ok"; if (p >= 67) return "brand"; if (p >= 34) return "info"; if (p >= 1) return "warn"; return "muted";
}

export async function GET(_req: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const report = await one<{ projectId: string; title: string; type: string; period: string | null; ai: boolean }>(
    `SELECT project_id AS "projectId", title, type, period_label AS period, generated_by_ai AS ai FROM report WHERE id=$1`, [reportId]
  );
  if (!report) return new Response("Not found", { status: 404 });
  if (!(await can(report.projectId, "project.view"))) return new Response("Forbidden", { status: 403 });

  const project = await one<{ title: string; code: string; donor: string | null; currency: string }>(
    `SELECT title, code, donor, currency FROM project WHERE id=$1`, [report.projectId]
  );
  const c = project?.currency ?? "USD";
  const sections = await q<{ title: string; content: string }>(
    `SELECT title, content FROM report_section WHERE report_id=$1 ORDER BY "order"`, [reportId]
  );
  const acts = await q<{ title: string; status: string; progress: number; type: string }>(
    `SELECT title, status, progress, type FROM activity WHERE project_id=$1 AND type<>'milestone' ORDER BY "order"`, [report.projectId]
  );
  const inds = await q<{ name: string; target: number; unit: string; latest: number }>(
    `SELECT i.name, i.target, i.unit,
            COALESCE((SELECT value FROM indicator_actual WHERE indicator_id=i.id ORDER BY recorded_at DESC LIMIT 1),0) AS latest
     FROM indicator i JOIN objective o ON o.id=i.objective_id WHERE o.project_id=$1`, [report.projectId]
  );
  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [report.projectId]);
  const bs = bud ? await budgetSummary(bud.id) : null;

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle,
  } = await import("docx");

  // colored block-bar paragraph (renders everywhere, no image generation needed)
  const bar = (value: number) => {
    const filled = Math.max(0, Math.min(20, Math.round(value / 5)));
    return new Paragraph({
      children: [
        new TextRun({ text: "\u2588".repeat(filled), color: TONE_HEX[toneFor(value)], font: "Consolas" }),
        new TextRun({ text: "\u2591".repeat(20 - filled), color: "D9D9D9", font: "Consolas" }),
        new TextRun({ text: `  ${Math.round(value)}%`, bold: true }),
      ],
    });
  };

  const noBorders = { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } } as const;
  const barTable = (items: { label: string; value: number }[]) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { ...noBorders, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
    rows: items.map((it) => new TableRow({
      children: [
        new TableCell({ width: { size: 45, type: WidthType.PERCENTAGE }, borders: noBorders, children: [new Paragraph({ children: [new TextRun({ text: it.label, size: 20 })] })] }),
        new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: noBorders, children: [bar(it.value)] }),
      ],
    })),
  });

  const heading = (t: string) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 80 } });
  const body: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

  // Title block
  body.push(new Paragraph({ children: [new TextRun({ text: report.title, bold: true, size: 32 })] }));
  body.push(new Paragraph({ children: [new TextRun({ text: `${project?.title ?? ""} · ${project?.code ?? ""}${project?.donor ? " · " + project.donor : ""}`, color: "666666" })], spacing: { after: 120 } }));
  if (report.ai) body.push(new Paragraph({ children: [new TextRun({ text: "AI-generated draft — reviewed by project team.", italics: true, color: "888888", size: 18 })], spacing: { after: 120 } }));

  // Narrative sections
  for (const s of sections) {
    body.push(heading(s.title));
    for (const line of s.content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("•") || t.startsWith("-")) body.push(new Paragraph({ text: t.replace(/^[•\-]\s*/, ""), bullet: { level: 0 } }));
      else body.push(new Paragraph({ children: [new TextRun(t)] }));
    }
  }

  // Analysis (computed from the workplan)
  const done = acts.filter((a) => a.status === "done").length;
  const blocked = acts.filter((a) => a.status === "blocked").length;
  const inProg = acts.filter((a) => a.status === "in_progress").length;
  const avg = acts.length ? Math.round(acts.reduce((s, a) => s + a.progress, 0) / acts.length) : 0;
  body.push(heading("Analysis — Work Plan"));
  body.push(new Paragraph({ children: [new TextRun(
    `${acts.length} activities tracked: ${done} completed, ${inProg} in progress, ${blocked} blocked. ` +
    `Average activity progress is ${avg}%.` + (bs ? ` Budget utilisation is ${pct(bs.burn)}.` : "")
  )], spacing: { after: 100 } }));

  // Charts
  if (acts.length) {
    body.push(new Paragraph({ children: [new TextRun({ text: "Activity progress", bold: true })], spacing: { before: 80, after: 60 } }));
    body.push(barTable(acts.map((a) => ({ label: a.title, value: a.progress }))));
  }
  if (inds.length) {
    body.push(new Paragraph({ children: [new TextRun({ text: "Indicator progress vs target", bold: true })], spacing: { before: 160, after: 60 } }));
    body.push(barTable(inds.map((i) => ({ label: `${i.name} (${i.latest}/${i.target} ${i.unit})`, value: i.target > 0 ? (i.latest / i.target) * 100 : 0 }))));
  }
  if (bs) {
    body.push(new Paragraph({ children: [new TextRun({ text: "Budget utilisation", bold: true })], spacing: { before: 160, after: 60 } }));
    body.push(barTable([{ label: `Spent ${money(bs.actual, c)} of ${money(bs.planned, c)}`, value: bs.burn }]));
  }

  body.push(new Paragraph({ children: [new TextRun({ text: `Generated by Project Strand · ${new Date().toLocaleDateString()}`, color: "999999", size: 16 })], spacing: { before: 240 }, alignment: AlignmentType.RIGHT }));

  const doc = new Document({ sections: [{ children: body }] });
  const buf = await Packer.toBuffer(doc);
  const fname = report.title.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "_") + ".docx";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}
