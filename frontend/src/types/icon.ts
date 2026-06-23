import type { ComponentType, SVGProps } from 'react';

// Structural alias for any lucide-react icon component. We don't reach for
// `LucideIcon` from lucide-react because in this project's tsconfig it
// resolves as a namespace, not a usable type. See
// docs/solutions/build-errors/lucide-react-icon-type-import.md for context.
export type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { className?: string }
>;
