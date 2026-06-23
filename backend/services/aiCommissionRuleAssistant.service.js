// backend/services/aiCommissionRuleAssistant.service.js
// Multi-turn OpenAI assistant for tiered commission rule configuration (Tiered + EE/ES/EC/EF).

const fs = require('fs').promises;
const path = require('path');
const OpenAI = require('openai');
const aiProductGenerator = require('./aiProductGenerator.service');
const { tokenLimitOption } = require('../utils/openaiChatOptions');
const { streamChatCompletionContent } = require('../utils/openaiJsonStreamDisplay');

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/** UUIDs in user-visible chat — never show in question/summary/warnings (ruleId stays in proposal JSON only). */
const UUID_IN_TEXT_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

const COMMISSION_LADDER_OVERRIDE_RULES = `
COMMISSION LADDER SANITY — OVERRIDES & INVERTED PAYOUTS (CRITICAL):
- Tenant ladder: **lower level number = more senior** (e.g. Advisor -1, Junior Partner 0). **Downline** = more junior tiers (higher level numbers).
- On each EE / ES / EC / EF cell, compare payouts across tier rows before patching.

**Red flag — inverted totals (rare, allowed but suspicious):** A **more senior** tier shows **less** $ (or %) than a **junior** tier on the same family size (e.g. Advisor EE $5, Junior Partner EE $20). Do NOT silently accept — use kind **"question"** to confirm the grid was read correctly (row/column swap, wrong tier column) or whether that inversion is intentional.

**Override-on-upline pattern (highly likely, not guaranteed):** Strongest signal: on the same EE/ES/EC/EF, a tier's listed $ is **lower than the tier below it** (more junior row shows a bigger number than the row above). Example: **Advisor (-1) EE $20**, **Junior Partner (0) EE $5** — the $5 is very often an **override increment on the upline base**, not Junior Partner's full payout → combined total **$25** ($20 + $5). Also common when upline $ is higher and downline $ is a **smaller** delta (base + add-on), even if not strictly "lower than below."
- This is the **most likely** reading when those patterns appear — **not always** correct. Do not assume without user confirmation when stakes are high (3+ tiers, large $ spreads, or unclear grid labels).
- When override pattern is likely, propose **cumulative totals** per tier (not raw increment alone) after confirm — unless the user says to use literal grid numbers.

**Two tiers (Advisor + one junior):** If junior-listed $ < upline $ on a family size, **highly likely** junior total = upline + junior increment. Ask briefly if unclear; if grid clearly shows base + small override, you may propose combined totals and note assumption in **warnings**.

**Three or more tiers (CRITICAL — stacked overrides are highly likely, not mandatory):**
- Grids often show **base** on the most senior tier (Advisor/L1) and **smaller $** on each tier below that are **per-tier override increments** — especially when each junior tier's number is **less than** the tier under it on the same EE/ES/EC/EF.
- **Option B — stacked (most likely when 3+ override-style rows):** Each tier's total = **sum of increments from base through that tier** (each step: prior tier's **total** + this tier's increment).
  - Example: Advisor EE $35; Jr +$13 → **$48**; Sr +$9 → **$57** ($48 + $9), not $44 ($35 + $9 only).
- **Option A — own-tier only (less common):** Each tier = Advisor base + **only that tier's** increment (Senior ignores Junior's increment in the sum). Use when the user explicitly confirms non-stacked semantics.
- When **3+ tiers** show override-style deltas — especially any tier **lower $ than the tier below** — use kind **"question"**: present **Option B (stacked) as highly likely** and Option A as the alternative. Do not treat stacking as automatic law; confirm before patching unless the user already chose stacked / "overrides on top of each other."
- After user confirms stacked (or grid explicitly labels cumulative overrides), patch **cumulative totals** and show math in **summary** / **warnings**.

Percent-mode grids: same highly-likely stacking when junior rates look like increments on upline; confirm for 3+ tiers.
`;

const USER_FACING_MARKDOWN_RULES = `
USER-FACING TEXT (kind "question", proposal "summary", per-rule "summary", and "warnings"):
- Write in GitHub-flavored markdown inside JSON string values: **bold** for product names, vendors, agent tier names, and EE/ES/EC/EF; use "- " bullet lists for audits and multi-product comparisons.
- Do NOT use # headings (UI keeps body text size — use **Section label:** instead).
- NEVER include UUIDs, ruleIds, productIds, vendorIds, or CommissionGroupIds in question text, summary, or warnings. Refer by **productName**, **ruleName**, and catalog **#N** (catalogIndex) only. ruleId belongs ONLY in proposal JSON keys (rules[].ruleId or internal patches), never in prose shown to admins.
- For audits, comparisons, or "should we change anything?" requests, prefer kind "question" with organized markdown (product sections, tier bullets) rather than one dense paragraph with technical IDs.
`;

function catalogLabelByRuleId(rulesCatalog, ruleId) {
  const rid = normRuleId(ruleId);
  if (!rid) return 'this rule';
  const row = (rulesCatalog || []).find((r) => normRuleId(r.ruleId) === rid);
  if (!row) return 'this rule';
  const idx = row.catalogIndex != null ? `#${row.catalogIndex}` : '';
  const name = row.productName || row.ruleName || row.productLabel || 'rule';
  return idx ? `${name} (${idx})` : name;
}

function stripGuidsFromUserText(text, rulesCatalog) {
  if (typeof text !== 'string' || !text.trim()) return text;
  return text.replace(UUID_IN_TEXT_RE, (uuid) => catalogLabelByRuleId(rulesCatalog, uuid));
}

function sanitizeCommissionAiReply(reply, rulesCatalog) {
  if (!reply || typeof reply !== 'object') return reply;
  if (reply.kind === 'question' && typeof reply.text === 'string') {
    return { ...reply, text: stripGuidsFromUserText(reply.text.trim(), rulesCatalog) };
  }
  if (reply.kind !== 'proposal') return reply;
  const warnings = Array.isArray(reply.warnings)
    ? reply.warnings.map((w) =>
        typeof w === 'string' ? stripGuidsFromUserText(w, rulesCatalog) : w
      )
    : undefined;
  const summary =
    typeof reply.summary === 'string'
      ? stripGuidsFromUserText(reply.summary.trim(), rulesCatalog)
      : reply.summary;
  if (!Array.isArray(reply.rules)) {
    return { ...reply, summary, ...(warnings ? { warnings } : {}) };
  }
  const rules = reply.rules.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const s =
      typeof entry.summary === 'string'
        ? stripGuidsFromUserText(entry.summary, rulesCatalog)
        : entry.summary;
    return s !== entry.summary ? { ...entry, summary: s } : entry;
  });
  return { ...reply, summary, rules, ...(warnings ? { warnings } : {}) };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  const mimeTypes = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return mimeTypes[ext] || 'image/jpeg';
}

