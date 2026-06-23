// ai_scripts/generate-bounce-reissue-nacha.cjs
//
// One-time remediation script — generates a NACHA file to repay agents whose
// commission ACH credits bounced because of the historical base64 storage bug
// (see backend/services/encryptionService.js#smartDecryptAccountNumber for
// the full write-up).
//
// IMPORTANT — only includes agents whose bounces we are confident were caused
// by the base64 bug and whose stored bank info is otherwise correct. R02
// (Account Closed) bounces and unverified R03 bounces are excluded — those
// agents need outreach to confirm/update their banking before a reissue.
//
// Funding side (file header / batch header) is hard-coded from the working
// APR 16 2026 NACHA file the bank successfully accepted, so the file is
// byte-compatible with what Old Glory has previously processed.
//
// Usage: node ai_scripts/generate-bounce-reissue-nacha.cjs

const path = require('path');
const fs = require('fs');

// We don't need ENCRYPTION_KEY for the included agents — their stored values
// are legacy base64, which smartDecryptAccountNumber handles without any key.
// We pre-decode here and pass plain digits straight into the formatter, so
// nothing inside NACHAService will attempt to AES-decrypt.

const NACHAService = require('../backend/services/NACHAService');
const encryptionService = require('../backend/services/encryptionService');

// ---------------------------------------------------------------------------
// 1. Funding side — copied from the original APR 16 2026 NACHA file header.
// ---------------------------------------------------------------------------
const tenantACHAccount = {
  RoutingNumber: '103113441',
  AccountHolderName: 'MightyWELL',
  BankName: 'Old Glory Bank',
  AccountType: 'Checking'
};
const companyIdentification = '1920966690';

// ---------------------------------------------------------------------------
// 2. Bounced commissions to reissue.
// AccountNumberEncrypted values pulled directly from oe.AgentBankInfo via
// db-query.sh, then run through smartDecryptAccountNumber (the same helper
// the production NACHA path now uses) so the digits we send match exactly
// what production will send going forward.
// ---------------------------------------------------------------------------
const bouncedReissues = [
  {
    label: 'Bethany Demeter',
    agentId: '63BAAE37-4BF1-46F4-8147-3CE4FC4E94FF',
    routingNumber: '082900872',
    accountNumberEncrypted: 'NTI1OTEwNzU=',
    bankName: 'Arvest',
    accountHolderName: 'Bethany Demeter',
    accountType: 'Checking',
    bounces: [
      { date: '2026-04-14', returnCode: 'R03', amount: 128.35 },
      { date: '2026-04-16', returnCode: 'R03', amount: 56.50 }
    ]
  },
  {
    label: 'Elizabeth Patterson',
    agentId: '7651839D-124D-48B3-AD95-6FDE789DF63E',
    routingNumber: '111901519',
    accountNumberEncrypted: 'MjAwMDAxOTQ2OQ==',
    bankName: 'American National Bank of Texas',
    accountHolderName: 'Elizabeth Patterson',
    accountType: 'Checking',
    bounces: [
      { date: '2026-04-14', returnCode: 'R03', amount: 103.50 },
      { date: '2026-04-16', returnCode: 'R03', amount: 152.00 }
    ]
  }
];

// ---------------------------------------------------------------------------
// 3. Decrypt + build the payouts array the formatter expects.
// ---------------------------------------------------------------------------
const payouts = bouncedReissues.map((r) => {
  const accountNumber = encryptionService.smartDecryptAccountNumber(r.accountNumberEncrypted);
  if (!accountNumber || !/^\d{4,17}$/.test(accountNumber)) {
    throw new Error(
      `Decoded account number for ${r.label} failed sanity check: "${accountNumber}"`
    );
  }
  const totalAmount = Number(
    r.bounces.reduce((s, b) => s + b.amount, 0).toFixed(2)
  );
  return {
    entityType: 'Agent',
    entityId: r.agentId,
    entityName: r.label,
    accountHolderName: r.accountHolderName,
    routingNumber: r.routingNumber,
    accountNumber,
    accountType: r.accountType,
    bankName: r.bankName,
    amount: totalAmount,
    _bounces: r.bounces
  };
});

// ---------------------------------------------------------------------------
// 4. Pre-flight summary — print everything before we write the file.
// ---------------------------------------------------------------------------
console.log('\n=== Pre-flight: agents to be paid ===\n');
let grandTotal = 0;
for (const p of payouts) {
  const breakdown = p._bounces
    .map((b) => `${b.date} ${b.returnCode} $${b.amount.toFixed(2)}`)
    .join(' + ');
  console.log(
    `  ${p.entityName.padEnd(22)} routing=${p.routingNumber}  ` +
    `account=${p.accountNumber.padEnd(17)}  total=$${p.amount.toFixed(2)}  ` +
    `(${breakdown})`
  );
  grandTotal += p.amount;
}
console.log(`\n  GRAND TOTAL: $${grandTotal.toFixed(2)}\n`);

// ---------------------------------------------------------------------------
// 5. Generate the NACHA file using the SAME formatter prod uses.
// ---------------------------------------------------------------------------
const nachaContent = NACHAService.formatNACHAFile(payouts, {
  payoutType: 'Agent Commission Payouts',
  tenantACHAccount,
  companyIdentification
});

// 94-char line validation (same check production does).
const lines = String(nachaContent).split(/\r?\n/).filter((l) => l.length > 0);
const badLines = lines
  .map((line, idx) => ({ idx: idx + 1, len: line.length }))
  .filter((x) => x.len !== 94);
if (badLines.length > 0) {
  throw new Error(
    `Invalid NACHA output: ${badLines.length} line(s) are not 94 chars: ` +
      badLines.slice(0, 5).map((x) => `Line ${x.idx} len=${x.len}`).join(', ')
  );
}

// ---------------------------------------------------------------------------
// 6. Write the file.
// ---------------------------------------------------------------------------
const today = new Date();
const yyyy = today.getFullYear();
const mm = String(today.getMonth() + 1).padStart(2, '0');
const dd = String(today.getDate()).padStart(2, '0');
const hhmm =
  String(today.getHours()).padStart(2, '0') +
  String(today.getMinutes()).padStart(2, '0');

const outputDir = path.resolve(__dirname, '../backend/temp/exports/nacha');
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(
  outputDir,
  `BOUNCE_REISSUE_${yyyy}${mm}${dd}_${hhmm}.txt`
);
fs.writeFileSync(outputPath, nachaContent);

console.log(`Wrote ${lines.length} lines (all 94 chars).`);
console.log(`Output: ${outputPath}\n`);

// ---------------------------------------------------------------------------
// 7. Echo the file body so the operator can eyeball it.
// ---------------------------------------------------------------------------
console.log('--- NACHA file contents ---');
console.log(nachaContent);
console.log('--- end ---\n');
