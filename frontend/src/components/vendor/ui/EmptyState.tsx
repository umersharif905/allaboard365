import type { ComponentType, ReactNode, SVGProps } from 'react';

interface EmptyStateProps {
  icon: ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;
  title: string;
  description?: string;
  tone?: 'default' | 'subtle' | 'error';
  action?: ReactNode;
  className?: string;
}

const TONE = {
  default: {
    halo: 'bg-oe-light',
    icon: 'text-oe-primary',
  },
  subtle: {
    halo: 'bg-gray-100',
    icon: 'text-gray-400',
  },
  error: {
    halo: 'bg-red-50',
    icon: 'text-red-500',
  },
};

const EmptyState = ({
  icon: Icon,
  title,
  description,
  tone = 'subtle',
  action,
  className = '',
}: EmptyStateProps) => {
  const t = TONE[tone];
  return (
    <div
      className={`flex flex-col items-center justify-center text-center py-16 px-6 animate-fade-in-fast ${className}`}
    >
      <div className={`relative mb-4`}>
        <div className={`absolute inset-0 rounded-full blur-xl opacity-60 ${t.halo}`} />
        <div className={`relative h-16 w-16 rounded-full ${t.halo} flex items-center justify-center`}>
          <Icon className={`h-8 w-8 ${t.icon}`} />
        </div>
      </div>
      <h2 className="text-base font-semibold text-gray-900 mb-1">{title}</h2>
      {description && (
        <p className="text-sm text-gray-500 max-w-sm leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
};

export default EmptyState;
