interface SkeletonProps {
  className?: string;
  rounded?: 'sm' | 'md' | 'lg' | 'full';
}

const ROUND: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  sm: 'rounded',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
};

// Inject the calm pulse keyframes once. Done as a module-level style tag so
// the animation works without any tailwind config changes.
const ANIM_NAME = 'oeSkeletonPulse';
if (typeof document !== 'undefined' && !document.getElementById(`${ANIM_NAME}-style`)) {
  const style = document.createElement('style');
  style.id = `${ANIM_NAME}-style`;
  style.textContent = `@keyframes ${ANIM_NAME} { 0%,100% { opacity: 1 } 50% { opacity: 0.78 } }`;
  document.head.appendChild(style);
}

const PULSE_STYLE: React.CSSProperties = {
  animation: `${ANIM_NAME} 1.6s ease-in-out infinite`,
};

// Calm, opacity-only skeleton. No moving gradients, no transforms. Fixed
// footprint so layout never shifts while loading.
const Skeleton = ({ className = 'h-4 w-full', rounded = 'md' }: SkeletonProps) => (
  <div
    aria-hidden="true"
    style={PULSE_STYLE}
    className={`bg-gray-200/70 ${ROUND[rounded]} ${className}`}
  />
);

interface SkeletonRowsProps {
  count?: number;
  rowClassName?: string;
  className?: string;
}

export const SkeletonRows = ({
  count = 5,
  rowClassName = 'h-10',
  className = 'space-y-2',
}: SkeletonRowsProps) => (
  <div className={className}>
    {Array.from({ length: count }).map((_, i) => (
      <Skeleton key={i} className={`w-full ${rowClassName}`} />
    ))}
  </div>
);

export default Skeleton;
