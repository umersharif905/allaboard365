// Shared commission status pill (larger than legacy text-xs chips)
import React from 'react';

const BASE =
  'inline-flex items-center px-3 py-1.5 text-sm font-semibold rounded-full border';

interface CommissionStatusBadgeProps {
  status?: string | null;
}

const CommissionStatusBadge: React.FC<CommissionStatusBadgeProps> = ({ status }) => {

  const normalized = (status ?? '').trim();

  switch (normalized) {
    case 'Paid':
      return <span className={`${BASE} bg-green-100 text-green-900 border-green-200`}>Paid</span>;

    case 'Pending':
      return <span className={`${BASE} bg-yellow-100 text-yellow-900 border-yellow-200`}>Pending</span>;

    case 'Failed':
      return <span className={`${BASE} bg-red-100 text-red-900 border-red-200`}>Failed</span>;

    case 'Earned':
      return <span className={`${BASE} bg-sky-100 text-sky-900 border-sky-200`}>Earned</span>;

    case 'Uninvoiced':
      return <span className={`${BASE} bg-amber-100 text-amber-950 border-amber-300`}>Uninvoiced</span>;

    case 'Reserved':
      return <span className={`${BASE} bg-violet-100 text-violet-900 border-violet-200`}>Reserved</span>;

    case 'Cancelled':
      return <span className={`${BASE} bg-gray-200 text-gray-900 border-gray-300`}>Cancelled</span>;

    default:
      return (
        <span className={`${BASE} bg-gray-100 text-gray-900 border-gray-200`}>
          {normalized || 'Unknown'}
        </span>
      );
  }
};

export default CommissionStatusBadge;
