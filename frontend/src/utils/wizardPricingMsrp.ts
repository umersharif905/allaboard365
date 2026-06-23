const round2 = (n: number) => Math.round(Number(n || 0) * 100) / 100;

/** Net + override + commission (product-level MSRP components, no included processing fee). */
export function calculatePricingComponentBase(
  netRate: number,
  overrideRate: number,
  commission: number
): number {
  return round2((netRate || 0) + (overrideRate || 0) + (commission || 0));
}

/**
 * Resolve wizard msrpRate from DB row.
 * IncludeProcessingFee products may store MSRPRate as member retail (base + included)
 * or legacy base-only; promote legacy rows to retail for wizard display.
 */
export function resolveWizardRetailMsrpRate(opts: {
  msrpFromDb: number;
  componentBase: number;
  includedProcessingFee: number;
  includeProcessingFee: boolean;
}): number {
  const msrp = round2(opts.msrpFromDb);
  const base = round2(opts.componentBase);
  const included = round2(opts.includedProcessingFee);

  if (!opts.includeProcessingFee || included <= 0) {
    return msrp > 0 ? msrp : base;
  }

  const retailTotal = round2(base + included);
  if (Math.abs(msrp - retailTotal) <= 0.02) return msrp;
  if (Math.abs(msrp - base) <= 0.02) return retailTotal;
  return msrp;
}

/** Member-facing monthly rate shown in wizard (MSRPRate row value when fee is included). */
export function memberRetailFromMsrpRate(msrpRate: number): number {
  return round2(msrpRate || 0);
}
