import type { FieldDef } from '../../../types/publicFormDefinition';

/**
 * Pre-keyed "Member info" palette presets for the member concepts that don't
 * have a dedicated semantic field type (DOB, address, relation, UA tier).
 *
 * The semantic types — first_name / last_name / member_id / email / tel — are
 * already pre-keyed by `newFieldFromPalette`, so they're not duplicated here.
 * Each preset's `field.name` is the canonical key the signed-in prefill matches
 * (see `memberAutofillKeys` / `mapPrefillToInitialValues`).
 */
export type MemberFieldPreset = { id: string; label: string; field: FieldDef };

export const MEMBER_FIELD_PRESETS: readonly MemberFieldPreset[] = [
  {
    id: 'dateOfBirth',
    label: 'Date of birth',
    field: { name: 'dateOfBirth', type: 'date', label: 'Date of birth', required: false, dateDisallowFuture: true }
  },
  {
    id: 'addressLine1',
    label: 'Street address',
    field: { name: 'addressLine1', type: 'text', label: 'Home street address', required: false }
  },
  {
    id: 'addressCity',
    label: 'City',
    field: { name: 'addressCity', type: 'text', label: 'City', required: false }
  },
  {
    id: 'addressState',
    label: 'State',
    field: { name: 'addressState', type: 'text', label: 'State', required: false }
  },
  {
    id: 'addressZip',
    label: 'ZIP code',
    field: { name: 'addressZip', type: 'text', label: 'ZIP code', required: false }
  },
  {
    id: 'relationToPrimary',
    label: 'Relation to primary',
    field: {
      name: 'relationToPrimary',
      type: 'select',
      label: 'Relation to primary member',
      required: false,
      options: [
        { value: 'self', label: 'Self' },
        { value: 'spouse', label: 'Spouse' },
        { value: 'child', label: 'Child' }
      ]
    }
  },
  {
    id: 'uaTier',
    label: 'Unshared Amount tier',
    field: {
      name: 'uaTier',
      type: 'select',
      label: 'Unshared Amount tier',
      required: false,
      options: [
        { value: '1500', label: '$1,500' },
        { value: '2500', label: '$2,500' },
        { value: '5000', label: '$5,000' }
      ]
    }
  }
] as const;