/** Models sometimes emit flatAmount/rate as strings ("10", "$10.50"); accept those as finite numbers. */
function parseAiFiniteNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/^[$€£]\s*/, '').replace(/,/g, '').replace(/%$/, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickFlatAmountFields(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    parseAiFiniteNumber(obj.flatAmount) ??
    parseAiFiniteNumber(obj.amount) ??
    parseAiFiniteNumber(obj.flat) ??
    parseAiFiniteNumber(obj.value) ??
    parseAiFiniteNumber(obj.usd) ??
    parseAiFiniteNumber(obj.commission)
  );
}

function pickRateFields(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return (
    parseAiFiniteNumber(obj.rate) ??
    parseAiFiniteNumber(obj.percent) ??
    parseAiFiniteNumber(obj.percentage)
  );
}

/** Coerce EE/ES/EC/EF slot — models often emit scalars or use "amount" instead of flatAmount. */
function coerceFamilyTierSlot(raw, mode) {
  if (raw == null) return null;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const n = parseAiFiniteNumber(raw);
    if (n == null) return null;
    if (mode === 'percentage') {
      const rate = n > 1 && n <= 100 ? n / 100 : n;
      return { rate };
    }
    return { flatAmount: n };
  }
  if (typeof raw !== 'object') return null;

  const entry = {};
  if (mode === 'flatrate') {
    let fa = pickFlatAmountFields(raw);
    if (fa == null) {
      const r = pickRateFields(raw);
      if (r != null) fa = r;
    }
    if (fa != null) entry.flatAmount = fa;
  } else {
    let r = pickRateFields(raw);
    if (r == null) {
      const fa = pickFlatAmountFields(raw);
      if (fa != null) r = fa > 1 && fa <= 100 ? fa / 100 : fa;
    } else if (r > 1 && r <= 100) {
      r = r / 100;
    }
    if (r != null) entry.rate = r;
  }
  return Object.keys(entry).length ? entry : null;
}

function mergeProductTierSources(tier) {
  const sources = [
    tier.productTiers,
    tier.product_tiers,
    tier.amounts,
    tier.familyTiers,
    tier.family,
    tier.families,
  ];
  const merged = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const k of ['EE', 'ES', 'EC', 'EF']) {
      if (src[k] != null) merged[k] = src[k];
    }
  }
  return merged;
}

/** Infer flatrate vs percentage when the model mislabels patch.mode. */
function inferPatchMode(patch) {
  const declared = String(patch?.mode || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (declared === 'flatrate' || declared === 'flat' || declared === 'usd') {
    return 'flatrate';
  }
  if (declared === 'percentage' || declared === 'percent' || declared === 'pct') {
    return 'percentage';
  }
  let flatHints = 0;
  let pctHints = 0;
  for (const t of patch?.tiers || []) {
    if (!t || typeof t !== 'object') continue;
    if (pickFlatAmountFields(t) != null) flatHints += 2;
    if (pickRateFields(t) != null) pctHints += 1;
    const pt = mergeProductTierSources(t);
    for (const k of Object.keys(pt)) {
      const slot = pt[k];
      if (typeof slot === 'number' || typeof slot === 'string') {
        const n = parseAiFiniteNumber(slot);
        if (n != null && n >= 1) flatHints += 1;
      } else if (slot && typeof slot === 'object') {
        if (pickFlatAmountFields(slot) != null) flatHints += 1;
        if (pickRateFields(slot) != null) pctHints += 1;
      }
    }
  }
  return flatHints >= pctHints ? 'flatrate' : 'percentage';
}

function buildSystemPrompt(tenantTierLevels, formSnapshot) {
  const tiersJson = JSON.stringify(tenantTierLevels || []);
  const snapshotJson = JSON.stringify(formSnapshot || {});

  return `You author Commission Rules for a benefits platform. A rule has:
- mode: "percentage" or "flatrate"
- tiers: one row per agent tier in this tenant's ladder

Per-family-size codes (always these four — never invent others):
  EE = Employee Only        (a.k.a. "Single", "Member Only", "Employee Only", "EO")
  ES = Employee + Spouse    (a.k.a. "Member + Spouse", "EE+1 Spouse")
  EC = Employee + Children  (a.k.a. "Member + Child(ren)", "EE+Children")
  EF = Family               (a.k.a. "Family", "Full Family", "EE + Family")

Source-table column mapping rules (defaults — do NOT stop to ask about Member+1 mapping):
  - Three columns like "Single / Member+1 / Family" or "Employee / Employee+1 / Family":
      Single / Member-only / Employee-only -> EE
      Family -> EF
      Member+1 / Employee+1 -> put the SAME value in BOTH ES and EC (unless the user or source clearly labels spouse-only vs children-only columns).
  - Four distinct family columns: map each column to EE, ES, EC, or EF by label (best match).
  - If only a single column of $ or % values is shown (no per-family
    breakdown), treat the value as the BASE rate/amount for that tier row
    and leave productTiers empty.

Per-row invariant (CRITICAL): for each tier row, populate EITHER
  - base "rate" (percentage mode) or base "flatAmount" (flatrate mode), OR
  - "productTiers" with per-family-size values
but NEVER both. The form will discard one side if both are set.

Tenant agent tiers (use exactly these names and integer levels — never invent):
${tiersJson}

Current form state (refine, don't restart, when the user iterates):
${snapshotJson}

The user may attach screenshots of commission grids, PDFs, spreadsheets,
or natural-language instructions like "20% on Jr Agent, 80% on Advisor"
or "look at the table I uploaded".

Respond with STRICT JSON only — no prose outside JSON — matching one of:
  { "kind": "question", "text": "..." }
  { "kind": "proposal",
    "summary": "<= 140 char human summary>",
    "patch": { "mode": "percentage"|"flatrate", "tiers": [...] },
    "warnings": ["..."] }

Use "question" only when truly blocked (illegible attachment, missing numbers,
no tier ladder context, contradictory instructions). Do NOT ask about
Single/Member+1/Family mapping — use the defaults above. Use "proposal"
when you can fill requested tiers from the source or instructions.

Percentages MUST be decimals (0.20 not "20%" not 20).
Flat amounts MUST be numbers in USD (58 not "$58.00").

JSON productTiers shape (Member+1): when the source maps one middle column to Member+1 / Employee+1, emit BOTH "ES" and "EC" with the identical rate or flatAmount — never omit "EC" while "ES" is present (the UI mirrors ES→EC on save, but proposals must show both keys).
${COMMISSION_LADDER_OVERRIDE_RULES}
${USER_FACING_MARKDOWN_RULES}
`;
}

function normalizeTierRow(tier, mode) {
  if (!tier || typeof tier !== 'object') return null;
  const level = Number(
    tier.level ?? tier.tierLevel ?? tier.agentLevel ?? tier.TierLevel
  );
  if (!Number.isFinite(level)) return null;
  const name =
    typeof tier.name === 'string'
      ? tier.name
      : typeof tier.tierName === 'string'
        ? tier.tierName
        : '';

  const pt = mergeProductTierSources(tier);
  const keys = ['EE', 'ES', 'EC', 'EF'];
  let hasPerFamily = false;
  const productTiers = {};
  for (const k of keys) {
    const v = pt[k];
    if (v == null) continue;
    const entry = coerceFamilyTierSlot(v, mode);
    if (entry) {
      productTiers[k] = entry;
      hasPerFamily = true;
    }
  }

  let rate;
  let flatAmount;
  if (hasPerFamily) {
    rate = undefined;
    flatAmount = undefined;
  } else if (mode === 'percentage') {
    let r = pickRateFields(tier);
    if (r == null) {
      const fa = pickFlatAmountFields(tier);
      if (fa != null) r = fa > 1 && fa <= 100 ? fa / 100 : fa;
    } else if (r > 1 && r <= 100) {
      r = r / 100;
    }
    rate = r ?? undefined;
    flatAmount = undefined;
  } else {
    let fa = pickFlatAmountFields(tier);
    if (fa == null) fa = pickRateFields(tier);
    flatAmount = fa ?? undefined;
    rate = undefined;
  }

  return {
    level,
    name,
    ...(rate !== undefined ? { rate } : {}),
    ...(flatAmount !== undefined ? { flatAmount } : {}),
    ...(Object.keys(productTiers).length ? { productTiers } : {}),
  };
}

function validateAndNormalizeReply(raw, allowedLevelsSet) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'question' && typeof raw.text === 'string' && raw.text.trim()) {
    return sanitizeCommissionAiReply({ kind: 'question', text: raw.text.trim() }, null);
  }
  if (raw.kind !== 'proposal') return null;
  const patch = raw.patch;
  if (!patch || typeof patch !== 'object') return null;
  const mode = inferPatchMode(patch);
  if (mode !== 'percentage' && mode !== 'flatrate') return null;
  if (!Array.isArray(patch.tiers)) return null;

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w) => typeof w === 'string')
    : [];
  const tiers = [];
  for (const t of patch.tiers) {
    const row = normalizeTierRow(t, mode);
    if (!row) continue;
    if (allowedLevelsSet && allowedLevelsSet.size > 0 && !allowedLevelsSet.has(row.level)) {
      warnings.push(`Dropped tier at unknown level ${row.level} (${row.name || 'unnamed'}).`);
      continue;
    }
    // Require at least base or per-family values
    const hasBase =
      mode === 'percentage' ? row.rate != null : row.flatAmount != null;
    const hasPt = row.productTiers && Object.keys(row.productTiers).length > 0;
    if (!hasBase && !hasPt) {
      warnings.push(`Skipped tier level ${row.level} with no amounts.`);
      continue;
    }
    tiers.push(row);
  }

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim().slice(0, 400)
      : 'Commission tier proposal';

  return sanitizeCommissionAiReply(
    {
      kind: 'proposal',
      summary,
      patch: { mode, tiers },
      warnings,
    },
    null
  );
}

