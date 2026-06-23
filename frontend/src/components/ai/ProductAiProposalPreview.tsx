import {
  Box,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
  Alert,
} from '@mui/material';
import type { ConfigurationField, PricingTier, ProductFormData } from '../../types/sysadmin/addproductswizard.types';
import type { PaymentProcessorSettings } from '../../types/paymentProcessorSettings';
import type { ProductFieldChange } from '../../utils/productAiMerge';
import {
  previewMergedPricingTiers,
  normalizeProductAiPatch,
  pricingPatchMissingComponents,
  IGNORED_AI_PATCH_FIELDS,
} from '../../utils/productAiMerge';
import {
  formatAiFeePreviewLabel,
  resolveAiFeePreviewSettings,
  resolveAiPreviewBandAmounts,
  type AiFeePreviewSettings,
} from '../../utils/productAiFeePreview';
import { formatFieldLabel, formatMoney } from '../../utils/productAiChatDisplay';

function tierTitle(tier: PricingTier): string {
  return tier.label?.trim() || (tier.tierType && tier.tierType !== 'N/A' ? tier.tierType : 'Unnamed tier');
}

function formatIsoDateLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = String(value).trim();
  if (!t) return null;
  return t.length >= 10 ? t.slice(0, 10) : t;
}

/** Effective / end dates for bands shown in this tier diff (open-ended bands first). */
function formatTierPhaseDateLabel(tier: PricingTier): string | null {
  const bands = tier.ageBands || [];
  if (bands.length === 0) return null;
  const open = bands.filter((b) => !formatIsoDateLabel(b.terminationDate));
  const source = open.length > 0 ? open : bands;
  const effectiveDates = [
    ...new Set(source.map((b) => formatIsoDateLabel(b.effectiveDate)).filter((d): d is string => Boolean(d))),
  ].sort();
  const terminationDates = [
    ...new Set(source.map((b) => formatIsoDateLabel(b.terminationDate)).filter((d): d is string => Boolean(d))),
  ].sort();
  if (effectiveDates.length === 0 && terminationDates.length === 0) return null;
  const parts: string[] = [];
  if (effectiveDates.length === 1) parts.push(`Effective ${effectiveDates[0]}`);
  else if (effectiveDates.length > 1) parts.push(`Effective ${effectiveDates.join(', ')}`);
  if (terminationDates.length === 1) parts.push(`Ends ${terminationDates[0]}`);
  else if (terminationDates.length > 1) parts.push(`Ends ${terminationDates.join(', ')}`);
  return parts.join(' · ');
}


function formatArrayItem(item: unknown): string {
  if (item == null) return '(empty)';
  if (typeof item !== 'object') return String(item);
  const o = item as Record<string, unknown>;
  if (o.tierType || o.label || o.ageBands) {
    const tier = item as PricingTier;
    return tierSummaryLine(tier, false);
  }
  if (o.fieldName) return String(o.fieldName);
  if (o.question) return String(o.question);
  return JSON.stringify(item).slice(0, 120);
}

function tierSummaryLine(tier: PricingTier, showIncludedFee: boolean): string {
  const title = tierTitle(tier);
  const bands = tier.ageBands || [];
  if (bands.length === 0) return `${title} — no age bands`;
  const sample = bands
    .slice(0, 4)
    .map((b) => {
      const cfg = formatBandConfig(b);
      const cfgSuffix = cfg ? ` [${cfg}]` : '';
      const base = `${b.minAge}–${b.maxAge}${cfgSuffix}: net ${formatMoney(b.netRate)}`;
      if (showIncludedFee) {
        return `${base} / incl. fee ${formatMoney(b.includedProcessingFee || 0)} / msrp ${formatMoney(b.msrpRate)}`;
      }
      return `${base} / msrp ${formatMoney(b.msrpRate)}`;
    })
    .join('; ');
  const extra = bands.length > 4 ? ` (+${bands.length - 4} more)` : '';
  return `${title} (${bands.length} band${bands.length === 1 ? '' : 's'}): ${sample}${extra}`;
}

function pricingPatchHasRates(tiers: PricingTier[]): boolean {
  return tiers.some((t) =>
    (t.ageBands || []).some((b) => (b.netRate || 0) > 0 || (b.msrpRate || 0) > 0)
  );
}

