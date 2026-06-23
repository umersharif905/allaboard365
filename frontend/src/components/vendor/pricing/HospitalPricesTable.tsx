// Nearby hospital asking prices (CMS MRF data) for a billing code:
// cash price, gross charge, negotiated min/max, top payer rates.
//
// When `data` is provided the component renders it directly and skips its
// internal fetch — used by the standalone Procedure Pricing page which lifts
// the fetch to compute summary stats. When `data` is omitted the component
// self-fetches as before (keeps ProcedurePricingSection working unchanged).

import { useEffect, useMemo, useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { cptPricingService } from '../../../services/cpt-pricing.service';
import type { HospitalPrice, HospitalPricesResult } from '../../../types/cptPricing.types';

interface HospitalPricesTableProps {
  code: string;
  zip?: string;
  radius?: number;
  limit?: number;
  /** When provided, skip the internal fetch and render this data directly. */
  data?: HospitalPricesResult;
}

const fmt = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const HospitalPricesTable = ({ code, zip, radius = 100, limit = 25, data: externalData }: HospitalPricesTableProps) => {
  const [internalData, setInternalData] = useState<HospitalPricesResult | null>(null);
  const [loading, setLoading] = useState(externalData === undefined);
  const [error, setError] = useState<string | null>(null);
  const [settingFilter, setSettingFilter] = useState<string>('');

  // Only fetch when no external data is provided
  useEffect(() => {
    if (externalData !== undefined) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    cptPricingService
      .getHospitalPrices(code, { zip, radius, limit })
      .then((res) => {
        if (!cancelled) setInternalData(res);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, zip, radius, limit, externalData]);

  const data = externalData ?? internalData;

  // Distinct setting values for the filter dropdown
  const settingOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    for (const row of data.results) {
      if (row.setting) seen.add(row.setting);
    }
    return Array.from(seen).sort();
  }, [data]);

  const filteredResults = useMemo(() => {
    if (!data) return [];
    if (!settingFilter) return data.results;
    return data.results.filter((r) => r.setting === settingFilter);
  }, [data, settingFilter]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading hospital prices…
      </div>
    );
  }
  if (error) {
    return <p className="text-sm text-red-600 py-3">{error}</p>;
  }
  if (!data || data.results.length === 0) {
    return <p className="text-sm text-gray-500 py-3">No hospital price data found for {code}{zip ? ` near ${zip}` : ''}.</p>;
  }

  return (
    <div className="space-y-3">
      {settingOptions.length > 1 && (
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-500 shrink-0">Setting:</label>
          <select
            value={settingFilter}
            onChange={(e) => setSettingFilter(e.target.value)}
            className="px-2 py-1 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent bg-white"
          >
            <option value="">All settings</option>
            {settingOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {settingFilter && (
            <span className="text-xs text-gray-400">
              {filteredResults.length} of {data.results.length} rows
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 text-left border-b border-gray-200">
              <th className="py-2 pr-4 font-medium">Hospital</th>
              <th className="py-2 pr-4 font-medium text-right">Distance</th>
              <th className="py-2 pr-4 font-medium text-right">Cash price</th>
              <th className="py-2 pr-4 font-medium text-right">Gross charge</th>
              <th className="py-2 pr-4 font-medium text-right">Negotiated min</th>
              <th className="py-2 pr-4 font-medium text-right">Negotiated max</th>
              <th className="py-2 font-medium">Top payer rates</th>
            </tr>
          </thead>
          <tbody>
            {filteredResults.map((row) => (
              <HospitalRow key={row.price_id} row={row} />
            ))}
          </tbody>
        </table>
        {filteredResults.length === 0 && (
          <p className="text-sm text-gray-500 py-3">No rows match the selected setting filter.</p>
        )}
      </div>
    </div>
  );
};

const HospitalRow = ({ row }: { row: HospitalPrice }) => (
  <tr className="border-b border-gray-100 align-top">
    <td className="py-2 pr-4">
      <div className="flex items-start gap-2">
        <Building2 className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-gray-900">{row.hospital_name}</p>
          <p className="text-xs text-gray-500">
            {row.hospital_city}, {row.hospital_state} {row.hospital_zip}
            {row.setting ? ` · ${row.setting}` : ''}
          </p>
        </div>
      </div>
    </td>
    <td className="py-2 pr-4 text-right text-gray-700">
      {row.distance_mi != null ? `${Math.round(row.distance_mi)} mi` : '—'}
    </td>
    <td className="py-2 pr-4 text-right font-medium text-gray-900">{fmt(row.cash_price)}</td>
    <td className="py-2 pr-4 text-right text-gray-700">{fmt(row.gross_charge)}</td>
    <td className="py-2 pr-4 text-right text-gray-700">{fmt(row.min_negotiated)}</td>
    <td className="py-2 pr-4 text-right text-gray-700">{fmt(row.max_negotiated)}</td>
    <td className="py-2 text-xs text-gray-600">
      {row.top_payers?.length
        ? row.top_payers.map((p) => (
            <p key={`${p.payer}-${p.plan}`}>
              <span className="text-gray-900">{fmt(p.amount)}</span> {p.payer}
            </p>
          ))
        : '—'}
    </td>
  </tr>
);

export default HospitalPricesTable;