function normRuleId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase();
}

function vendorNameMatches(vendorName, needle) {
  const vn = (vendorName || '').toLowerCase();
  if (needle === 'apex') return vn.includes('apex');
  if (needle === 'tall tree') return vn.includes('tall') && vn.includes('tree');
  return vn.includes(String(needle).toLowerCase());
}

/**
 * Enforce user-stated vendor/side scope and flag incomplete grid coverage.
 */
function auditGroupProposalScope(reply, rulesCatalog, prompt) {
  if (!reply || reply.kind !== 'proposal') return reply;

  const catalogTiered = (rulesCatalog || []).filter((r) => r && r.commissionType === 'Tiered');
  const byId = new Map(catalogTiered.map((r) => [normRuleId(r.ruleId), r]));
  const warnings = [...(reply.warnings || [])];
  const text = (prompt || '').toLowerCase();

  const scopesApexIndividual =
    /\bapex\b/.test(text) &&
    (/\bindividual\b/.test(text) || /\brighthand\b/.test(text) || /\bright[\s-]?hand\b/.test(text));
  const scopesTallTreeGroup =
    /tall\s*tree/.test(text) &&
    (/\bgroup\b/.test(text) || /\blefthand\b/.test(text) || /\bleft[\s-]?hand\b/.test(text));
  const userNamedVendors = scopesApexIndividual && scopesTallTreeGroup;

  let rules = [...(reply.rules || [])];

  if (userNamedVendors) {
    const kept = [];
    for (const entry of rules) {
      const row = byId.get(normRuleId(entry.ruleId));
      if (!row) {
        kept.push(entry);
        continue;
      }
      const st = (row.productSalesType || '').toLowerCase();
      const vn = row.vendorName || '';
      if (st === 'individual' && !vendorNameMatches(vn, 'apex')) {
        warnings.push(
          `Removed patch for "${row.productName || row.ruleName}" — you scoped Individual plans to APEX; this rule's vendor is "${vn}".`
        );
        continue;
      }
      if (st === 'group' && !vendorNameMatches(vn, 'tall tree')) {
        warnings.push(
          `Removed patch for "${row.productName || row.ruleName}" — you scoped Group plans to Tall Tree; this rule's vendor is "${vn}".`
        );
        continue;
      }
      kept.push(entry);
    }
    rules = kept;

    const patchedNames = rules.map((e) => (byId.get(normRuleId(e.ruleId))?.productName || '').toLowerCase());

    const groupChecks = [
      { label: 'HSA', test: (p) => /\bhsa\b/.test(p) },
      { label: 'Basic Copay', test: (p) => /basic/.test(p) },
      { label: 'Copay Silver', test: (p) => /silver/.test(p) },
      { label: 'Copay Gold', test: (p) => /gold/.test(p) && !/silver/.test(p) },
      { label: 'Concierge', test: (p) => /concierge/.test(p) },
    ];
    for (const { label, test } of groupChecks) {
      const inCatalog = catalogTiered.some(
        (r) =>
          (r.productSalesType || '').toLowerCase() === 'group' &&
          vendorNameMatches(r.vendorName, 'tall tree') &&
          test((r.productName || '').toLowerCase())
      );
      if (inCatalog && !patchedNames.some(test)) {
        warnings.push(
          `Group grid includes "${label}" but no Tall Tree group product patch was proposed — add the matching rule or say to skip it.`
        );
      }
    }

    const apexHsaInCatalog = catalogTiered.some(
      (r) =>
        (r.productSalesType || '').toLowerCase() === 'individual' &&
        vendorNameMatches(r.vendorName, 'apex') &&
        /\bhsa\b/.test((r.productName || '').toLowerCase())
    );
    if (apexHsaInCatalog && !patchedNames.some((p) => /\bhsa\b/.test(p))) {
      warnings.push('Individual grid includes HSA but no APEX HSA product patch was proposed.');
    }
    const apexCopayInCatalog = catalogTiered.some(
      (r) =>
        (r.productSalesType || '').toLowerCase() === 'individual' &&
        vendorNameMatches(r.vendorName, 'apex') &&
        (/basic/.test((r.productName || '').toLowerCase()) || /copay/.test((r.productName || '').toLowerCase()))
    );
    if (apexCopayInCatalog && !patchedNames.some((p) => /basic/.test(p) || /copay/.test(p))) {
      warnings.push('Individual grid includes Basic Copay but no APEX Copay/Basic product patch was proposed.');
    }
  }

  if (userNamedVendors && rules.length === 0) {
    return {
      kind: 'question',
      text:
        warnings.length > 0
          ? `No patches matched your vendor scope (APEX = Individual, Tall Tree = Group). ${warnings.slice(0, 4).join(' ')}`
          : 'No patches matched your vendor scope (APEX individual, Tall Tree group). Confirm this group has Tiered rules for those vendors.',
    };
  }

  return {
    ...reply,
    rules,
    warnings: warnings.length ? warnings : undefined,
  };
}

