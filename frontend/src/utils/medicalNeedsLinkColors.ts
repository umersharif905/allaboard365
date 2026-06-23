/** Preset keys and helpers for Medical Needs link buttons (member portal + product wizard). */

export function isMedicalNeedsHexColor(s: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(String(s || '').trim());
}

export function medicalNeedsButtonPresetClasses(color: string): string {
  const map: Record<string, string> = {
    teal: 'bg-teal-600 hover:bg-teal-700 text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
    violet: 'bg-violet-600 hover:bg-violet-700 text-white',
    oePrimary: 'bg-oe-primary hover:bg-oe-dark text-white',
    slate: 'bg-slate-600 hover:bg-slate-700 text-white'
  };
  return map[color] || map.teal;
}

/** Small swatch / solid backgrounds (no hover) for settings UI */
export function medicalNeedsPresetSwatchBg(color: string): string {
  const map: Record<string, string> = {
    teal: 'bg-teal-600',
    purple: 'bg-purple-600',
    violet: 'bg-violet-600',
    oePrimary: 'bg-oe-primary',
    slate: 'bg-slate-600'
  };
  return map[color] || map.teal;
}

/** Matches Tailwind presets — for syncing `<input type="color">` when a preset is active */
export const MEDICAL_NEEDS_PRESET_HEX: Record<string, string> = {
  teal: '#0d9488',
  purple: '#9333ea',
  violet: '#7c3aed',
  oePrimary: '#1f8dbf',
  slate: '#475569'
};

export const MEDICAL_NEEDS_PRESETS: { value: string; label: string }[] = [
  { value: 'teal', label: 'Teal' },
  { value: 'purple', label: 'Purple' },
  { value: 'violet', label: 'Violet' },
  { value: 'oePrimary', label: 'Brand' },
  { value: 'slate', label: 'Slate' }
];

export function medicalNeedsColorPickerValue(buttonColor: string): string {
  if (isMedicalNeedsHexColor(buttonColor)) return buttonColor;
  if (buttonColor && MEDICAL_NEEDS_PRESET_HEX[buttonColor]) {
    return MEDICAL_NEEDS_PRESET_HEX[buttonColor];
  }
  return '#1f8dbf';
}
