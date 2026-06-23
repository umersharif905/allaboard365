import { User } from 'lucide-react';
import { getUserColorStyle } from '../../../types/userColor';

// Soft "who owns this thread" chip. Reuses the same per-user color as the
// share-request claim chips so a person reads as the same color everywhere.
interface Props {
  name?: string | null;
  color?: string | null;
  isMine?: boolean;
  size?: 'sm' | 'md';
}

const OwnerPill = ({ name, color, isMine, size = 'sm' }: Props) => {
  if (!name) return null;
  const { style, className } = getUserColorStyle(color);
  const pad = size === 'md' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]';
  const icon = size === 'md' ? 'h-3 w-3' : 'h-2.5 w-2.5';
  return (
    <span
      style={style}
      className={`inline-flex items-center gap-1 rounded-full font-medium ${pad} ${className}`}
      title={`Owned by ${name}`}
    >
      <User className={icon} aria-hidden />
      {isMine ? 'Me' : name}
    </span>
  );
};

export default OwnerPill;
