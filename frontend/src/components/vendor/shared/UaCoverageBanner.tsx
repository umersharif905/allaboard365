// UaCoverageBanner — the "two unshared amounts paid in full / 12 months"
// coverage signal. Shared by the Member Finances tab and the Share Request
// Finances tab. The underlying number is a member-level analysis (it spans all
// of the member's share requests in a trailing window), computed server-side
// and returned on both the member and per-SR finance-summary payloads.

import { ShieldCheck } from 'lucide-react';

export interface UaCoverage {
  windowMonths: number;
  uaPaidInFullCount: number;
  fullyCovered: boolean;
}

interface UaCoverageBannerProps {
  ua: UaCoverage;
  className?: string;
}

const UaCoverageBanner = ({ ua, className = '' }: UaCoverageBannerProps) => (
  <div
    className={`flex items-start gap-3 rounded-lg border p-4 ${
      ua.fullyCovered ? 'border-oe-success/40 bg-green-50' : 'border-gray-200 bg-white'
    } ${className}`}
  >
    <ShieldCheck className={`h-5 w-5 mt-0.5 ${ua.fullyCovered ? 'text-oe-success' : 'text-gray-400'}`} />
    <div className="text-sm">
      <p className="font-medium text-gray-900">
        {ua.uaPaidInFullCount} unshared amount{ua.uaPaidInFullCount === 1 ? '' : 's'} paid in full
        <span className="text-gray-500 font-normal"> · trailing {ua.windowMonths} months</span>
      </p>
      <p className="text-gray-600 mt-0.5">
        {ua.fullyCovered
          ? 'Two or more unshared amounts paid in full — remaining eligible expenses should be fully covered.'
          : 'Two unshared amounts paid in full within 12 months unlocks full coverage on further expenses.'}
      </p>
    </div>
  </div>
);

export default UaCoverageBanner;
