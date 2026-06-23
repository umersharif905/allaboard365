const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { authenticateUrls, authenticateProductDocumentsArray } = require('../../uploads');
const { getProductDocumentsForProductIds } = require('../../../services/shared/product-documents.service');
const systemFeesCalculator = require('../../../utils/systemFeesCalculator');
const productProcessingFeesUtil = require('../../../utils/productProcessingFees');
const pricingAuthority = require('../../../services/pricing/pricingAuthority.service');
const {
    getAgentProductCommissionPreview,
    getDownlineAgentProductCommissionPreview,
    getTenantProductCommissionPreview,
    listTenantCommissionGroups
} = require('../../../services/agentProductCommissionPreview.service');
const { isUplineAncestor } = require('../../../utils/agentHierarchy');

/** SysAdmin pricing uses the product owner's tenant for fee/processing context. */
async function resolvePricingFeeTenantId(pool, productId, tenantId, user) {
    const roles = getUserRoles(user || {});
    if (!roles.includes('SysAdmin')) {
        return tenantId;
    }
    const ownerReq = pool.request();
    ownerReq.input('productId', sql.UniqueIdentifier, productId);
    const ownerRes = await ownerReq.query(`
        SELECT ProductOwnerId
        FROM oe.Products
        WHERE ProductId = @productId
    `);
    return ownerRes.recordset[0]?.ProductOwnerId || tenantId;
}

function normalizeAgentIdForCompare(id) {
    if (id == null || id === '') return '';
    return String(id).trim().toLowerCase();
}
const { generateQuickQuotePdfBuffer } = require('../../../services/quickQuotePdf.service');
const { classifyQuoteMode, buildQuickQuoteResult } = require('./quickQuoteResult');
const ProposalGeneratorService = require('../../../services/proposalGenerator.service');
const { getAgentSenderContext } = require('../../../utils/agentSenderContext');
const { buildSmsBodyWithLinks } = require('../../../utils/smsBody');
const sendGridEmailService = require('../../../services/sendGridEmailService');
const sendGridEmailDeliveryTracking = require('../../../services/sendGridEmailDeliveryTracking.service');
const MessageQueueService = require('../../../services/messageQueue.service');
const { filterPricingRowsAsOfYyyyMmDd } = require('../../../utils/pricingAsOfDisplay');
const includedProcessingFeeUtil = require('../../../utils/includedProcessingFee');

/** Tenant admins / sysadmins have no agent row; use tenant-wide commission preview. */
function shouldUseTenantCommissionPreview(req) {
    const roles = req.user?.roles || [];
    const cr = req.user?.currentRole;
    if (cr === 'TenantAdmin' || cr === 'SysAdmin') return true;
    if (cr === 'Agent') return false;
    if (roles.includes('TenantAdmin') && !roles.includes('Agent')) return true;
    if (roles.includes('SysAdmin')) return true;
    return false;
}

/** Agency admins viewing downline/agency commission codes: allow tenant-mode
 *  preview (with explicit commissionGroupId) when the caller is in
 *  oe.AgencyAdmins.  Returns true if the Agent caller has at least one row in
 *  oe.AgencyAdmins, false otherwise. Caller still must pass an explicit
 *  commissionGroupId — getTenantProductCommissionPreview validates the group
 *  is tenant-scoped via the standard tenant-isolation logic. */
