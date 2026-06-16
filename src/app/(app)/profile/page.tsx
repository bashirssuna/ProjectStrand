import Link from "next/link";
import { requireUser } from "@/server/auth";
import { q, one } from "@/server/db";
import { updateProfileAction, changePasswordAction, uploadAvatarAction, signOut } from "@/app/actions";
import { SignaturePad } from "@/components/signature-pad";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ pw?: string; avatar?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const profile = await one<{ title: string | null; phone: string | null; bio: string | null; avatarUrl: string | null }>(
    `SELECT title, phone, bio, avatar_url AS "avatarUrl" FROM user_profile WHERE user_id=$1`, [user.id]
  );
  const sig = await one<{ dataUrl: string | null }>(`SELECT data_url AS "dataUrl" FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [user.id]);

  const assigned = await q<{ id: string; title: string; status: string; projectId: string; endDate: string | null }>(
    `SELECT id, title, status, project_id AS "projectId", end_date AS "endDate"
     FROM activity WHERE owner_id=$1 AND status NOT IN ('done','cancelled') ORDER BY end_date NULLS LAST LIMIT 10`, [user.id]
  );
  const pending = await q<{ id: string; number: string; amount: number; projectId: string }>(
    `SELECT r.id, r.number, r.amount, r.project_id AS "projectId"
     FROM requisition r
     JOIN requisition_approval ra ON ra.requisition_id=r.id AND ra.decision='pending'
     JOIN project_member pm ON pm.project_id=r.project_id AND pm.user_id=$1
     WHERE (ra.role='pm' AND pm.role IN ('project_manager','pi','co_pi'))
        OR (ra.role='finance_admin' AND pm.role='finance_admin')
        OR (ra.role='admin' AND pm.role IN ('pi','co_pi'))
     GROUP BY r.id, r.number, r.amount, r.project_id`, [user.id]
  );

  return (
    <div className="max-w-3xl space-y-7">
      <PageHeader title="My profile" subtitle="Your details, photo, password, signature and assigned work."
        actions={<form action={signOut}><button className="btn btn-sm" type="submit">Sign out</button></form>} />

      {/* Profile photo */}
      <div className="card p-5">
        <SectionTitle>Profile photo</SectionTitle>
        {sp.avatar === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Photo updated.</p>}
        {sp.avatar === "type" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Please choose an image file.</p>}
        {sp.avatar === "size" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Image must be under 2 MB.</p>}
        <div className="flex items-center gap-4">
          <div style={{ width: 72, height: 72, borderRadius: "50%", overflow: "hidden", background: "var(--surface)", border: "1px solid var(--border)", display: "grid", placeItems: "center" }}>
            {profile?.avatarUrl
              ? <img src={profile.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span className="font-display text-2xl" style={{ color: "var(--muted)" }}>{user.name.slice(0, 1).toUpperCase()}</span>}
          </div>
          <form action={uploadAvatarAction} className="flex items-end gap-2">
            <Field label="Upload a photo (max 2 MB)"><input type="file" name="file" accept="image/*" required className="input" /></Field>
            <button className="btn btn-primary" type="submit">Upload</button>
          </form>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <form action={updateProfileAction} className="card p-5 space-y-3">
          <SectionTitle>Details</SectionTitle>
          <Field label="Name"><input name="name" defaultValue={user.name} className="input" /></Field>
          <Field label="Title"><input name="title" defaultValue={profile?.title ?? ""} className="input" placeholder="Principal Investigator" /></Field>
          <Field label="Phone"><input name="phone" defaultValue={profile?.phone ?? ""} className="input" /></Field>
          <Field label="Bio"><textarea name="bio" defaultValue={profile?.bio ?? ""} rows={3} className="textarea" /></Field>
          <div className="text-xs" style={{ color: "var(--muted)" }}>Email: {user.email}</div>
          <button className="btn btn-primary" type="submit">Save profile</button>
        </form>

        <div className="card p-5">
          <SectionTitle>Signature</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Used to sign requisition approvals. Drawn signatures are stored as an image asset.</p>
          <SignaturePad existing={sig?.dataUrl ?? null} />
        </div>
      </div>

      <div className="card p-5">
        <SectionTitle>Change password</SectionTitle>
        {sp.pw === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Password updated.</p>}
        {sp.pw === "wrong" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>Your current password is incorrect.</p>}
        {sp.pw === "match" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>The new passwords don&apos;t match.</p>}
        {sp.pw && !["ok", "wrong", "match"].includes(sp.pw) && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>{sp.pw}</p>}
        <form action={changePasswordAction} className="grid sm:grid-cols-3 gap-3 items-end">
          <Field label="Current password"><input type="password" name="currentPassword" required className="input" /></Field>
          <Field label="New password"><input type="password" name="newPassword" required minLength={8} className="input" /></Field>
          <Field label="Confirm new password"><input type="password" name="confirmPassword" required minLength={8} className="input" /></Field>
          <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs" style={{ color: "var(--muted)" }}>At least 8 characters, with one capital letter and one special character.</span>
            <button className="btn btn-primary" type="submit">Update password</button>
          </div>
        </form>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div>
          <SectionTitle>My assigned work</SectionTitle>
          {assigned.length === 0 ? <Empty title="Nothing assigned" /> : (
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {assigned.map((a) => (
                <Link key={a.id} href={`/projects/${a.projectId}/workplan`} className="block p-3 hover:bg-[var(--surface)]" style={{ borderColor: "var(--border)" }}>
                  <div className="text-sm font-medium">{a.title}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge tone="info">{label(a.status)}</Badge>
                    {a.endDate && <span className="text-xs" style={{ color: "var(--muted)" }}>due {fmtDate(a.endDate)}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionTitle>Awaiting my approval</SectionTitle>
          {pending.length === 0 ? <Empty title="Nothing to sign" /> : (
            <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
              {pending.map((p) => (
                <Link key={p.id} href={`/projects/${p.projectId}/requisitions/${p.id}`} className="flex items-center justify-between p-3 hover:bg-[var(--surface)]" style={{ borderColor: "var(--border)" }}>
                  <span className="font-mono text-sm">{p.number}</span>
                  <span className="tabular-nums text-sm">{money(p.amount)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
