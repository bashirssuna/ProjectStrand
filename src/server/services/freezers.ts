import "server-only";
import { q, one } from "@/server/db";

// A reading is in range when it sits within whichever bounds are set.
export function inRange(temp: number, min: number | null | undefined, max: number | null | undefined): boolean {
  if (min != null && temp < min) return false;
  if (max != null && temp > max) return false;
  return true;
}

export type FreezerRow = {
  id: string; name: string; location: string | null; kind: string; status: string;
  setPoint: number | null; minTemp: number | null; maxTemp: number | null;
  lastTemp: number | null; lastReadingAt: string | null; lastInRange: boolean | null;
  openIncidents: number; criticalOpen: number;
};

export async function listFreezers(orgId: string): Promise<FreezerRow[]> {
  return await q<FreezerRow>(
    `SELECT f.id, f.name, f.location, f.kind, f.status, f.set_point AS "setPoint", f.min_temp AS "minTemp", f.max_temp AS "maxTemp",
            lt.temperature AS "lastTemp", lt.reading_at AS "lastReadingAt", lt.in_range AS "lastInRange",
            COALESCE((SELECT COUNT(*) FROM lab_freezer_incident i WHERE i.freezer_id=f.id AND i.resolved=false),0)::int AS "openIncidents",
            COALESCE((SELECT COUNT(*) FROM lab_freezer_incident i WHERE i.freezer_id=f.id AND i.resolved=false AND i.severity='critical'),0)::int AS "criticalOpen"
     FROM lab_freezer f
     LEFT JOIN LATERAL (SELECT temperature, reading_at, in_range FROM lab_temp_log WHERE freezer_id=f.id ORDER BY reading_at DESC LIMIT 1) lt ON true
     WHERE f.org_id=$1 ORDER BY f.name`, [orgId]
  );
}

export async function getFreezer(orgId: string, id: string) {
  return await one<{
    id: string; name: string; location: string | null; kind: string; status: string;
    setPoint: number | null; minTemp: number | null; maxTemp: number | null; assetId: string | null; notes: string | null;
  }>(
    `SELECT id, name, location, kind, status, set_point AS "setPoint", min_temp AS "minTemp", max_temp AS "maxTemp", asset_id AS "assetId", notes
     FROM lab_freezer WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
}

export type TempLogRow = { id: string; readingAt: string; temperature: number; minReading: number | null; maxReading: number | null; inRange: boolean; note: string | null; recordedByName: string | null };
export async function freezerTempLogs(freezerId: string, limit = 60): Promise<TempLogRow[]> {
  return await q<TempLogRow>(
    `SELECT id, reading_at AS "readingAt", temperature, min_reading AS "minReading", max_reading AS "maxReading", in_range AS "inRange", note, recorded_by_name AS "recordedByName"
     FROM lab_temp_log WHERE freezer_id=$1 ORDER BY reading_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`, [freezerId]
  );
}

export type IncidentRow = { id: string; incidentAt: string; kind: string; severity: string; description: string | null; actionTaken: string | null; resolved: boolean; resolvedAt: string | null; reportedByName: string | null };
export async function freezerIncidents(freezerId: string): Promise<IncidentRow[]> {
  return await q<IncidentRow>(
    `SELECT id, incident_at AS "incidentAt", kind, severity, description, action_taken AS "actionTaken", resolved, resolved_at AS "resolvedAt", reported_by_name AS "reportedByName"
     FROM lab_freezer_incident WHERE freezer_id=$1 ORDER BY resolved ASC, incident_at DESC`, [freezerId]
  );
}

export type FreezerStats = { total: number; outOfRange: number; openIncidents: number; criticalOpen: number };
export async function freezerStats(orgId: string): Promise<FreezerStats> {
  const total = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM lab_freezer WHERE org_id=$1`, [orgId]))?.c ?? 0;
  const outOfRange = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM lab_freezer f WHERE f.org_id=$1 AND f.status='active'
       AND (SELECT in_range FROM lab_temp_log WHERE freezer_id=f.id ORDER BY reading_at DESC LIMIT 1)=false`, [orgId]))?.c ?? 0;
  const openIncidents = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM lab_freezer_incident i JOIN lab_freezer f ON f.id=i.freezer_id WHERE f.org_id=$1 AND i.resolved=false`, [orgId]))?.c ?? 0;
  const criticalOpen = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM lab_freezer_incident i JOIN lab_freezer f ON f.id=i.freezer_id WHERE f.org_id=$1 AND i.resolved=false AND i.severity='critical'`, [orgId]))?.c ?? 0;
  return { total, outOfRange, openIncidents, criticalOpen };
}
