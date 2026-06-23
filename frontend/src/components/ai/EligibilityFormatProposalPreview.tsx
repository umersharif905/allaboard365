import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React, { useEffect, useMemo, useState } from 'react';
import { apiService } from '../../services/api.service';
import type {
  EligibilityTemplatePreviewResponse,
  VendorEligibilityFormSlice,
} from '../../types/ai/eligibilityFormatAssistant.types';
import type { EligibilityFormatPatch } from '../../utils/eligibilityFormatAiMerge';
import { normalizeEligibilityAiPatch } from '../../utils/eligibilityFormatAiMerge';
import {
  parseEligibilityTemplateColumns,
  validateTemplatePlaceholders,
  type EligibilityTemplateColumn,
} from '../../utils/eligibilityRowTemplate';

const VISIBLE_COLUMNS = 12;

type ColumnRow = {
  index: number;
  headerLabel: string;
  placeholders: string;
  modifiers: string;
  status: 'new' | 'removed' | 'changed' | 'same';
};

function buildColumnRows(
  beforeCols: EligibilityTemplateColumn[],
  afterCols: EligibilityTemplateColumn[]
): ColumnRow[] {
  const maxLen = Math.max(beforeCols.length, afterCols.length);
  const rows: ColumnRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const b = beforeCols[i];
    const a = afterCols[i];
    const bSig = b ? `${b.placeholders.join(',')}:${b.headerLabel}` : '';
    const aSig = a ? `${a.placeholders.join(',')}:${a.headerLabel}` : '';
    let status: ColumnRow['status'] = 'same';
    if (!b && a) status = 'new';
    else if (b && !a) status = 'removed';
    else if (bSig !== aSig) status = 'changed';

    rows.push({
      index: i + 1,
      headerLabel: a?.headerLabel || b?.headerLabel || '—',
      placeholders: (a || b)?.placeholders.join(', ') || '—',
      modifiers: (a || b)?.modifiers.join(', ') || '',
      status,
    });
  }
  return rows;
}

function statusChip(status: ColumnRow['status']) {
  if (status === 'same') return null;
  const color =
    status === 'new' ? 'success' : status === 'removed' ? 'error' : 'warning';
  const label = status === 'new' ? 'New' : status === 'removed' ? 'Removed' : 'Changed';
  return <Chip size="small" label={label} color={color} sx={{ ml: 0.5 }} />;
}

type Props = {
  vendorId: string;
  formData: VendorEligibilityFormSlice;
  patch: EligibilityFormatPatch;
};

