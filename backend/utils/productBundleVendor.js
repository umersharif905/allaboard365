'use strict';

function isBundleProductFlag(isBundle) {
  return isBundle === true || isBundle === 'true' || isBundle === 1 || isBundle === '1';
}

/** Bundles are tenant-owned — never persist a VendorId. */
function resolveProductVendorId(isBundle, vendorId) {
  if (isBundleProductFlag(isBundle)) return null;
  return vendorId || null;
}

module.exports = {
  isBundleProductFlag,
  resolveProductVendorId,
};