type BandRow = {
  key: string;
  ages: string;
  tobacco: string;
  config?: string;
  removed?: boolean;
  before?: {
    net: number;
    override: number;
    commission: number;
    includedFee: number;
    msrp: number;
  };
  after?: {
    net: number;
    override: number;
    commission: number;
    includedFee: number;
    msrp: number;
  };
};

function bandKey(b: {
  id?: string;
  minAge?: number;
  maxAge?: number;
  tobaccoStatus?: string;
  configValue1?: string;
  configValue2?: string;
  configValue3?: string;
  configValue4?: string;
  configValue5?: string;
}) {
  const config = [b.configValue1, b.configValue2, b.configValue3, b.configValue4, b.configValue5]
    .map((v) => (v == null ? '' : String(v).trim()))
    .join('|');
  return `${b.minAge}-${b.maxAge}-${b.tobaccoStatus ?? 'N/A'}-${config}`;
}

/** Human-readable configuration value(s) for a band (e.g. "Unshared Amount: 2000"). */
function formatBandConfig(b: {
  configValue1?: string;
  configValue2?: string;
  configValue3?: string;
  configValue4?: string;
  configValue5?: string;
  configField1?: string;
  configField2?: string;
  configField3?: string;
  configField4?: string;
  configField5?: string;
}): string {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [b.configField1, b.configValue1],
    [b.configField2, b.configValue2],
    [b.configField3, b.configValue3],
    [b.configField4, b.configValue4],
    [b.configField5, b.configValue5],
  ];
  return pairs
    .map(([field, value]) => {
      const v = value == null ? '' : String(value).trim();
      if (!v) return '';
      const f = field == null ? '' : String(field).trim();
      return f ? `${f}: ${v}` : v;
    })
    .filter(Boolean)
    .join(' · ');
}

function buildBandRowAmounts(
  band: { netRate: number; overrideRate: number; commission: number; includedProcessingFee?: number; msrpRate: number },
  feeSettings: AiFeePreviewSettings,
  tenantPaymentSettings?: PaymentProcessorSettings | null,
  manualIncludedProcessingFee?: boolean
) {
  const { includedFee, msrp } = resolveAiPreviewBandAmounts(
    band,
    feeSettings,
    tenantPaymentSettings,
    manualIncludedProcessingFee
  );
  return {
    net: band.netRate,
    override: band.overrideRate,
    commission: band.commission,
    includedFee,
    msrp,
  };
}

function buildBandRows(
  before: PricingTier,
  after: PricingTier,
  feeSettings: AiFeePreviewSettings,
  tenantPaymentSettings?: PaymentProcessorSettings | null,
  manualIncludedProcessingFee?: boolean
): BandRow[] {
  const beforeMap = new Map(before.ageBands.map((b) => [bandKey(b), b]));
  const afterMap = new Map(after.ageBands.map((b) => [bandKey(b), b]));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const rows: BandRow[] = [];
  for (const key of keys) {
    const bBand = beforeMap.get(key);
    const aBand = afterMap.get(key);
    if (!aBand && bBand) {
      rows.push({
        key,
        ages: `${bBand.minAge}–${bBand.maxAge}`,
        tobacco: bBand.tobaccoStatus || 'N/A',
        config: formatBandConfig(bBand),
        removed: true,
        before: buildBandRowAmounts(
          bBand,
          feeSettings,
          tenantPaymentSettings,
          manualIncludedProcessingFee
        ),
      });
      continue;
    }
    if (!aBand) continue;
    rows.push({
      key,
      ages: `${aBand.minAge}–${aBand.maxAge}`,
      tobacco: aBand.tobaccoStatus || 'N/A',
      config: formatBandConfig(aBand),
      before: bBand
        ? buildBandRowAmounts(bBand, feeSettings, tenantPaymentSettings, manualIncludedProcessingFee)
        : undefined,
      after: buildBandRowAmounts(
        aBand,
        feeSettings,
        tenantPaymentSettings,
        manualIncludedProcessingFee
      ),
    });
  }
  return rows;
}

