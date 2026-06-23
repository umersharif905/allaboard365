import { Loader2 } from 'lucide-react';
import React from 'react';

interface W9RequirementNoticeProps {
  isChecking?: boolean;
  isMissing: boolean;
  targetLabel: string;
  onFix: () => void;
  className?: string;
}

const W9RequirementNotice: React.FC<W9RequirementNoticeProps> = ({
  isChecking = false,
  isMissing,
  targetLabel,
  onFix,
  className = ''
}) => {
  if (isChecking) {
    return (
      <div className={`inline-flex items-center gap-1 text-[11px] leading-4 text-gray-600 whitespace-nowrap ${className}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking W9...
      </div>
    );
  }

  if (!isMissing) {
    return null;
  }

  return (
    <div className={`inline-flex items-center gap-1 text-[12px] leading-4 text-red-600 whitespace-nowrap ${className}`}>
      <span>W9 required</span>
      <button
        type="button"
        onClick={onFix}
        className="font-semibold underline hover:no-underline"
        title={`Fix ${targetLabel} requirement`}
      >
        Fix now
      </button>
    </div>
  );
};

export default W9RequirementNotice;
