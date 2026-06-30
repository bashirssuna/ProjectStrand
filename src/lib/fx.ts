// Pure multi-currency consolidation. No DB access.
//
// Exchange rates are stored relative to the org's base currency:
//   rate(C) = base units per 1 unit of C   (amount_in_C * rate(C) = amount_in_base)
// To express an amount that is in currency C into a chosen reporting currency R:
//   amount_in_base = amount_C * rate(C)            (rate(base) is implicitly 1)
//   amount_in_R    = amount_in_base / rate(R)      (rate(base) is implicitly 1)
// If a required rate is missing, the amount is NOT converted at par — it is
// returned in `unconverted` so the UI can show it separately and exclude it
// from the headline total. Silent 1:1 conversion is never performed.

export type RateMap = Record<string, { rate: number; asOf: string }>;

export type Consolidation = {
  reporting: string;
  value: number;                                    // total of all convertible amounts, in `reporting`
  nativeParts: [string, number][];                  // every source currency with a non-zero amount
  unconverted: { currency: string; amount: number }[]; // amounts with no rate path to `reporting`
  asOf: string | null;                              // most recent rate date used
  convertedCurrencies: number;
};

function rateToBase(c: string, base: string, rates: RateMap): number | null {
  if (c === base) return 1;
  const r = rates[c];
  return r && r.rate > 0 ? r.rate : null;
}

export function consolidate(map: Record<string, number>, reporting: string, base: string, rates: RateMap): Consolidation {
  let value = 0;
  let asOf: string | null = null;
  let convertedCurrencies = 0;
  const nativeParts: [string, number][] = [];
  const unconverted: { currency: string; amount: number }[] = [];
  const rRate = rateToBase(reporting, base, rates);

  for (const [c, amt] of Object.entries(map)) {
    if (!amt) continue;
    nativeParts.push([c, amt]);
    if (c === reporting) { value += amt; convertedCurrencies++; continue; }
    const cRate = rateToBase(c, base, rates);
    if (cRate == null || rRate == null) { unconverted.push({ currency: c, amount: amt }); continue; }
    value += (amt * cRate) / rRate;
    convertedCurrencies++;
    for (const used of [c, reporting]) {
      const r = rates[used];
      if (r && (!asOf || r.asOf > asOf)) asOf = r.asOf;
    }
  }
  nativeParts.sort((a, b) => a[0].localeCompare(b[0]));
  return { reporting, value, nativeParts, unconverted, asOf, convertedCurrencies };
}

// Distinct currencies, across several maps, that cannot be converted to `reporting`.
export function missingRateCurrencies(maps: Record<string, number>[], reporting: string, base: string, rates: RateMap): string[] {
  const missing = new Set<string>();
  const rOk = reporting === base || (rates[reporting]?.rate ?? 0) > 0;
  for (const map of maps) {
    for (const [c, amt] of Object.entries(map)) {
      if (!amt || c === reporting) continue;
      const cOk = c === base || (rates[c]?.rate ?? 0) > 0;
      if (!cOk || !rOk) missing.add(c);
    }
  }
  return [...missing].sort();
}
