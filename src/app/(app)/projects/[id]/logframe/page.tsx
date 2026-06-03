import { q } from "@/server/db";
import { SectionTitle, Empty, ProgressBar, Badge } from "@/components/ui";
import { pct, num } from "@/lib/format";

export default async function LogframePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const objectives = await q<{ id: string; code: string; statement: string; narrative: string | null }>(
    `SELECT id, code, statement, narrative FROM objective WHERE project_id=$1 ORDER BY "order", code`, [id]
  );
  const outputs = await q<{ id: string; objectiveId: string | null; code: string; statement: string }>(
    `SELECT id, objective_id AS "objectiveId", code, statement FROM output WHERE project_id=$1 ORDER BY "order", code`, [id]
  );
  const indicators = await q<{
    id: string; objectiveId: string | null; outputId: string | null; name: string;
    baseline: number; target: number; unit: string; mov: string | null; latest: number;
  }>(
    `SELECT i.id, i.objective_id AS "objectiveId", i.output_id AS "outputId", i.name,
            i.baseline, i.target, i.unit, i.means_of_verification AS mov,
            COALESCE((SELECT value FROM indicator_actual WHERE indicator_id=i.id ORDER BY recorded_at DESC LIMIT 1),0) AS latest
     FROM indicator i
     LEFT JOIN objective o ON o.id = i.objective_id
     LEFT JOIN output op ON op.id = i.output_id
     WHERE COALESCE(o.project_id, (SELECT project_id FROM output WHERE id=i.output_id)) = $1
     ORDER BY i.name`, [id]
  );

  if (objectives.length === 0 && outputs.length === 0) {
    return <Empty title="No logframe yet" hint="Import a proposal or add objectives and indicators to build the results framework." />;
  }

  const indFor = (objId: string, outIds: string[]) =>
    indicators.filter((i) => i.objectiveId === objId || (i.outputId && outIds.includes(i.outputId)));

  function indicatorProgress(i: { baseline: number; target: number; latest: number }) {
    const denom = i.target - i.baseline;
    if (denom === 0) return i.latest >= i.target ? 100 : 0;
    return Math.max(0, Math.min(100, ((i.latest - i.baseline) / denom) * 100));
  }

  return (
    <div className="space-y-6">
      {objectives.map((obj) => {
        const objOutputs = outputs.filter((o) => o.objectiveId === obj.id);
        const objInds = indFor(obj.id, objOutputs.map((o) => o.id));
        return (
          <div key={obj.id} className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Badge tone="brand">{obj.code}</Badge>
              <span className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Objective</span>
            </div>
            <h3 className="font-display text-lg font-semibold">{obj.statement}</h3>
            {obj.narrative && <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>{obj.narrative}</p>}

            {objOutputs.length > 0 && (
              <div className="mt-3 space-y-1">
                {objOutputs.map((o) => (
                  <div key={o.id} className="text-sm flex gap-2">
                    <span className="font-mono text-xs mt-0.5" style={{ color: "var(--muted)" }}>{o.code}</span>
                    <span>{o.statement}</span>
                  </div>
                ))}
              </div>
            )}

            {objInds.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr>
                    <th className="th text-left">Indicator</th>
                    <th className="th text-right">Baseline</th>
                    <th className="th text-right">Latest</th>
                    <th className="th text-right">Target</th>
                    <th className="th text-left" style={{ width: 180 }}>Progress</th>
                    <th className="th text-left">Verification</th>
                  </tr></thead>
                  <tbody>
                    {objInds.map((i) => {
                      const p = indicatorProgress(i);
                      return (
                        <tr key={i.id}>
                          <td className="td">{i.name} <span className="text-xs" style={{ color: "var(--muted)" }}>({i.unit})</span></td>
                          <td className="td text-right tabular-nums">{num(i.baseline)}</td>
                          <td className="td text-right tabular-nums font-medium">{num(i.latest)}</td>
                          <td className="td text-right tabular-nums">{num(i.target)}</td>
                          <td className="td"><ProgressBar value={p} tone={p >= 100 ? "ok" : p >= 50 ? "brand" : "warn"} showLabel /></td>
                          <td className="td text-xs" style={{ color: "var(--muted)" }}>{i.mov ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {(() => {
        const orphanInd = indicators.filter((i) => !objectives.some((o) => indFor(o.id, outputs.filter((op) => op.objectiveId === o.id).map((op) => op.id)).includes(i)));
        if (orphanInd.length === 0) return null;
        return (
          <div className="card p-5">
            <SectionTitle>Other indicators</SectionTitle>
            <table className="w-full text-sm">
              <tbody>
                {orphanInd.map((i) => (
                  <tr key={i.id}>
                    <td className="td">{i.name}</td>
                    <td className="td text-right tabular-nums">{num(i.latest)} / {num(i.target)} {i.unit}</td>
                    <td className="td" style={{ width: 180 }}><ProgressBar value={i.target > 0 ? (i.latest / i.target) * 100 : 0} showLabel /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}
