/**
 * Shared variable substitution for email and SMS templates.
 * Replaces {[variable.name]} placeholders with actual values.
 *
 * Used by: welcomeEmail.service.js, campaignTrigger.service.js, messageCenter routes, groups.js
 */

/**
 * Effective termination date for template `{[member.TerminationDate]}`:
 * `oe.Members.TerminationDate` when set, else latest non-null `oe.Enrollments.TerminationDate` for the member.
 * Embed in SELECT lists (requires alias `m` for Members).
 */
const SQL_MEMBER_EFFECTIVE_TERMINATION_DATE =
  'COALESCE(m.TerminationDate, (SELECT MAX(e.TerminationDate) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.TerminationDate IS NOT NULL))';

/**
 * Format a DB date value for template display (locale date string, empty if invalid/missing).
 * @param {Date|string|number|null|undefined} value
 * @returns {string}
 */
function formatMemberDateForTemplate(value) {
  if (value == null || value === '') return '';
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

/**
 * Substitute template variables in a string.
 * @param {string} str - The template string with {[variable]} placeholders
 * @param {object} context - Context object with member, agent, tenant, group, system data
 * @returns {string} The string with variables replaced
 */
function substituteVariables(str, context) {
  if (!str || typeof str !== 'string') return str;
  let s = str;
  const { member = {}, agent = {}, tenant = {}, group = {}, system = {}, plan = {} } = context;

  // member
  s = s.replace(/\{\[member\.FirstName\]\}/g, member.FirstName || '');
  s = s.replace(/\{\[member\.LastName\]\}/g, member.LastName || '');
  s = s.replace(/\{\[member\.Email\]\}/g, member.Email || '');
  s = s.replace(/\{\[member\.Phone\]\}/g, member.Phone || member.PhoneNumber || '');
  s = s.replace(/\{\[member\.FullName\]\}/g, [member.FirstName, member.LastName].filter(Boolean).join(' ').trim() || '');
  s = s.replace(/\{\[member\.TerminationDate\]\}/g, formatMemberDateForTemplate(member.TerminationDate));

  // agent
  const agentName = [agent.FirstName, agent.LastName].filter(Boolean).join(' ').trim() || agent.Name || '';
  s = s.replace(/\{\[agent\.FirstName\]\}/g, agent.FirstName || '');
  s = s.replace(/\{\[agent\.LastName\]\}/g, agent.LastName || '');
  s = s.replace(/\{\[agent\.Name\]\}/g, agentName);
  s = s.replace(/\{\[agent\.Email\]\}/g, agent.Email || '');
  s = s.replace(/\{\[agent\.Phone\]\}/g, agent.Phone || agent.PhoneNumber || '');

  // tenant
  s = s.replace(/\{\[tenant\.Name\]\}/g, tenant.Name || '');
  s = s.replace(/\{\[tenant\.Email\]\}/g, tenant.Email || '');
  s = s.replace(/\{\[tenant\.Phone\]\}/g, tenant.Phone || tenant.PhoneNumber || '');

  // group
  s = s.replace(/\{\[group\.Name\]\}/g, group.Name || '');

  // plan (the product/plan name; populated for triggers tied to a specific plan, e.g. PlanTermination)
  s = s.replace(/\{\[plan\.Name\]\}/g, plan.Name || '');

  // system
  const currentDate = new Date().toLocaleDateString();
  const currentYear = new Date().getFullYear().toString();
  s = s.replace(/\{\[system\.CurrentDate\]\}/g, currentDate);
  s = s.replace(/\{\[system\.CurrentYear\]\}/g, currentYear);
  s = s.replace(/\{\[system\.CurrentMonth\]\}/g, new Date().toLocaleString('default', { month: 'long' }));
  s = s.replace(/\{\[system\.LoginUrl\]\}/g, system.LoginUrl || process.env.LOGIN_URL || process.env.FRONTEND_URL || '');

  return s;
}

module.exports = {
  substituteVariables,
  formatMemberDateForTemplate,
  SQL_MEMBER_EFFECTIVE_TERMINATION_DATE
};
