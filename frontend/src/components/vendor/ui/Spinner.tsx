interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

const SIZE: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'h-3 w-3 border',
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-2',
};

const Spinner = ({ size = 'sm', className = '', label }: SpinnerProps) => (
  <span
    role="status"
    aria-label={label ?? 'Loading'}
    className={`inline-block ${SIZE[size]} rounded-full border-current border-t-transparent animate-spin ${className}`}
  />
);

export default Spinner;