function PricingTierDiffTable({
  beforeTier,
  afterTier,
  isNew,
  feeSettings,
  tenantPaymentSettings,
  manualIncludedProcessingFee,
}: {
  beforeTier?: PricingTier;
  afterTier: PricingTier;
  isNew: boolean;
  feeSettings?: AiFeePreviewSettings;
  tenantPaymentSettings?: PaymentProcessorSettings | null;
  manualIncludedProcessingFee?: boolean;
}) {
  const showIncludedFee = feeSettings?.includeProcessingFee === true;
  // Both branches are BandRow[]; annotate so the ternary doesn't infer a union
  // (the "added" branch omits the optional `removed`/`before`, which is valid).
  const rows: BandRow[] = beforeTier
    ? buildBandRows(beforeTier, afterTier, feeSettings!, tenantPaymentSettings, manualIncludedProcessingFee)
    : afterTier.ageBands.map((b) => ({
        key: bandKey(b),
        ages: `${b.minAge}–${b.maxAge}`,
        tobacco: b.tobaccoStatus || 'N/A',
        config: formatBandConfig(b),
        before: undefined,
        after: buildBandRowAmounts(
          b,
          feeSettings!,
          tenantPaymentSettings,
          manualIncludedProcessingFee
        ),
      }));

  const showConfig = rows.some((r) => Boolean(r.config));

  const renderCell = (beforeVal: number | undefined, afterVal: number | undefined, removed?: boolean) => {
    if (removed) {
      return (
        <TableCell align="right" sx={{ fontSize: 12 }}>
          <Typography component="span" variant="caption" color="text.secondary" sx={{ textDecoration: 'line-through' }}>
            {beforeVal !== undefined ? formatMoney(beforeVal) : '—'}
          </Typography>
        </TableCell>
      );
    }
    const changed = beforeVal !== undefined && afterVal !== undefined && Math.abs(beforeVal - afterVal) > 0.009;
    return (
      <TableCell align="right" sx={{ fontSize: 12 }}>
        {beforeVal !== undefined && changed && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ textDecoration: 'line-through', mr: 0.5 }}>
            {formatMoney(beforeVal)}
          </Typography>
        )}
        <Typography
          component="span"
          variant="caption"
          fontWeight={changed || beforeVal === undefined ? 700 : 400}
          color={changed || beforeVal === undefined ? 'success.main' : 'text.primary'}
        >
          {formatMoney(afterVal ?? 0)}
        </Typography>
      </TableCell>
    );
  };

  return (
    <Box sx={{ mb: 2, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <Box sx={{ px: 1.5, py: 1, bgcolor: 'grey.100' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">{tierTitle(afterTier)}</Typography>
          {afterTier.tierType && afterTier.tierType !== 'N/A' && (
            <Chip size="small" label={afterTier.tierType} variant="outlined" />
          )}
          {isNew && <Chip size="small" label="New tier" color="success" />}
          {!isNew && <Chip size="small" label="Updated" color="primary" variant="outlined" />}
        </Box>
        {formatTierPhaseDateLabel(afterTier) && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
            {formatTierPhaseDateLabel(afterTier)}
          </Typography>
        )}
      </Box>
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
          No age bands in this tier.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Ages</TableCell>
              <TableCell>Tobacco</TableCell>
              {showConfig && <TableCell>Config</TableCell>}
              <TableCell align="right">Net</TableCell>
              <TableCell align="right">Override</TableCell>
              <TableCell align="right">Commission</TableCell>
              {showIncludedFee && <TableCell align="right">Included fee</TableCell>}
              <TableCell align="right">MSRP</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.key}
                sx={row.removed ? { bgcolor: 'action.hover' } : undefined}
              >
                <TableCell sx={{ fontSize: 12 }}>
                  {row.ages}
                  {row.removed && (
                    <Chip size="small" label="Removed" color="error" variant="outlined" sx={{ ml: 1, height: 20 }} />
                  )}
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>{row.tobacco}</TableCell>
                {showConfig && (
                  <TableCell sx={{ fontSize: 12 }}>{row.config || '—'}</TableCell>
                )}
                {renderCell(row.before?.net, row.after?.net, row.removed)}
                {renderCell(row.before?.override, row.after?.override, row.removed)}
                {renderCell(row.before?.commission, row.after?.commission, row.removed)}
                {showIncludedFee &&
                  renderCell(row.before?.includedFee, row.after?.includedFee, row.removed)}
                {renderCell(row.before?.msrp, row.after?.msrp, row.removed)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

function SimpleValueTable({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) {
    return (
      <Typography variant="body2" color="text.secondary">
        {label}: (cleared)
      </Typography>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <Typography variant="body2">
        <strong>{label}:</strong> {value ? 'Yes' : 'No'}
      </Typography>
    );
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return (
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        <strong>{label}:</strong> {String(value)}
      </Typography>
    );
  }
  if (Array.isArray(value)) {
    return (
      <Box sx={{ mb: 1 }}>
        <Typography variant="body2" fontWeight={600} gutterBottom>
          {label} ({value.length})
        </Typography>
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
          {value.slice(0, 12).map((item, i) => (
            <Typography component="li" variant="caption" key={i}>
              {formatArrayItem(item)}
            </Typography>
          ))}
          {value.length > 12 && (
            <Typography component="li" variant="caption" color="text.secondary">
              …and {value.length - 12} more
            </Typography>
          )}
        </Box>
      </Box>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {label}: (structured update — apply to view in wizard)
    </Typography>
  );
}

export function ProductAiProposalPreview({
  formData,
  patch,
  changes,
  configurationFields,
  tenantPaymentSettings,
}: {
  formData: ProductFormData;
  patch: Partial<ProductFormData>;
  changes: ProductFieldChange[];
  configurationFields?: ConfigurationField[];
  tenantPaymentSettings?: PaymentProcessorSettings | null;
}) {
  const normalizedPatch = normalizeProductAiPatch(patch);
  const feeSettings = resolveAiFeePreviewSettings(formData, normalizedPatch);
  const manualFeeEntry =
    normalizedPatch.manualIncludedProcessingFee === true || formData.manualIncludedProcessingFee === true;
  const visibleChanges = changes.filter((c) => !IGNORED_AI_PATCH_FIELDS.has(c.field));

  const pricingTiersInPatch = normalizedPatch.pricingTiers;
  const hasPricingPatch = Array.isArray(pricingTiersInPatch) && pricingTiersInPatch.length > 0;
  const pricingHasRates = hasPricingPatch && pricingPatchHasRates(pricingTiersInPatch);
  const missingComponents =
    hasPricingPatch && pricingTiersInPatch && pricingPatchMissingComponents(pricingTiersInPatch);

  if (visibleChanges.length === 0 && !hasPricingPatch) {
    return (
      <Typography variant="body2" color="text.secondary">
        No field changes detected. The assistant may have returned metadata only — try asking again with
        &quot;build pricing tiers from the screenshot with EE/ES/EC/EF and age bands&quot;.
      </Typography>
    );
  }

  const otherChanges = visibleChanges.filter((c) => c.field !== 'pricingTiers');

  const feeFields = [
    'manualIncludedProcessingFee',
    'includeProcessingFee',
    'roundUpProcessingFee',
    'processingFeePercentage',
  ] as const;
  const feeChanges = feeFields.filter((f) => normalizedPatch[f] !== undefined);

  let pricingSection = null;
  if (hasPricingPatch && pricingTiersInPatch) {
    const mergedAll = previewMergedPricingTiers(formData.pricingTiers, pricingTiersInPatch);
    const patchTargets = new Set(
      pricingTiersInPatch.map((t) =>
        t.id != null ? String(t.id) : `${t.tierType || ''}|${t.label || ''}`
      )
    );
    const isPatchedTier = (tier: PricingTier) =>
      patchTargets.has(String(tier.id)) ||
      patchTargets.has(`${tier.tierType || ''}|${tier.label || ''}`) ||
      pricingTiersInPatch.some(
        (p) =>
          (p.tierType && p.tierType !== 'N/A' && p.tierType === tier.tierType) ||
          (p.label && p.label === tier.label)
      );

    const tiersToShow = mergedAll.filter(isPatchedTier);
    const unchangedCount = formData.pricingTiers.filter(
      (t) =>
        !pricingTiersInPatch.some(
          (p) =>
            (p.id != null && String(p.id) === String(t.id)) ||
            (p.tierType && p.tierType !== 'N/A' && p.tierType === t.tierType) ||
            (p.label && p.label === t.label)
        )
    ).length;

    pricingSection = (
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Pricing changes
        </Typography>
        {unchangedCount > 0 && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            {unchangedCount} other tier{unchangedCount === 1 ? '' : 's'} unchanged (only tiers in this patch are shown).
          </Typography>
        )}
        {!pricingHasRates && (
          <Typography variant="body2" color="error" sx={{ mb: 1 }}>
            Proposal tiers have no dollar amounts — Apply is disabled until age bands include netRate/msrpRate.
          </Typography>
        )}
        {missingComponents && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Note: every band has override and commission set to $0 (everything is in Net Rate). If your
            source has Lyric/Override or Agent Comp columns you can ask the assistant to map them — otherwise
            this net-only setup will apply as shown.
          </Typography>
        )}
        {feeSettings.includeProcessingFee && (
          <Alert severity="info" sx={{ mb: 1.5, py: 0.5 }}>
            <Typography variant="body2">
              <strong>Processing fee enabled:</strong>{' '}
              {manualFeeEntry
                ? 'Manual included fee $ per age band (auto % and round-up disabled).'
                : formatAiFeePreviewLabel(feeSettings)}
              {' '}MSRP = base rate (net + override + commission) + included processing fee
              {feeSettings.roundUpProcessingFee ? ' (round-up → whole-dollar totals).' : '.'}
            </Typography>
          </Alert>
        )}
        {normalizedPatch.pricingTiers!.map((patchTier, idx) => {
          const patchId = patchTier.id != null ? String(patchTier.id) : '';
          const afterTier =
            mergedAll.find((t) => patchId && String(t.id) === patchId) ||
            mergedAll.find(
              (t) =>
                patchTier.tierType &&
                patchTier.tierType !== 'N/A' &&
                t.tierType === patchTier.tierType
            ) ||
            tiersToShow[idx];
          if (!afterTier) return null;
          const beforeTier = patchId
            ? formData.pricingTiers.find((t) => String(t.id) === patchId)
            : formData.pricingTiers.find(
                (t) =>
                  (patchTier.tierType && t.tierType === patchTier.tierType) ||
                  (patchTier.label && t.label === patchTier.label)
              );
          return (
            <PricingTierDiffTable
              key={`${afterTier.id}-${idx}`}
              beforeTier={beforeTier}
              afterTier={afterTier}
              isNew={!beforeTier}
              feeSettings={feeSettings}
              tenantPaymentSettings={tenantPaymentSettings}
              manualIncludedProcessingFee={manualFeeEntry}
            />
          );
        })}
        {configurationFields && configurationFields.length > 0 && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            Configuration columns on the Pricing step may also reflect config values from these bands.
          </Typography>
        )}
      </Box>
    );
  }

  return (
    <Box>
      {feeChanges.length > 0 && (
        <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
            Product settings:
          </Typography>
          {normalizedPatch.manualIncludedProcessingFee !== undefined && (
            <Chip
              size="small"
              color={normalizedPatch.manualIncludedProcessingFee ? 'warning' : 'default'}
              label={`Manual included fee: ${normalizedPatch.manualIncludedProcessingFee ? 'On' : 'Off'}`}
            />
          )}
          {normalizedPatch.includeProcessingFee !== undefined && (
            <Chip
              size="small"
              color={normalizedPatch.includeProcessingFee ? 'success' : 'default'}
              label={`Include processing fee: ${normalizedPatch.includeProcessingFee ? 'On' : 'Off'}`}
            />
          )}
          {normalizedPatch.roundUpProcessingFee !== undefined && (
            <Chip
              size="small"
              color={normalizedPatch.roundUpProcessingFee !== false ? 'success' : 'default'}
              label={`Round up fee: ${normalizedPatch.roundUpProcessingFee !== false ? 'On' : 'Off'}`}
            />
          )}
          {normalizedPatch.processingFeePercentage !== undefined && (
            <Chip
              size="small"
              color="info"
              label={`Processing fee %: ${normalizedPatch.processingFeePercentage ?? 'tenant default'}`}
            />
          )}
        </Box>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {(visibleChanges.length || (hasPricingPatch ? 1 : 0))} area
        {(visibleChanges.length || (hasPricingPatch ? 1 : 0)) === 1 ? '' : 's'} will be updated:
      </Typography>
      {pricingSection}
      {otherChanges.map((change) => (
        <Box
          key={change.field}
          sx={{ mb: 1.5, p: 1.5, bgcolor: 'background.paper', borderRadius: 1, border: 1, borderColor: 'divider' }}
        >
          <SimpleValueTable label={formatFieldLabel(change.field)} value={change.newValue} />
        </Box>
      ))}
    </Box>
  );
}
