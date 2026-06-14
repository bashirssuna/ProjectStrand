import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { updateOrgProfileAction, uploadOrgLogoAction, removeOrgLogoAction, changeAdminPasswordAction } from "@/app/actions";

export default async function OrganizationPage({ searchParams }: { searchParams: Promise<{ saved?: string; logo?: string; err?: string; pw?: string }> }) {
  const user = await requireUser();
  const userOrg = await getUserOrg(user.id);
  if (!userOrg || (!userOrg.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const sp = await searchParams;
  const o = (await one<{
    name: string; logoDataUrl: string | null; address: string | null; email: string | null; phone: string | null;
    website: string | null; slogan: string | null; mission: string | null; vision: string | null; valuesText: string | null;
    objectives: string | null; registrationNo: string | null; tin: string | null; brandColor: string;
    twitter: string | null; linkedin: string | null; facebook: string | null;
  }>(
    `SELECT name, logo_data_url AS "logoDataUrl", address, email, phone, website, slogan, mission, vision,
            values_text AS "valuesText", objectives, registration_no AS "registrationNo", tin, brand_color AS "brandColor",
            social_twitter AS twitter, social_linkedin AS linkedin, social_facebook AS facebook
     FROM organization WHERE id=$1`, [userOrg.id]
  ))!;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Organisation profile" subtitle="Your institution's details, branding and letterhead" />

      <a href="/organization/access" className="card p-4 mb-5 flex items-center justify-between gap-3 hover:border-[var(--brand)]" style={{ display: "flex" }}>
        <div>
          <div className="font-display font-semibold">Access &amp; permissions</div>
          <div className="text-sm" style={{ color: "var(--muted)" }}>See everyone&apos;s rights and manage roles &amp; fine-grained permissions — by person or by department.</div>
        </div>
        <span className="btn btn-sm">Open →</span>
      </a>

      <a href="/organization/subscription" className="card p-4 mb-5 flex items-center justify-between gap-3 hover:border-[var(--brand)]" style={{ display: "flex" }}>
        <div>
          <div className="font-display font-semibold">Subscription &amp; renewals</div>
          <div className="text-sm" style={{ color: "var(--muted)" }}>See your renewal countdown, request a 1/3/5-year renewal, and upload proof of payment.</div>
        </div>
        <span className="btn btn-sm">Open →</span>
      </a>
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Profile saved.</div>}
      {sp.logo === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Logo updated — it now appears on all printouts.</div>}
      {sp.logo === "removed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>Logo removed.</div>}
      {sp.err === "logosize" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Logo must be under 2MB.</div>}
      {sp.err === "logo" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please choose an image file.</div>}
      {sp.pw === "changed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Password changed.</div>}
      {sp.pw === "wrong" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Current password is incorrect.</div>}
      {sp.pw && !["changed", "wrong"].includes(sp.pw) && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.pw)}</div>}

      {/* Logo / letterhead */}
      <SectionTitle>Logo &amp; letterhead</SectionTitle>
      <div className="card p-4 mb-6 flex flex-wrap items-center gap-6">
        <div style={{ width: 180, height: 90, border: "1px dashed var(--border)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "#fff", overflow: "hidden" }}>
          {o.logoDataUrl ? <img src={o.logoDataUrl} alt="Logo" style={{ maxHeight: 84, maxWidth: 172, objectFit: "contain" }} /> : <span className="text-xs" style={{ color: "var(--muted)" }}>No logo</span>}
        </div>
        <div className="flex-1 min-w-[260px]">
          <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>Your logo and address appear as the headed paper on every printout — requisitions, vouchers, invoices, receipts, payslips and financial statements. PNG or JPG, under 2MB.</p>
          <div className="flex gap-2 items-center">
            <form action={uploadOrgLogoAction} className="flex items-center gap-2">
              <input type="file" name="logo" accept="image/*" required className="input" />
              <button className="btn btn-primary btn-sm" type="submit">Upload logo</button>
            </form>
            {o.logoDataUrl && <form action={removeOrgLogoAction}><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form>}
          </div>
        </div>
      </div>

      {/* Core details */}
      <form action={updateOrgProfileAction}>
        <SectionTitle>Details &amp; contact</SectionTitle>
        <div className="card p-4 grid sm:grid-cols-2 gap-3 mb-6">
          <div className="sm:col-span-2"><Field label="Organisation name"><input name="name" defaultValue={o.name} required className="input" /></Field></div>
          <div className="sm:col-span-2"><Field label="Slogan / motto"><input name="slogan" defaultValue={o.slogan ?? ""} className="input" placeholder="A short tagline shown under the name on letterhead" /></Field></div>
          <div className="sm:col-span-2"><Field label="Address"><textarea name="address" rows={2} defaultValue={o.address ?? ""} className="textarea" placeholder="Physical / postal address — appears on letterhead" /></Field></div>
          <Field label="Email"><input name="email" defaultValue={o.email ?? ""} className="input" /></Field>
          <Field label="Phone"><input name="phone" defaultValue={o.phone ?? ""} className="input" /></Field>
          <Field label="Website"><input name="website" defaultValue={o.website ?? ""} className="input" /></Field>
          <Field label="Registration no."><input name="registrationNo" defaultValue={o.registrationNo ?? ""} className="input" /></Field>
          <Field label="TIN (tax no.)"><input name="tin" defaultValue={o.tin ?? ""} className="input" placeholder="Appears on invoices & receipts" /></Field>
          <Field label="Brand colour"><input type="color" name="brandColor" defaultValue={o.brandColor} className="input" style={{ height: 38, padding: 4 }} /></Field>
        </div>

        <SectionTitle>Socials</SectionTitle>
        <div className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
          <Field label="Twitter / X"><input name="twitter" defaultValue={o.twitter ?? ""} className="input" placeholder="@handle or URL" /></Field>
          <Field label="LinkedIn"><input name="linkedin" defaultValue={o.linkedin ?? ""} className="input" /></Field>
          <Field label="Facebook"><input name="facebook" defaultValue={o.facebook ?? ""} className="input" /></Field>
        </div>

        <SectionTitle>Mission, vision &amp; values</SectionTitle>
        <div className="card p-4 grid gap-3 mb-6">
          <Field label="Mission"><textarea name="mission" rows={2} defaultValue={o.mission ?? ""} className="textarea" /></Field>
          <Field label="Vision"><textarea name="vision" rows={2} defaultValue={o.vision ?? ""} className="textarea" /></Field>
          <Field label="Core values"><textarea name="valuesText" rows={2} defaultValue={o.valuesText ?? ""} className="textarea" placeholder="e.g. Integrity, Rigour, Collaboration" /></Field>
          <Field label="Objectives"><textarea name="objectives" rows={3} defaultValue={o.objectives ?? ""} className="textarea" /></Field>
          <div className="flex justify-end"><button className="btn btn-primary" type="submit">Save organisation profile</button></div>
        </div>
      </form>

      {/* Admin password */}
      <SectionTitle>Change admin password</SectionTitle>
      <form action={changeAdminPasswordAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Current password"><input type="password" name="current" required className="input" /></Field>
        <Field label="New password"><input type="password" name="next" required className="input" /></Field>
        <Field label="Confirm new password"><input type="password" name="confirm" required className="input" /></Field>
        <div className="sm:col-span-3 flex items-center justify-between">
          <span className="text-xs" style={{ color: "var(--muted)" }}>At least 8 characters, with one capital and one special character.</span>
          <button className="btn btn-primary" type="submit">Change password</button>
        </div>
      </form>
    </div>
  );
}
