import type { ComponentType } from 'react';
import {
  AlignLeft,
  Calendar,
  ChevronDown,
  CircleDot,
  Code,
  Hash,
  Link2,
  ListChecks,
  Mail,
  Paperclip,
  PenLine,
  Phone,
  Pilcrow,
  ScrollText,
  Stethoscope,
  Type,
  User
} from 'lucide-react';
import type { PaletteFieldType } from '../../../types/publicFormDefinition';
import { MEMBER_FIELD_PRESETS, type MemberFieldPreset } from './memberFieldPresets';

type FieldIcon = ComponentType<{ className?: string }>;

const FIELD_META: Record<PaletteFieldType, { label: string; icon: FieldIcon }> = {
  text: { label: 'Text', icon: Type },
  email: { label: 'Email', icon: Mail },
  tel: { label: 'Phone', icon: Phone },
  first_name: { label: 'First name', icon: User },
  last_name: { label: 'Last name', icon: User },
  member_id: { label: 'Member ID', icon: Hash },
  date: { label: 'Date', icon: Calendar },
  textarea: { label: 'Long text', icon: AlignLeft },
  paragraph: { label: 'Paragraph', icon: Pilcrow },
  static_html: { label: 'Content block', icon: Code },
  select: { label: 'Dropdown', icon: ChevronDown },
  radio: { label: 'Radio group', icon: CircleDot },
  checkbox_group: { label: 'Checkboxes', icon: ListChecks },
  terms: { label: 'Terms', icon: ScrollText },
  file: { label: 'Files', icon: Paperclip },
  signature: { label: 'Signature', icon: PenLine },
  provider_search: { label: 'Provider search', icon: Stethoscope },
  anatomy_surgery: { label: 'Procedure selector', icon: Stethoscope }
};

const GROUPS: { title: string; types: PaletteFieldType[] }[] = [
  {
    title: 'Basic',
    types: ['text', 'email', 'tel', 'first_name', 'last_name', 'member_id', 'date', 'textarea', 'paragraph']
  },
  { title: 'Content', types: ['static_html'] },
  { title: 'Choices', types: ['select', 'radio', 'checkbox_group'] },
  { title: 'Legal & files', types: ['terms', 'file', 'signature'] },
  { title: 'Healthcare', types: ['provider_search', 'anatomy_surgery'] }
];

/**
 * Compact field palette — a 2-column grid of icon + label tiles, grouped.
 * Replaces the old tall vertical list of full-width buttons.
 */
export function FieldPalette({
  onAdd,
  onAddMember
}: {
  onAdd: (type: PaletteFieldType) => void;
  onAddMember: (preset: MemberFieldPreset) => void;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Add field</h3>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">
          Member info (autofills when signed in)
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {MEMBER_FIELD_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onAddMember(preset)}
              title={`Add ${preset.label} (autofills from member account)`}
              className="flex flex-col items-center justify-center gap-1 rounded-md border border-oe-light bg-oe-light/30 px-1 py-2 text-center transition-colors hover:border-oe-primary hover:bg-oe-light/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary"
            >
              <Link2 className="h-4 w-4 text-oe-dark" />
              <span className="text-[10px] leading-tight text-gray-600">{preset.label}</span>
            </button>
          ))}
        </div>
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="space-y-1.5">
          <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{g.title}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {g.types.map((type) => {
              const { label, icon: Icon } = FIELD_META[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => onAdd(type)}
                  title={`Add ${label}`}
                  className="flex flex-col items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-1 py-2 text-center transition-colors hover:border-oe-primary hover:bg-oe-light/40 active:bg-oe-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oe-primary"
                >
                  <Icon className="h-4 w-4 text-gray-500" />
                  <span className="text-[10px] leading-tight text-gray-600">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-gray-400 leading-snug pt-2 border-t border-gray-100">
        Required file fields are enforced in the browser only.
      </p>
    </div>
  );
}
