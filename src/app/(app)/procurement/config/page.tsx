import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { getProcurementConfig } from "@/server/services/procurement";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { saveProcurementConfigAction } from "@/app/actions";

export default async function ProcurementConfigPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  const sp = await searchParams;
  const cfg = await getProcurementConfig(orgId);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Procurement thresholds" subtitle={`Quotation rules by value · ${orgName}`} actions={<Link href="/procurement/requests" className="btn btn-sm">← Requests</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}

      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        Set the value bands that decide how many written quotations a purchase needs. Approval is blocked when a request has fewer
        quotations than its band requires, unless a single-source justification is recorded. Defaults follow the VITAL HMB policy.
      </p>

      <SectionTitle>Thresholds &amp; required quotations</SectionTitle>
      <form action={saveProcurementConfigAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Currency"><input name="currency" defaultValue={cfg.currency} className="input" /></Field>
        <div className="sm:col-span-2" />

        <Field label="Direct procurement up to"><input type="number" step="1" name="directMax" defaultValue={cfg.directMax} className="input" /></Field>
        <Field label="Quotations required (direct)"><input type="number" step="1" name="quotesDirect" defaultValue={cfg.quotesDirect} className="input" /></Field>
        <div className="text-xs self-center" style={{ color: "var(--muted)" }}>≤ this value → direct procurement</div>

        <Field label="Competitive (micro) up to"><input type="number" step="1" name="microMax" defaultValue={cfg.microMax} className="input" /></Field>
        <Field label="Quotations required (micro)"><input type="number" step="1" name="quotesMicro" defaultValue={cfg.quotesMicro} className="input" /></Field>
        <div className="text-xs self-center" style={{ color: "var(--muted)" }}>between the two → competitive quotation</div>

        <div />
        <Field label="Quotations / bids required (formal)"><input type="number" step="1" name="quotesFormal" defaultValue={cfg.quotesFormal} className="input" /></Field>
        <div className="text-xs self-center" style={{ color: "var(--muted)" }}>above the micro ceiling → formal bidding</div>

        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="enforce" defaultChecked={cfg.enforce} /> Block approval when quotations are insufficient</label>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Save thresholds</button></div>
      </form>

      <p className="text-xs mt-4" style={{ color: "var(--muted)" }}>
        Policy default (in your procurement currency): ≤ 1,000,000 → 1 quote; 1,000,001–5,000,000 → 3 quotes; above 5,000,000 → formal bidding with 3 bids.
      </p>
    </div>
  );
}