function buildSystemPromptGroup(tenantTierLevels, rulesCatalog) {
  const tiersJson = JSON.stringify(tenantTierLevels || []);
  const catalogJson = JSON.stringify(rulesCatalog || []);

  const patchable = (rulesCatalog || [])
    .filter(
      (row) =>
        row &&
        row.commissionType === 'Tiered' &&
        typeof row.ruleId === 'string' &&
        row.ruleId.trim()
    )
    .map((row, idx) => ({
      catalogIndex: row.catalogIndex != null ? row.catalogIndex : idx + 1,
      ruleId: row.ruleId,
      locked: Boolean(row.locked),
      ruleName: row.ruleName,
      productName: row.productName,
      catalogDisplaySubtitle: row.catalogDisplaySubtitle,
      commissionJsonHints: row.commissionJsonHints,
      productLabel: row.productLabel,
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      productId: row.productId,
      productSalesType: row.productSalesType,
      productIsBundle: row.productIsBundle,
    }));

  const patchableJson = JSON.stringify(patchable);

  return `You author Commission Rules for a benefits platform. The user is editing MULTIPLE commission rules together (same commission group), e.g. products sold as a bundle.

Per-family-size codes (always these four):
  EE = Employee Only (Single / member-only)
  ES = Employee + Spouse
  EC = Employee + Children
  EF = Family

RECRUITMENT GRIDS → EE / ES / EC / EF (CRITICAL):
- EE = Single / employee-only column.
- **Member + 1** / **Employee + 1** / middle-tier columns on agency grids usually mean **one rate for “not single, not full family”** (spouse OR children interchangeably for commission). Put the **same** flat $ or **same** rate on **both ES and EC** unless the user or attachment gives **different** amounts for spouse vs children.
- EF = Family column.
- Do **not** leave EC blank while ES is filled when the source implied a single Member+1 bucket — duplicate ES→EC (symmetrically: if only EC is filled, duplicate→ES).

Per-row invariant (CRITICAL): each tier row has EITHER base rate/flatAmount OR productTiers (EE–EF), never both.

Catalog below lists ONLY rules in this group. Each entry includes:
  - ruleId (UUID), ruleName (commission rule title — may differ from product name)
  - productName (oe.Products.Name), productLabel (often same as productName), catalogDisplaySubtitle ("Product • Tiers: …" exactly like the admin UI list — use for keyword matching)
  - commissionJsonHints: description/notes from commission JSON when present
  - vendorId, vendorName (carrier on oe.Vendors)
  - productId (null = All Products wildcard rule), productSalesType (Individual | Group | Both), productIsBundle
  - vendorCommission: when present, VendorCommission USD pools from pricing — poolsByTier.EE..EF each has minUsd/maxUsd (latest effective pricing wave); globalMaxUsd is the largest maxUsd among tiers; bundles use the tightest caps across components
  - vendorCommissionLoadError when caps could not be loaded
  - snapshot of current Tiered config (type + tiers) when applicable
  - commissionType, locked

Use ruleId EXACTLY as given on every patch object.

PRODUCT ↔ RULE MAPPING (CRITICAL — prevents wrong-plan dollars):
- **productName** (and words in catalogDisplaySubtitle) are the authoritative plan identity — NOT ruleName.
- Many rules share similar **ruleName** prefixes (e.g. multiple "Tall Tree Gold - …" titles) while **productName** differs (CoPay Basic vs CoPay Silver vs CoPay Gold vs HSA). Always pick ruleId by matching the **grid row / user text** to **productName** (case-insensitive substring: "Basic", "Silver", "Gold", "Concierge", "HSA", "Copay", "ShareWELL").
- **Basic ≠ Silver ≠ Gold ≠ Concierge** — never put a Silver grid on a Gold ruleId (or vice versa) even if ruleName sounds related.
- In each rules[] entry, set "summary" to name the matched **productName** and vendor (e.g. "MightyWELL CoPay Silver — Tall Tree group rates").
- **Exactly ONE** rules[] object per **ruleId** in a single proposal. If you revise a rule, update that object — never emit the same ruleId twice with different amounts.

Map nicknames using **productName** first, then catalogDisplaySubtitle, then vendorName, then ruleName only as a last resort.

COMMISSION GRID ↔ TENANT LADDER (CRITICAL):
- Payout rows in patch.tiers use **only** the tenant agent ladder in this prompt (e.g. Advisor level -1, Junior Partner level 0).
- Catalog subtitles like "Tiers: Associate, Agent, Agency, GA" describe **rule entity scope**, NOT which rows to fill with $. Do not invent Associate/Agent rows unless they appear in the tenant ladder JSON.
- When user maps **Associate / lower / red** grid → put those $ on **Advisor** (or the tier they name). **Agent / higher / green** grid → **Junior Partner** (or the tier they name).
${COMMISSION_LADDER_OVERRIDE_RULES}

USER-NAMED VENDORS + TABLE SIDES (CRITICAL):
- When user says **left / group** plans use vendor **Tall Tree** and **right / individual** plans use **APEX**: patch **only** catalog rows whose vendorName matches that side (case-insensitive). productSalesType Group vs Individual must agree with the side.
- **Never** substitute ARM or another vendor for Tall Tree on group plans because the $ match — if no Tall Tree row exists for a grid plan, use kind **"question"** listing the gap.
- **Never** patch vendors/products the user did not include in scope when they gave explicit vendor + side instructions.

ATTACHMENT / GRID COMPLETENESS (CRITICAL):
- When images or extracted text show **Group Plans** rows (typically HSA, Basic Copay, Copay Silver, Copay Gold, Concierge) and **Individual Plans** rows (typically HSA, Basic Copay), you must either:
  (a) propose a patch for **every** in-scope plan row that has a matching catalog product (vendor + productName), for **both** grid levels the user specified (e.g. Advisor + Junior Partner), OR
  (b) use kind **"question"** listing which grid rows have **no** matching catalog rule — do not silently skip Silver/Gold/Concierge.
- Partial proposals (e.g. only HSA + Basic when the image shows five group plans) are invalid unless the user explicitly limited scope.

TASK SCOPE — DO NOT SPRAWL ACROSS THE WHOLE GROUP (CRITICAL):
- The catalog can include **many** Tiered rules (dental, vision, other carriers). The user often cares about **only** what they named (carriers like Apex / Tall Tree / ShareWELL), **sales channel** (individual vs group), and **plan types** (e.g. copay tiers, HSA/preventative, concierge).
- **Default = explicit scope only**: Patch **only** rules the user names, that appear as **plan rows** in attachments, or when they explicitly say **all rules / entire group / whole catalog / everything tiered**. Do **not** add ARM, dental, vision, Lyric, Quest, GetWell, or other products “to be thorough” when never mentioned — no creative add-ons.
- **Attachments / extracted grid text** (PDF, image OCR, spreadsheet): Treat visible **plan rows** as the authoritative set of products for dollar targets (e.g. if the grid shows Group HSA/Basic/Silver/Gold/Concierge and Individual HSA/Basic/Concierge — do **not** invent Dental/Vision rules).
- User exceptions override defaults (e.g. "membership concierge handles all commission, no ShareWELL carve-out") — apply only to that product's rule.

PRODUCT NAME HINTS — ShareWELL:
- ShareWELL carve-out rules may appear as **Essential ShareWELL**, **Essential (ShareWELL)**, bundle riders, etc. The **product name** may include ShareWELL even when **vendorName** is another carrier (e.g. tenant-owned product).
- Match ShareWELL requests if **any** of these contain "ShareWELL" / "Sharewell" (case-insensitive): **productName**, **catalogDisplaySubtitle**, **ruleName**, **commissionJsonHints**, or **vendorName**.
- Do **not** claim “no ShareWELL rule” without scanning **productName** and **catalogDisplaySubtitle** on every patchable row — users often recognize the UI subtitle line, not the vendor.

GROUP VS INDIVIDUAL (productSalesType) — STRICT:
- Individual = individual-market product; Group = group-market product; Both = eligible when user refers to either side.
- When the user separates “individual” vs “group” columns/sides, **only** patch rows whose productSalesType is Individual (individual side), Group (group side), or Both when they clearly apply to both.
- Do **not** copy dollar grids meant for individual copay/HSA onto Group-only copay rows (or the reverse). If a nickname exists in both markets, treat them as **different rules** unless SalesType is Both.

VENDOR MATCHING — ShareWELL / CARRIER CARVE-OUTS:
- When the user allocates dollars to **ShareWELL** (or any carrier by name), find the catalog row whose **vendorName** matches that carrier (case-insensitive; allow partial match like "ShareWELL" vs "Sharewell").
- Put those dollars on **that product’s commission rule** — not on another vendor’s product even if the **product name** sounds related (e.g. “Health Concierge Membership” under a different vendor is **not** ShareWELL unless vendorName says so).
- If the user asks for ShareWELL dollars but **no in-scope** patchable row matches ShareWELL/Essential ShareWELL (vendor or product text), respond with kind **"question"**: say no matching rule was found **under the user's stated vendors/plans**, then list **only** catalog rows whose vendorName or productLabel suggests ShareWELL — not unrelated carriers. If still none, ask them to add the ShareWELL commission rule to this group or name the product — **never** substitute concierge/membership from another vendor.
- Never silently substitute a different product for a named carrier.

WHEN UNSURE — ASK (kind "question"), DO NOT GUESS:
- Multiple catalog rows could match a nickname **within scope** → **question**: enumerate **only those scoped** candidates with catalog **#N**, ruleName, productLabel, vendorName, productSalesType (no UUIDs).
- Do **not** paste the entire group's patchable inventory when the user narrowed vendors/plans — that trains wrong picks (e.g. ARM/dental when they said Apex + Tall Tree).
- Attachment/grid ambiguous vs catalog → **question** before emitting a proposal.
- Only emit kind "proposal" when mapping is confident; otherwise **question** with concrete choices.

MULTI-RULE OUTPUT (CRITICAL):
- If the user names, implies, or attaches a grid covering MORE THAN ONE distinct catalog product/rule **within scope**, you MUST return multiple objects inside "rules" — **one object per affected ruleId** (unique ruleIds only).
- Never fold payouts for multiple products into a single ruleId. Amounts for product A belong only on A's ruleId.
- Never assign the same dollar grid to two different ruleIds. Never list the same ruleId twice.
- Emit one patch per **in-scope** Tiered rule that matches their product list (including locked Tiered rules when relevant) — never pad with unrelated rules (dental/vision/other carriers) just because they share this commission group.

RESPECT VENDOR COMMISSION POOLS:
- For flatrate patches, prefer flat amounts ≤ vendorCommission.poolsByTier[T].maxUsd per EE–EF when the user did not explicitly exceed carrier limits.
- If the user demands more than maxUsd, keep their numbers but add "warnings" citing the tier cap (and globalMaxUsd when relevant).

BUNDLE / SPLIT PAYOUT ACROSS MULTIPLE PRODUCT RULES (CRITICAL):
- Commission is stored **per product rule**. When items are sold together, one **agent hierarchy tier** (e.g. Junior Partner) + one **family tier** (EE/ES/EC/EF) often means: **sum** of flat $ on ShareWELL's rule + Copay's rule + … = the user's **total** payout for that bundle at that agent level.
- Example: "$50 total at Jr Partner EE — $15 from ShareWELL and $35 from Copay" ⇒ patch **ShareWELL's** rule with Jr Partner EE flat **15** and **Copay's** rule with Jr Partner EE flat **35** (same for other EE–EF columns if the user gave a grid). **Never** put the full $50 on one rule and only a nominal amount on the other unless they asked for that.
- Phrases like "$15 from ShareWELL for Advisor **and** Junior Partner" mean: on **ShareWELL vendor’s** commission rule (vendorName match), set **both** the **Advisor** and **Junior Partner** tier rows to **$15** per relevant EE–EF cell. Include **both** hierarchy rows in that patch — never only Junior Partner on a membership product from another vendor.
- **Advisor = X% of Junior Partner**: Unless the user specifies otherwise, apply **per rule**: on each product's ruleId, Advisor flat amounts = X × Junior Partner flat amounts **on that same rule** (e.g. 0.80 × each EE–EF slice). That keeps bundle totals consistent (total Advisor $ = 0.80 × total Jr Partner $ across the bundle).
- **Do not** swap meanings: Junior Partner target payouts belong on **Junior Partner** tier rows; Advisor targets on **Advisor** tier rows. Putting "the total" on Jr Partner and only $15 on Advisor is wrong when the user described splits **per product** and/or **both** levels pulling from ShareWELL.
- When allocating overflow to a bundled product (e.g. ShareWELL) because standalone product pools are too small, distribute explicit $ to ShareWELL's rule **and** reduce the other products' rules so **per hierarchy tier + EE–EF**, sums still match the user's targets.
- In "summary" or per-rule "summary", briefly state the **sum check** (e.g. "Jr Partner EE: $15 ShareWELL + $35 Copay = $50") so mistakes are obvious.

Patchable Tiered rule inventory below is the **full** group roster (for valid ruleIds). **Filter by scope** — user vendors, attachment plan rows, and named products — before proposing or listing candidates; do not assume every row below applies.
${patchableJson}

Full catalog (authoritative snapshots + pricing caps):
${catalogJson}

Tenant agent tiers — use exactly these levels and names for every patch.tiers row:
${tiersJson}

ONLY output tier patches for catalog rows where commissionType is "Tiered" (locked Tiered rules are allowed — locked means **active** rule in this system; the user accepts updates with a warning).
Do NOT invent ruleIds. For non-Tiered rules, explain in "summary" / "warnings" if the user asked about them.

LOCKED TIERED RULES:
- Patchable inventory lists Tiered rules with a **locked** boolean. **locked: true** rules are still valid patch targets — propose tier patches when the user asks for those products.
- For any proposal touching locked: true, include in **warnings** a line like: "Modifying locked rule — **[ruleName]** (catalog #N)." Do **not** refuse to emit the patch only because the rule is locked.

Respond with STRICT JSON only:
  { "kind": "question", "text": "..." }
  { "kind": "proposal",
    "summary": "<= 240 char overall>",
    "rules": [
      { "ruleId": "<uuid>", "summary": "<short per-rule>", "patch": { "mode": "percentage"|"flatrate", "tiers": [...] } }
    ],
    "warnings": ["..."] }

Percentages as decimals (0.05 = 5%). Flat amounts as USD numbers (prefer bare JSON numbers; do not emit tier rows with only level/name and zero amounts).

REQUIRED patch.tiers shape (flatrate example — use "flatrate" mode for $ grids):
  { "level": 0, "name": "Junior Partner", "productTiers": { "EE": { "flatAmount": 65 }, "ES": { "flatAmount": 79 }, "EC": { "flatAmount": 79 }, "EF": { "flatAmount": 92 } } }
Do NOT emit empty tier objects, bare numbers at the tier root without productTiers, or "EE": 65 (scalar) — always nest { "flatAmount": <number> } under each EE/ES/EC/EF key you set.

In each tier row's productTiers object: for any Member+1 / Employee+1 bucket, include BOTH "ES" and "EC" with the same value — never omit "EC" while "ES" is filled (apply mirrors ES→EC, but JSON must list both so previews match).

When refining after prior proposals in chat, keep consistency with earlier GROUP_PROPOSAL_JSON assistant messages.

CONVERSATION MEMORY:
- Prior turns in this session are included (recent user messages and assistant replies). Earlier group proposals appear as GROUP_PROPOSAL_JSON with the same ruleId/patch shape—extend or revise them when the user corrects splits; do not drop agreed totals unless they asked to replace them.
- Commission grid images from earlier turns are re-sent and/or summarized in **[Commission grids from this chat session]**. On follow-up ("yes", "correct", product mapping fixes), use that block for dollar amounts — do not re-ask for numbers already transcribed there.
${USER_FACING_MARKDOWN_RULES}
`;
}

