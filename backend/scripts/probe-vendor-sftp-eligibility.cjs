#!/usr/bin/env node
'use strict';

/**
 * Probe vendor eligibility SFTP (connect + optional upload).
 *
 * Usage:
 *   node scripts/probe-vendor-sftp-eligibility.cjs <vendorId> [--file <fileId>]
 *   node scripts/probe-vendor-sftp-eligibility.cjs C34859BA-1B50-4AE8-9A14-2DC7794886A4 --file B6D671F2-FCE0-4D69-ACDD-C321ECA15AD4
 *
 * Loads backend/.env for DB + Azure blob. Does not print passwords.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const VendorExportService = require('../services/vendorExportService');
const sftpClientWrapper = require('../services/sftpClientWrapper');

async function main() {
  const vendorId = process.argv[2];
  const fileIdx = process.argv.indexOf('--file');
  const fileId = fileIdx >= 0 ? process.argv[fileIdx + 1] : null;

  if (!vendorId) {
    console.error('Usage: node scripts/probe-vendor-sftp-eligibility.cjs <vendorId> [--file <fileId>]');
    process.exit(1);
  }

  const vendor = await VendorExportService.getVendorConfig(vendorId);
  if (!vendor) {
    console.error('Vendor not found:', vendorId);
    process.exit(1);
  }

  console.log('Vendor:', vendor.VendorName || vendorId);
  console.log('SFTP host:', vendor.SftpHostname, 'port:', vendor.SftpPort || 22);
  console.log('SFTP user:', vendor.SftpUsername);
  console.log('Has password:', !!vendor.SftpPassword);
  console.log('SftpPathEligibility:', vendor.SftpPathEligibility || '(none)');
  console.log('SftpPath:', vendor.SftpPath || '(none)');

  let connectOpts;
  try {
    connectOpts = VendorExportService.getSftpConnectOptsFromVendor(vendor);
  } catch (e) {
    console.error('Connect opts:', e.message);
    process.exit(1);
  }

  const sftp = sftpClientWrapper.create();
  console.log('\n--- test connect (30s timeout) ---');
  const test = await sftp.testConnect(connectOpts);
  console.log(test);
  if (!test.success) {
    process.exit(2);
  }

  if (!fileId) {
    console.log('\nNo --file; connect-only probe done.');
    process.exit(0);
  }

  console.log('\n--- resolve file + upload ---', fileId);
  try {
    const result = await VendorExportService.uploadEligibilityExportFileToSFTP(vendorId, fileId);
    console.log('Upload OK:', result);
    process.exit(0);
  } catch (e) {
    console.error('Upload failed:', e.message);
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
