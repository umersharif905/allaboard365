/**
 * Canonical field keys that a signed-in member's profile autofills.
 *
 * Autofill on the public forms is driven by the field's KEY (`FieldDef.name`)
 * matching one of these — see `mapPrefillToInitialValues` (exact-name + semantic
 * type) and the prefill payload built by
 * `backend/services/publicFormInvitationPrefillService.js`. Keep this list in
 * sync with that payload's keys.
 *
 * This is the single source of truth for:
 *   - the "Autofills from member account" dropdown in FieldInspector, and
 *   - the pre-keyed "Member info" palette defaults.
 */
export type MemberAutofillField = {
  /** The canonical field key to write into FieldDef.name. */
  key: string;
  /** Human label shown in the builder affordance. */
  label: string;
};

export const MEMBER_AUTOFILL_FIELDS: readonly MemberAutofillField[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'dateOfBirth', label: 'Date of birth' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'memberId', label: 'Member ID' },
  { key: 'addressLine1', label: 'Street address' },
  { key: 'addressCity', label: 'City' },
  { key: 'addressState', label: 'State' },
  { key: 'addressZip', label: 'ZIP code' },
  { key: 'relationToPrimary', label: 'Relation to primary member' },
  { key: 'uaTier', label: 'Unshared Amount tier' }
] as const;

const KEY_TO_LABEL = new Map(MEMBER_AUTOFILL_FIELDS.map((f) => [f.key, f.label]));

/** True when a field key is one the member profile autofills. */
export function isMemberAutofillKey(key: string | undefined | null): boolean {
  return !!key && KEY_TO_LABEL.has(key);
}

/** Human label for a canonical key, or null if it isn't one. */
export function memberAutofillLabel(key: string | undefined | null): string | null {
  if (!key) return null;
  return KEY_TO_LABEL.get(key) ?? null;
}
