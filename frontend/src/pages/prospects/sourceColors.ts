// Soft pastel label palette for prospect sources. Keys are stored in the DB.
export interface SourceColorDef { key: string; label: string; chip: string; dot: string; }
export const SOURCE_COLORS: SourceColorDef[] = [
  { key: 'slate',  label: 'Slate',  chip: 'bg-slate-100 text-slate-700 border-slate-200',   dot: 'bg-slate-300' },
  { key: 'rose',   label: 'Rose',   chip: 'bg-rose-100 text-rose-700 border-rose-200',       dot: 'bg-rose-300' },
  { key: 'peach',  label: 'Peach',  chip: 'bg-orange-100 text-orange-700 border-orange-200', dot: 'bg-orange-300' },
  { key: 'amber',  label: 'Amber',  chip: 'bg-amber-100 text-amber-700 border-amber-200',    dot: 'bg-amber-300' },
  { key: 'green',  label: 'Sage',   chip: 'bg-green-100 text-green-700 border-green-200',     dot: 'bg-green-300' },
  { key: 'teal',   label: 'Teal',   chip: 'bg-teal-100 text-teal-700 border-teal-200',        dot: 'bg-teal-300' },
  { key: 'sky',    label: 'Sky',    chip: 'bg-sky-100 text-sky-700 border-sky-200',           dot: 'bg-sky-300' },
  { key: 'indigo', label: 'Periwinkle', chip: 'bg-indigo-100 text-indigo-700 border-indigo-200', dot: 'bg-indigo-300' },
  { key: 'purple', label: 'Lilac',  chip: 'bg-purple-100 text-purple-700 border-purple-200', dot: 'bg-purple-300' },
  { key: 'pink',   label: 'Pink',   chip: 'bg-pink-100 text-pink-700 border-pink-200',        dot: 'bg-pink-300' },
];
export const getSourceColor = (key?: string | null) => SOURCE_COLORS.find((c) => c.key === key) || null;
