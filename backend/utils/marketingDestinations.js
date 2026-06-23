'use strict';

/**
 * Allowed marketing-link destination types. Agents pick one of these base URLs
 * when creating website/landing prospect sources.
 */
const VALID_DESTINATION_TYPES = ['website', 'landing'];

/**
 * Sanitize a raw `marketingLink.destinations` array coming from a settings save.
 *
 * Rules (mirrors the client-side trim/filter in the tenant settings modal):
 * - Input must be an array; anything else yields [].
 * - Each entry must be an object.
 * - `type` must be one of 'website' | 'landing' (invalid entries are dropped).
 * - `url` is trimmed and must be a non-empty string (otherwise the entry is dropped).
 * - `label` is trimmed (may be empty).
 *
 * @param {unknown} raw
 * @returns {Array<{ type: string, label: string, url: string }>}
 */
function sanitizeMarketingDestinations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d) => d && typeof d === 'object')
    .map((d) => ({
      type: typeof d.type === 'string' ? d.type.trim() : '',
      label: typeof d.label === 'string' ? d.label.trim() : '',
      url: typeof d.url === 'string' ? d.url.trim() : ''
    }))
    .filter((d) => VALID_DESTINATION_TYPES.includes(d.type) && d.url.length > 0);
}

/**
 * Normalize the `marketingLink` block of an AdvancedSettings object in place,
 * adding a sanitized `destinations` array alongside the existing `idParam` and
 * `links`. Returns the same object for convenience. No-op when there is no
 * marketingLink block to update.
 *
 * @param {Record<string, any>} advancedSettings
 * @returns {Record<string, any>}
 */
function normalizeMarketingLinkDestinations(advancedSettings) {
  if (!advancedSettings || typeof advancedSettings !== 'object') return advancedSettings;
  const ml = advancedSettings.marketingLink;
  if (!ml || typeof ml !== 'object') return advancedSettings;
  ml.destinations = sanitizeMarketingDestinations(ml.destinations);
  return advancedSettings;
}

module.exports = {
  VALID_DESTINATION_TYPES,
  sanitizeMarketingDestinations,
  normalizeMarketingLinkDestinations
};
