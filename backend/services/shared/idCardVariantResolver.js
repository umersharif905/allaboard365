// backend/services/shared/idCardVariantResolver.js
//
// Resolves the correct ID card "variation" for a given vendor network selection.
//
// Products store the default ID card layout at the top level of `IDCardData`
// (Card_Front, Card_Back, DisableIDCard). They optionally also store
// per-network overrides under `IDCardData.NetworkVariations[<vendorNetworkId>]`.
//
// When a member's group has selected a network for the product's vendor, this
// resolver merges that variation onto the default so consumers (member portal,
// admin modal, print views, etc.) see exactly the right card without each one
// having to re-implement the lookup.
//
// Missing fields in the variation always fall through to the default. Pass
// `networkId = null` (or no variation present) to get the default unchanged.

const CARD_BACK_SECTIONS = ['Top_Left', 'Top_Right', 'Middle', 'Bottom_Left', 'Bottom_Right'];

function deepMergeSection(base, override) {
    if (!base && !override) return undefined;
    return { ...(base || {}), ...(override || {}) };
}

/**
 * @param {object|null|undefined} idCardData - parsed `IDCardData` JSON from oe.Products
 * @param {string|null|undefined} networkId - selected vendor network id (or null for default)
 * @returns {object|null} merged ID card layout (no NetworkVariations key)
 */
function resolveIDCardVariant(idCardData, networkId) {
    if (!idCardData || typeof idCardData !== 'object') return idCardData || null;

    // Strip the NetworkVariations key from the response in all cases - consumers should
    // never need it, and leaving it in would leak other variations to the client.
    const { NetworkVariations, ...defaults } = idCardData;

    const variant =
        networkId && NetworkVariations && typeof NetworkVariations === 'object'
            ? NetworkVariations[networkId] || NetworkVariations[String(networkId)]
            : null;

    if (!variant || typeof variant !== 'object') {
        return defaults;
    }

    const merged = {
        ...defaults,
        ...variant,
        DisableIDCard: variant.DisableIDCard !== undefined ? variant.DisableIDCard : defaults.DisableIDCard,
        Card_Front: {
            ...(defaults.Card_Front || {}),
            ...(variant.Card_Front || {}),
            Header: deepMergeSection(defaults.Card_Front?.Header, variant.Card_Front?.Header),
            Footer: deepMergeSection(defaults.Card_Front?.Footer, variant.Card_Front?.Footer)
        },
        Card_Back: CARD_BACK_SECTIONS.reduce((acc, key) => {
            acc[key] = deepMergeSection(defaults.Card_Back?.[key], variant.Card_Back?.[key]);
            return acc;
        }, {})
    };

    // Don't expose other network variations.
    delete merged.NetworkVariations;
    return merged;
}

/**
 * Convenience for code paths that hold a JSON string instead of a parsed object.
 * Returns the merged layout (or null on parse failure).
 */
function resolveIDCardVariantFromJson(jsonString, networkId) {
    if (!jsonString) return null;
    try {
        const parsed = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
        return resolveIDCardVariant(parsed, networkId);
    } catch (e) {
        return null;
    }
}

module.exports = {
    resolveIDCardVariant,
    resolveIDCardVariantFromJson,
    CARD_BACK_SECTIONS
};
