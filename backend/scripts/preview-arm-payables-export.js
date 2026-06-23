#!/usr/bin/env node
/**
 * Preview ARM payables CSV header + totals for a NACHA (compare to ARM_payables_YYYYMMDD.csv).
 * Usage:
 *   node scripts/preview-arm-payables-export.js <nachaId> [--testing]
 * Env: loads ai_scripts/.env; --testing uses allaboard-testing + DB_USER_TESTING_RW.
 */
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '../../ai_scripts/.env');
if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
    }
}

const useTesting = process.argv.includes('--testing');
if (useTesting) {
    process.env.DB_NAME = 'allaboard-testing';
    if (process.env.DB_USER_TESTING_RW) process.env.DB_USER = process.env.DB_USER_TESTING_RW;
    if (process.env.DB_PASSWORD_TESTING_RW) process.env.DB_PASSWORD = process.env.DB_PASSWORD_TESTING_RW;
}

const nachaId = process.argv.find((a) => a && !a.startsWith('-') && a !== process.argv[1] && a !== process.argv[0]);
const ARM_VENDOR = '406B4EEA-F334-4EFC-82D5-89545E55CC01';

if (!nachaId) {
    console.error('Usage: node scripts/preview-arm-payables-export.js <nachaId> [--testing]');
    process.exit(1);
}

const VendorExportService = require('../services/vendorExportService');

(async () => {
    const vendor = await VendorExportService.getVendorConfig(ARM_VENDOR);
    const tpl = (vendor.PayablesRowTemplate || '').trim() || VendorExportService.getDefaultPayablesTemplate();
    console.log('DB:', process.env.DB_NAME);
    console.log('PayablesRowTemplate in DB:', vendor.PayablesRowTemplate ? `${vendor.PayablesRowTemplate.slice(0, 80)}...` : '(null → server default)');
    console.log('Effective template:', tpl.slice(0, 120) + (tpl.length > 120 ? '...' : ''));

    const { rows, paidThroughStart, paidThroughEnd, nachaPayout, allocationWarnings } =
        await VendorExportService.fetchPayablesRowsForNacha(nachaId, ARM_VENDOR);
    const { csv, total, contractTotal, paidTotal, varianceTotal } = VendorExportService.formatPayablesCSV(
        rows,
        vendor,
        paidThroughStart,
        paidThroughEnd,
        { nachaPayoutNet: nachaPayout }
    );
    const lines = csv.split('\n').filter(Boolean);
    console.log(
        'Rows in:', rows.length,
        '| Member lines out:', lines.length - 2,
        '| NACHA payout:', nachaPayout,
        '| Contract total:', contractTotal ?? total,
        '| Paid total:', paidTotal,
        '| Variance total:', varianceTotal
    );
    console.log('Header:', lines[0]);
    if (lines[1]) console.log('First data:', lines[1]);
    if (lines.length > 2) console.log('Last data:', lines[lines.length - 2]);
    console.log('Footer:', lines[lines.length - 1]);
    if (allocationWarnings?.length) console.log('Allocation warnings:', allocationWarnings.length);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
