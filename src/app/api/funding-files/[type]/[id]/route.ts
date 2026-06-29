import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { readUpload } from "@/server/services/storage";

export async function GET(_req: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) return new Response("Forbidden", { status: 403 });
  const table = type === "receipt" ? "funding_receipt" : type === "agreement" ? "funding_agreement" : null;
  if (!table) return new Response("Bad type", { status: 400 });
  const row = await one<{ fileKey: string | null; fileName: string | null }>(
    `SELECT file_key AS "fileKey", file_name AS "fileName" FROM ${table} WHERE id=$1 AND org_id=$2`, [id, org.id]);
  if (!row || !row.fileKey) return new Response("No file", { status: 404 });
  try {
    const buf = await readUpload(row.fileKey);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${(row.fileName || "document").replace(/"/g, "")}"`,
      },
    });
  } catch {
    return new Response("File missing on disk", { status: 404 });
  }
}
