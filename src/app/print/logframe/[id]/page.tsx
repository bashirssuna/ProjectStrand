import { redirect } from "next/navigation";
import { q, one } from "@/server/db";
import { getProjectAccess } from "@/server/policy";
import { num } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintLogframe({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  if (!access.permissions.has("project.view")) redirect("/dashboard");
  const proj = await one<{ title: string; code: string; orgId: string }>(`SELECT title, code, org_id AS "orgId" FROM project WHERE id=$1`, [id]);
  if (!proj) redirect("/dashboard");

  const objectives = await q<{ id: string; level: string; code: string; statement: string; narrative: string | null }>(
    `SELECT id, level, code, statement, narrative FROM objective WHERE project_id=$1 ORDER BY (level='goal') DESC, "order", code`, [id]
  );
  const outputs = await q<{ id: string; code: string; statement: string }>(
    `SELECT id, code, statement FROM output WHERE project_id=$1 ORDER BY "order", code`, [id]
  );
  const indicators = await q<{ id: string; objectiveId: string | null; outputId: string | null; name: string; baseline: number; target: number; unit: string; mov: string | null; assumptions: string | null; latest: number }>(
    `SELECT i.id, i.objective_id AS "objectiveId", i.output_id AS "outputId", i.name, i.baseline, i.target, i.unit,
            i.means_of_verification AS mov, i.assumptions,
            COALESCE((SELECT value FROM indicator_actual WHERE indicator_id=i.id ORDER BY recorded_at DESC LIMIT 1),0) AS latest
     FROM indicator i LEFT JOIN objective o ON o.id=i.objective_id LEFT JOIN output op ON op.id=i.output_id
     WHERE COALESCE(o.project_id, (SELECT project_id FROM output WHERE id=i.output_id))=$1 ORDER BY i.name`, [id]
  );
  const lh = await getLetterhead(proj.orgId);

  const goals = objectives.filter((o) => o.level === "goal");
  const objs = objectives.filter((o) => o.level !== "goal");
  const objInds = (oid: string) => indicators.filter((i) => i.objectiveId === oid);
  const outInds = (oid: string) => indicators.filter((i) => i.outputId === oid);
  const prog = (i: { baseline: number; target: number; latest: number }) => { const d = i.target - i.baseline; return d === 0 ? (i.latest >= i.target ? 100 : 0) : Math.max(0, Math.min(100, Math.round(((i.latest - i.baseline) / d) * 100))); };
  const join = (v: (string | null)[]) => { const f = v.filter(Boolean) as string[]; return f.length ? f.join("; ") : "—"; };

  const th: React.CSSProperties = { border: "1px solid #888", padding: "6px 8px", background: "#eee", textAlign: "left", fontSize: 11, fontWeight: 700 };
  const td: React.CSSProperties = { border: "1px solid #bbb", padding: "6px 8px", fontSize: 11, verticalAlign: "top" };
  const band: React.CSSProperties = { border: "1px solid #888", padding: "5px 8px", background: "#f3f3f3", fontWeight: 700, fontSize: 11, letterSpacing: 0.5 };

  const indCell = (inds: typeof indicators) => inds.length ? (
    <div>{inds.map((i) => <div key={i.id} style={{ marginBottom: 4 }}><strong>{i.name}</strong> ({i.unit}): {num(i.baseline)} → <strong>{num(i.latest)}</strong> / {num(i.target)} ({prog(i)}%)</div>)}</div>
  ) : "—";

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "34px 26px", fontSize: 12 }}>
        <PrintLetterhead lh={lh} subtitle={`Logical Framework — ${proj.code}: ${proj.title}`} />
        <div style={{ textAlign: "center", margin: "12px 0 14px", fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Logical Framework Matrix</div>

        {objectives.length === 0 && outputs.length === 0 ? <p style={{ color: "#555" }}>No logframe has been defined for this project yet.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ ...th, width: "30%" }}>Results / narrative summary</th><th style={th}>Indicators · baseline → latest / target</th><th style={th}>Means of verification</th><th style={th}>Assumptions</th></tr></thead>
            <tbody>
              {goals.length > 0 && <tr><td colSpan={4} style={band}>GOAL</td></tr>}
              {goals.map((g) => { const inds = objInds(g.id); return (
                <tr key={g.id}><td style={td}><strong>{g.code}</strong> {g.statement}{g.narrative ? <div style={{ color: "#555", marginTop: 3 }}>{g.narrative}</div> : null}</td><td style={td}>{indCell(inds)}</td><td style={td}>{join(inds.map((i) => i.mov))}</td><td style={td}>{join(inds.map((i) => i.assumptions))}</td></tr>
              ); })}
              {objs.length > 0 && <tr><td colSpan={4} style={band}>OBJECTIVES / OUTCOMES</td></tr>}
              {objs.map((o) => { const inds = objInds(o.id); return (
                <tr key={o.id}><td style={td}><strong>{o.code}</strong> {o.statement}{o.narrative ? <div style={{ color: "#555", marginTop: 3 }}>{o.narrative}</div> : null}</td><td style={td}>{indCell(inds)}</td><td style={td}>{join(inds.map((i) => i.mov))}</td><td style={td}>{join(inds.map((i) => i.assumptions))}</td></tr>
              ); })}
              {outputs.length > 0 && <tr><td colSpan={4} style={band}>OUTPUTS</td></tr>}
              {outputs.map((o) => { const inds = outInds(o.id); return (
                <tr key={o.id}><td style={td}><strong>{o.code}</strong> {o.statement}</td><td style={td}>{indCell(inds)}</td><td style={td}>{join(inds.map((i) => i.mov))}</td><td style={td}>{join(inds.map((i) => i.assumptions))}</td></tr>
              ); })}
            </tbody>
          </table>
        )}
        <p style={{ marginTop: 16, fontSize: 10, color: "#666" }}>Latest indicator values are drawn live from Project Strand at time of printing.</p>
        <div style={{ marginTop: 14 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
