// Shared status badge styling for prospects.
import { ProspectStatus } from '../../services/prospect.service';

export function statusBadgeClass(status: ProspectStatus): string {
  switch (status) {
    case 'New':
      return 'bg-gray-100 text-gray-700';
    case 'Contacted':
      return 'bg-oe-light text-oe-dark';
    case 'Proposal Sent':
      return 'bg-yellow-100 text-yellow-800';
    case 'Closed':
      return 'bg-green-100 text-green-800';
    case 'Lost':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

// Tag color palette — ordered for the color picker UI.
export type TagColorKey = 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink';

export const TAG_COLOR_PALETTE: TagColorKey[] = [
  'gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink',
];

/** Returns Tailwind chip classes for a tag color key (falls back to gray). */
export function tagChipClass(color: string): string {
  switch (color as TagColorKey) {
    case 'red':    return 'bg-red-100 text-red-800';
    case 'orange': return 'bg-orange-100 text-orange-800';
    case 'amber':  return 'bg-amber-100 text-amber-800';
    case 'green':  return 'bg-green-100 text-green-800';
    case 'teal':   return 'bg-teal-100 text-teal-800';
    case 'blue':   return 'bg-blue-100 text-blue-800';
    case 'indigo': return 'bg-indigo-100 text-indigo-800';
    case 'purple': return 'bg-purple-100 text-purple-800';
    case 'pink':   return 'bg-pink-100 text-pink-800';
    case 'gray':
    default:       return 'bg-gray-100 text-gray-700';
  }
}

/** Returns a swatch background color class for the color picker dot. */
export function tagSwatchClass(color: string): string {
  switch (color as TagColorKey) {
    case 'red':    return 'bg-red-400';
    case 'orange': return 'bg-orange-400';
    case 'amber':  return 'bg-amber-400';
    case 'green':  return 'bg-green-400';
    case 'teal':   return 'bg-teal-400';
    case 'blue':   return 'bg-blue-400';
    case 'indigo': return 'bg-indigo-400';
    case 'purple': return 'bg-purple-400';
    case 'pink':   return 'bg-pink-400';
    case 'gray':
    default:       return 'bg-gray-400';
  }
}