async function isAgencyAdminCaller(req) {
    if (!req?.user?.UserId) return false;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('UserId', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                SELECT TOP 1 1 AS Hit
                FROM oe.Agents a
                INNER JOIN oe.AgencyAdmins aa ON aa.AgentId = a.AgentId AND aa.AgencyId = a.AgencyId
                WHERE a.UserId = @UserId
            `);
        return result.recordset.length > 0;
    } catch (_) {
        return false;
    }
}

/** Link owners previewing their onboarding codes may use tenant-mode preview when
 *  commissionGroupId matches their agent or agency commission group. */
async function isLinkOwnerGroupPreviewAllowed(req, requestedGroupId) {
    if (!req?.user?.UserId || !requestedGroupId) return false;
    const gid = String(requestedGroupId).trim().toLowerCase();
    if (!gid) return false;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('UserId', sql.UniqueIdentifier, req.user.UserId)
            .query(`
                SELECT TOP 1
                    a.CommissionGroupId AS AgentCommissionGroupId,
                    ag.CommissionGroupId AS AgencyCommissionGroupId
                FROM oe.Agents a
                LEFT JOIN oe.Agencies ag ON ag.AgencyId = a.AgencyId
                WHERE a.UserId = @UserId AND a.Status = 'Active'
            `);
        if (!result.recordset.length) return false;
        const row = result.recordset[0];
        const candidates = [row.AgentCommissionGroupId, row.AgencyCommissionGroupId]
            .filter((id) => id != null && String(id).trim() !== '')
            .map((id) => String(id).trim().toLowerCase());
        return candidates.includes(gid);
    } catch (_) {
        return false;
    }
}

function parseRequiredDataFieldLabels(raw) {
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(parsed)) return [];
        const labels = [];
        for (const field of parsed) {
            const label = String(field?.fieldName || field?.label || field?.name || '').trim();
            if (label) labels.push(label);
            if (labels.length >= 5) break;
        }
        return labels;
    } catch (_) {
        return [];
    }
}

function withResolvedConfigFieldLabels(pricingRow, requiredDataFields) {
    const labels = parseRequiredDataFieldLabels(requiredDataFields);
    const row = { ...pricingRow };
    for (let i = 1; i <= 5; i += 1) {
        const fieldKey = `ConfigField${i}`;
        const valueKey = `ConfigValue${i}`;
        const hasLabel = String(row[fieldKey] ?? '').trim().length > 0;
        const hasValue = String(row[valueKey] ?? '').trim().length > 0;
        if (!hasLabel && hasValue && labels[i - 1]) {
            row[fieldKey] = labels[i - 1];
        }
    }
    return row;
}

function parseAllowedConfigOptions(raw) {
    if (!raw) return null;
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed) return null;
        if (Array.isArray(parsed)) {
            const cleaned = parsed.map(v => String(v || '').trim()).filter(Boolean);
            return cleaned.length > 0 ? cleaned : null;
        }
        if (typeof parsed === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                const key = String(k || '').trim();
                if (!key) continue;
                const vals = Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean) : [];
                if (vals.length > 0) out[key] = vals;
            }
            return Object.keys(out).length > 0 ? out : null;
        }
        return null;
    } catch (_) {
        return null;
    }
}

function normalizeOptionKey(v) {
    return String(v || '').trim().toLowerCase();
}

function isPricingRowAllowedByBundleOptions(pricingRow) {
    const allowed = parseAllowedConfigOptions(pricingRow?.AllowedConfigOptions);
    if (!allowed) return true;

    const allowedArray = Array.isArray(allowed) ? allowed.map(normalizeOptionKey) : null;
    const allowedByField = !Array.isArray(allowed)
        ? Object.fromEntries(
            Object.entries(allowed).map(([k, vals]) => [normalizeOptionKey(k), (vals || []).map(normalizeOptionKey)])
        )
        : null;

    for (let i = 1; i <= 5; i += 1) {
        const field = String(pricingRow?.[`ConfigField${i}`] || '').trim();
        const value = String(pricingRow?.[`ConfigValue${i}`] || '').trim();
        if (!value) continue;
        const valueNorm = normalizeOptionKey(value);

        if (allowedArray) {
            if (!allowedArray.includes(valueNorm)) return false;
            continue;
        }

        const fieldNorm = normalizeOptionKey(field);
        if (fieldNorm && allowedByField?.[fieldNorm] && !allowedByField[fieldNorm].includes(valueNorm)) {
            return false;
        }
    }

    return true;
}

/**
 * Load tenant payment + per-product subscription fee flags for agent pricing display (matches quick-quote semantics).
 */
async function loadAgentPricingFeeContext(pool, tenantId, productIds, bundleParentProductId = null) {
    const feeCfgDefaults = {
        ...productProcessingFeesUtil.defaultProductFeeSettings(),
        roundUpProcessingFee: true
    };
    const out = {
        chargeFeeToMember: false,
        paymentProcessorSettings: null,
        systemFeesSettings: null,
        feesByProductId: {}
    };
    if (!tenantId || !productIds || !productIds.length) {
        return out;
    }
    const uniqueIds = Array.from(new Set(productIds.map((id) => String(id).trim()).filter(Boolean)));
    const tenantReq = pool.request();
    tenantReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    const tenantRes = await tenantReq.query(`
        SELECT TOP 1 PaymentProcessorSettings, SystemFees
        FROM oe.Tenants
        WHERE TenantId = @tenantId
    `);
    const parseJson = (v) => {
        if (!v) return null;
        try {
            return typeof v === 'string' ? JSON.parse(v) : v;
        } catch (_) {
            return null;
        }
    };
    const tenantRow = tenantRes.recordset?.[0];
    if (tenantRow?.PaymentProcessorSettings) {
        out.paymentProcessorSettings = parseJson(tenantRow.PaymentProcessorSettings);
    }
    if (tenantRow?.SystemFees) {
        out.systemFeesSettings = parseJson(tenantRow.SystemFees);
    }
    out.chargeFeeToMember = out.paymentProcessorSettings?.chargeFeeToMember === true;

    const loadedSettings = await productProcessingFeesUtil.loadFeeSettingsByProductId({
        poolOrTransaction: pool,
        tenantId,
        productIds: uniqueIds,
        bundleParentProductId
    });
    loadedSettings.forEach((cfg, productId) => {
        out.feesByProductId[String(productId).toLowerCase()] = cfg;
    });
    uniqueIds.forEach((id) => {
        const pid = String(id).toLowerCase();
        if (!out.feesByProductId[pid]) {
            out.feesByProductId[pid] = { ...feeCfgDefaults };
        }
    });
    return out;
}

function round2(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function normalizeAgentPricingPaymentMethod(raw) {
    const s = String(raw || 'ACH').trim().toLowerCase();
    if (s === 'card' || s === 'credit' || s === 'creditcard') return 'Card';
    return 'ACH';
}

function computeRowNonIncludedProcessingFee(basePremium, productIdForFees, feeContext, feeCfg, paymentMethod) {
    if (!feeContext?.chargeFeeToMember || !feeContext?.paymentProcessorSettings) return 0;
    if (feeCfg.includeProcessingFee === true) return 0;

    const breakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[String(productIdForFees), basePremium]]),
        paymentMethodType: paymentMethod,
        paymentProcessorSettings: feeContext.paymentProcessorSettings,
        subscriptionFeeSettingsByProductId: new Map([[String(productIdForFees), feeCfg]])
    });
    return round2(breakdown.nonIncludedProcessingFeeAmount || 0);
}

const feeCfgDefaultsForDisplay = {
    includeProcessingFee: false,
    roundUpProcessingFee: true,
    zeroFeeForACH: false,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null
};

/** Base premium from a pricing row (component sum when MSRPRate already includes stored fee). */
function premiumFromPricingRowLikeFrontend(pricing) {
    return includedProcessingFeeUtil.resolveCatalogBasePremiumFromPricingRow(pricing);
}

/** Normalize oe.ProductPricing column names (Pascal vs camel) before catalog resolution. */
function normalizeCatalogPricingRow(row) {
    return {
        MSRPRate: row?.MSRPRate ?? row?.msrpRate,
        NetRate: row?.NetRate ?? row?.VendorNetRate ?? row?.netRate,
        OverrideRate: row?.OverrideRate ?? row?.TenantOverride ?? row?.overrideRate,
        VendorCommission: row?.VendorCommission ?? row?.vendorCommission,
        SystemFees: row?.SystemFees ?? row?.systemFees,
        IncludedProcessingFee: row?.IncludedProcessingFee ?? row?.includedProcessingFee
    };
}

/**
 * Map a catalog tier row → applyIncludedFee input for agent product-tab display.
 * Leaves pricingDetails empty when MSRP is base-only so subscription include runs like checkout.
 */
function buildPricingProductFromCatalogRow(row, productId) {
    const pricingRow = normalizeCatalogPricingRow(row);
    const catalog = includedProcessingFeeUtil.resolveCatalogRetailAndBaseFromPricingRow(pricingRow);
    const tierMsrp = round2(Number(pricingRow.MSRPRate || 0));
    const componentSum = round2(
        Number(pricingRow.NetRate || 0) +
        Number(pricingRow.OverrideRate || 0) +
        Number(pricingRow.VendorCommission || 0) +
        Number(pricingRow.SystemFees || 0)
    );
    const storedIncluded = round2(catalog.includedProcessingFee || Number(pricingRow.IncludedProcessingFee || 0));

    let basePremium;
    if (storedIncluded > 0 && componentSum > 0) {
        basePremium = componentSum;
    } else if (tierMsrp > componentSum + 0.01 && componentSum > 0) {
        basePremium = componentSum;
    } else {
        basePremium = round2(
            catalog.baseAmount != null && catalog.baseAmount > 0
                ? catalog.baseAmount
                : includedProcessingFeeUtil.resolveCatalogBasePremiumFromPricingRow(pricingRow)
        );
    }

    const pricingDetails = {};
    if (storedIncluded > 0) {
        pricingDetails.includedProcessingFee = storedIncluded;
    } else if (tierMsrp > basePremium + 0.01) {
        pricingDetails.catalogRetailMsrp = tierMsrp;
    }

    const pid = productId != null ? String(productId) : String(row?.ProductId ?? row?.productId ?? '');
    return {
        productId: pid,
        productName: row?.ProductName ?? row?.productName ?? '',
        monthlyPremium: basePremium > 0 ? basePremium : tierMsrp,
        pricingDetails: Object.keys(pricingDetails).length > 0 ? pricingDetails : undefined
    };
}

/**
 * Member-facing product-tab display — delegates included fee to pricingAuthority.applyIncludedFee.
 */
function buildProductTabDisplayFromBackendUtils(_basePremiumIgnored, productIdForFees, feeContext, pricingRow, paymentMethod = 'ACH') {
    const normalizedPaymentMethod = normalizeAgentPricingPaymentMethod(paymentMethod);
    const catalogInput = buildPricingProductFromCatalogRow(pricingRow, productIdForFees);
    const basePremium = round2(catalogInput.monthlyPremium || 0);
    const pricingDetails = catalogInput.pricingDetails || {};

    const emptyDisplay = (displayPremium) => ({
        basePremium,
        displayPremium: round2(displayPremium),
        hasIncludedProcessingAdjustment: false,
        includedProcessingFee: 0,
        nonIncludedProcessingFee: 0,
        assumedPaymentMethod: normalizedPaymentMethod,
        roundUpProcessingFeeEnabled: false,
        usesCustomSystemFeeHandling: false,
        customSystemFeeAmount: 0
    });

    if (!feeContext || !productIdForFees) {
        const fallback =
            pricingDetails.catalogRetailMsrp ??
            (pricingDetails.includedProcessingFee != null
                ? round2(basePremium + Number(pricingDetails.includedProcessingFee))
                : basePremium);
        return emptyDisplay(fallback);
    }

    const feeCfg = feeContext.feesByProductId[String(productIdForFees).toLowerCase()] || feeCfgDefaultsForDisplay;
    const usesCustom = feeCfg.customSystemFeeEnabled === true;
    const customAmt =
        usesCustom && feeCfg.customSystemFeeAmount != null && Number(feeCfg.customSystemFeeAmount) > 0
            ? round2(Number(feeCfg.customSystemFeeAmount))
            : 0;

    const applied =
        pricingDetails.includedProcessingFee != null &&
        Number(pricingDetails.includedProcessingFee) > 0 &&
        feeCfg.includeProcessingFee !== true
        ? {
            basePremium,
            includedFee: round2(Number(pricingDetails.includedProcessingFee)),
            displayPremium: round2(basePremium + Number(pricingDetails.includedProcessingFee))
        }
        : pricingAuthority._internal.applyIncludedFee({
            basePremium,
            productCfg: feeCfg,
            paymentProcessorSettings: feeContext.paymentProcessorSettings,
            chargeFeeToMemberEnabled: feeContext.chargeFeeToMember === true,
            pricingDetails
        });

    let nonIncluded = 0;
    if (
        feeCfg.includeProcessingFee !== true &&
        applied.includedFee <= 0 &&
        feeContext.chargeFeeToMember &&
        feeContext.paymentProcessorSettings
    ) {
        nonIncluded = computeRowNonIncludedProcessingFee(
            applied.basePremium,
            productIdForFees,
            feeContext,
            feeCfg,
            normalizedPaymentMethod
        );
    }

    return {
        basePremium: applied.basePremium,
        displayPremium: round2(applied.displayPremium + customAmt + nonIncluded),
        hasIncludedProcessingAdjustment: applied.includedFee > 0,
        includedProcessingFee: round2(applied.includedFee),
        nonIncludedProcessingFee: nonIncluded,
        assumedPaymentMethod: normalizedPaymentMethod,
        roundUpProcessingFeeEnabled: Boolean(feeCfg.roundUpProcessingFee === true),
        usesCustomSystemFeeHandling: usesCustom,
        customSystemFeeAmount: customAmt
    };
}

function enrichPricingRowsWithMemberDisplay(finalPricing, productId, feeContext, paymentMethod = 'ACH') {
    return finalPricing.map((pricing) => {
        const pid = pricing.ProductId || productId;
        const base = premiumFromPricingRowLikeFrontend(pricing);
        const computedMemberDisplay = buildProductTabDisplayFromBackendUtils(
            base,
            pid,
            feeContext,
            pricing,
            paymentMethod
        );
        return { ...pricing, computedMemberDisplay };
    });
}

const BUNDLE_SIM_TIERS = ['EE', 'ES', 'EC', 'EF'];
const UNSHARED_CONFIG_FIELD_RE = /unshared\s*amount|deductible/i;

/**
 * Whether a pricing row matches the simulator's selected UA/config value.
 * Prefer labeled Unshared Amount / Deductible slots; fall back to ConfigValue1 when the row has no labeled config.
 * Rows with no config values match any selection (e.g. bundle children without UA variants).
 */
function pricingRowMatchesSimulatorConfig(row, configValue) {
    const target = String(configValue || '').trim();
    if (!target) return true;

    let sawLabeledConfig = false;
    for (let i = 1; i <= 5; i += 1) {
        const field = String(row[`ConfigField${i}`] || '').trim();
        const value = String(row[`ConfigValue${i}`] || '').trim();
        if (!value) continue;
        if (UNSHARED_CONFIG_FIELD_RE.test(field)) {
            sawLabeledConfig = true;
            if (value === target) return true;
        }
    }
    if (sawLabeledConfig) return false;

    const cv1 = String(row.ConfigValue1 || '').trim();
    if (!cv1) return true;
    return cv1 === target;
}

function pickBestPremiumRowFromCandidates(candidates) {
    return candidates.reduce((acc, cur) => {
        const curPremium = premiumFromRow(cur);
        if (curPremium <= 0) return acc;
        if (!acc) return cur;
        const accPremium = premiumFromRow(acc);
        return curPremium < accPremium ? cur : acc;
    }, null);
}

function getFeeCfgFromContext(feeContext, productId) {
    if (!feeContext || !productId) return feeCfgDefaultsForDisplay;
    return feeContext.feesByProductId[String(productId).toLowerCase()] || feeCfgDefaultsForDisplay;
}

function getBundleTierSystemFeesNode(premiumOnlySubtotal, feeContext, feeCfgsForIncludedProducts) {
    if (!feeContext || premiumOnlySubtotal <= 0) return 0;
    const anyCustom = (feeCfgsForIncludedProducts || []).some((c) => c.customSystemFeeEnabled === true);
    if (anyCustom) return 0;
    return systemFeesCalculator.calculateSystemFees(premiumOnlySubtotal, feeContext.systemFeesSettings);
}

/**
 * Pick lowest-positive premium row for one included product in bundle simulator.
 * @param {'strict'|'na_only'|'any'} tobaccoMode - strict: N/A or matches selection; na_only: N/A rows only; any: ignore tobacco
 */
function pickBestBundleRowForTier(rows, tier, bundleTobacco, age, configValue, tobaccoMode) {
    const tierAgeMatches = rows.filter((p) => {
        const rowTier = (p.TierType || '').toString().trim().toUpperCase();
        if (rowTier && rowTier !== tier) return false;
        const min = p.MinAge != null ? Number(p.MinAge) : 0;
        const max = p.MaxAge != null ? Number(p.MaxAge) : 999;
        return age >= min && age <= max;
    });

    const tobaccoMatches = tierAgeMatches.filter((p) => {
        const rowTobacco = normalizeTobaccoRow(p.TobaccoStatus);
        if (tobaccoMode === 'any') {
            return true;
        }
        if (tobaccoMode === 'na_only') {
            return rowTobacco === 'N/A';
        }
        if (rowTobacco !== 'N/A' && rowTobacco !== bundleTobacco) {
            return false;
        }
        return true;
    });

    const configVal = configValue != null ? String(configValue).trim() : '';
    let best = null;
    if (configVal.length > 0) {
        const configFiltered = tobaccoMatches.filter((p) => pricingRowMatchesSimulatorConfig(p, configVal));
        best = pickBestPremiumRowFromCandidates(configFiltered);
    }
    // Fallback when UA has no priced row for this tier/age (or only zero-premium stubs matched).
    if (!best || premiumFromRow(best) <= 0) {
        best = pickBestPremiumRowFromCandidates(tobaccoMatches);
    }
    return best;
}

/**
 * Pick per-tier, per-component pricing rows for the bundle simulator.
 * Returns `{ tier, pickedRows[], matchedProducts, totalProducts }` per tier so the caller
 * can hand component premiums to pricingAuthority for fee composition.
 */
function pickBundleSimulatorTierSelections(finalPricing, criteria) {
    const { tobacco, age, configValue } = criteria;
    const bundleTobacco = tobacco === 'Y' ? 'Y' : 'N';
    const productNames = Array.from(new Set(finalPricing.map((p) => p.ProductName).filter(Boolean)));

    return BUNDLE_SIM_TIERS.map((tier) => {
        const pickedRows = [];
        for (const productName of productNames) {
            const rows = finalPricing.filter((p) => (p.ProductName || '') === productName);
            let best = pickBestBundleRowForTier(rows, tier, bundleTobacco, age, configValue, 'strict');
            if (!best || premiumFromRow(best) <= 0) {
                best = pickBestBundleRowForTier(rows, tier, bundleTobacco, age, configValue, 'na_only');
            }
            if (!best || premiumFromRow(best) <= 0) {
                best = pickBestBundleRowForTier(rows, tier, bundleTobacco, age, configValue, 'any');
            }
            if (best) {
                pickedRows.push({
                    productId: best.ProductId,
                    productName: best.ProductName || productName,
                    premium: premiumFromRow(best),
                    pricingRow: best
                });
            }
        }
        return {
            tier,
            pickedRows,
            matchedProducts: pickedRows.length,
            totalProducts: productNames.length
        };
    });
}

/**
 * Bundle tab simulator totals — composes fees through `pricingAuthority.computePricing`
 * so included fees follow the 'Highest' policy (ACH + Card payers charged the same baked-in
 * price) and non-included fees follow the member's actual payment method.
 *
 * Returns a list of per-tier results in the legacy shape PLUS an `authority` block per tier
 * (products/totals/display/pricingFingerprint) callers can use to show the exact figures
 * a member will be billed.
 */
async function computeBundleSimulatorTiers(pool, tenantId, finalPricing, feeContext, bundleProductId, bundleName, criteria) {
    const { paymentMethod } = criteria;
    const normalizedPaymentMethod = paymentMethod === 'Card' ? 'Card' : 'ACH';

    const selections = pickBundleSimulatorTierSelections(finalPricing, criteria);

    const results = [];
    for (const selection of selections) {
        const { tier, pickedRows, matchedProducts, totalProducts } = selection;

        if (pickedRows.length === 0) {
            results.push({
                tier,
                totalPremium: 0,
                subtotalWithIncluded: 0,
                nonIncludedSubtotal: 0,
                processingFee: 0,
                systemFees: 0,
                matchedProducts,
                totalProducts,
                authority: null
            });
            continue;
        }

        const pricingProducts = [{
            productId: bundleProductId,
            productName: bundleName || 'Bundle',
            isBundle: true,
            monthlyPremium: round2(pickedRows.reduce((s, r) => s + Number(r.premium || 0), 0)),
            includedProducts: pickedRows.map((r) => buildBundleSimulatorComponentInput(r.pricingRow || r))
        }];

        // eslint-disable-next-line no-await-in-loop
        const authorityOutput = await pricingAuthority.computePricing({
            poolOrTransaction: pool,
            tenantId,
            pricingProducts,
            paymentMethodType: normalizedPaymentMethod
        });

        const bundleRow = authorityOutput.products[0] || null;
        const subtotalWithIncluded = bundleRow ? round2(bundleRow.displayPremium) : 0;
        const processingFee = round2(authorityOutput.totals.nonIncludedFeeTotal);
        const systemFees = round2(authorityOutput.totals.systemFees);
        // Look up subscription settings directly by productId from each included product
        // row. Do NOT filter by positional index — pricingAuthority.computePricing does not
        // guarantee that `products[].includedProducts` preserves the input order, so a
        // positional lookup against `pickedRows` could silently mis-associate fee configs
        // if the authority ever sorts/dedupes/reorders its output.
        const feeCfgByProductId = authorityOutput._raw.subscriptionFeeSettingsByProductId;
        const nonIncludedSubtotal = bundleRow
            ? round2(bundleRow.includedProducts
                .filter((ip) => {
                    const cfg = feeCfgByProductId.get(String(ip.productId));
                    return !(cfg && cfg.includeProcessingFee === true);
                })
                .reduce((s, ip) => s + Number(ip.basePremium || 0), 0))
            : 0;

        results.push({
            tier,
            totalPremium: round2(authorityOutput.totals.monthlyContribution),
            subtotalWithIncluded,
            nonIncludedSubtotal,
            processingFee,
            systemFees,
            matchedProducts,
            totalProducts,
            authority: {
                products: authorityOutput.products,
                totals: authorityOutput.totals,
                display: authorityOutput.display,
                pricingFingerprint: authorityOutput.pricingFingerprint
            }
        });
    }

    return results;
}


/**
 * @route   GET /api/me/agent/products
 * @desc    Get all products available to the authenticated agent (or TenantAdmin accessing agent portal)
 * @access  Private (Agent, TenantAdmin)
 */
router.get('/', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        console.log('🔍 Agent products endpoint hit:', {
            userId: req.user?.UserId,
            userRoles: req.user?.roles,
            currentRole: req.user?.currentRole,
            tenantId: req.tenantId
        });
        
        const pool = await getPool();
        const request = pool.request();
        request.input('TenantId', sql.UniqueIdentifier, req.tenantId);
        
        // Check if we should include hidden products (for commission rules, etc.)
        // Default: include hidden products to allow commission rules for bundle components
        const includeHidden = req.query.includeHidden !== 'false';
        
        // Only show products owned by this tenant or subscribed by this tenant
        // Include hidden products by default (hidden products can be bundle components that need commission rules)
        const hiddenFilter = includeHidden ? '' : 'AND (p.IsHidden IS NULL OR p.IsHidden = 0)';
        
        const result = await request.query(`
            SELECT DISTINCT
                p.ProductId, p.Name, p.ProductType, p.Description, p.IsBundle, p.IsHidden, p.ProductImageUrl, 
                p.ProductLogoUrl, p.ProductDocumentUrl, p.TrainingConfig, t.Name as ProductOwnerName, p.Status, p.SalesType
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            LEFT JOIN oe.TenantProductSubscriptions tps ON p.ProductId = tps.ProductId 
                AND tps.TenantId = @TenantId 
                AND tps.SubscriptionStatus != 'Cancelled'
            WHERE p.Status = 'Active' 
            ${hiddenFilter}
            AND (p.ProductOwnerId = @TenantId OR tps.TenantId = @TenantId)
            ORDER BY p.Name
        `);
        
        console.log('🔍 Agent products query result:', result.recordset.length, 'products found');

        // Training: get AgentId and best completion score per product (for requiresTrainingCompleted / trainingCompleted)
        let trainingCompletionsByProduct = {};
        const agentIdRequest = pool.request();
        agentIdRequest.input('UserId', sql.UniqueIdentifier, req.user.UserId);
        const agentIdResult = await agentIdRequest.query(`
            SELECT AgentId FROM oe.Agents WHERE UserId = @UserId AND Status = 'Active'
        `);
        const agentId = agentIdResult.recordset.length > 0 ? agentIdResult.recordset[0].AgentId : null;
        if (agentId) {
            const compRequest = pool.request();
            compRequest.input('AgentId', sql.UniqueIdentifier, agentId);
            const compResult = await compRequest.query(`
                SELECT ProductId, MAX(ScorePercent) AS BestScore
                FROM oe.TrainingCompletions
                WHERE AgentId = @AgentId
                GROUP BY ProductId
            `);
            compResult.recordset.forEach(row => {
                trainingCompletionsByProduct[row.ProductId] = row.BestScore;
            });
        }
        
        const productIdsForDocs = result.recordset.map((p) => p.ProductId).filter(Boolean);
        const productDocumentsMap = productIdsForDocs.length > 0 ? await getProductDocumentsForProductIds(pool, productIdsForDocs, sql) : new Map();

        // Process each product to add bundle components and authenticate URLs
        const products = await Promise.all(result.recordset.map(async (product) => {
            let processedProduct = { ...product };
            delete processedProduct.TrainingConfig;
            let requiresTrainingCompleted = false;
            let trainingCompleted = false;
            if (product.TrainingConfig) {
                try {
                    const config = typeof product.TrainingConfig === 'string' ? JSON.parse(product.TrainingConfig) : product.TrainingConfig;
                    const agentTraining = config.agentTraining || {};
                    requiresTrainingCompleted = agentTraining.requiredForSell === true;
                    const passingScore = agentTraining.passingScorePercent ?? 80;
                    const bestScore = trainingCompletionsByProduct[product.ProductId];
                    trainingCompleted = bestScore != null && bestScore >= passingScore;
                } catch (e) {
                    // ignore parse errors
                }
            }
            processedProduct.requiresTrainingCompleted = requiresTrainingCompleted;
            processedProduct.trainingCompleted = trainingCompleted;
            let productDocs = productDocumentsMap.get(product.ProductId) || [];
            if (productDocs.length === 0 && product.ProductDocumentUrl && typeof product.ProductDocumentUrl === 'string' && product.ProductDocumentUrl.trim()) {
                productDocs = [{ documentUrl: product.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
            }
            if (productDocs.length > 0) {
                productDocs = await authenticateProductDocumentsArray(productDocs);
            }
            processedProduct.productDocuments = productDocs;
            
            // Authenticate document URL
            if (processedProduct.ProductDocumentUrl) {
                try {
                    processedProduct = await authenticateUrls(processedProduct, ['ProductDocumentUrl']);
                    console.log('✅ Authenticated ProductDocumentUrl for:', processedProduct.Name);
                } catch (error) {
                    console.warn('⚠️ Failed to authenticate ProductDocumentUrl:', error.message);
                }
            }
            // Authenticate image/logo URLs so they load in agent portal (blob URLs may be private or have expired SAS)
            if (processedProduct.ProductImageUrl || processedProduct.ProductLogoUrl) {
                try {
                    const urlFields = [];
                    if (processedProduct.ProductImageUrl) urlFields.push('ProductImageUrl');
                    if (processedProduct.ProductLogoUrl) urlFields.push('ProductLogoUrl');
                    processedProduct = await authenticateUrls(processedProduct, urlFields);
                } catch (error) {
                    console.warn('⚠️ Failed to authenticate product image/logo URLs:', error.message);
                }
            }
            
            // If this is a bundle, get included products
            if (processedProduct.IsBundle) {
                console.log(`🔍 Processing bundle product: ${processedProduct.Name}`);
                
                try {
                    const bundleRequest = pool.request();
                    bundleRequest.input('BundleProductId', sql.UniqueIdentifier, processedProduct.ProductId);
                    
                    const bundleResult = await bundleRequest.query(`
                        SELECT 
                            pb.IncludedProductId,
                            pb.SortOrder,
                            pb.IsRequired,
                            pb.HidePricing,
                            pb.LinkedToProductId,
                            p.Name AS ProductName,
                            p.Description,
                            p.ProductType,
                            p.Status,
                            p.ProductDocumentUrl
                        FROM oe.ProductBundles pb
                        INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
                        WHERE pb.BundleProductId = @BundleProductId
                          AND p.Status = 'Active'
                        ORDER BY pb.SortOrder
                    `);
                    const includedIds = bundleResult.recordset.map((r) => r.IncludedProductId).filter(Boolean);
                    const includedDocsMap = includedIds.length > 0 ? await getProductDocumentsForProductIds(pool, includedIds, sql) : new Map();
                    
                    // Process bundle products and authenticate their document URLs
                    processedProduct.BundleProducts = await Promise.all(
                        bundleResult.recordset.map(async (bundleProduct) => {
                            let docs = includedDocsMap.get(bundleProduct.IncludedProductId) || [];
                            if (docs.length === 0 && bundleProduct.ProductDocumentUrl && typeof bundleProduct.ProductDocumentUrl === 'string' && bundleProduct.ProductDocumentUrl.trim()) {
                                docs = [{ documentUrl: bundleProduct.ProductDocumentUrl.trim(), displayName: 'Document', sortOrder: 0 }];
                            }
                            if (docs.length > 0) docs = await authenticateProductDocumentsArray(docs);
                            let processedBundleProduct = {
                                productId: bundleProduct.IncludedProductId,
                                name: bundleProduct.ProductName,
                                description: bundleProduct.Description,
                                productType: bundleProduct.ProductType,
                                sortOrder: bundleProduct.SortOrder,
                                isRequired: bundleProduct.IsRequired,
                                hidePricing: bundleProduct.HidePricing ?? false,
                                linkedToProductId: bundleProduct.LinkedToProductId,
                                productDocumentUrl: bundleProduct.ProductDocumentUrl,
                                productDocuments: docs
                            };
                            
                            if (processedBundleProduct.productDocumentUrl) {
                                try {
                                    processedBundleProduct = await authenticateUrls(processedBundleProduct, ['productDocumentUrl']);
                                } catch (error) {
                                    console.warn('⚠️ Failed to authenticate bundle product document URL:', error.message);
                                }
                            }
                            
                            return processedBundleProduct;
                        })
                    );
                    
                    console.log(`✅ Bundle ${processedProduct.Name} has ${processedProduct.BundleProducts.length} included products`);
                } catch (error) {
                    console.error(`❌ Error fetching bundle products for ${processedProduct.Name}:`, error);
                    processedProduct.BundleProducts = [];
                }
            }
            
            return processedProduct;
        }));
        
        res.json({ success: true, data: products });
    } catch (error) {
        console.error('Error fetching agent products for /api/me/agent/products:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
});

/**
 * @route   GET /api/me/agent/products/:productId/commission-groups
 * @desc    Active commission groups for the tenant (tenant / sysadmin preview only — pick group before commission preview).
 * @access  Private (TenantAdmin, SysAdmin)
 */
router.get(
    '/:productId/commission-groups',
    authorize(['TenantAdmin', 'SysAdmin']),
    requireTenantAccess,
    async (req, res) => {
        try {
            if (!shouldUseTenantCommissionPreview(req)) {
                return res.status(403).json({
                    success: false,
                    message: 'Only tenant administrators can list commission groups here.'
                });
            }
            const tenantId = req.tenantId || req.user?.TenantId;
            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId not found for request' });
            }
            const groups = await listTenantCommissionGroups(tenantId.toString());
            res.json({ success: true, data: groups });
        } catch (error) {
            console.error('Error in GET /api/me/agent/products/:productId/commission-groups:', error);
            res.status(500).json({ success: false, message: 'Failed to load commission groups' });
        }
    }
);

/**
 * @route   GET /api/me/agent/products/:productId/commission-preview
 * @desc    Commission preview for this product (Tier rules). Agents: their group + level. Tenants: pass commissionGroupId query.
 * @access  Private (Agent, TenantAdmin, SysAdmin)
 */
router.get(
    '/:productId/commission-preview',
    authorize(['Agent', 'TenantAdmin', 'SysAdmin']),
    requireTenantAccess,
    async (req, res) => {
        try {
            const { productId } = req.params;
            const tenantId = req.tenantId || req.user?.TenantId;
            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId not found for request' });
            }

            const requestedGroupId = req.query.commissionGroupId
                ? String(req.query.commissionGroupId).trim()
                : '';
            const useTenantMode =
                shouldUseTenantCommissionPreview(req) ||
                (requestedGroupId &&
                    ((await isAgencyAdminCaller(req)) ||
                        (await isLinkOwnerGroupPreviewAllowed(req, requestedGroupId))));
            if (useTenantMode) {
                if (!requestedGroupId) {
                    return res.status(400).json({
                        success: false,
                        message: 'commissionGroupId query parameter is required for tenant commission preview.'
                    });
                }
                const preview = await getTenantProductCommissionPreview({
                    tenantId: tenantId.toString(),
                    productId: productId.toString(),
                    commissionGroupId: requestedGroupId
                });
                return res.json({ success: true, data: { ...preview, viewerRole: 'tenant' } });
            }

            const pool = await getPool();
            const agentLookup = pool.request();
            agentLookup.input('UserId', sql.UniqueIdentifier, req.user.UserId);
            agentLookup.input('TenantId', sql.UniqueIdentifier, tenantId);
            const agentResult = await agentLookup.query(`
                SELECT TOP 1 AgentId
                FROM oe.Agents
                WHERE UserId = @UserId AND TenantId = @TenantId AND Status = 'Active'
            `);
            const agentId = agentResult.recordset?.[0]?.AgentId;
            if (!agentId) {
                const roles = req.user?.roles || [];
                if (roles.includes('TenantAdmin') || roles.includes('SysAdmin')) {
                    const commissionGroupId = req.query.commissionGroupId
                        ? String(req.query.commissionGroupId).trim()
                        : '';
                    if (!commissionGroupId) {
                        return res.status(400).json({
                            success: false,
                            message: 'commissionGroupId query parameter is required for tenant commission preview.'
                        });
                    }
                    const preview = await getTenantProductCommissionPreview({
                        tenantId: tenantId.toString(),
                        productId: productId.toString(),
                        commissionGroupId
                    });
                    return res.json({ success: true, data: { ...preview, viewerRole: 'tenant' } });
                }
                return res.status(403).json({ success: false, message: 'Active agent profile not found' });
            }

            const downlineAgentIdParam = req.query.downlineAgentId
                ? String(req.query.downlineAgentId).trim()
                : '';

            const viewerAgentIdStr = agentId.toString();
            if (
                downlineAgentIdParam &&
                normalizeAgentIdForCompare(downlineAgentIdParam) !== normalizeAgentIdForCompare(viewerAgentIdStr)
            ) {
                const isDownline = await isUplineAncestor(pool, downlineAgentIdParam, viewerAgentIdStr);
                if (!isDownline) {
                    return res.status(403).json({
                        success: false,
                        message: 'Access denied: target agent is not in your downline.'
                    });
                }
                const preview = await getDownlineAgentProductCommissionPreview({
                    viewerAgentId: viewerAgentIdStr,
                    subjectAgentId: downlineAgentIdParam,
                    tenantId: tenantId.toString(),
                    productId: productId.toString()
                });
                return res.json({ success: true, data: preview });
            }

            const preview = await getAgentProductCommissionPreview({
                agentId: agentId.toString(),
                tenantId: tenantId.toString(),
                productId: productId.toString()
            });

            res.json({ success: true, data: { ...preview, viewerRole: 'agent' } });
        } catch (error) {
            console.error('Error in GET /api/me/agent/products/:productId/commission-preview:', error);
            res.status(500).json({ success: false, message: 'Failed to load commission preview' });
        }
    }
);

/**
 * @route   GET /api/me/agent/products/:productId/pricing
 * @desc    Get pricing options for a specific product - if bundle, aggregates all sub-product pricing
 * @access  Private (Agent, TenantAdmin, SysAdmin)
 */
router.get('/:productId/pricing', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        console.log('===== PRICING ROUTE HIT =====');
        console.log('Full URL:', req.originalUrl);
        console.log('Product ID:', req.params.productId);
        console.log('User:', req.user);
        console.log('Tenant ID:', req.user?.TenantId);
        
        const { productId } = req.params;
        const tenantId = req.tenantId || req.user?.TenantId;
        const pool = await getPool();
        
        // First, check if this is a bundle product
        const productCheckRequest = pool.request();
        productCheckRequest.input('productId', sql.UniqueIdentifier, productId);
        const productCheck = await productCheckRequest.query(`
            SELECT IsBundle FROM oe.Products WHERE ProductId = @productId
        `);
        
        const isBundle = productCheck.recordset[0]?.IsBundle;
        console.log('[Agent Product Pricing] Is Bundle:', isBundle);
        
        let finalPricing = [];
        let bundleIncludedProductIds = [];
        
        if (isBundle) {
            // Get all included products in the bundle
            const bundleRequest = pool.request();
            bundleRequest.input('bundleProductId', sql.UniqueIdentifier, productId);
            const bundleResult = await bundleRequest.query(`
                SELECT IncludedProductId
                FROM oe.ProductBundles
                WHERE BundleProductId = @bundleProductId
            `);
            
            const includedProductIds = bundleResult.recordset.map(r => r.IncludedProductId);
            bundleIncludedProductIds = includedProductIds;
            console.log('[Agent Product Pricing] Bundle has', includedProductIds.length, 'included products');
            
            // Get pricing for all included products
            const allProductPricing = [];
            
            for (const includedProductId of includedProductIds) {
                const pricingRequest = pool.request();
                pricingRequest.input('includedProductId', sql.UniqueIdentifier, includedProductId);
                pricingRequest.input('bundleProductId', sql.UniqueIdentifier, productId);
                
                const pricingResult = await pricingRequest.query(`
                    SELECT 
                        pp.ProductPricingId,
                        pp.ProductId AS PricingProductId,
                        pp.NetRate,
                        pp.OverrideRate,
                        pp.VendorCommission,
                        pp.SystemFees,
                        pp.MSRPRate,
            pp.IncludedProcessingFee,
                    pp.IncludedProcessingFee,
                        pp.IncludedProcessingFee,
                        pp.MinAge,
                        pp.MaxAge,
                        pp.TobaccoStatus,
                        pp.TierType,
                        pp.Label,
                        pp.ConfigField1,
                        pp.ConfigField2,
                        pp.ConfigField3,
                        pp.ConfigField4,
                        pp.ConfigField5,
                        pp.ConfigValue1,
                        pp.ConfigValue2,
                        pp.ConfigValue3,
                        pp.ConfigValue4,
                        pp.ConfigValue5,
                        pp.Status,
                        pp.EffectiveDate,
                        pp.TerminationDate,
                        p.IsVendorPrice,
                        p.ProductId,
                        p.Name AS ProductName,
                        p.RequiredDataFields,
                        pb.AllowedConfigOptions
                    FROM oe.ProductPricing pp
                    INNER JOIN oe.Products p ON pp.ProductId = p.ProductId
                    LEFT JOIN oe.ProductBundles pb
                        ON pb.BundleProductId = @bundleProductId
                        AND pb.IncludedProductId = pp.ProductId
                    WHERE pp.ProductId = @includedProductId
                        AND pp.Status = 'Active'
                `);
                
                allProductPricing.push(...pricingResult.recordset);
            }
            
            console.log('[Agent Product Pricing] Total pricing records from all products:', allProductPricing.length);
            
            // Aggregate pricing by matching tiers
            const pricingMap = new Map();
            
            allProductPricing.forEach((pricingRaw) => {
                const pricing = withResolvedConfigFieldLabels(pricingRaw, pricingRaw.RequiredDataFields);
                if (!isPricingRowAllowedByBundleOptions(pricing)) return;
                // Include ProductPricingId so phased pricing rows are not collapsed into one.
                const key = `${pricing.ProductName || 'Unknown'}_${pricing.TierType || 'null'}_${pricing.TobaccoStatus || 'null'}_${pricing.MinAge || 'null'}_${pricing.MaxAge || 'null'}_${pricing.Label || 'Standard'}_${String(pricing.ProductPricingId || '')}`;
                
                if (!pricingMap.has(key)) {
                    pricingMap.set(key, {
                        ProductPricingId: pricing.ProductPricingId || null,
                        IsVendorPrice: pricing.IsVendorPrice || false,
                        ProductId: pricing.ProductId || pricing.PricingProductId,
                        ProductName: pricing.ProductName || 'Unknown',
                        Label: pricing.Label || 'Standard',
                        TierType: pricing.TierType,
                        TobaccoStatus: pricing.TobaccoStatus,
                        MinAge: pricing.MinAge,
                        MaxAge: pricing.MaxAge,
                        VendorNetRate: pricing.NetRate || 0,
                        AffiliateNetRate: pricing.NetRate || 0,
                        NetRate: pricing.NetRate || 0,
                        OverrideRate: pricing.OverrideRate || 0,
                        VendorCommission: pricing.VendorCommission || 0,
                        TenantOverride: pricing.OverrideRate || 0,
                        SystemFees: pricing.SystemFees || 0,
                        MSRPRate: pricing.MSRPRate || 0,
                        IncludedProcessingFee: pricing.IncludedProcessingFee ?? 0,
                        ConfigField1: pricing.ConfigField1,
                        ConfigValue1: pricing.ConfigValue1,
                        ConfigField2: pricing.ConfigField2,
                        ConfigValue2: pricing.ConfigValue2,
                        ConfigField3: pricing.ConfigField3,
                        ConfigValue3: pricing.ConfigValue3,
                        ConfigField4: pricing.ConfigField4,
                        ConfigValue4: pricing.ConfigValue4,
                        ConfigField5: pricing.ConfigField5,
                        ConfigValue5: pricing.ConfigValue5,
                        EffectiveDate: pricing.EffectiveDate || new Date().toISOString(),
                        TerminationDate: pricing.TerminationDate,
                        Status: pricing.Status
                    });
                }
            });
            
            finalPricing = Array.from(pricingMap.values());
            console.log('[Agent Product Pricing] Aggregated bundle pricing into', finalPricing.length, 'tier combinations');
            
        } else {
            // Regular product - query pricing directly
            console.log('[Agent Product Pricing] Querying ProductPricing table for single product');
            
            const pricingQuery = `
                SELECT 
                    pp.ProductPricingId,
                    pp.NetRate,
                    pp.OverrideRate,
                    pp.VendorCommission,
                    pp.SystemFees,
                    pp.MSRPRate,
            pp.IncludedProcessingFee,
                    pp.IncludedProcessingFee,
                    pp.MinAge,
                    pp.MaxAge,
                    pp.TobaccoStatus,
                    pp.TierType,
                    pp.Label,
                    pp.ConfigField1,
                    pp.ConfigField2,
                    pp.ConfigField3,
                    pp.ConfigField4,
                    pp.ConfigField5,
                    pp.ConfigValue1,
                    pp.ConfigValue2,
                    pp.ConfigValue3,
                    pp.ConfigValue4,
                    pp.ConfigValue5,
                    pp.Status,
                    pp.EffectiveDate,
                    pp.TerminationDate,
                    p.IsVendorPrice,
                    p.RequiredDataFields
                FROM oe.ProductPricing pp
                INNER JOIN oe.Products p ON pp.ProductId = p.ProductId
                WHERE pp.ProductId = @productId
                    AND pp.Status = 'Active'
                ORDER BY pp.TierType, pp.Label, pp.TobaccoStatus, pp.MinAge
            `;
            
            const request = pool.request();
            request.input('productId', sql.UniqueIdentifier, productId);
            
            const pricingResult = await request.query(pricingQuery);
            
            console.log('ProductPricing query result:', pricingResult.recordset.length, 'records found');
            
            finalPricing = pricingResult.recordset.map((pricingRaw) => {
                const pricing = withResolvedConfigFieldLabels(pricingRaw, pricingRaw.RequiredDataFields);
                return {
                    ProductPricingId: pricing.ProductPricingId || null,
                    IsVendorPrice: pricing.IsVendorPrice || false,
                    ProductId: productId,
                    ProductName: null, // Single products don't need ProductName for filtering
                    Label: pricing.Label || 'Standard',
                    TierType: pricing.TierType,
                    TobaccoStatus: pricing.TobaccoStatus,
                    MinAge: pricing.MinAge,
                    MaxAge: pricing.MaxAge,
                    VendorNetRate: pricing.NetRate || 0,
                    AffiliateNetRate: pricing.NetRate || 0,
                    NetRate: pricing.NetRate || 0,
                    OverrideRate: pricing.OverrideRate || 0,
                    VendorCommission: pricing.VendorCommission || 0,
                    TenantOverride: pricing.OverrideRate || 0,
                    SystemFees: pricing.SystemFees || 0,
                    MSRPRate: pricing.MSRPRate || 0,
                    IncludedProcessingFee: pricing.IncludedProcessingFee ?? 0,
                    EffectiveDate: pricing.EffectiveDate || new Date().toISOString(),
                    TerminationDate: pricing.TerminationDate,
                    ConfigField1: pricing.ConfigField1,
                    ConfigValue1: pricing.ConfigValue1,
                    ConfigField2: pricing.ConfigField2,
                    ConfigValue2: pricing.ConfigValue2,
                    ConfigField3: pricing.ConfigField3,
                    ConfigValue3: pricing.ConfigValue3,
                    ConfigField4: pricing.ConfigField4,
                    ConfigValue4: pricing.ConfigValue4,
                    ConfigField5: pricing.ConfigField5,
                    ConfigValue5: pricing.ConfigValue5,
                    Status: pricing.Status
                };
            });
        }
        
        // Add common fields for compatibility
        finalPricing = finalPricing.map(pricing => ({
            ...pricing,
            OwnerOverRide: 0,
            DiscountAmount: 0,
            DiscountEffectiveDate: null,
            DiscountEndDate: null
        }));
        
        console.log('Final Pricing Result:', finalPricing.length, 'tiers');
        if (finalPricing.length > 0) {
            console.log('First Record:', finalPricing[0]);
        }

        const productIdsForFees = isBundle
            ? [productId, ...bundleIncludedProductIds]
            : [productId];
        const feeTenantId = await resolvePricingFeeTenantId(pool, productId, tenantId, req.user);
        const feeContext = await loadAgentPricingFeeContext(pool, feeTenantId, productIdsForFees);
        const paymentMethod = normalizeAgentPricingPaymentMethod(req.query.paymentMethod);

        const enrichedPricing = enrichPricingRowsWithMemberDisplay(
            finalPricing,
            productId,
            feeContext,
            paymentMethod
        );

        res.json({
            success: true,
            data: enrichedPricing,
            feeContext,
            paymentMethod
        });
        
    } catch (error) {
        console.error('===== PRICING ROUTE ERROR =====');
        console.error('Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch product pricing',
            error: error.message 
        });
    }
});

/**
 * @route   POST /api/me/agent/products/:productId/pricing/bundle-simulator
 * @desc    Bundle tier totals for product details modal — processing via processingFeeCalculator + includedProcessingFee only.
 * @access  Private (Agent, TenantAdmin, SysAdmin)
 */
router.post('/:productId/pricing/bundle-simulator', authorize(['Agent', 'TenantAdmin', 'SysAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const tenantId = req.tenantId || req.user?.TenantId;
        const pool = await getPool();

        const productCheckRequest = pool.request();
        productCheckRequest.input('productId', sql.UniqueIdentifier, productId);
        const productCheck = await productCheckRequest.query(`
            SELECT IsBundle, Name FROM oe.Products WHERE ProductId = @productId
        `);
        const isBundle = productCheck.recordset[0]?.IsBundle;
        const bundleName = productCheck.recordset[0]?.Name || 'Bundle';
        if (!isBundle) {
            return res.status(400).json({ success: false, message: 'Product is not a bundle' });
        }

        let finalPricing = [];
        let bundleIncludedProductIds = [];

        const bundleRequest = pool.request();
        bundleRequest.input('bundleProductId', sql.UniqueIdentifier, productId);
        const bundleResult = await bundleRequest.query(`
            SELECT IncludedProductId
            FROM oe.ProductBundles
            WHERE BundleProductId = @bundleProductId
        `);
        bundleIncludedProductIds = bundleResult.recordset.map((r) => r.IncludedProductId);

        const allProductPricing = [];
        for (const includedProductId of bundleIncludedProductIds) {
            const pricingRequest = pool.request();
            pricingRequest.input('includedProductId', sql.UniqueIdentifier, includedProductId);
            pricingRequest.input('bundleProductId', sql.UniqueIdentifier, productId);

            const pricingResult = await pricingRequest.query(`
                SELECT 
                    pp.ProductPricingId,
                    pp.ProductId AS PricingProductId,
                    pp.NetRate,
                    pp.OverrideRate,
                    pp.VendorCommission,
                    pp.SystemFees,
                    pp.MSRPRate,
            pp.IncludedProcessingFee,
                    pp.IncludedProcessingFee,
                    pp.MinAge,
                    pp.MaxAge,
                    pp.TobaccoStatus,
                    pp.TierType,
                    pp.Label,
                    pp.ConfigField1,
                    pp.ConfigField2,
                    pp.ConfigField3,
                    pp.ConfigField4,
                    pp.ConfigField5,
                    pp.ConfigValue1,
                    pp.ConfigValue2,
                    pp.ConfigValue3,
                    pp.ConfigValue4,
                    pp.ConfigValue5,
                    pp.Status,
                    pp.EffectiveDate,
                    pp.TerminationDate,
                    p.IsVendorPrice,
                    p.ProductId,
                    p.Name AS ProductName,
                    p.RequiredDataFields,
                    pb.AllowedConfigOptions
                FROM oe.ProductPricing pp
                INNER JOIN oe.Products p ON pp.ProductId = p.ProductId
                LEFT JOIN oe.ProductBundles pb
                    ON pb.BundleProductId = @bundleProductId
                    AND pb.IncludedProductId = pp.ProductId
                WHERE pp.ProductId = @includedProductId
                    AND pp.Status = 'Active'
            `);

            allProductPricing.push(...pricingResult.recordset);
        }

        const pricingMap = new Map();
        allProductPricing.forEach((pricingRaw) => {
            const pricing = withResolvedConfigFieldLabels(pricingRaw, pricingRaw.RequiredDataFields);
            if (!isPricingRowAllowedByBundleOptions(pricing)) return;
            const key = `${pricing.ProductName || 'Unknown'}_${pricing.TierType || 'null'}_${pricing.TobaccoStatus || 'null'}_${pricing.MinAge || 'null'}_${pricing.MaxAge || 'null'}_${pricing.Label || 'Standard'}_${String(pricing.ProductPricingId || '')}`;

            if (!pricingMap.has(key)) {
                pricingMap.set(key, {
                    ProductPricingId: pricing.ProductPricingId || null,
                    IsVendorPrice: pricing.IsVendorPrice || false,
                    ProductId: pricing.ProductId || pricing.PricingProductId,
                    ProductName: pricing.ProductName || 'Unknown',
                    Label: pricing.Label || 'Standard',
                    TierType: pricing.TierType,
                    TobaccoStatus: pricing.TobaccoStatus,
                    MinAge: pricing.MinAge,
                    MaxAge: pricing.MaxAge,
                    VendorNetRate: pricing.NetRate || 0,
                    AffiliateNetRate: pricing.NetRate || 0,
                    VendorCommission: pricing.VendorCommission || 0,
                    TenantOverride: pricing.OverrideRate || 0,
                    SystemFees: pricing.SystemFees || 0,
                    MSRPRate: pricing.MSRPRate || 0,
                    IncludedProcessingFee: pricing.IncludedProcessingFee || 0,
                    ConfigField1: pricing.ConfigField1,
                    ConfigValue1: pricing.ConfigValue1,
                    ConfigField2: pricing.ConfigField2,
                    ConfigValue2: pricing.ConfigValue2,
                    ConfigField3: pricing.ConfigField3,
                    ConfigValue3: pricing.ConfigValue3,
                    ConfigField4: pricing.ConfigField4,
                    ConfigValue4: pricing.ConfigValue4,
                    ConfigField5: pricing.ConfigField5,
                    ConfigValue5: pricing.ConfigValue5,
                    EffectiveDate: pricing.EffectiveDate || new Date().toISOString(),
                    TerminationDate: pricing.TerminationDate,
                    Status: pricing.Status
                });
            }
        });

        finalPricing = Array.from(pricingMap.values());
        finalPricing = finalPricing.map((pricing) => ({
            ...pricing,
            OwnerOverRide: 0,
            DiscountAmount: 0,
            DiscountEffectiveDate: null,
            DiscountEndDate: null
        }));

        const asOfRaw = req.body?.asOf ?? req.body?.effectiveDate;
        const asOfStr = typeof asOfRaw === 'string' ? asOfRaw.trim() : '';
        finalPricing = filterPricingRowsAsOfYyyyMmDd(finalPricing, asOfStr || undefined);

        const productIdsForFees = [productId, ...bundleIncludedProductIds];
        const feeTenantId = await resolvePricingFeeTenantId(pool, productId, tenantId, req.user);
        const feeContext = await loadAgentPricingFeeContext(pool, feeTenantId, productIdsForFees, productId);

        const tobacco = String(req.body?.tobacco || 'N').toUpperCase() === 'Y' ? 'Y' : 'N';
        const age = Number(req.body?.age ?? 35);
        const configValue = req.body?.configValue != null ? String(req.body.configValue) : '';
        const paymentMethod = String(req.body?.paymentMethod || 'ACH').toLowerCase() === 'card' ? 'Card' : 'ACH';

        const bundleProductIds = Array.isArray(req.body?.bundleProductIds)
            ? req.body.bundleProductIds
            : bundleIncludedProductIds;
        void bundleProductIds; // preserved for API backward-compat with legacy callers

        // Each tier now runs `pricingAuthority.computePricing`, producing an `authority`
        // block alongside the legacy tier shape. The EE-tier authority block is surfaced at
        // the top of the response as a representative quote so the frontend can display the
        // drift-resistant fingerprint + policy-correct totals without walking the tier list.
        const bundleTotalsByTier = await computeBundleSimulatorTiers(
            pool,
            tenantId,
            finalPricing,
            feeContext,
            productId,
            bundleName,
            { tobacco, age, configValue, paymentMethod }
        );

        const representativeTier =
            bundleTotalsByTier.find((t) => t.tier === 'EE' && t.authority) ||
            bundleTotalsByTier.find((t) => t.authority) ||
            null;
        const authority = representativeTier ? representativeTier.authority : null;

        res.json({ success: true, data: { bundleTotalsByTier, feeContext, authority } });
    } catch (error) {
        console.error('bundle-simulator error:', error);
        res.status(500).json({ success: false, message: error.message || 'Bundle simulator failed' });
    }
});

function toBool(v) {
    if (v === true || v === 1) return true;
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function roundUpFlag(v) {
    // Match enrollment pricing behavior: null/undefined defaults to true.
    if (v === null || v === undefined) return true;
    return toBool(v);
}

function normalizeTobaccoInput(v) {
    return String(v || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N';
}

function normalizeTobaccoRow(v) {
    if (v == null || String(v).trim() === '') return 'N/A';
    const u = String(v).trim().toUpperCase();
    if (u === 'Y' || u === 'YES') return 'Y';
    if (u === 'N' || u === 'NO') return 'N';
    return 'N/A';
}

function premiumFromRow(row) {
    const msrp = Number(row?.MSRPRate || 0);
    if (msrp > 0) return msrp;
    const vendor = Number(row?.VendorNetRate || row?.NetRate || 0);
    if (vendor > 0) return vendor;
    return 0;
}

/** Map oe.ProductPricing row → applyIncludedFee input (agent catalog + bundle simulator). */
function buildBundleSimulatorComponentInput(row) {
    return buildPricingProductFromCatalogRow(row, row.ProductId);
}

/** Map a catalog-normalized premium part → pricingAuthority input (quick quote + bundle simulator). */
function buildAuthorityInputFromCatalogPart(part) {
    return {
        productId: part.productId,
        productName: part.productName || '',
        monthlyPremium: round2(Number(part.basePremium || 0)),
        ...(part.pricingDetails ? { pricingDetails: part.pricingDetails } : {})
    };
}

function normalizeConfigValuesMap(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        const slot = String(key || '').trim();
        if (!slot) continue;
        const values = Array.isArray(value) ? value : [value];
        const cleaned = values
            .map((v) => String(v || '').trim())
            .filter(Boolean);
        if (cleaned.length > 0) out[slot] = Array.from(new Set(cleaned));
    }
    return out;
}

function buildConfigCombinations(configMap) {
    const entries = Object.entries(configMap || {});
    if (!entries.length) return [{}];
    let combinations = [{}];
    for (const [slot, values] of entries) {
        const next = [];
        for (const combo of combinations) {
            for (const value of values) {
                next.push({ ...combo, [slot]: value });
            }
        }
        combinations = next;
    }
    return combinations.length > 0 ? combinations : [{}];
}

function pickBestPricingRow(rows, criteria, selectedConfigValues) {
    const baseMatches = (rows || []).filter((row) => {
        const tierType = String(row?.TierType || '').trim().toUpperCase();
        if (tierType && tierType !== String(criteria.tier || '').trim().toUpperCase()) return false;

        const rowTobacco = normalizeTobaccoRow(row?.TobaccoStatus);
        if (rowTobacco !== 'N/A' && rowTobacco !== criteria.tobaccoUse) return false;

        const minAge = row?.MinAge != null ? Number(row.MinAge) : 0;
        const maxAge = row?.MaxAge != null ? Number(row.MaxAge) : 999;
        const age = Number(criteria.age || 0);
        if (age < minAge || age > maxAge) return false;

        return true;
    });

    const configEntries = Object.entries(selectedConfigValues || {})
        .map(([slot, value]) => [String(slot).trim(), String(value || '').trim()])
        .filter(([slot, value]) => Boolean(slot) && Boolean(value));

    const configMatches = configEntries.length
        ? baseMatches.filter((row) => {
            for (const [slot, value] of configEntries) {
                const rowValue = String(row?.[`ConfigValue${slot}`] || '').trim();
                if (rowValue !== value) return false;
            }
            return true;
        })
        : [];

    const candidates = configMatches.length > 0 ? configMatches : baseMatches;
    if (!candidates.length) return null;

    return candidates.reduce((best, current) => {
        const currentPremium = premiumFromRow(current);
        if (!best) return current;
        const bestPremium = premiumFromRow(best);

        if (currentPremium <= 0 && bestPremium > 0) return best;
        if (bestPremium <= 0 && currentPremium > 0) return current;
        if (currentPremium > 0 && currentPremium < bestPremium) return current;
        return best;
    }, null);
}

async function getProductPricingRows(pool, productId) {
    const request = pool.request();
    request.input('productId', sql.UniqueIdentifier, productId);
    const result = await request.query(`
        SELECT
            pp.ProductPricingId,
            pp.NetRate,
            pp.OverrideRate,
            pp.VendorCommission,
            pp.SystemFees,
            pp.MSRPRate,
            pp.IncludedProcessingFee,
            pp.MinAge,
            pp.MaxAge,
            pp.TobaccoStatus,
            pp.TierType,
            pp.Label,
            pp.ConfigField1,
            pp.ConfigValue1,
            pp.Status
        FROM oe.ProductPricing pp
        WHERE pp.ProductId = @productId
          AND pp.Status = 'Active'
    `);
    return result.recordset || [];
}

/**
 * @route   POST /api/me/agent/products/quick-quote/calculate
 * @desc    Calculate a quick premium quote for selected products
 * @access  Private (Agent, TenantAdmin)
 */
router.post('/quick-quote/calculate', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant context is required' });
        }

        const criteria = req.body?.criteria || {};
        const selectedProducts = Array.isArray(req.body?.selectedProducts) ? req.body.selectedProducts : [];
        if (!selectedProducts.length) {
            return res.status(400).json({ success: false, message: 'At least one product is required' });
        }

        const normalizedCriteria = {
            personName: String(criteria.personName || '').trim() || undefined,
            age: Number(criteria.age || 0),
            tobaccoUse: normalizeTobaccoInput(criteria.tobaccoUse),
            tier: String(criteria.tier || 'EE').trim().toUpperCase(),
            householdSize: Number(criteria.householdSize || 1),
            paymentMethod: String(criteria.paymentMethod || 'ACH').trim().toUpperCase() === 'CARD' ? 'Card' : 'ACH'
        };

        const selectedProductIds = Array.from(
            new Set(
                selectedProducts
                    .map((p) => p?.productId)
                    .filter((p) => Boolean(p))
            )
        );

        const pool = await getPool();
        const productsReq = pool.request();
        const inParams = selectedProductIds.map((id, idx) => {
            const name = `pid_${idx}`;
            productsReq.input(name, sql.UniqueIdentifier, id);
            return `@${name}`;
        }).join(', ');

        const selectedProductRows = await productsReq.query(`
            SELECT ProductId, Name, IsBundle
            FROM oe.Products
            WHERE ProductId IN (${inParams})
        `);
        const selectedProductMap = new Map((selectedProductRows.recordset || []).map((r) => [String(r.ProductId), r]));

        const breakdown = [];
        const underlyingPremiumParts = [];

        for (const selected of selectedProducts) {
            const productId = String(selected?.productId || '').trim();
            if (!productId) continue;

            const selectedConfigValueMap = typeof selected?.configValues === 'object' && selected?.configValues !== null
                ? normalizeConfigValuesMap(selected.configValues)
                : normalizeConfigValuesMap(selected?.configValue != null ? { 1: String(selected.configValue).trim() } : {});
            const selectedConfigLabels = typeof selected?.configLabels === 'object' && selected?.configLabels !== null
                ? selected.configLabels
                : {};
            const configCombinations = buildConfigCombinations(selectedConfigValueMap);
            const productMeta = selectedProductMap.get(productId);
            if (!productMeta) continue;

            const isBundle = productMeta.IsBundle === true || productMeta.IsBundle === 1;
            for (let comboIndex = 0; comboIndex < configCombinations.length; comboIndex += 1) {
                const selectedConfigValues = configCombinations[comboIndex] || {};
                const selectedConfigDetails = Object.entries(selectedConfigValues || {})
                    .map(([key, value]) => ({
                        key: String(key),
                        label: String(selectedConfigLabels?.[key] || '').trim() || 'Plan',
                        value: String(value || '').trim()
                    }))
                    .filter((item) => item.value.length > 0);
                const quoteItemId = `${productId}__${comboIndex + 1}`;
                let basePremium = 0;

                if (isBundle) {
                    const bundleReq = pool.request();
                    bundleReq.input('bundleProductId', sql.UniqueIdentifier, productId);
                    const bundleRes = await bundleReq.query(`
                        SELECT IncludedProductId
                        FROM oe.ProductBundles
                        WHERE BundleProductId = @bundleProductId
                    `);
                    const includedIds = (bundleRes.recordset || []).map((r) => r.IncludedProductId).filter(Boolean);

                    for (const includedProductId of includedIds) {
                        const pricingRows = await getProductPricingRows(pool, includedProductId);
                        const bestRow = pickBestPricingRow(pricingRows, normalizedCriteria, selectedConfigValues);
                        if (!bestRow) continue;
                        const catalogInput = buildPricingProductFromCatalogRow(bestRow, includedProductId);
                        const partPremium = round2(catalogInput.monthlyPremium || 0);
                        if (partPremium > 0) {
                            basePremium += partPremium;
                            underlyingPremiumParts.push({
                                ownerQuoteItemId: quoteItemId,
                                productId: String(includedProductId),
                                productName: bestRow?.ProductName,
                                basePremium: partPremium,
                                pricingDetails: catalogInput.pricingDetails
                            });
                        }
                    }
                } else {
                    const pricingRows = await getProductPricingRows(pool, productId);
                    const bestRow = pickBestPricingRow(pricingRows, normalizedCriteria, selectedConfigValues);
                    if (!bestRow) continue;
                    const catalogInput = buildPricingProductFromCatalogRow(bestRow, productId);
                    const partPremium = round2(catalogInput.monthlyPremium || 0);
                    if (partPremium > 0) {
                        basePremium += partPremium;
                        underlyingPremiumParts.push({
                            ownerQuoteItemId: quoteItemId,
                            productId: productId,
                            productName: bestRow?.ProductName,
                            basePremium: partPremium,
                            pricingDetails: catalogInput.pricingDetails
                        });
                    }
                }

                breakdown.push({
                    quoteItemId,
                    productId,
                    productName: productMeta.Name,
                    isBundle,
                    basePremium: round2(basePremium),
                    includedProcessingFee: 0,
                    premiumWithIncludedFee: round2(basePremium),
                    selectedConfigValues: selectedConfigValues && Object.keys(selectedConfigValues).length > 0 ? selectedConfigValues : null,
                    selectedConfigDetails: selectedConfigDetails.length > 0 ? selectedConfigDetails : null
                });
            }
        }

        // Price a set of breakdown items through the pricing authority. The 'Highest'
        // included-fee policy is applied per product, so a product's display premium is
        // the same whether priced alone or in a basket — only the basket-level
        // non-included + system fees aggregate. Used both per-item (comparison mode) and
        // over the whole basket (determinate mode).
        const priceScenario = async (items) => {
            const selectedQuoteItemIds = new Set(items.map((i) => String(i.quoteItemId)));
            const scenarioUnderlyingParts = underlyingPremiumParts.filter((p) => selectedQuoteItemIds.has(String(p.ownerQuoteItemId)));

            // Group underlying premium parts by ownerQuoteItemId so each item maps 1:1 with a
            // pricingProducts entry the authority understands.
            const partsByQuoteItemId = new Map();
            for (const part of scenarioUnderlyingParts) {
                const key = String(part.ownerQuoteItemId);
                if (!partsByQuoteItemId.has(key)) partsByQuoteItemId.set(key, []);
                partsByQuoteItemId.get(key).push(part);
            }

            const pricingProducts = items
                .map((item) => {
                    const parts = partsByQuoteItemId.get(String(item.quoteItemId)) || [];
                    if (parts.length === 0) return null;
                    if (item.isBundle) {
                        return {
                            productId: item.productId,
                            productName: item.productName,
                            isBundle: true,
                            monthlyPremium: round2(parts.reduce((s, p) => s + Number(p.basePremium || 0), 0)),
                            includedProducts: parts.map((p) => buildAuthorityInputFromCatalogPart({
                                ...p,
                                productName: p.productName || item.productName
                            }))
                        };
                    }
                    const single = parts[0];
                    return {
                        ...buildAuthorityInputFromCatalogPart({
                            ...single,
                            productName: item.productName || single.productName
                        }),
                        isBundle: false
                    };
                })
                .filter(Boolean);

            const authorityOutput = await pricingAuthority.computePricing({
                poolOrTransaction: pool,
                tenantId,
                pricingProducts,
                paymentMethodType: normalizedCriteria.paymentMethod
            });

            // Read per-item included fees + display premiums straight from authority output so
            // each breakdown row shows its drift-resistant display premium.
            const authorityByProductId = new Map();
            for (const row of authorityOutput.products) {
                authorityByProductId.set(String(row.productId), row);
            }
            const scenarioBreakdown = items.map((item) => {
                const row = authorityByProductId.get(String(item.productId));
                const includedFee = row ? round2(row.includedFee) : 0;
                const displayPremium = row ? round2(row.displayPremium) : Number(item.basePremium || 0);
                return {
                    ...item,
                    includedProcessingFee: includedFee,
                    premiumWithIncludedFee: displayPremium
                };
            });

            return {
                scenarioBreakdown,
                totals: {
                    subtotalPremium: round2(authorityOutput.totals.displayPremiumTotal),
                    processingFee: round2(authorityOutput.totals.nonIncludedFeeTotal),
                    systemFees: round2(authorityOutput.totals.systemFees),
                    totalPremium: round2(authorityOutput.totals.monthlyContribution)
                },
                authority: {
                    products: authorityOutput.products,
                    totals: authorityOutput.totals,
                    display: authorityOutput.display,
                    pricingFingerprint: authorityOutput.pricingFingerprint
                }
            };
        };

        const mode = classifyQuoteMode(breakdown);

        // Price each product x amount on its own through the pricing authority and attach its
        // own Total + Fees (`optionTotals`) to the line. The UI shows these per option
        // (Total, plus a Fees line when the product carries separate fees) — no base premium.
        const pricedBreakdown = [];
        for (const item of breakdown) {
            // eslint-disable-next-line no-await-in-loop
            const { scenarioBreakdown, totals } = await priceScenario([item]);
            pricedBreakdown.push({ ...scenarioBreakdown[0], optionTotals: totals });
        }

        // Determinate basket (one amount per product): also expose a combined authority
        // block + totals at the top level for backward-compat consumers (fingerprint, PDF).
        // Comparison mode (any product has multiple amounts) omits the combined total.
        let basketTotals = null;
        let basketAuthority = null;
        if (mode !== 'comparison') {
            const basket = await priceScenario(breakdown);
            basketTotals = basket.totals;
            basketAuthority = basket.authority;
        }

        const shaped = buildQuickQuoteResult({ breakdown: pricedBreakdown, mode, basketTotals });

        return res.json({
            success: true,
            data: {
                criteria: normalizedCriteria,
                breakdown: shaped.breakdown,
                totals: shaped.totals,
                quoteOptions: shaped.quoteOptions,
                comparison: shaped.comparison,
                // Authority block (pricingFingerprint + drift-resistant totals) is only
                // meaningful for a determinate basket; null in per-product comparison mode.
                authority: basketAuthority
            }
        });
    } catch (error) {
        console.error('Error calculating quick quote:', error);
        return res.status(500).json({ success: false, message: 'Failed to calculate quick quote' });
    }
});

function isAllowedQuickQuoteDocumentUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        if (!u.protocol.startsWith('http')) return false;
        return u.pathname.includes('/proposals/');
    } catch {
        return false;
    }
}

/** URLs the server may fetch for quick-quote email attachments (quote PDF or tenant blob docs). */
function isAllowedQuickQuoteAttachmentUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        if (!u.protocol.startsWith('http')) return false;
        if (isAllowedQuickQuoteDocumentUrl(url)) return true;
        if (u.hostname.includes('blob.core.windows.net') || u.hostname.includes('storage.allaboard365.com')) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function sanitizeQuickQuoteAttachmentFilename(name) {
    const base = String(name || 'document')
        .replace(/[^a-zA-Z0-9-_. ]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 120) || 'document';
    return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

const QUOTE_EMAIL_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const QUOTE_EMAIL_MAX_EXTRA_ATTACHMENTS = 20;

/** Default subject: "Quote from <agent name>", else "Quote from <tenant name>", else product fallback. */
function buildQuickQuoteDefaultSubject(sender, emailConfig) {
    const agentName = sender?.replyToName && String(sender.replyToName).trim();
    const tenantName = emailConfig?.tenantName && String(emailConfig.tenantName).trim();
    if (agentName) {
        return `Quote from ${agentName}`;
    }
    if (tenantName) {
        return `Quote from ${tenantName}`;
    }
    return 'Quote from AllAboard365';
}

/**
 * Envelope From *address* for SendGrid: use tenant AdvancedSettings email customFromAddress (verified in SendGrid),
 * else platform DEFAULT_FROM_EMAIL, else shared noreply. Does not use tenant ContactEmail — not guaranteed authenticated with SendGrid.
 */
function resolveQuickQuoteFromEmail(emailConfig) {
    const custom = emailConfig?.customFromAddress && String(emailConfig.customFromAddress).trim();
    if (custom) {
        return custom;
    }
    const envFrom = process.env.DEFAULT_FROM_EMAIL && String(process.env.DEFAULT_FROM_EMAIL).trim();
    if (envFrom) {
        return envFrom;
    }
    return 'noreply@allaboard365.com';
}

/**
 * @route   POST /api/me/agent/products/quick-quote/pdf
 * @desc    Generate downloadable PDF for quick quote
 * @access  Private (Agent, TenantAdmin)
 */
router.post('/quick-quote/pdf', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { breakdown } = req.body || {};
        if (!Array.isArray(breakdown) || breakdown.length === 0) {
            return res.status(400).json({ success: false, message: 'Quote breakdown is required' });
        }
        const buffer = await generateQuickQuotePdfBuffer(req.body);
        const fileName = `quick-quote-${new Date().toISOString().slice(0, 10)}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Error generating quick quote PDF:', error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: error.message || 'Failed to generate quote PDF'
            });
        }
    }
});

