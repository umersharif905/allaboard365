// Summary statistics computed from the hospital MRF price rows for a given
// procedure code. Displayed above the HospitalPricesTable in the standalone
// Procedure Pricing page. All figures are estimates from the CMS price
// transparency data and should not be used for billing or coverage decisions.

import type { HospitalPrice } from '../../../types/cptPricing.types';

interface ChargemasterSummaryPanelProps {
  rows: HospitalPrice[];
  code: string;
}

const fmt = (n: number | null) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeStats(rows: HospitalPrice[]) {
  // Filter to rows with meaningful data (ignore nulls and suspiciously low gross charges)
  const valid = rows.filter((r) => r.gross_charge != null && r.gross_charge > 1);

  const grossCharges = valid.map((r) => r.gross_charge as number);
  const cashPrices = rows.filter((r) => r.cash_price != null && r.cash_price > 1).map((r) => r.cash_price as number);

  // Negotiated min/max across all rows that have them
  const negoMins = rows.filter((r) => r.min_negotiated != null && r.min_negotiated > 0).map((r) => r.min_negotiated as number);
  const negoMaxs = rows.filter((r) => r.max_negotiated != null && r.max_negotiated > 0).map((r) => r.max_negotiated as number);

  const avgGross = grossCharges.length
    ? grossCharges.reduce((a, b) => a + b, 0) / grossCharges.length
    : null;
  const medGross = median(grossCharges);
  const avgCash = cashPrices.length
    ? cashPrices.reduce((a, b) => a + b, 0) / cashPrices.length
    : null;
  const negoMin = negoMins.length ? Math.min(...negoMins) : null;
  const negoMax = negoMaxs.length ? Math.max(...negoMaxs) : null;

  // Distinct hospitals by CCN
  const hospitalCount = new Set(rows.map((r) => r.hospital_ccn)).size;

  return { avgGross, medGross, avgCash, negoMin, negoMax, hospitalCount, rowCount: rows.length };
}

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
}

const StatTile = ({ label, value, sub }: StatTileProps) => (
  <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
    <p className="text-xs text-gray-500 mb-0.5">{label}</p>
    <p className="text-base font-semibold text-gray-900">{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

export default function ChargemasterSummaryPanel({ rows, code }: ChargemasterSummaryPanelProps) {
  const { avgGross, medGross, avgCash, negoMin, negoMax, hospitalCount, rowCount } = computeStats(rows);

  const negoRange =
    negoMin != null && negoMax != null
      ? `${fmt(negoMin)} – ${fmt(negoMax)}`
      : negoMin != null
      ? `≥ ${fmt(negoMin)}`
      : negoMax != null
      ? `≤ ${fmt(negoMax)}`
      : '—';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-xs text-gray-500">
            Chargemaster / MRF data — {rowCount} price line{rowCount !== 1 ? 's' : ''} across{' '}
            {hospitalCount} hospital{hospitalCount !== 1 ? 's' : ''}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">
            Estimates from CMS price-transparency files for code {code}. Not a coverage or billing guarantee.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatTile
          label="Avg chargemaster"
          value={fmt(avgGross ?? null)}
          sub="estimate"
        />
        <StatTile
          label="Median chargemaster"
          value={fmt(medGross ?? null)}
          sub="estimate"
        />
        <StatTile
          label="Avg cash price"
          value={fmt(avgCash ?? null)}
          sub="estimate"
        />
        <StatTile
          label="Negotiated range"
          value={negoRange}
          sub="across all payers"
        />
        <StatTile
          label="Hospitals"
          value={hospitalCount > 0 ? String(hospitalCount) : '—'}
          sub={rowCount > 0 ? `${rowCount} price rows` : undefined}
        />
      </div>
    </div>
  );
}
