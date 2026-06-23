/** Strip UUIDs from commission AI chat text shown to admins (ruleId stays in proposal JSON only). */

const UUID_IN_TEXT_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

export function stripGuidsFromCommissionAiText(
  text: string,
  ruleIdToLabel?: ReadonlyMap<string, string>
): string {
  if (!text?.trim()) return text;
  return text.replace(UUID_IN_TEXT_RE, (uuid) => {
    const key = uuid.toLowerCase();
    return ruleIdToLabel?.get(key) ?? 'that rule';
  });
}