function validateAndNormalizeGroupReply(raw, patchableRuleIdSet, allowedLevelsSet) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'question' && typeof raw.text === 'string' && raw.text.trim()) {
    return { kind: 'question', text: raw.text.trim() };
  }
  if (raw.kind !== 'proposal') return null;

  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((w) => typeof w === 'string') : [];
  const rulesArr = Array.isArray(raw.rules) ? raw.rules : [];
  const rulesOut = [];
  const seenRuleIds = new Map();

  for (let idx = 0; idx < rulesArr.length; idx++) {
    const entry = rulesArr[idx];
    const n = idx + 1;
    const summaryHint =
      typeof entry?.summary === 'string' && entry.summary.trim()
        ? ` Summary: "${entry.summary.trim().slice(0, 120)}${entry.summary.trim().length > 120 ? '…' : ''}"`
        : '';

    const ridRaw = entry?.ruleId;
    const rid = normRuleId(ridRaw);

    if (!rid) {
      warnings.push(
        `Proposal entry ${n}/${rulesArr.length}:${summaryHint} dropped — no ruleId (each patch must include the exact ruleId UUID from the catalog).`
      );
      continue;
    }

    if (!patchableRuleIdSet.has(rid)) {
      warnings.push(
        `Proposal entry ${n}/${rulesArr.length}:${summaryHint} dropped — ruleId "${String(ridRaw).trim()}" is not a Tiered rule in this commission group (typo, wrong group, or stale catalog).`
      );
      continue;
    }
    const patch = entry.patch;
    if (!patch || typeof patch !== 'object') {
      warnings.push(`Skipped entry for rule ${rid}: invalid patch.`);
      continue;
    }
    const mode = inferPatchMode(patch);
    if (mode !== 'percentage' && mode !== 'flatrate') {
      warnings.push(`Skipped rule ${rid}: patch.mode must be percentage or flatrate.`);
      continue;
    }
    if (!Array.isArray(patch.tiers)) {
      warnings.push(`Skipped rule ${rid}: patch.tiers must be an array.`);
      continue;
    }

    const tiers = [];
    for (const t of patch.tiers) {
      const row = normalizeTierRow(t, mode);
      if (!row) continue;
      if (allowedLevelsSet && allowedLevelsSet.size > 0 && !allowedLevelsSet.has(row.level)) {
        warnings.push(`Rule ${rid}: dropped tier at unknown level ${row.level}.`);
        continue;
      }
      const hasBase = mode === 'percentage' ? row.rate != null : row.flatAmount != null;
      const hasPt = row.productTiers && Object.keys(row.productTiers).length > 0;
      if (!hasBase && !hasPt) {
        warnings.push(`Rule ${rid}: skipped tier level ${row.level} with no amounts.`);
        continue;
      }
      tiers.push(row);
    }

    if (tiers.length === 0) {
      warnings.push(`Rule ${rid}: no valid tier rows in patch.`);
      console.warn(
        '[commission-rule-assistant] rejected patch for rule',
        rid,
        'mode=',
        patch.mode,
        'inferred=',
        mode,
        'sample=',
        JSON.stringify((patch.tiers || []).slice(0, 2)).slice(0, 600)
      );
      continue;
    }

    const ruleSummary =
      typeof entry.summary === 'string' && entry.summary.trim()
        ? entry.summary.trim().slice(0, 240)
        : 'Updated tiers';

    const rulePayload = {
      ruleId: entry.ruleId.trim(),
      summary: ruleSummary,
      patch: { mode, tiers },
    };

    if (seenRuleIds.has(rid)) {
      const prevIdx = seenRuleIds.get(rid);
      warnings.push(
        `Duplicate ruleId in proposal (entries ${prevIdx} and ${n}) — kept the later patch for ${rid}. Verify productName ↔ ruleId mapping (Basic/Silver/Gold are different products).`
      );
      const existingIdx = rulesOut.findIndex((r) => normRuleId(r.ruleId) === rid);
      if (existingIdx >= 0) {
        rulesOut[existingIdx] = rulePayload;
      } else {
        rulesOut.push(rulePayload);
      }
    } else {
      seenRuleIds.set(rid, n);
      rulesOut.push(rulePayload);
    }
  }

  if (rulesOut.length === 0) {
    return {
      kind: 'question',
      text:
        warnings.length > 0
          ? `I could not produce valid tier patches (${warnings.slice(0, 3).join(' ')}). Each tier row needs a numeric flatAmount or rate (base or under productTiers EE–EF), using levels from the tenant ladder. Please restate amounts or which rules to change.`
          : 'I could not produce valid tier patches for any Tiered rules. Please clarify.',
    };
  }

  const summary =
    typeof raw.summary === 'string' && raw.summary.trim()
      ? raw.summary.trim().slice(0, 280)
      : 'Multi-rule commission proposal';

  return {
    kind: 'proposal',
    summary,
    rules: rulesOut,
    warnings,
  };
}

