// frontend/src/types/userColor.ts
// User PreferredColor is a free-form #rrggbb hex string. Rendered via inline
// styles (Tailwind can't synthesize classes from runtime hex). Text color is
// chosen by perceived luminance so the label stays readable on any background.

/** Accepted shape from API: a #rrggbb hex string or null. */
export type UserColorHex = string | null | undefined;

export interface UserColorStyle {
  /** Style object to spread onto a span. */
  style: React.CSSProperties;
  /** Fallback Tailwind classes for the no-color case. Empty when style is set. */
  className: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Decide black or white text for the given hex background by luminance. */
const pickTextColor = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // sRGB relative luminance approximation (good enough for chip text).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f2937' /* gray-800 */ : '#ffffff';
};

/**
 * Map a stored PreferredColor value to the styling needed to render a pill.
 * Returns inline style when a valid hex is provided, or neutral fallback
 * classes when not.
 */
export const getUserColorStyle = (color: UserColorHex): UserColorStyle => {
  if (typeof color === 'string' && HEX_RE.test(color)) {
    return {
      style: {
        backgroundColor: color,
        color: pickTextColor(color),
      },
      className: '',
    };
  }
  // No preference set — neutral pill that still reads as a chip.
  return {
    style: {},
    className: 'bg-gray-100 text-gray-700',
  };
};