/**
 * @route   POST /api/me/agent/products/quick-quote/prepare-send
 * @desc    Build PDF, upload to blob, return URLs and sender metadata for email/SMS preview
 */
router.post('/quick-quote/prepare-send', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant context is required' });
        }
        const body = req.body || {};
        const { breakdown } = body;
        if (!Array.isArray(breakdown) || breakdown.length === 0) {
            return res.status(400).json({ success: false, message: 'Quote breakdown is required' });
        }
        const buffer = await generateQuickQuotePdfBuffer(body);
        const prospectLabel = String(body?.criteria?.personName || body?.recipientName || 'quote').trim() || 'quote';
        const documentUrl = await ProposalGeneratorService.uploadProposalPDF(buffer, `QuickQuote-${prospectLabel}`);
        const sender = await getAgentSenderContext(req);
        const emailConfig = await sendGridEmailService.getTenantEmailConfig(tenantId);
        const fromEmail = resolveQuickQuoteFromEmail(emailConfig);
        /** Shown as From "name" in the inbox; envelope address is verified tenant custom or platform default. */
        const fromDisplayName = (sender.replyToName && String(sender.replyToName).trim()) || emailConfig.tenantName || 'AllAboard365';
        const recipName = String(body?.recipientName || body?.criteria?.personName || '').trim() || 'there';
        const firstName = recipName.split(/\s+/)[0] || 'there';
        const defaultEmailBody = `${sender.replyToName} sent you a premium quote.

Hi ${firstName},

Please find your premium quote attached as a PDF.

If you have any questions, reply to this email and ${sender.replyToName} will receive your message.

Best regards,
${sender.replyToName}`;
        return res.json({
            success: true,
            data: {
                documentUrl,
                fromEmail,
                fromDisplayName,
                replyToEmail: sender.replyToEmail,
                replyToName: sender.replyToName,
                defaultEmailBody,
                defaultSubject: buildQuickQuoteDefaultSubject(sender, emailConfig)
            }
        });
    } catch (error) {
        console.error('Error preparing quick quote send:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to prepare quote for sending'
        });
    }
});

