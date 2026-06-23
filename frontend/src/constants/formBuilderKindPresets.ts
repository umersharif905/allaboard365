const CUSTOM_KIND_RE = /^K_[0-9a-f]{32}$/i;

/** Prefer stored KindLabel; otherwise legacy “Custom form” for internal K_* kinds, else FormKind. */
export function displayFormKindLabel(kindLabel: string | null | undefined, formKind: string): string {
  const kl = kindLabel?.trim();
  if (kl) return kl;
  if (CUSTOM_KIND_RE.test(formKind)) return 'Custom form';
  return formKind;
}
