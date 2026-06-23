/** Minimal commission breakdown for hover previews (group rules list, rules table). */

const FAMILY_TIERS = ['EE', 'ES', 'EC', 'EF'] as const;

export type CommissionRulePreviewInput = {
  RuleName?: string;
  CommissionType?: string;
  CommissionRate?: number | null;
  FlatAmount?: number | null;
  CommissionJson?: string | object | null;
  EntityType?: string;
  TierLevel?: number | null;
};

export type CommissionRulePreviewLine = {
  tier: string;
  amount: string;
};

const formatMoney = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

const formatPct = (rate: number) => `${(Math.round(rate * 10000) / 100).toFixed(2)}%`;

function parseCommissionJson(rule: CommissionRulePreviewInput): Record<string, unknown> | null {
  if (!rule.CommissionJson) return null;
  try {
    return typeof rule.CommissionJson === 'string'
      ? (JSON.parse(rule.CommissionJson) as Record<string, unknown>)
      : (rule.CommissionJson as Record<string, unknown>);
  } catch {
    return null;
  }
}

function formatTierAmount(
  tier: {
    flatAmount?: number;
    rate?: number;
    productTiers?: Record<string, { flatAmount?: number; rate?: number }>;
  },
  mode: 'percentage' | 'flatrate'
): string {
  const productTiers = tier.productTiers;
  const familyParts: string[] = [];
  if (productTiers) {
    for (const code of FAMILY_TIERS) {
      const cell = productTiers[code];
      if (mode === 'flatrate' && cell?.flatAmount != null && Number.isFinite(cell.flatAmount)) {
        familyParts.push(`${code} ${formatMoney(cell.flatAmount)}`);
      } else if (mode === 'percentage' && cell?.rate != null && Number.isFinite(cell.rate)) {
        familyParts.push(`${code} ${formatPct(cell.rate)}`);
      }
    }
  }
  if (familyParts.length > 0) return familyParts.join(' · ');

  if (mode === 'flatrate' && tier.flatAmount != null && Number.isFinite(tier.flatAmount)) {
    return FAMILY_TIERS.map((c) => `${c} ${formatMoney(tier.flatAmount!)}`).join(' · ');
  }
  if (mode === 'percentage' && tier.rate != null && Number.isFinite(tier.rate)) {
    return formatPct(tier.rate);
  }
  return '—';
}

function tieredLines(json: Record<string, unknown>): CommissionRulePreviewLine[] {
  const tiers = json.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return [];
  const mode = json.type === 'percentage' ? 'percentage' : 'flatrate';

  return [...tiers]
    .sort((a, b) => Number(a?.level ?? 0) - Number(b?.level ?? 0))
    .map((t) => {
      const name = String(t?.name ?? `Level ${t?.level ?? ''}`).trim();
      return { tier: name, amount: formatTierAmount(t, mode) };
    });
}

function splitLines(json: Record<string, unknown>): CommissionRulePreviewLine[] {
  const sc = json.splitCommission as
    | {
        primaryAgentName?: string;
        primaryAgentPercentage?: number;
        agents?: Array<{ agentName?: string; percentage?: number; agentId?: string }>;
        primaryAgentId?: string;
      }
    | undefined;
  if (!sc) return [];
  const lines: CommissionRulePreviewLine[] = [];
  if (sc.primaryAgentName && sc.primaryAgentPercentage != null) {
    lines.push({
      tier: sc.primaryAgentName,
      amount: formatPct(sc.primaryAgentPercentage),
    });
  }
  for (const a of sc.agents ?? []) {
    if (a.agentId && a.agentId === sc.primaryAgentId) continue;
    const name = (a.agentName || 'Agent').trim();
    if (a.percentage != null) {
      lines.push({ tier: name, amount: formatPct(a.percentage) });
    }
  }
  return lines;
}

/** Up to 8 tier rows; caller can truncate display if needed. */
export function buildCommissionRuleQuickPreview(rule: CommissionRulePreviewInput): CommissionRulePreviewLine[] {
  const json = parseCommissionJson(rule);
  const type = rule.CommissionType;

  if (type === 'Tiered' && json) {
    const lines = tieredLines(json);
    if (lines.length > 0) return lines.slice(0, 12);
  }

  if (type === 'Split' && json) {
    return splitLines(json).slice(0, 8);
  }

  if (type === 'Percentage' && rule.CommissionRate != null) {
    return [{ tier: 'Rate', amount: formatPct(rule.CommissionRate) }];
  }

  if (type === 'Flat' && rule.FlatAmount != null) {
    const flat = formatMoney(Number(rule.FlatAmount));
    return FAMILY_TIERS.map((c) => ({ tier: c, amount: flat }));
  }

  if (json?.tiers && Array.isArray(json.tiers) && json.tiers.length > 0) {
    return tieredLines(json).slice(0, 12);
  }

  if (rule.EntityType === 'Tier' && rule.TierLevel != null && rule.CommissionRate != null) {
    return [{ tier: `Level ${rule.TierLevel}`, amount: formatPct(rule.CommissionRate) }];
  }

  return [];
}

export function commissionRulePreviewModeLabel(rule: CommissionRulePreviewInput): string {
  const json = parseCommissionJson(rule);
  if (rule.CommissionType === 'Tiered' || (json?.tiers && Array.isArray(json.tiers))) {
    return json?.type === 'percentage' ? 'Tiered %' : 'Tiered $';
  }
  if (rule.CommissionType === 'Percentage') return 'Percentage';
  if (rule.CommissionType === 'Flat') return 'Flat $';
  if (rule.CommissionType === 'Split') return 'Split';
  return rule.CommissionType || 'Rule';
}
