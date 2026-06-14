import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { addCoiAction, deleteCoiAction, addGiftAction, deleteGiftAction } from "@/app/actions";

export default async function EthicsPage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  const sp = await searchParams;

  const cois = await q<{ id: string; personName: string; role: string | null; relatedTo: string | null; nature: string; action: string | null; declaredOn: string }>(
    `SELECT id, person_name AS "personName", role, related_to AS "relatedTo", nature, action, declared_on AS "declaredOn"
     FROM coi_declaration WHERE org_id=$1 ORDER BY declared_on DESC`, [orgId]
  );
  const gifts = await q<{ id: string; personName: string; supplierName: string | null; description: string; estValue: number | null; currency: string; receivedOn: string; actionTaken: string | null }>(
    `SELECT id, person_name AS "personName", supplier_name AS "supplierName", description, est_value::float AS "estValue",
            currency, received_on AS "receivedOn", action_taken AS "actionTaken"
     FROM gift_log WHERE org_id=$1 ORDER BY received_on DESC`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Ethics register" subtitle={`Conflicts of interest & gifts · ${orgName}`} actions={<Link href="/procurement" className="btn btn-sm">← Procurement</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "coifields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A person and the nature of the conflict are required.</div>}
      {sp.err === "giftfields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A person and a description are required.</div>}

      {/* Conflict of interest */}
      <SectionTitle>Conflict-of-interest declarations</SectionTitle>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Anyone evaluating a procurement who has a personal or financial interest in a bidder must declare it and step back from the decision.</p>
      {cois.length === 0 ? <Empty title="No declarations recorded" hint="Record the first declaration below." /> : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Person</th><th className="th text-left">Concerning</th><th className="th text-left">Nature</th><th className="th text-left">Action taken</th><th className="th text-left">Date</th><th className="th" /></tr></thead>
            <tbody>
              {cois.map((d) => (
                <tr key={d.id}>
                  <td className="td">{d.personName}{d.role ? <span className="text-xs block" style={{ color: "var(--muted)" }}>{d.role}</span> : null}</td>
                  <td className="td text-xs">{d.relatedTo ?? "—"}</td>
                  <td className="td text-xs">{d.nature}</td>
                  <td className="td text-xs">{d.action ?? "—"}</td>
                  <td className="td">{fmtDate(d.declaredOn)}</td>
                  <td className="td text-right"><form action={deleteCoiAction}><input type="hidden" name="coiId" value={d.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>×</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addCoiAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end mb-8">
        <Field label="Person"><input name="personName" required className="input" /></Field>
        <Field label="Role"><input name="role" className="input" placeholder="Evaluation committee" /></Field>
        <Field label="Concerning (supplier / procurement)"><input name="relatedTo" className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Nature of the conflict"><input name="nature" required className="input" placeholder="e.g. relative is a director of the bidder" /></Field></div>
        <Field label="Declared on"><input type="date" name="declaredOn" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Action taken"><input name="action" className="input" placeholder="e.g. withdrew from evaluation" /></Field></div>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Record declaration</button></div>
      </form>

      {/* Gifts */}
      <SectionTitle>Gifts &amp; inducements log</SectionTitle>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Soliciting or accepting gifts, commissions, or favours from suppliers is prohibited. Log any offer and the action taken.</p>
      {gifts.length === 0 ? <Empty title="No entries" hint="Log any gift offered by a supplier below." /> : (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Person</th><th className="th text-left">From supplier</th><th className="th text-left">Item</th><th className="th text-right">Est. value</th><th className="th text-left">Action</th><th className="th text-left">Date</th><th className="th" /></tr></thead>
            <tbody>
              {gifts.map((g) => (
                <tr key={g.id}>
                  <td className="td">{g.personName}</td>
                  <td className="td text-xs">{g.supplierName ?? "—"}</td>
                  <td className="td text-xs">{g.description}</td>
                  <td className="td text-right tabular-nums">{g.estValue != null ? money(g.estValue, g.currency) : "—"}</td>
                  <td className="td text-xs">{g.actionTaken ?? "—"}</td>
                  <td className="td">{fmtDate(g.receivedOn)}</td>
                  <td className="td text-right"><form action={deleteGiftAction}><input type="hidden" name="giftId" value={g.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>×</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addGiftAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Person"><input name="personName" required className="input" /></Field>
        <Field label="From supplier"><input name="supplierName" className="input" /></Field>
        <Field label="Received on"><input type="date" name="receivedOn" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Description"><input name="description" required className="input" placeholder="e.g. branded hamper" /></Field></div>
        <Field label="Est. value"><input type="number" step="0.01" name="estValue" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue="UGX" className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Action taken"><input name="actionTaken" className="input" placeholder="e.g. declined / surrendered to project" /></Field></div>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Log gift</button></div>
      </form>
    </div>
  );
}
