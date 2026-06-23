/**
 * Whether the product is configured to use vendor group IDs (Step 1 "Use vendor group ID").
 */
function productUsesVendorGroupId(vendorGroupIdProductType) {
    if (vendorGroupIdProductType == null) return false;
    const t = String(vendorGroupIdProductType).trim();
    return t !== '' && t.toLowerCase() !== 'none';
}

/**
 * Persisted ShowGroupIdOnIDCard bit — only 1 when vendor group IDs are enabled for the product.
 */
function resolveShowGroupIdOnIDCardBit(vendorGroupIdProductType, showGroupIdOnIDCard) {
    if (!productUsesVendorGroupId(vendorGroupIdProductType)) return 0;
    return showGroupIdOnIDCard === true ||
        showGroupIdOnIDCard === 'true' ||
        showGroupIdOnIDCard === 1 ||
        showGroupIdOnIDCard === '1'
        ? 1
        : 0;
}

module.exports = {
    productUsesVendorGroupId,
    resolveShowGroupIdOnIDCardBit
};