/**
 * @route   POST /api/me/agent/products/quick-quote/send-email
 */
router.post('/quick-quote/send-email', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant context is required' });
        }
        const { documentUrl, recipientEmail, subject, message, additionalAttachmentUrls } = req.body || {};
        if (!recipientEmail || !String(recipientEmail).includes('@')) {
            return res.status(400).json({ success: false, message: 'Valid recipient email is required' });
        }
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        if (!isAllowedQuickQuoteDocumentUrl(documentUrl)) {
            return res.status(400).json({ success: false, message: 'Invalid or expired document link' });
        }
        const quotePdfResp = await fetch(documentUrl);
        if (!quotePdfResp.ok) {
            return res.status(400).json({ success: false, message: 'Could not load quote PDF from storage' });
        }
        const quotePdfBuffer = Buffer.from(await quotePdfResp.arrayBuffer());
        console.log('[quick-quote/send-email] Loaded quote PDF from storage, bytes:', quotePdfBuffer.length);

        const sender = await getAgentSenderContext(req);
        const emailConfig = await sendGridEmailService.getTenantEmailConfig(tenantId);
        const fromEmail = resolveQuickQuoteFromEmail(emailConfig);
        const plain = String(message).trim();
        const html = plain.replace(/\n/g, '<br>');

        const quoteUrlNorm = String(documentUrl).trim();
        let extras = Array.isArray(additionalAttachmentUrls) ? additionalAttachmentUrls : [];
        extras = extras
            .filter((x) => x && typeof x.url === 'string' && String(x.url).trim())
            .slice(0, QUOTE_EMAIL_MAX_EXTRA_ATTACHMENTS)
            .map((x) => ({
                url: String(x.url).trim(),
                filename: sanitizeQuickQuoteAttachmentFilename(x.filename || 'document.pdf')
            }))
            .filter((x) => isAllowedQuickQuoteAttachmentUrl(x.url) && x.url !== quoteUrlNorm);

        const seenUrls = new Set();
        extras = extras.filter((x) => {
            if (seenUrls.has(x.url)) return false;
            seenUrls.add(x.url);
            return true;
        });

        const attachments = [{
            content: quotePdfBuffer.toString('base64'),
            filename: 'quick-quote.pdf',
            type: 'application/pdf',
            disposition: 'attachment'
        }];
        let totalBytes = quotePdfBuffer.length;

        for (const extra of extras) {
            const extraResp = await fetch(extra.url);
            if (!extraResp.ok) {
                return res.status(400).json({
                    success: false,
                    message: `Could not download attachment: ${extra.filename}`
                });
            }
            const buf = Buffer.from(await extraResp.arrayBuffer());
            if (totalBytes + buf.length > QUOTE_EMAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
                return res.status(400).json({
                    success: false,
                    message: 'Attachments exceed maximum total size (25 MB). Remove some product documents and try again.'
                });
            }
            totalBytes += buf.length;
            attachments.push({
                content: buf.toString('base64'),
                filename: extra.filename,
                type: 'application/pdf',
                disposition: 'attachment'
            });
        }

        const recipientNorm = String(recipientEmail).trim().toLowerCase();
        const senderEmail = String(sender.replyToEmail || '').trim();
        const senderNorm = senderEmail.toLowerCase();
        const ccSender =
            senderNorm && senderNorm !== recipientNorm
                ? [{ email: senderEmail, name: sender.replyToName || undefined }]
                : undefined;

        console.log('[quick-quote/send-email] Calling SendGrid', {
            to: recipientEmail,
            attachmentCount: attachments.length,
            extraProductAttachments: extras.length
        });
        const defaultSubjectFallback = buildQuickQuoteDefaultSubject(sender, emailConfig);
        const sendResult = await sendGridEmailService.sendEmail({
            tenantId,
            to: recipientEmail,
            from: fromEmail,
            ...(ccSender && { cc: ccSender }),
            subject: String((subject != null && String(subject).trim()) ? subject : defaultSubjectFallback).trim(),
            html,
            text: plain,
            replyTo: { email: sender.replyToEmail, name: sender.replyToName },
            attachments,
            metadata: {
                fromName: (sender.replyToName && String(sender.replyToName).trim()) || emailConfig.tenantName || 'AllAboard365',
                sentBy: req.user.UserId
            }
        });
        if (sendResult && sendResult.messageId === 'dev-mode-skip') {
            console.warn('[quick-quote/send-email] SendGrid disabled — email was NOT sent to provider');
            return res.status(503).json({
                success: false,
                message:
                    'Email is not sent: SENDGRID_API_KEY is missing or invalid in this environment. Add it to backend/.env and restart the API.'
            });
        }
        console.log('[quick-quote/send-email] SendGrid OK', sendResult?.messageId);
        const subjForHistory = String((subject != null && String(subject).trim()) ? subject : defaultSubjectFallback).trim();
        const mhResult = await sendGridEmailDeliveryTracking.insertQuickQuoteMessageHistory({
            tenantId,
            recipientEmail: String(recipientEmail).trim(),
            subject: subjForHistory,
            providerMessageId: sendResult?.messageId
        });
        return res.json({
            success: true,
            message: 'Email sent',
            messageHistoryId: mhResult && mhResult.historyId ? mhResult.historyId : null
        });
    } catch (error) {
        console.error('Error sending quick quote email:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to send email'
        });
    }
});