class AICommissionRuleAssistantService {
  constructor() {
    this._openai = null;
    this.model = process.env.OPENAI_MODEL || 'gpt-4o';
  }

  get openai() {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is not set.');
      }
      this._openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this._openai;
  }

  /**
   * Build user message parts: text + optional images + extracted doc text.
   */
  async buildUserContent({ prompt, attachmentPaths, gridExtract }) {
    const parts = [];
    const attachmentSummaries = [];

    const safePrompt = typeof prompt === 'string' ? prompt : '';
    let docTextBlocks = '';
    const gridText =
      typeof gridExtract === 'string' && gridExtract.trim() ? gridExtract.trim().slice(0, 24000) : '';

    for (const filePath of attachmentPaths || []) {
      const base = path.basename(filePath);
      const ext = path.extname(filePath).replace('.', '').toLowerCase();

      if (IMAGE_EXT.has(ext)) {
        try {
          const imageBuffer = await fs.readFile(filePath);
          const base64Image = imageBuffer.toString('base64');
          const mimeType = getMimeType(filePath);
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          });
          attachmentSummaries.push({ name: base, type: 'image' });
        } catch (e) {
          attachmentSummaries.push({ name: base, type: 'image', error: e.message });
        }
        continue;
      }

      try {
        let text = '';
        if (ext === 'pdf') text = await aiProductGenerator.extractTextFromPDF(filePath);
        else if (['xlsx', 'xls', 'csv'].includes(ext)) text = await aiProductGenerator.extractTextFromExcel(filePath);
        else if (['doc', 'docx'].includes(ext)) text = await aiProductGenerator.extractTextFromWord(filePath);
        else if (ext === 'txt' || ext === 'plain') {
          text = await fs.readFile(filePath, 'utf8');
        } else {
          attachmentSummaries.push({ name: base, type: ext || 'file', skipped: true });
          continue;
        }
        const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n...[truncated]` : text;
        docTextBlocks += `\n\n--- File: ${base} ---\n${clipped}`;
        attachmentSummaries.push({ name: base, type: ext, chars: clipped.length });
      } catch (e) {
        attachmentSummaries.push({ name: base, type: ext || 'file', error: e.message });
      }
    }

    let userText = safePrompt.trim();
    if (gridText) {
      userText += `\n\n[Commission grids from this chat session — authoritative $ amounts; use on every follow-up turn]${gridText}`;
    }
    if (docTextBlocks) {
      userText += `\n\n[Extracted document text]${docTextBlocks}`;
    }
    parts.unshift({ type: 'text', text: userText || '(No text — refer to attachments.)' });

    return { parts, attachmentSummaries };
  }

  /**
   * OCR commission grid images once per session; persisted client-side as sessionGridExtract.
   */
  async extractCommissionGridText(imagePaths) {
    const paths = (imagePaths || []).filter((p) => {
      const ext = path.extname(p).replace('.', '').toLowerCase();
      return IMAGE_EXT.has(ext);
    });
    if (paths.length === 0) return '';

    const parts = [
      {
        type: 'text',
        text:
          'Transcribe every commission dollar amount from these recruitment grid image(s). ' +
          'For each grid shown (e.g. Associate/red vs Agent/green), output markdown tables with ' +
          'Group Plans (left) and Individual Plans (right). Columns: Plan name, Single (EE), Member+1 (ES=EC), Family (EF). ' +
          'Include every plan row (HSA, Basic Copay, Copay Silver, Gold, Concierge, etc.). Numbers only in tables — no questions.',
      },
    ];

    for (const filePath of paths) {
      try {
        const imageBuffer = await fs.readFile(filePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = getMimeType(filePath);
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64Image}` },
        });
      } catch (e) {
        console.warn('[commission-rule-assistant] grid extract read failed:', e.message);
      }
    }

    if (parts.length < 2) return '';

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: parts }],
        ...tokenLimitOption(this.model, 4096),
      });
      return (response.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      console.warn('[commission-rule-assistant] grid extract failed:', err.message);
      return '';
    }
  }

  /**
   * @param {object} params
   * @param {Array<{role:string, content:string}>} params.messages - prior turns (no attachments)
   * @param {object} params.formSnapshot
   * @param {Array<{level:number, name:string}>} params.tenantTierLevels
   * @param {string[]} params.attachmentPaths - temp disk paths
   */
  async runTurn({
    messages,
    formSnapshot,
    tenantTierLevels,
    attachmentPaths,
    prompt,
    sessionGridExtract,
    refreshGridExtract,
    onStreamDelta,
  }) {
    const allowedLevels = new Set((tenantTierLevels || []).map((t) => Number(t.level)).filter(Number.isFinite));

    let gridExtract =
      typeof sessionGridExtract === 'string' && sessionGridExtract.trim() ? sessionGridExtract.trim() : '';
    if (refreshGridExtract) {
      const fresh = await this.extractCommissionGridText(attachmentPaths);
      if (fresh) gridExtract = fresh;
    }

    const systemPrompt = buildSystemPrompt(tenantTierLevels, formSnapshot);
    const { parts: userParts, attachmentSummaries } = await this.buildUserContent({
      prompt,
      attachmentPaths,
      gridExtract,
    });

    const apiMessages = [{ role: 'system', content: systemPrompt }];

    const capped = Array.isArray(messages) ? messages.slice(-20) : [];
    for (const m of capped) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c.trim()) continue;
      apiMessages.push({ role: m.role, content: c });
    }

    apiMessages.push({ role: 'user', content: userParts });

    let content;
    try {
      const completionOpts = {
        model: this.model,
        messages: apiMessages,
        response_format: { type: 'json_object' },
        ...tokenLimitOption(this.model, 2500),
      };
      if (typeof onStreamDelta === 'function') {
        content = await streamChatCompletionContent(this.openai, completionOpts, {
          onDisplayDelta: onStreamDelta,
        });
      } else {
        const response = await this.openai.chat.completions.create(completionOpts);
        content = response.choices?.[0]?.message?.content;
      }
    } catch (err) {
      console.error('[aiCommissionRuleAssistant] OpenAI error:', err.message);
      return {
        reply: {
          kind: 'question',
          text: `The AI service failed: ${err.message}. Try again in a moment.`,
        },
        attachmentSummaries,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(content || '{}');
    } catch {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the key numbers?',
        },
        attachmentSummaries,
      };
    }

    const normalized = validateAndNormalizeReply(parsed, allowedLevels);
    if (!normalized) {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the key numbers?',
        },
        attachmentSummaries,
      };
    }

    return { reply: normalized, attachmentSummaries, sessionGridExtract: gridExtract || undefined };
  }

  /**
   * Multi-rule commission group turn: proposes patches keyed by ruleId.
   */
  async runGroupTurn({
    messages,
    rulesCatalog,
    tenantTierLevels,
    attachmentPaths,
    prompt,
    sessionGridExtract,
    refreshGridExtract,
    onStreamDelta,
  }) {
    const allowedLevels = new Set((tenantTierLevels || []).map((t) => Number(t.level)).filter(Number.isFinite));

    const patchableRuleIdSet = new Set();
    for (const row of rulesCatalog || []) {
      if (
        row &&
        row.commissionType === 'Tiered' &&
        typeof row.ruleId === 'string' &&
        row.ruleId.trim()
      ) {
        patchableRuleIdSet.add(normRuleId(row.ruleId));
      }
    }

    let gridExtract =
      typeof sessionGridExtract === 'string' && sessionGridExtract.trim() ? sessionGridExtract.trim() : '';
    if (refreshGridExtract) {
      const fresh = await this.extractCommissionGridText(attachmentPaths);
      if (fresh) gridExtract = fresh;
    }

    const systemPrompt = buildSystemPromptGroup(tenantTierLevels, rulesCatalog);
    const { parts: userParts, attachmentSummaries } = await this.buildUserContent({
      prompt,
      attachmentPaths,
      gridExtract,
    });

    const apiMessages = [{ role: 'system', content: systemPrompt }];

    const capped = Array.isArray(messages) ? messages.slice(-24) : [];
    for (const m of capped) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c.trim()) continue;
      apiMessages.push({ role: m.role, content: c });
    }

    apiMessages.push({ role: 'user', content: userParts });

    let content;
    try {
      const completionOpts = {
        model: this.model,
        messages: apiMessages,
        response_format: { type: 'json_object' },
        ...tokenLimitOption(this.model, 16384),
      };
      if (typeof onStreamDelta === 'function') {
        content = await streamChatCompletionContent(this.openai, completionOpts, {
          onDisplayDelta: onStreamDelta,
        });
      } else {
        const response = await this.openai.chat.completions.create(completionOpts);
        content = response.choices?.[0]?.message?.content;
      }
    } catch (err) {
      console.error('[aiCommissionRuleAssistant] group OpenAI error:', err.message);
      return {
        reply: {
          kind: 'question',
          text: `The AI service failed: ${err.message}. Try again in a moment.`,
        },
        attachmentSummaries,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(content || '{}');
    } catch {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the key numbers?',
        },
        attachmentSummaries,
      };
    }

    let normalized = validateAndNormalizeGroupReply(parsed, patchableRuleIdSet, allowedLevels);
    if (!normalized) {
      return {
        reply: {
          kind: 'question',
          text: 'I had trouble structuring that response. Could you restate the key numbers?',
        },
        attachmentSummaries,
      };
    }

    normalized = auditGroupProposalScope(normalized, rulesCatalog, prompt);
    normalized = sanitizeCommissionAiReply(normalized, rulesCatalog);

    return { reply: normalized, attachmentSummaries, sessionGridExtract: gridExtract || undefined };
  }
}

module.exports = new AICommissionRuleAssistantService();
