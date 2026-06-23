/**
 * Maps a server-built prefill payload (keyed by well-known concept names like
 * `firstName`, `dateOfBirth`, `addressZip`) onto a form's actual field names.
 *
 * Matching per field: semantic field `type` (first_name/last_name/email/tel/
 * member_id), else exact field `name`. Forms autofill demographic fields by
 * naming them with the canonical key (e.g. `dateOfBirth`) — see
 * memberAutofillKeys and the form-builder affordance.
 *
 * Shared by the public-form autofill (PublicFormPage) and the authenticated
 * invitation flow (InvitationFormPage); kept standalone so it can be unit
 * tested without importing a page (which instantiates ApiService at load).
 */
export function mapPrefillToInitialValues(
  definition: { fields?: Array<{ name: string; type: string }> },
  prefill: Record<string, string | null>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of definition.fields || []) {
    const v = (() => {
      switch (f.type) {
        case 'first_name': return prefill.firstName;
        case 'last_name': return prefill.lastName;
        case 'email': return prefill.email;
        case 'tel': return prefill.phone;
        case 'member_id': return prefill.memberId;
        default: return prefill[f.name];
      }
    })();
    if (v != null) out[f.name] = v;
  }
  return out;
}
