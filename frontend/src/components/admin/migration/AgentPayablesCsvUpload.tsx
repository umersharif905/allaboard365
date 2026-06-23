import { FileSpreadsheet, Loader2 } from 'lucide-react';
import type { AgentMigrationPayablesIndex } from '../../../services/e123Migration.service';

interface Props {
  file: File | null;
  onFileChange: (file: File | null) => void;
  uploadedMeta: AgentMigrationPayablesIndex | null;
  disabled?: boolean;
  busy?: boolean;
}

export default function AgentPayablesCsvUpload({
  file,
  onFileChange,
  uploadedMeta,
  disabled = false,
  busy = false
}: Props) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <label className="block text-sm font-medium text-gray-900 mb-1">
            E123 payables detail CSV <span className="text-red-600">*</span>
          </label>
          <p className="text-xs text-gray-500 mb-3">
            Upload the most recent <strong>full calendar month</strong> payables detail export from E123.
            We use payee bank columns for ACH and <strong>seller lines only</strong> (payee = writing agent) to
            suggest commission tiers from the agency&apos;s default commission group. Upline override rows are ignored
            for tier matching.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={disabled || busy}
            className="block w-full text-sm text-gray-700 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-emerald-50 file:text-emerald-800 file:font-medium hover:file:bg-emerald-100 disabled:opacity-50"
            onChange={(e) => onFileChange(e.target.files?.[0] || null)}
          />
          {file ? (
            <p className="text-xs text-gray-600 mt-2">Selected: {file.name}</p>
          ) : null}
          {uploadedMeta ? (
            <div className="mt-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-900 space-y-1">
              <div>
                Loaded {uploadedMeta.agentCount} payee agents from{' '}
                {uploadedMeta.fileName || 'payables CSV'}
                {uploadedMeta.dominantMonth ? ` (${uploadedMeta.dominantMonth})` : ''}.
              </div>
              {uploadedMeta.commissionGroupName ? (
                <div>Tier rules: {uploadedMeta.commissionGroupName}</div>
              ) : null}
              {uploadedMeta.warnings?.length ? (
                <ul className="list-disc pl-4 text-amber-900">
                  {uploadedMeta.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {busy ? (
            <p className="text-xs text-gray-500 mt-2 inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Parsing payables…
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
