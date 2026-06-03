import { q } from "@/server/db";
import { Gantt, type GanttRow } from "@/components/gantt";
import { SectionTitle, Empty, Badge } from "@/components/ui";

export default async function GanttPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await q<GanttRow>(
    `SELECT id, code, title, type, status, progress,
            start_date AS "startDate", end_date AS "endDate"
     FROM activity WHERE project_id=$1 ORDER BY "order", created_at`, [id]
  );

  return (
    <div className="space-y-5">
      <SectionTitle action={
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          <Badge tone="brand">◆ milestone</Badge>
          <span>dashed line = today</span>
        </div>
      }>Project timeline</SectionTitle>

      {rows.length === 0 ? (
        <Empty title="No activities to chart" hint="Add activities with start and end dates on the Work plan tab to see the Gantt timeline." />
      ) : (
        <>
          <Gantt rows={rows} />
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Bars are tinted by status and filled to percent complete; parent bars roll up from their
            sub-activities. Manage dates and dependencies on the Work plan tab.
          </p>
        </>
      )}
    </div>
  );
}
