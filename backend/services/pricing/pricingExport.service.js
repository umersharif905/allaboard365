// backend/services/pricing/pricingExport.service.js
// Builds an XLSX pricing export workbook for a product or bundle.

const XLSX = require('xlsx');
const { getPool, sql } = require('../../config/database');

const CURRENCY_FORMAT = '"$"#,##0.00';
const FORBIDDEN_SHEET_CHARS = /[\\/*?:[\]]/g;
/** Standard family-size tier display order (Individual → Family). */
const FAMILY_TIER_ORDER = ['EE', 'ES', 'EC', 'EF'];

function normalizeTierType(tierType) {
  return (tierType || '').toString().trim().toUpperCase();
}

function compareTierTypes(a, b) {
  const aKey = normalizeTierType(a);
  const bKey = normalizeTierType(b);
  const aIdx = FAMILY_TIER_ORDER.indexOf(aKey);
  const bIdx = FAMILY_TIER_ORDER.indexOf(bKey);
  const aOrder = aIdx >= 0 ? aIdx : FAMILY_TIER_ORDER.length;
  const bOrder = bIdx >= 0 ? bIdx : FAMILY_TIER_ORDER.length;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return aKey.localeCompare(bKey);
}

function sortTierTypes(tierTypes) {
  return [...tierTypes].sort(compareTierTypes);
}

function ageBandKey(minAge, maxAge) {
  return `${minAge ?? ''}|${maxAge ?? ''}`;
}

/** Human-readable age section title (e.g. "Up to 45", "Age 40–64", "All Ages"). */
function formatAgeBandHeader(minAge, maxAge) {
  const min = minAge != null && minAge !== '' ? Number(minAge) : null;
  const max = maxAge != null && maxAge !== '' ? Number(maxAge) : null;
  if (min == null && max == null) return 'All Ages';
  if ((min == null || min === 0) && max != null) return `Up to ${max}`;
  if (min != null && max == null) return `Age ${min}+`;
  return `Age ${min}–${max}`;
}

function shouldShowAgeSectionHeaders(ageBands) {
  if (ageBands.length > 1) return true;
  const only = ageBands[0];
  return only && (only.minAge != null || only.maxAge != null);
}

/** Normalize DB tobacco values to N/A, No, or Yes for grouping. */
function normalizeTobaccoStatus(status) {
  const s = (status || 'N/A').toString().trim();
  if (s === 'Non-Tobacco' || s === 'No' || s === 'N') return 'No';
  if (s === 'Tobacco' || s === 'Yes' || s === 'Y') return 'Yes';
  return 'N/A';
}

function tobaccoSectionLabel(normalized) {
  if (normalized === 'No') return 'Tobacco — No';
  if (normalized === 'Yes') return 'Tobacco — Yes';
  return 'Tobacco — N/A';
}

const TOBACCO_SECTION_ORDER = ['N/A', 'No', 'Yes'];

// 0-indexed column positions for the 5 dollar columns in the pricing table
const PRICING_DOLLAR_COLS = [2, 3, 4, 5, 6];

function sanitizeSheetName(name, usedNames = new Set()) {
  let safe = (name || 'Sheet').replace(FORBIDDEN_SHEET_CHARS, '').trim().slice(0, 31);
  if (!safe) safe = 'Sheet';
  let candidate = safe;
  let idx = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${idx++}`;
    candidate = safe.slice(0, 31 - suffix.length) + suffix;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

/** Verify tenant owns this product (subscribers cannot export vendor pricing). */
async function getProductWithAccess(pool, productId, tenantId) {
  const req = pool.request();
  req.input('ProductId', sql.UniqueIdentifier, productId);
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  const result = await req.query(`
    SELECT p.ProductId, p.Name, p.IsBundle
    FROM oe.Products p
    WHERE p.ProductId = @ProductId
      AND p.Status = 'Active'
      AND p.ProductOwnerId = @TenantId
  `);
  return result.recordset[0] || null;
}

/** SysAdmin: any active product by id (no tenant ownership check). */
async function getProductById(pool, productId) {
  const req = pool.request();
  req.input('ProductId', sql.UniqueIdentifier, productId);
  const result = await req.query(`
    SELECT p.ProductId, p.Name, p.IsBundle
    FROM oe.Products p
    WHERE p.ProductId = @ProductId
      AND p.Status = 'Active'
  `);
  return result.recordset[0] || null;
}

async function getBundleComponents(pool, bundleProductId) {
  const req = pool.request();
  req.input('BundleProductId', sql.UniqueIdentifier, bundleProductId);
  const result = await req.query(`
    SELECT
      pb.IncludedProductId,
      pb.SortOrder,
      pb.IsRequired,
      pb.HidePricing,
      p.Name AS ProductName
    FROM oe.ProductBundles pb
    INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
    WHERE pb.BundleProductId = @BundleProductId
      AND pb.IncludedProductId != pb.BundleProductId
      AND p.Status = 'Active'
    ORDER BY pb.SortOrder
  `);
  return result.recordset;
}

async function getProductPricing(pool, productId) {
  const req = pool.request();
  req.input('ProductId', sql.UniqueIdentifier, productId);
  const result = await req.query(`
    SELECT
      pp.Label           AS TierLabel,
      pp.TierType,
      pp.MinAge,
      pp.MaxAge,
      pp.TobaccoStatus,
      pp.NetRate              AS VendorRate,
      pp.OverrideRate,
      pp.VendorCommission     AS Commission,
      pp.IncludedProcessingFee AS IncludedFee,
      pp.MSRPRate
    FROM oe.ProductPricing pp
    WHERE pp.ProductId = @ProductId
      AND pp.Status = 'Active'
    ORDER BY pp.TobaccoStatus, pp.TierType, pp.MinAge
  `);
  return result.recordset;
}

const PRICING_HEADERS = [
  'Tier Label', 'Tier Type',
  'Vendor (Net Rate)', 'Override', 'Commission', 'Included Fee', 'MSRP'
];

/**
 * Convert flat tier rows into AOA rows grouped by TobaccoStatus → Age band → TierType (EE→EF).
 * Returns the AOA rows and a list of 0-indexed row indices that hold dollar values.
 */
function buildPricingSheetRows(tiers, hidePricing = false) {
  const rows = [];
  const currencyRowIndices = [];

  if (hidePricing) {
    rows.push(['Note: Rates for this component are linked to the bundle pricing.']);
    rows.push([]);
  }

  rows.push(PRICING_HEADERS);

  // Group by TobaccoStatus → age band → tier rows
  const tobaccoMap = new Map();
  for (const t of tiers) {
    const tob = normalizeTobaccoStatus(t.TobaccoStatus);
    const key = ageBandKey(t.MinAge, t.MaxAge);
    if (!tobaccoMap.has(tob)) tobaccoMap.set(tob, new Map());
    const ageMap = tobaccoMap.get(tob);
    if (!ageMap.has(key)) {
      ageMap.set(key, { minAge: t.MinAge, maxAge: t.MaxAge, tiers: [] });
    }
    ageMap.get(key).tiers.push(t);
  }

  const orderedTobacco = [
    ...TOBACCO_SECTION_ORDER.filter(k => tobaccoMap.has(k)),
    ...[...tobaccoMap.keys()].filter(k => !TOBACCO_SECTION_ORDER.includes(k))
  ];

  for (const tob of orderedTobacco) {
    const ageMap = tobaccoMap.get(tob);
    const orderedAgeBands = [...ageMap.values()].sort(
      (a, b) => (a.minAge ?? 0) - (b.minAge ?? 0) || (a.maxAge ?? 999) - (b.maxAge ?? 999)
    );
    const showAgeHeaders = shouldShowAgeSectionHeaders(orderedAgeBands);

    rows.push([`\u2014 ${tobaccoSectionLabel(tob)} \u2014`]);

    for (const ageBand of orderedAgeBands) {
      if (showAgeHeaders) {
        rows.push([
          `\u2014 ${formatAgeBandHeader(ageBand.minAge, ageBand.maxAge)} \u2014`
        ]);
      }

      const byTierType = new Map();
      for (const t of ageBand.tiers) {
        if (!byTierType.has(t.TierType)) byTierType.set(t.TierType, []);
        byTierType.get(t.TierType).push(t);
      }

      for (const tierType of sortTierTypes(byTierType.keys())) {
        for (const t of byTierType.get(tierType)) {
          rows.push([
            t.TierLabel,
            t.TierType,
            Number(t.VendorRate || 0),
            Number(t.OverrideRate || 0),
            Number(t.Commission || 0),
            Number(t.IncludedFee || 0),
            Number(t.MSRPRate || 0)
          ]);
          currencyRowIndices.push(rows.length - 1);
        }
      }
    }
  }

  const hasIncludedFees = tiers.some(t => Number(t.IncludedFee || 0) > 0);
  if (hasIncludedFees) {
    rows.push([]);
    rows.push(['* Included Fee: Processing fee baked into the displayed premium rate.']);
  }

  return { rows, currencyRowIndices };
}

function applyPricingSheetFormatting(ws, currencyRowIndices) {
  for (const r of currencyRowIndices) {
    for (const c of PRICING_DOLLAR_COLS) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && typeof ws[addr].v === 'number') {
        ws[addr].z = CURRENCY_FORMAT;
      }
    }
  }
  ws['!cols'] = [
    { wch: 20 }, // Tier Label
    { wch: 12 }, // Tier Type
    { wch: 18 }, // Vendor (Net Rate)
    { wch: 12 }, // Override
    { wch: 14 }, // Commission
    { wch: 14 }, // Included Fee
    { wch: 12 }, // MSRP
  ];
}

function buildOverviewSheet(product, components) {
  const rows = [
    ['Pricing Export'],
    [],
    ['Product', product.Name],
    ['Type', product.IsBundle ? 'Bundle' : 'Single Product'],
    ['Generated', new Date().toISOString()],
    []
  ];

  if (components && components.length > 0) {
    rows.push(['Bundle Components']);
    rows.push(['#', 'Product Name', 'Sort Order', 'Hide Pricing']);
    components.forEach((c, i) => {
      rows.push([i + 1, c.ProductName, c.SortOrder ?? i, c.HidePricing ? 'Yes' : 'No']);
    });
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 12 }, { wch: 14 }];
  return ws;
}

/** Per-component line total for bundle breakdown (MSRP when set, else premium components). */
function componentScenarioTotal(tier) {
  const msrp = Number(tier.MSRPRate || 0);
  if (msrp > 0) return msrp;
  return (
    Number(tier.VendorRate || 0) +
    Number(tier.OverrideRate || 0) +
    Number(tier.IncludedFee || 0)
  );
}

function scenarioAgeBounds(scenario) {
  if (scenario.minAge != null || scenario.maxAge != null) {
    return { min: scenario.minAge ?? 0, max: scenario.maxAge ?? 999 };
  }
  const [minPart, maxPart] = (scenario.ageKey || '').split('|');
  return {
    min: minPart !== '' ? Number(minPart) : 0,
    max: maxPart !== '' ? Number(maxPart) : 999
  };
}

function productTobaccoVariants(tiers) {
  return new Set(tiers.map(t => normalizeTobaccoStatus(t.TobaccoStatus)));
}

/**
 * Tobacco match:
 * - exact match
 * - product only N/A tiers → use in No/Yes sections
 * - section N/A but product only No/Yes → use No (non-tobacco) tiers
 */
function tobaccoAppliesToScenario(tier, scenarioTobacco, variants) {
  const tierTob = normalizeTobaccoStatus(tier.TobaccoStatus);
  if (tierTob === scenarioTobacco) return true;
  if (tierTob === 'N/A' && !variants.has('No') && !variants.has('Yes')) return true;
  if (scenarioTobacco === 'N/A' && tierTob === 'No' && !variants.has('N/A')) return true;
  return false;
}

function tierMatchesScenarioAge(tier, sMin, sMax, mode) {
  const pMin = tier.MinAge ?? 0;
  const pMax = tier.MaxAge ?? 999;
  if (mode === 'cover') return pMin <= sMin && pMax >= sMax;
  return pMin <= sMax && pMax >= sMin;
}

function pickBestTierTotal(candidates) {
  if (candidates.length === 0) return null;
  const best = Math.max(...candidates.map(componentScenarioTotal));
  return best > 0 ? best : null;
}

/**
 * Best per-product total for a bundle scenario: covering age band first, then overlapping
 * band (e.g. Essential 18–45 + 46–64 shown in a 18–64 section via highest overlapping tier).
 */
function lookupProductScenarioTotal(tiers, scenario) {
  if (!tiers?.length) return null;

  const tierType = normalizeTierType(scenario.tierType);
  const { min: sMin, max: sMax } = scenarioAgeBounds(scenario);
  const variants = productTobaccoVariants(tiers);

  const tobaccoMatched = tiers.filter(t => {
    if (normalizeTierType(t.TierType) !== tierType) return false;
    return tobaccoAppliesToScenario(t, scenario.tobacco, variants);
  });

  const covering = tobaccoMatched.filter(t =>
    tierMatchesScenarioAge(t, sMin, sMax, 'cover')
  );
  const coveringTotal = pickBestTierTotal(covering);
  if (coveringTotal != null) return coveringTotal;

  const overlapping = tobaccoMatched.filter(t =>
    tierMatchesScenarioAge(t, sMin, sMax, 'overlap')
  );
  return pickBestTierTotal(overlapping);
}

function ageBandHasAnyPricing(componentPricing, scenarioBase) {
  for (const { tiers } of componentPricing) {
    for (const tierType of FAMILY_TIER_ORDER) {
      const total = lookupProductScenarioTotal(tiers, {
        ...scenarioBase,
        tierType
      });
      if (total != null && total > 0) return true;
    }
  }
  return false;
}

/**
 * Bundle tab: tobacco/age sections, EE→EF rows, one column per component (blank if no
 * matching tier — not $0). Omits age sections with no priced tiers.
 */
function buildBundleBreakdownSheet(allComponentPricing) {
  const componentNames = allComponentPricing.map(c => c.componentName);
  const tiersByProduct = new Map(
    allComponentPricing.map(c => [c.componentName, c.tiers])
  );

  const tobaccoMap = new Map();
  for (const { tiers } of allComponentPricing) {
    for (const t of tiers) {
      const tobacco = normalizeTobaccoStatus(t.TobaccoStatus);
      const ageKey = ageBandKey(t.MinAge, t.MaxAge);
      const tierType = normalizeTierType(t.TierType);
      if (!tobaccoMap.has(tobacco)) tobaccoMap.set(tobacco, new Map());
      const ageMap = tobaccoMap.get(tobacco);
      if (!ageMap.has(ageKey)) {
        ageMap.set(ageKey, {
          minAge: t.MinAge,
          maxAge: t.MaxAge,
          tierTypes: new Set()
        });
      }
      ageMap.get(ageKey).tierTypes.add(tierType);
    }
  }

  const headers = ['Tier Type', ...componentNames, 'Bundle Total'];
  const dollarColStart = 1;
  const dollarColEnd = componentNames.length + 1;

  const aoa = [['Bundle breakdown \u2014 per product totals by scenario'], [], headers];
  const currencyRowIndices = [];

  const orderedTobacco = [
    ...TOBACCO_SECTION_ORDER.filter(k => tobaccoMap.has(k)),
    ...[...tobaccoMap.keys()].filter(k => !TOBACCO_SECTION_ORDER.includes(k))
  ];

  for (const tobacco of orderedTobacco) {
    const ageMap = tobaccoMap.get(tobacco);
    const orderedAgeBands = [...ageMap.entries()].sort(
      (a, b) =>
        (a[1].minAge ?? 0) - (b[1].minAge ?? 0) ||
        (a[1].maxAge ?? 999) - (b[1].maxAge ?? 999)
    );

    const ageBandsToRender = orderedAgeBands.filter(([ageKey, band]) =>
      ageBandHasAnyPricing(allComponentPricing, { tobacco, ageKey, minAge: band.minAge, maxAge: band.maxAge })
    );

    if (ageBandsToRender.length === 0) continue;

    aoa.push([`\u2014 ${tobaccoSectionLabel(tobacco)} \u2014`]);
    const showAgeHeaders = shouldShowAgeSectionHeaders(ageBandsToRender.map(([, b]) => b));

    for (const [ageKey, ageBand] of ageBandsToRender) {
      if (showAgeHeaders) {
        aoa.push([`\u2014 ${formatAgeBandHeader(ageBand.minAge, ageBand.maxAge)} \u2014`]);
      }

      const tierTypes = sortTierTypes(
        FAMILY_TIER_ORDER.filter(tt => ageBand.tierTypes.has(tt))
      );

      for (const tierType of tierTypes) {
        const scenario = {
          tobacco,
          ageKey,
          tierType,
          minAge: ageBand.minAge,
          maxAge: ageBand.maxAge
        };
        const productCells = componentNames.map(name => {
          const total = lookupProductScenarioTotal(tiersByProduct.get(name) || [], scenario);
          return total == null ? '' : total;
        });
        const numericAmounts = productCells.filter(v => typeof v === 'number');
        if (numericAmounts.length === 0) continue;

        const bundleTotal = numericAmounts.reduce((sum, n) => sum + n, 0);
        aoa.push([tierType, ...productCells, bundleTotal]);
        currencyRowIndices.push(aoa.length - 1);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  for (const r of currencyRowIndices) {
    for (let c = dollarColStart; c <= dollarColEnd; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && typeof ws[addr].v === 'number') {
        ws[addr].z = CURRENCY_FORMAT;
      }
    }
  }

  ws['!cols'] = [
    { wch: 14 },
    ...componentNames.map(() => ({ wch: 22 })),
    { wch: 14 }
  ];

  return ws;
}

/**
 * Build a pricing export workbook for the given product + tenant.
 *
 * Returns:
 *   { buffer: Buffer, productName: string }  — on success
 *   { error: 'not_found' }                   — product not accessible
 *   { error: 'no_tiers' }                    — product has no active pricing tiers
 */
async function buildPricingWorkbook(productId, tenantId, options = {}) {
  const pool = await getPool();
  const product = options.sysAdmin
    ? await getProductById(pool, productId)
    : await getProductWithAccess(pool, productId, tenantId);

  if (!product) {
    return { error: 'not_found' };
  }

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();

  if (!product.IsBundle) {
    const tiers = await getProductPricing(pool, productId);
    if (tiers.length === 0) {
      return { error: 'no_tiers' };
    }

    // Overview first
    const overviewWs = buildOverviewSheet(product, null);
    XLSX.utils.book_append_sheet(wb, overviewWs, sanitizeSheetName('Overview', usedNames));

    // Product pricing sheet
    const { rows, currencyRowIndices } = buildPricingSheetRows(tiers, false);
    const pricingWs = XLSX.utils.aoa_to_sheet(rows);
    applyPricingSheetFormatting(pricingWs, currencyRowIndices);
    XLSX.utils.book_append_sheet(wb, pricingWs, sanitizeSheetName(product.Name, usedNames));
  } else {
    // Bundle: component sheets first, Bundle Totals, then Overview last
    const components = await getBundleComponents(pool, product.ProductId);

    let totalTierCount = 0;
    const allComponentPricing = [];

    for (const component of components) {
      const tiers = await getProductPricing(pool, component.IncludedProductId);
      totalTierCount += tiers.length;
      allComponentPricing.push({ componentName: component.ProductName, tiers });

      const { rows, currencyRowIndices } = buildPricingSheetRows(tiers, component.HidePricing);
      const ws = XLSX.utils.aoa_to_sheet(rows);
      applyPricingSheetFormatting(ws, currencyRowIndices);
      XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(component.ProductName, usedNames));
    }

    if (totalTierCount === 0) {
      return { error: 'no_tiers' };
    }

    // Bundle breakdown tab (per-product columns, not net/override/commission)
    const bundleWs = buildBundleBreakdownSheet(allComponentPricing);
    XLSX.utils.book_append_sheet(wb, bundleWs, sanitizeSheetName('Bundle', usedNames));

    // Overview last
    const overviewWs = buildOverviewSheet(product, components);
    XLSX.utils.book_append_sheet(wb, overviewWs, sanitizeSheetName('Overview', usedNames));
  }

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return { buffer, productName: product.Name };
}

module.exports = { buildPricingWorkbook };
