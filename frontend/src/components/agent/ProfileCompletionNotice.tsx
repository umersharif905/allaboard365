import { Loader2 } from 'lucide-react';
import React from 'react';

interface ProfileCompletionNoticeProps {
  isChecking?: boolean;
  isIncomplete: boolean;
  onFix: () => void;
  className?: string;
  /** Overrides default "Checking profile..." */
  checkingLabel?: string;
  /** Overrides default "Profile incomplete" */
  incompleteLabel?: string;
}

const ProfileCompletionNotice: React.FC<ProfileCompletionNoticeProps> = ({
  isChecking = false,
  isIncomplete,
  onFix,
  className = '',
  checkingLabel = 'Checking profile...',
  incompleteLabel = 'Profile incomplete'
}) => {
  if (isChecking) {
    return (
      <div className={`inline-flex items-center gap-1 text-[11px] leading-4 text-gray-600 whitespace-nowrap ${className}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {checkingLabel}
      </div>
    );
  }

  if (!isIncomplete) {
    return null;
  }

  return (
    <div className={`inline-flex items-center gap-1 text-[12px] leading-4 text-red-600 whitespace-nowrap ${className}`}>
      <span>{incompleteLabel}</span>
      <button
        type="button"
        onClick={onFix}
        className="font-semibold underline hover:no-underline"
        title="Fix profile completion requirements"
      >
        Fix now
      </button>
    </div>
  );
};

export default ProfileCompletionNotice;