/**
 * @route   POST /api/me/agent/products/quick-quote/send-sms
 */
router.post('/quick-quote/send-sms', authorize(['Agent', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!tenantId) {
            return res.status(400).json({ success: false, message: 'Tenant context is required' });
        }
        const { documentUrl, recipientPhone, message } = req.body || {};
        if (!recipientPhone || !String(recipientPhone).trim()) {
            return res.status(400).json({ success: false, message: 'Phone number is required' });
        }
        if (!message || !String(message).trim()) {
            return res.status(400).json({ success: false, message: 'Message is required' });
        }
        if (!isAllowedQuickQuoteDocumentUrl(documentUrl)) {
            return res.status(400).json({ success: false, message: 'Invalid or expired document link' });
        }
        const bodyText = buildSmsBodyWithLinks(String(message).trim(), documentUrl, {
            linkLabel: 'View quote:',
        });
        await MessageQueueService.queueMessage({
            tenantId,
            messageType: 'SMS',
            recipientAddress: recipientPhone,
            subject: null,
            messageBody: bodyText,
            status: 'Pending',
            createdBy: req.user.UserId,
            recipientId: null
        });
        return res.json({ success: true, message: 'SMS queued' });
    } catch (error) {
        console.error('Error sending quick quote SMS:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to send SMS'
        });
    }
});

module.exports = router;