export function EligibilityFormatProposalPreview({ vendorId, formData, patch }: Props) {
  const normalized = normalizeEligibilityAiPatch(patch);
  const proposedTemplate =
    normalized.eligibilityRowTemplate !== undefined
      ? normalized.eligibilityRowTemplate
      : (formData.EligibilityRowTemplate || '').trim();
  const proposedDateFormat =
    normalized.eligibilityDateFormat ?? formData.EligibilityDateFormat ?? 'ARM';
  const proposedPartner =
    normalized.eligibilityIntegrationPartner !== undefined
      ? normalized.eligibilityIntegrationPartner
      : formData.EligibilityIntegrationPartner || '';

  const beforeCols = parseEligibilityTemplateColumns(formData.EligibilityRowTemplate || '');
  const afterCols = parseEligibilityTemplateColumns(proposedTemplate);
  const columnRows = useMemo(() => buildColumnRows(beforeCols, afterCols), [beforeCols, afterCols]);

  const [preview, setPreview] = useState<EligibilityTemplatePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fullColumnsOpen, setFullColumnsOpen] = useState(false);

  const invalidInProposal = validateTemplatePlaceholders(proposedTemplate);

  useEffect(() => {
    if (!vendorId) return;
    const t = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError(null);
      void apiService
        .post<EligibilityTemplatePreviewResponse>(
          `/api/vendors/${vendorId}/eligibility-template-preview`,
          {
            template: proposedTemplate,
            eligibilityDateFormat: proposedDateFormat,
            eligibilityIntegrationPartner: proposedPartner,
            eligibilityPrimaryExportGrain:
              formData.EligibilityPrimaryExportGrain === 'SinglePrimaryRow'
                ? 'SinglePrimaryRow'
                : 'PerProduct',
          }
        )
        .then((res) => {
          if (!res.success) throw new Error(res.message || 'Preview failed');
          setPreview(res);
        })
        .catch((e: unknown) => {
          setPreview(null);
          setPreviewError(e instanceof Error ? e.message : 'Preview failed');
        })
        .finally(() => setPreviewLoading(false));
    }, 400);
    return () => clearTimeout(t);
  }, [
    vendorId,
    proposedTemplate,
    proposedDateFormat,
    proposedPartner,
    formData.EligibilityPrimaryExportGrain,
  ]);

  const parseErrors = [
    ...invalidInProposal.map((p) => `Invalid placeholder: ${p}`),
    ...(preview?.parseErrors || []),
  ];

  const displayColumns = fullColumnsOpen ? columnRows : columnRows.slice(0, VISIBLE_COLUMNS);
  const sampleRows = preview?.rows && preview.rows.length > 0 ? preview.rows : null;

  const dateFormatChanged =
    normalized.eligibilityDateFormat !== undefined &&
    (formData.EligibilityDateFormat || 'ARM') !== normalized.eligibilityDateFormat;
  const partnerChanged =
    normalized.eligibilityIntegrationPartner !== undefined &&
    (formData.EligibilityIntegrationPartner || '').trim() !==
      normalized.eligibilityIntegrationPartner.trim();

  return (
    <Box>
      {(dateFormatChanged || partnerChanged) && (
        <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {dateFormatChanged && (
            <Chip
              size="small"
              color="info"
              label={`Date format: ${formData.EligibilityDateFormat || 'ARM'} → ${normalized.eligibilityDateFormat}`}
            />
          )}
          {partnerChanged && (
            <Chip
              size="small"
              color="info"
              label={`Integration partner: ${formData.EligibilityIntegrationPartner || '(empty)'} → ${normalized.eligibilityIntegrationPartner}`}
            />
          )}
        </Box>
      )}

      {preview?.usesDefaultColumns && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Empty template uses the system default ARM column layout at export time.
        </Alert>
      )}

      {parseErrors.length > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {parseErrors.join(' · ')}
        </Alert>
      )}

      {columnRows.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={600} display="block" sx={{ mb: 1 }}>
            Column layout ({afterCols.length} columns)
          </Typography>
          <Table size="small" sx={{ '& td, & th': { fontSize: 12, py: 0.5 } }}>
            <TableHead>
              <TableRow>
                <TableCell width={40}>#</TableCell>
                <TableCell>CSV header</TableCell>
                <TableCell>Placeholder(s)</TableCell>
                <TableCell>Notes</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {displayColumns.map((row) => (
                <TableRow key={row.index}>
                  <TableCell>{row.index}</TableCell>
                  <TableCell>{row.headerLabel}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 11 }}>{row.placeholders}</TableCell>
                  <TableCell>
                    {row.modifiers && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        {row.modifiers}
                      </Typography>
                    )}
                    {statusChip(row.status)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {columnRows.length > VISIBLE_COLUMNS && (
            <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
              <IconButton size="small" onClick={() => setFullColumnsOpen((o) => !o)}>
                <ExpandMoreIcon
                  sx={{ transform: fullColumnsOpen ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
                />
              </IconButton>
              <Typography variant="caption" color="text.secondary">
                {fullColumnsOpen
                  ? 'Show fewer columns'
                  : `Full column list (${columnRows.length} total)`}
              </Typography>
            </Box>
          )}
        </Box>
      )}

      <Typography variant="caption" color="text.secondary" fontWeight={600} display="block" sx={{ mb: 1 }}>
        Sample CSV output
      </Typography>
      {previewLoading && (
        <Typography variant="body2" color="text.secondary">
          Loading preview…
        </Typography>
      )}
      {previewError && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {previewError}
        </Alert>
      )}
      {sampleRows && sampleRows.length > 0 && (
        <Box sx={{ overflowX: 'auto', maxHeight: 220, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Table size="small" stickyHeader sx={{ '& td, & th': { fontSize: 11, py: 0.25, whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                {(sampleRows[0] as string[]).map((h, i) => (
                  <TableCell key={i}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sampleRows.slice(1, 4).map((row, ri) => (
                <TableRow key={ri}>
                  {(row as string[]).map((cell, ci) => (
                    <TableCell key={ci}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(preview?.rowCount ?? 0) > 3 && (
            <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
              Showing up to 3 data rows of {preview?.rowCount}.
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
