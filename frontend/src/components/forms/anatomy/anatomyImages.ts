// Reference images shown beside the numbered selector list (until clickable
// SVGs are added to svgRegistry.ts). Drop the 5 pictures into
// frontend/public/anatomy/ with these names — or edit the URLs here.
// White-background PNG/JPG is fine. Files are served statically, so swapping
// them needs no rebuild.
export const ANATOMY_IMAGES: Record<string, string | undefined> = {
  overview: '/anatomy/body.png',
  head: '/anatomy/head.png',
  torso: '/anatomy/torso.png',
  arm: '/anatomy/arms.png',
  leg: '/anatomy/legs.png',
};

// Per-view color order (1-indexed by the sub-region's position in the taxonomy).
// These match the numbers/colors drawn on the reference images so a member can
// match the list entry to the highlighted spot on the picture.
export const VIEW_REGION_COLORS: Record<string, string[]> = {
  overview: ['purple', 'red', 'orange', 'green'],
  head: ['purple', 'orange', 'green', 'pink', 'blue'],
  torso: ['red', 'pink', 'green', 'yellow', 'cyan', 'purple'],
  arm: ['orange', 'green', 'blue'],
  leg: ['purple', 'cyan', 'green', 'orange'],
};

// Literal Tailwind classes (kept literal so they survive content purging).
export const COLOR_BADGE_BG: Record<string, string> = {
  purple: 'bg-purple-500',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  green: 'bg-green-500',
  pink: 'bg-pink-500',
  blue: 'bg-blue-500',
  yellow: 'bg-yellow-500',
  cyan: 'bg-cyan-500',
  gray: 'bg-gray-400',
};
