import { ChevronDown, Download, FileText, Info } from 'lucide-react';
import React, { useState } from 'react';
import { formatCurrency } from '../../utils/helpers';

export interface SummaryRowData {
  entityType: string;
  entityId: string;
  name: string;
  count: number;       // Number of invoices or payments
  countUnit?: 'invoice' | 'payment';
  credits: number;     // Gross positive earnings
  debits: number;      // Negative line items (legacy debit rows)
  clawbackTotal?: number; // Refund clawbacks netted on this NACHA
  netTotal: number;    // Final payout amount
  previousBalance?: number; // Optional, usually $0 for now
  // For interaction
  onViewDetails?: () => void;
  onExport?: () => void;
  onViewEntityDetails?: () => void; // For viewing agent/agency details
}

interface NACHAPayoutSummaryTableProps {
  rows: SummaryRowData[];
  loading?: boolean;
}

const NACHAPayoutSummaryTable: React.FC<NACHAPayoutSummaryTableProps> = ({ rows, loading }) => {
  const [sortField, setSortField] = useState<keyof SummaryRowData>('netTotal');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  const handleSort = (field: keyof SummaryRowData) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const sortedRows = [...rows].sort((a, b) => {
    const aValue = a[sortField] ?? 0;
    const bValue = b[sortField] ?? 0;
    
    // String sorting
    if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    }
    
    // Numeric sorting
    return sortDirection === 'asc' 
      ? (Number(aValue) - Number(bValue)) 
      : (Number(bValue) - Number(aValue));
  });

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-gray-500 bg-white rounded-lg border border-gray-200">
        <div className="w-8 h-8 border-4 border-oe-primary border-t-transparent rounded-full animate-spin mb-4"></div>
        <p>Loading summary data...</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th 
                className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors group"
                onClick={() => handleSort('name')}
              >
                <div className="flex items-center">
                  Recipient
                  {sortField === 'name' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th 
                className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors group"
                onClick={() => handleSort('count')}
              >
                <div className="flex items-center justify-center">
                  Count
                  <Info
                    size={12}
                    className="inline ml-1 text-gray-400"
                    title={
                      sortedRows.some((r) => r.countUnit === 'invoice')
                        ? '# of invoices included in this NACHA'
                        : '# of payments included in this NACHA'
                    }
                  />
                  {sortField === 'count' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th 
                className="px-6 py-3 text-right text-xs font-medium text-green-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={() => handleSort('credits')}
              >
                <div className="flex items-center justify-end">
                  Credits
                  {sortField === 'credits' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th 
                className="px-6 py-3 text-right text-xs font-medium text-red-600 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={() => handleSort('debits')}
              >
                <div className="flex items-center justify-end">
                  Debits
                  {sortField === 'debits' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th
                className="px-6 py-3 text-right text-xs font-medium text-orange-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={() => handleSort('clawbackTotal')}
              >
                <div className="flex items-center justify-end">
                  Clawbacks
                  <Info
                    size={12}
                    className="inline ml-1 text-orange-500/80"
                    title="Refund clawbacks applied on this NACHA (from debit lines or vendor payout clawback ledger)"
                  />
                  {sortField === 'clawbackTotal' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th 
                className="px-6 py-3 text-right text-xs font-bold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={() => handleSort('netTotal')}
              >
                <div className="flex items-center justify-end">
                  Net Total
                  {sortField === 'netTotal' && (
                    <ChevronDown size={14} className={`ml-1 transform transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
                  )}
                </div>
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {sortedRows.map((row, index) => (
              <tr key={`${row.entityType}-${row.entityId}-${index}`} className="hover:bg-gray-50 transition-colors group">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    {(row.entityType === 'Agent' || row.entityType === 'Agency') && row.onViewEntityDetails ? (
                      <button
                        onClick={row.onViewEntityDetails}
                        className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                        title={`View ${row.entityType} Details`}
                      >
                        {row.name}
                      </button>
                    ) : (
                      <div className="text-sm font-medium text-gray-900">{row.name}</div>
                    )}
                    <div className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
                      row.entityType === 'Agent' ? 'bg-blue-100 text-blue-800' : 
                      row.entityType === 'Agency' ? 'bg-purple-100 text-purple-800' : 
                      row.entityType === 'Vendor' ? 'bg-gray-100 text-gray-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {row.entityType}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-center">
                  <span 
                    className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 cursor-pointer hover:bg-blue-100 transition-colors border border-blue-100"
                    onClick={row.onViewDetails}
                    title={
                      row.countUnit === 'invoice' ? 'View invoices in this payout' : 'View payments in this payout'
                    }
                  >
                    {row.count}{' '}
                    {row.countUnit === 'invoice'
                      ? row.count === 1
                        ? 'Invoice'
                        : 'Invoices'
                      : row.count === 1
                        ? 'Payment'
                        : 'Payments'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-green-600 font-medium">
                  {formatCurrency(row.credits)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-red-600 font-medium">
                  {formatCurrency(row.debits)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm text-orange-700 font-medium">
                  {(row.clawbackTotal ?? 0) > 0 ? formatCurrency(row.clawbackTotal) : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-bold text-gray-900">
                  {formatCurrency(row.netTotal)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                     <button
                      onClick={row.onViewDetails}
                      className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      title="View Details"
                    >
                      <FileText size={18} />
                    </button>
                    {row.onExport ? (
                      <button
                        onClick={row.onExport}
                        className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors"
                        title="Export Statement (XLSX)"
                      >
                        <Download size={18} />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {sortedRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-gray-500 text-sm">
                  <div className="flex flex-col items-center">
                    <Info className="h-8 w-8 text-gray-300 mb-2" />
                    <p>No payouts found matching your criteria.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
          {sortedRows.length > 0 && (
            <tfoot className="bg-gray-50 font-semibold border-t border-gray-200">
              <tr>
                <td className="px-6 py-4 text-sm text-gray-900">Total</td>
                <td className="px-6 py-4 text-center text-sm text-gray-900">
                  {sortedRows.reduce((sum, r) => sum + r.count, 0)}
                </td>
                <td className="px-6 py-4 text-right text-sm text-green-700">
                  {formatCurrency(sortedRows.reduce((sum, r) => sum + r.credits, 0))}
                </td>
                <td className="px-6 py-4 text-right text-sm text-red-700">
                  {formatCurrency(sortedRows.reduce((sum, r) => sum + r.debits, 0))}
                </td>
                <td className="px-6 py-4 text-right text-sm text-orange-800">
                  {(() => {
                    const total = sortedRows.reduce((sum, r) => sum + (r.clawbackTotal || 0), 0);
                    return total > 0 ? formatCurrency(total) : '—';
                  })()}
                </td>
                <td className="px-6 py-4 text-right text-sm text-gray-900 text-base">
                  {formatCurrency(sortedRows.reduce((sum, r) => sum + r.netTotal, 0))}
                </td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
};

export default NACHAPayoutSummaryTable;

