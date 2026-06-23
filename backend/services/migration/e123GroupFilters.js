'use strict';

/**
 * Filters E123 View Groups rows down to importable employer list-bill groups.
 *
 * View Groups export alone is not enough — Copy Over buckets and org placeholders
 * also appear there with BGROUP=1 / BGROUPLISTBILL=1.
 */

const COPY_OVER_PATTERN = /\bcopy over\b/i;

/** Org/agency stubs that are not employer groups (ShareWELL-specific labels). */
const ORG_PLACEHOLDER_PATTERNS = [
  /^sharewell partners$/i,
  /^align health$/i,
  /^ella group$/i
];

const EXCLUSION_MESSAGES = {
  copy_over_bucket: 'Copy Over migration bucket — not an employer group',
  org_placeholder: 'Org/agency placeholder — not an employer group',
  zero_members: 'No enrolled members on this group node',
  selling_agent_not_listbill: 'Not a list-bill group (BGROUP/BGROUPLISTBILL)',
  agent_unmapped: 'Agent not mapped — run Agent Migration first'
};

/**
 * @returns {{ include: boolean, reason: string|null }}
 */
function classifyEmployerGroupRow({ label, memberCount, bgroup = null, bgrouplistbill = null }) {
  const l = String(label || '').trim();

  if (COPY_OVER_PATTERN.test(l)) {
    return { include: false, reason: 'copy_over_bucket' };
  }

  for (const pattern of ORG_PLACEHOLDER_PATTERNS) {
    if (pattern.test(l)) {
      return { include: false, reason: 'org_placeholder' };
    }
  }

  if (bgroup === 0 || bgrouplistbill === 0) {
    return { include: false, reason: 'selling_agent_not_listbill' };
  }

  if (Number(memberCount) <= 0) {
    return { include: false, reason: 'zero_members' };
  }

  return { include: true, reason: 'employer_group' };
}

function getEmployerGroupExclusionMessage(reason) {
  if (!reason) return null;
  return EXCLUSION_MESSAGES[reason] || null;
}

function getGroupMigrationExclusionMessage(excludeReason) {
  return getEmployerGroupExclusionMessage(excludeReason)
    || EXCLUSION_MESSAGES.agent_unmapped;
}

module.exports = {
  COPY_OVER_PATTERN,
  ORG_PLACEHOLDER_PATTERNS,
  EXCLUSION_MESSAGES,
  classifyEmployerGroupRow,
  getEmployerGroupExclusionMessage,
  getGroupMigrationExclusionMessage
};
