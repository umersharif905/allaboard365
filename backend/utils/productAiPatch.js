/**
 * Normalize and validate AI product wizard partial patches.
 */

const SNAPSHOT_ONLY_PATCH_KEYS = new Set([
  'pricingTierIds',
  'pricingTiersSummary',
  'pricingPhase',
  'productId',
  'currentStep',
  'currentStepLabel',
  'configurationFieldCount',
  'configurationFieldNames',
  'acknowledgementQuestionCount',
  'aiChunkCount',
  'productQuestionnaireCount',
  'networkVariationCount',
  'descriptionPreview',
  'hasProductImage',
  'hasProductLogo',
  'hasProductDocument',
  'idCardDisabled',
]);

const FORBIDDEN_PATCH_KEYS = new Set([
  'productImageUrl',
  'productLogoUrl',
  'productDocumentUrl',
  'productImageFile',
  'productLogoFile',
  'productDocumentFile',
  'productDocumentFiles',
  'idCardLogoFile',
]);

function parseMoneyNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(String(value).replace(/[$,]/g, '').trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceAgeBandNumbers(band, manualIncludedProcessingFee = false) {
  if (!band || typeof band !== 'object') return band;
  const net = parseMoneyNumber(band.netRate);
  const override = parseMoneyNumber(band.overrideRate);
  const comm = parseMoneyNumber(band.commission);
  let msrp = parseMoneyNumber(band.msrpRate);
  const included = parseMoneyNumber(band.includedProcessingFee);
  const hasComponents = (override || 0) > 0 || (comm || 0) > 0;
  const subtotal =
    hasComponents || net !== undefined
      ? (net || 0) + (override || 0) + (comm || 0)
      : undefined;
  if (hasComponents) {
    msrp = subtotal;
  } else if (msrp === undefined && net !== undefined) {
    msrp = net;
  }
  if (manualIncludedProcessingFee && included !== undefined && included >= 0 && subtotal !== undefined) {
    msrp = Math.round((subtotal + included) * 100) / 100;
  }
  return {
    ...band,
    ...(net !== undefined ? { netRate: net } : {}),
    ...(override !== undefined ? { overrideRate: override } : {}),
    ...(comm !== undefined ? { commission: comm } : {}),
    ...(msrp !== undefined ? { msrpRate: msrp } : {}),
    ...(included !== undefined ? { includedProcessingFee: included } : {}),
    ...(parseMoneyNumber(band.minAge) !== undefined ? { minAge: parseMoneyNumber(band.minAge) } : {}),
    ...(parseMoneyNumber(band.maxAge) !== undefined ? { maxAge: parseMoneyNumber(band.maxAge) } : {}),
  };
}

function coerceProcessingFeePatch(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const out = { ...patch };
  if (out.manualIncludedProcessingFee !== undefined) {
    out.manualIncludedProcessingFee =
      out.manualIncludedProcessingFee === true ||
      out.manualIncludedProcessingFee === 1 ||
      String(out.manualIncludedProcessingFee).toLowerCase() === 'true';
    if (out.manualIncludedProcessingFee) {
      out.includeProcessingFee = true;
      out.roundUpProcessingFee = false;
      out.processingFeePercentage = null;
    }
  }
  if (out.includeProcessingFee !== undefined) {
    out.includeProcessingFee =
      out.includeProcessingFee === true ||
      out.includeProcessingFee === 1 ||
      String(out.includeProcessingFee).toLowerCase() === 'true';
  }
  if (out.roundUpProcessingFee !== undefined) {
    const v = out.roundUpProcessingFee;
    out.roundUpProcessingFee =
      v !== false && v !== 0 && String(v).toLowerCase() !== 'false';
  }
  if (out.processingFeePercentage !== undefined && out.processingFeePercentage !== null) {
    const n = parseMoneyNumber(out.processingFeePercentage);
    if (n !== undefined) out.processingFeePercentage = n;
  }
  return out;
}

function stripStraySingletonAgeBands(bands) {
  if (!Array.isArray(bands) || bands.length <= 1) return bands;
  const hasWideBand = bands.some((b) => {
    const min = parseMoneyNumber(b.minAge) ?? b.minAge;
    const max = parseMoneyNumber(b.maxAge) ?? b.maxAge;
    return max - min >= 2;
  });
  if (!hasWideBand) return bands;
  return bands.filter((b) => {
    const min = parseMoneyNumber(b.minAge) ?? b.minAge;
    const max = parseMoneyNumber(b.maxAge) ?? b.maxAge;
    return min !== max;
  });
}

function normalizePatchPricingTiers(patch) {
  const withFees = coerceProcessingFeePatch(patch);
  if (!Array.isArray(withFees.pricingTiers)) return withFees;
  const expanded = expandCombinedSpreadsheetTiers(withFees.pricingTiers);
  const repaired = splitStackedEsEcAgeBands(expanded);
  return {
    ...withFees,
    pricingTiers: repaired.map((tier) => ({
      ...tier,
      id: tier.id != null ? String(tier.id) : tier.id,
      tierType: tier.tierType != null ? String(tier.tierType) : tier.tierType,
      label: tier.label != null ? String(tier.label) : tier.label,
      ageBands: Array.isArray(tier.ageBands)
        ? stripStraySingletonAgeBands(tier.ageBands).map((b) =>
            coerceAgeBandNumbers(b, withFees.manualIncludedProcessingFee === true)
          )
        : tier.ageBands,
    })),
  };
}

function stripSnapshotAndForbiddenKeys(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const out = { ...patch };
  for (const key of [...SNAPSHOT_ONLY_PATCH_KEYS, ...FORBIDDEN_PATCH_KEYS]) {
    delete out[key];
  }
  return out;
}

/**
 * Pricing proposals must include ageBands with dollar amounts — not just tier ids/metadata.
 */
function validatePricingPatchQuality(patch) {
  if (!Array.isArray(patch.pricingTiers) || patch.pricingTiers.length === 0) {
    return { ok: true };
  }

  const tierSummaries = [];

  for (let i = 0; i < patch.pricingTiers.length; i++) {
    const tier = patch.pricingTiers[i];
    const label = tier.label || tier.tierType || `Tier ${i + 1}`;

    if (!Array.isArray(tier.ageBands) || tier.ageBands.length === 0) {
      return {
        ok: false,
        reason:
          `Pricing tier "${label}" has no ageBands. Return full pricingTiers with ageBands ` +
          `(minAge, maxAge, netRate, msrpRate) transcribed from the document — never pricingTierIds.`,
      };
    }

    const bandsWithRates = tier.ageBands.filter((b) => {
      const net = parseMoneyNumber(b.netRate) || 0;
      const msrp = parseMoneyNumber(b.msrpRate) || 0;
      return net > 0 || msrp > 0;
    });

    if (bandsWithRates.length === 0) {
      return {
        ok: false,
        reason:
          `Pricing tier "${label}" age bands have no dollar amounts. Map Retail → msrpRate, Net Rate → netRate.`,
      };
    }

    tierSummaries.push(
      `${label}: ${tier.ageBands.length} band(s), e.g. ages ${tier.ageBands[0].minAge}-${tier.ageBands[0].maxAge}`
    );
  }

  const structureWarnings = validateTierBandStructure(patch.pricingTiers);
  const componentCheck = validatePricingComponentBreakdown(patch.pricingTiers);

  if (!componentCheck.ok) {
    return {
      ok: false,
      reason: componentCheck.reason,
      tierSummaries,
      structureWarnings: [...structureWarnings, ...componentCheck.warnings],
    };
  }

  return {
    ok: true,
    tierSummaries,
    structureWarnings: [...structureWarnings, ...componentCheck.warnings],
  };
}

function validatePricingComponentBreakdown(tiers) {
  const warnings = [];
  if (!Array.isArray(tiers)) return { ok: true, warnings };

  let bandCount = 0;
  let missingComponents = 0;

  for (const tier of tiers) {
    const label = tier.label || tier.tierType || 'tier';
    const bands = Array.isArray(tier.ageBands) ? tier.ageBands : [];

    for (const band of bands) {
      bandCount++;
      const net = parseMoneyNumber(band.netRate) || 0;
      const msrp = parseMoneyNumber(band.msrpRate) || 0;
      const override = parseMoneyNumber(band.overrideRate) || 0;
      const comm = parseMoneyNumber(band.commission) || 0;
      const componentSum = net + override + comm;

      if (net > 0 && override === 0 && comm === 0) {
        missingComponents++;
      } else if (net > 0 && Math.abs(msrp - componentSum) > 0.02 && msrp > net) {
        warnings.push(
          `Tier "${label}" ages ${band.minAge}-${band.maxAge}: msrpRate (${msrp}) should equal netRate + overrideRate + commission (${componentSum.toFixed(2)}), not Final Premium / Rounded column.`
        );
      }
    }
  }

  // Net-only pricing (override = commission = 0) is a VALID configuration the user can
  // explicitly request ("put everything in Net Rate"). Never hard-block on it, or the
  // assistant gets stuck re-asking the same question and can never fulfill the request.
  // Surface it as a non-blocking warning so the proposal still goes through.
  if (bandCount > 0 && missingComponents === bandCount) {
    warnings.push(
      'All age bands have overrideRate and commission set to 0 (everything is in Net Rate). ' +
        'If the source document has Lyric/Override and Agent Comp columns, map those instead — ' +
        'otherwise this net-only setup is applied as requested.'
    );
  } else if (missingComponents > 0) {
    warnings.push(
      `${missingComponents} age band(s) have overrideRate and commission set to 0 — confirm a net-only setup is intended for those.`
    );
  }

  return { ok: true, warnings };
}

const PRICING_PATCH_EXAMPLE = `{
  "kind": "proposal",
  "summary": "Copay MEC EE/ES/EC/EF from screenshot; enabling 3.5% processing fee + round-up so member totals match Rounded column (e.g. EE 18-39 → $141)",
  "patch": {
    "includeProcessingFee": true,
    "roundUpProcessingFee": true,
    "processingFeePercentage": 3.5,
    "pricingTiers": [
      { "tierType": "EE", "label": "Employee Only", "ageBands": [
        { "minAge": 18, "maxAge": 39, "tobaccoStatus": "N/A", "netRate": 75, "overrideRate": 10.75, "commission": 50, "msrpRate": 135.75 },
        { "minAge": 40, "maxAge": 65, "tobaccoStatus": "N/A", "netRate": 109.5, "overrideRate": 14.75, "commission": 50, "msrpRate": 174.25 }
      ]},
      { "tierType": "ES", "label": "Employee + Spouse (ES)", "ageBands": [ "...same 2 bands as ES/EC row..." ] },
      { "id": "<ec-tier-id-from-snapshot>", "tierType": "EC", "label": "Employee + Child(ren) (EC)", "ageBands": [ "...same 2 bands as ES/EC row..." ] },
      { "tierType": "EF", "label": "Employee + Family (EF)", "ageBands": [ "...2 bands..." ] }
    ]
  }
}`;

function isEsEcCombinedTier(tier) {
  const ttRaw = String(tier.tierType || '');
  const tt = ttRaw.toUpperCase().replace(/\s+/g, '');
  const label = String(tier.label || '');
  return (
    tt === 'ES/EC' ||
    tt === 'ES_EC' ||
    tt === 'ESEC' ||
    /ES\s*\/\s*EC/i.test(ttRaw) ||
    /ES\s*\/\s*EC/i.test(label)
  );
}

/** Spreadsheet "ES/EC" one row → two tiers ES + EC with identical ageBands. */
function expandCombinedSpreadsheetTiers(tiers) {
  if (!Array.isArray(tiers)) return tiers;
  const out = [];
  for (const tier of tiers) {
    if (isEsEcCombinedTier(tier) && Array.isArray(tier.ageBands) && tier.ageBands.length > 0) {
      const bands = tier.ageBands.map((b) => coerceAgeBandNumbers({ ...b }));
      out.push({
        ...tier,
        id: undefined,
        tierType: 'ES',
        label: 'Employee + Spouse (ES)',
        ageBands: bands.map((b) => ({ ...b, id: undefined })),
      });
      out.push({
        ...tier,
        tierType: 'EC',
        label: 'Employee + Child(ren) (EC)',
        ageBands: bands.map((b) => ({ ...b, id: undefined })),
      });
    } else {
      out.push(tier);
    }
  }
  return out;
}

/** When AI stacks ES+EC as duplicate age ranges in one tier, split into ES + EC. */
function splitStackedEsEcAgeBands(tiers) {
  if (!Array.isArray(tiers)) return tiers;
  const out = [];
  for (const tier of tiers) {
    const bands = Array.isArray(tier.ageBands) ? tier.ageBands : [];
    const naBands = bands.filter((b) => !b.tobaccoStatus || b.tobaccoStatus === 'N/A');
    if (naBands.length < 4) {
      out.push(tier);
      continue;
    }
    const byRange = new Map();
    for (const b of naBands) {
      const min = parseMoneyNumber(b.minAge) ?? b.minAge;
      const max = parseMoneyNumber(b.maxAge) ?? b.maxAge;
      const key = `${min}-${max}`;
      if (!byRange.has(key)) byRange.set(key, []);
      byRange.get(key).push(b);
    }
    const doubled = [...byRange.values()].every((arr) => arr.length === 2);
    const tierType = String(tier.tierType || '').toUpperCase();
    if (doubled && byRange.size >= 2 && (tierType === 'EC' || tierType === 'ES' || tierType === 'ES/EC')) {
      const sortedKeys = [...byRange.keys()].sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
      out.push({
        ...tier,
        id: undefined,
        tierType: 'ES',
        label: 'Employee + Spouse (ES)',
        ageBands: sortedKeys.map((k) => ({ ...coerceAgeBandNumbers(byRange.get(k)[0]), id: undefined })),
      });
      out.push({
        ...tier,
        tierType: 'EC',
        label: 'Employee + Child(ren) (EC)',
        ageBands: sortedKeys.map((k) => ({ ...coerceAgeBandNumbers(byRange.get(k)[1]), id: undefined })),
      });
    } else {
      out.push(tier);
    }
  }
  return out;
}

function validateTierBandStructure(tiers) {
  const warnings = [];
  if (!Array.isArray(tiers)) return warnings;

  for (const tier of tiers) {
    const label = tier.label || tier.tierType || 'tier';
    const bands = Array.isArray(tier.ageBands) ? tier.ageBands : [];
    const naBands = bands.filter((b) => !b.tobaccoStatus || b.tobaccoStatus === 'N/A');

    if (naBands.length > 3) {
      warnings.push(
        `Tier "${label}" has ${naBands.length} age bands — use separate EE/ES/EC/EF tiers (~2 bands each for Under/Over 40), not many bands in one tier.`
      );
    }

    const rangeKeys = naBands.map((b) => `${b.minAge}-${b.maxAge}`);
    const seen = new Set();
    for (const rk of rangeKeys) {
      if (seen.has(rk)) {
        warnings.push(
          `Tier "${label}" has duplicate age range ${rk} — likely stacked ES+EC bands; use separate ES and EC tiers.`
        );
        break;
      }
      seen.add(rk);
    }

    if (tier.minAge === tier.maxAge && tier.minAge != null) {
      // noop - check bands
    }
    for (const b of naBands) {
      if (b.minAge === b.maxAge && b.minAge != null) {
        warnings.push(
          `Tier "${label}" has a single-age band ${b.minAge}-${b.maxAge} — remove stray bands unless intentional.`
        );
      }
    }
  }
  return warnings;
}

function buildPricingPromptSection(formSnapshot) {
  const summary = formSnapshot?.pricingTiersSummary;
  const phase = formSnapshot?.pricingPhase;
  const lines = [
    '',
    'PHASE IN / PHASE OUT (Pricing step — critical):',
    '- The snapshot is the LIVE wizard form on each message (includes unsaved edits such as terminationDate you just set).',
    '- Age bands with terminationDate are PHASING OUT — list them for context but DO NOT patch unless the user explicitly asks to change retired pricing.',
    '- DEFAULT targets for "across the board", net changes, fee updates: activePricingTargets only (bands with NO terminationDate).',
    '- When the user phased in new pricing: duplicate tier rows per tierType (EE/ES/EC/EF) are normal — use recommendedActiveTierId from duplicateTierTypes, not older tier ids.',
    '- To phase in new pricing via proposal: (1) set terminationDate on outgoing open bands the user specified, (2) add NEW pricingTiers (new tier id) cloned from active targets with effectiveDate = next day after end date, terminationDate null.',
    '- effectiveDate on ageBand schedules when that row becomes active; the wizard does not auto-publish on a calendar date — mention that in questions when user gives a future go-live date.',
    '- If user only set end dates manually and has not created the new phase rows yet, ask whether to phase in new rows or only end-date the current cohort.',
    '',
    'PRICING FROM SCREENSHOTS / SPREADSHEETS (critical):',
    '- NEVER put pricingTierIds in patch — that is read-only snapshot metadata.',
    '- ALWAYS use patch.pricingTiers with full ageBands array per tier being added or updated.',
    '',
    'WIZARD COLUMN MAPPING (each ageBand — required when columns exist in source):',
    '- netRate ← "Net to Arm", "Net Rate", "Net"',
    '- commission ← Comp, Commission, Agent Comp, Agent $, Agent, Affiliate (same field; never SWP/Lyric/misc)',
    '- overrideRate ← SUM of ALL misc/admin columns between Net and Agent Comp, EXCLUDING bank/processing fee:',
    '    Lyric + SWP + Override + Admin Fee + similar per-row fees → one overrideRate number',
    '    Example EE Under 40: Lyric 3.25 + SWP 7.5 → overrideRate 10.75',
    '    Example EE Over 40: Lyric 3.25 + SWP 11.5 → overrideRate 14.75',
    '- msrpRate in patch MUST be Sub-Total only = netRate + overrideRate + commission (never include processing fee dollars).',
    '- VERIFY: net + override + commission should match Sub-Total column before Bank Fee — if not, re-sum misc into override.',
    '- Bank Fee / Final Premium / green Rounded column are NOT msrpRate — wizard recalculates includedProcessingFee + final MSRP on Apply.',
    '- When roundUpProcessingFee is true in snapshot: included fee is bumped so (Sub-Total + fee) is a whole dollar — mention round-up in summary.',
    '- If unsure which columns are misc vs commission, reply kind "question" and ask (default: misc → override; Comp/Agent/Affiliate → commission).',
    '- NET-ONLY IS VALID: if the user says to put everything in Net Rate (or to zero out override/commission, or the source truly has no Lyric/Override/Agent Comp columns), set overrideRate: 0 and commission: 0 and msrpRate = netRate, then RETURN THE PROPOSAL. Do NOT keep re-asking about Lyric/Agent Comp once the user has chosen net-only — that is a finished, applicable configuration.',
    '',
    'BANK FEE / ROUNDED MEMBER PRICE (processing fee settings — required when spreadsheet shows them):',
    '- Bank Fee is applied to Sub-Total (msrpRate), NOT added into overrideRate.',
    '- When spreadsheet shows "Bank Fee 3.5%" (or similar) and a Rounded member price column:',
    '  1. msrpRate = Sub-Total = net + override + commission',
    '  2. patch.includeProcessingFee: true',
    '  3. patch.processingFeePercentage: from label (e.g. 3.5 for "Bank Fee 3.5%")',
    '  4. patch.roundUpProcessingFee: true when Rounded rounds up (140.50 → 141)',
    '  5. Bank fee amount = round(msrpRate × fee%); member total = round(msrpRate + bank fee), then round up if Rounded column does (135.75 + 4.75 = 140.50 → 141)',
    '  6. proposal summary MUST state fee settings and target Rounded amounts per tier/age',
    '- Enable fee settings when breakdown clearly shows them — explain to user in summary.',
    '- If bank fee % is unclear, ask kind "question".',
    '',
    '- Split by age when document shows Under 40 / Over 40 (or similar): separate ageBands on the same tier.',
    '- Family columns EE / ES / EC / EF (or Single / ES/EC / Family) → separate pricingTiers with tierType EE, ES, EC, EF.',
    '- Spreadsheet row labeled "ES/EC" or "ES/EC combined" is ONE ROW but TWO tiers in OpenEnroll: duplicate the same ageBands to tierType ES AND tierType EC (never 4 bands inside EC alone).',
    '- Each coverage tier (EE, ES, EC, EF) gets ~2 ageBands when spreadsheet has Under 40 + Over 40 — NOT all four coverages as bands inside one tier.',
    '- REMOVING age bands: send ONLY the bands that should remain (e.g. 18-39 and 40-65). Do NOT include the band being removed. Partial tier patches must NOT list other tiers (EE/ES/EF stay untouched).',
    '- When updating existing tiers, copy the exact "id" from pricingTiersSummary. New tiers omit id.',
    '- Each ageBand needs minAge, maxAge, tobaccoStatus ("N/A" unless tobacco table), netRate, overrideRate, commission, msrpRate (numbers, not strings).',
    '- msrpRate must equal netRate + overrideRate + commission (recalculate; never copy Rounded/Final Premium).',
    '- If the attachment lists multiple products (e.g. UA 1500 / UA 3000), ask which product unless the user named one.',
    '',
    'CONFIGURATION-VALUE VARIATIONS (multiple bands per age/tobacco — fully supported):',
    '- A single tier can hold MANY ageBands that share the SAME minAge/maxAge/tobaccoStatus but differ by configValue1-5 (e.g. an "Unshared Amount" / deductible / coverage-level option). These are SEPARATE variations, NOT duplicates.',
    '  Example (all valid in ONE EE tier):',
    '    EE 40-50 N/A configValue1 "2000" → its own rates',
    '    EE 40-50 N/A configValue1 "3500" → its own rates',
    '    EE 40-50 N/A configValue1 "6000" → its own rates',
    '- ALWAYS include the configValue (configValue1..configValue5 matching the relevant configurationField) on EACH such band so the app keeps them distinct. Bands are matched by minAge + maxAge + tobaccoStatus + configValue signature.',
    '- To ADD a new configuration variation: send a band WITHOUT an id and with its configValue set — do NOT reuse an existing band id (reusing an id, or matching age/tobacco/config exactly, UPDATES that band instead of adding).',
    '- To UPDATE one specific variation: include the exact band "id" from pricingTiersSummary, OR repeat its exact configValue so it matches that variation only (other config variations stay untouched).',
    '- You CAN emit several config variations for the same age band in a single proposal — never claim only one config variation per tier is possible.',
    '- When the user lists config options (e.g. deductibles 2000/3500/6000), produce one ageBand per option with the matching configValue, all within the same tier.',
    '',
    'PROCESSING FEE (product-level — include in patch WITH pricingTiers when spreadsheet shows bank fee / rounded totals):',
    '- includeProcessingFee: true — bakes payment processing fee into member price (Pricing step "Include processing fee").',
    '- roundUpProcessingFee: true — rounds member total up to whole dollars when fee is included.',
    '- processingFeePercentage: number e.g. 3.5 when spreadsheet says "Bank Fee 3.5%" (null = owner tenant default).',
    '- When building from a breakdown image with Bank Fee + Rounded columns, ALWAYS include these three fields unless user said otherwise.',
    '',
    'MANUAL INCLUDED FEE $ (Pricing step "Manual entry" — use only with user confirmation):',
    '- DEFAULT: use auto fee (includeProcessingFee + processingFeePercentage + roundUpProcessingFee). Do NOT set manualIncludedProcessingFee unless the user confirmed hand-entered dollar amounts.',
    '- If Rounded totals cannot be matched by auto fee math, ask kind "question" first — explain the gap and ask whether to switch to manual $ entry.',
    '- When user confirms manual entry: patch.manualIncludedProcessingFee: true, includeProcessingFee: true, omit/clear processingFeePercentage and roundUpProcessingFee.',
    '- Each ageBand must include includedProcessingFee (dollar amount) and msrpRate = net + override + commission + includedProcessingFee.',
    '- Never guess manual fee dollars from a spreadsheet without user confirmation.',
    '',
    'Example proposal shape:',
    PRICING_PATCH_EXAMPLE,
  ];

  if (phase && typeof phase === 'object') {
    lines.push('', 'pricingPhase (active vs phased-out — follow guidance):');
    lines.push(JSON.stringify(phase, null, 2));
  }

  if (Array.isArray(summary) && summary.length > 0) {
    lines.push('', 'Current pricingTiersSummary (use tier/band ids from active targets when updating):');
    lines.push(JSON.stringify(summary, null, 2));
  }

  const roundUpOn = formSnapshot?.roundUpProcessingFee !== false;
  lines.push(
    '',
    'Current processing fee settings in wizard snapshot (use for every pricing proposal):',
    `- manualIncludedProcessingFee: ${formSnapshot?.manualIncludedProcessingFee === true}`,
    `- includeProcessingFee: ${formSnapshot?.includeProcessingFee === true}`,
    `- roundUpProcessingFee: ${roundUpOn} ${roundUpOn ? '(MSRP = ceil(Sub-Total + pct fee) — whole dollars)' : '(fee rounded to cents)'}`,
    `- processingFeePercentage: ${formSnapshot?.processingFeePercentage ?? 'null (tenant default)'}`,
    roundUpOn && formSnapshot?.includeProcessingFee
      ? '- Do NOT bake round-up into msrpRate in patch; only change net/override/commission — wizard recomputes included fee after Apply.'
      : ''
  );

  return lines.join('\n');
}

module.exports = {
  SNAPSHOT_ONLY_PATCH_KEYS,
  FORBIDDEN_PATCH_KEYS,
  stripSnapshotAndForbiddenKeys,
  normalizePatchPricingTiers,
  validatePricingPatchQuality,
  validateTierBandStructure,
  expandCombinedSpreadsheetTiers,
  splitStackedEsEcAgeBands,
  stripStraySingletonAgeBands,
  buildPricingPromptSection,
  coerceAgeBandNumbers,
  PRICING_PATCH_EXAMPLE,
};
