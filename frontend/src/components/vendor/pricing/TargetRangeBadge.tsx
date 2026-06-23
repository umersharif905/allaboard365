// Headline negotiation range "$X – $Y" (150%–200% of the Medicare all-in rate).

interface TargetRangeBadgeProps {
  targetMin: number | null | undefined;
  targetMax: number | null | undefined;
  /** Compact for table rows; default for cards. */
  size?: 'sm' | 'md';
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

const TargetRangeBadge = ({ targetMin, targetMax, size = 'md' }: TargetRangeBadgeProps) => {
  if (targetMin == null || targetMax == null) {
    return <span className="text-sm text-gray-400">—</span>;
  }
  return (
    <span
      title="Target negotiation range: 150%–200% of the Medicare all-in rate"
      className={`inline-flex items-center gap-1 rounded-full bg-oe-light text-oe-dark font-semibold ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
      }`}
    >
      {fmt(targetMin)} – {fmt(targetMax)}
    </span>
  );
};

export default TargetRangeBadge;
