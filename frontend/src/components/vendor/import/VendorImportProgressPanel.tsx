import React from 'react';
import { Loader2 } from 'lucide-react';
import type { VendorImportProgressEvent } from '../../../utils/vendorImportStream';
import { sanitizeUserFacingText } from './importDisplay';

interface Props {
  progress: VendorImportProgressEvent | null;
  title?: string;
}

const VendorImportProgressPanel: React.FC<Props> = ({ progress, title = 'Working…' }) => {
  if (!progress) return null;

  const pct =
    progress.current != null && progress.total != null && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : null;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
      <div className="flex items-center gap-2 font-medium">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" />
        <span>{title}</span>
      </div>
      <p className="mt-2">{sanitizeUserFacingText(progress.message)}</p>
      {pct != null && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-blue-800">
            <span>{progress.current} / {progress.total}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-blue-100">
            <div
              className="h-full rounded-full bg-oe-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorImportProgressPanel;
