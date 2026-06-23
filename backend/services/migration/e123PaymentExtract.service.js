'use strict';

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** E123 masked payloads are often last-4-only (4 digits) or contain mask characters. */
const MIN_ACH_ACCOUNT_DIGITS = 5;

function hasMaskCharacters(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  return /[*xX#]/.test(raw);
}

function isUsableAchAccount(rawAccount, accountDigits) {
  const account = accountDigits ?? digitsOnly(rawAccount);
  if (hasMaskCharacters(rawAccount)) return false;
  return account.length >= MIN_ACH_ACCOUNT_DIGITS;
}

function isUsableCreditCardPan(rawPan, panDigits) {
  const pan = panDigits ?? digitsOnly(rawPan);
  if (hasMaskCharacters(rawPan)) return false;
  return pan.length >= 13 && pan.length <= 19;
}

function normalizePayType(paytype, tp) {
  const p = String(paytype || tp?.paytype || '').trim().toUpperCase();
  if (p === 'CC' || p.includes('CREDIT') || p.includes('CARD')) return 'CreditCard';
  if (p === 'ACH' || p === 'CK' || p === 'CHECK' || p === 'ECHECK') return 'ACH';
  if (tp?.cctype || tp?.cardtype || tp?.ccnum) return 'CreditCard';
  if (tp?.ckaba || tp?.ckacc) return 'ACH';
  return null;
}

function parseTransactionDate(tx) {
  const raw = tx.transdate || tx.dtcreated || tx.dtsettled || '';
  const d = new Date(String(raw).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function isDeletedFlag(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'y';
}

function normalizeExpiryYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year) || year <= 0) return null;
  if (year >= 2000) return year;
  if (year <= 99) return 2000 + year;
  return null;
}

function extractPaymentFromTransactionPayment(tp, txPaytype) {
  const payType = normalizePayType(txPaytype, tp);
  const cardholderName = [tp.firstname, tp.lastname].filter(Boolean).join(' ').trim()
    || String(tp.name || '').trim()
    || null;

  if (payType === 'CreditCard') {
    const ccnum = digitsOnly(tp.ccnum);
    if (!isUsableCreditCardPan(tp.ccnum, ccnum)) return null;
    const last4 = digitsOnly(tp.cclast4);
    if (last4 && ccnum.slice(-4) !== last4) return null;

    const expMonth = Number(tp.ccexpm);
    return {
      paymentMethodType: 'CreditCard',
      cardNumber: ccnum,
      cardBrand: tp.cctype || tp.cardtype || null,
      expiryMonth: expMonth >= 1 && expMonth <= 12 ? expMonth : null,
      expiryYear: normalizeExpiryYear(tp.ccexpy),
      cardholderName,
      billingAddress: tp.address || null,
      billingCity: tp.city || null,
      billingState: tp.state || null,
      billingZip: tp.zip || null,
      billingCountry: tp.country || 'US',
      sourceE123Tpid: tp.tpid || null,
      sourceE123TransId: tp.transid || null
    };
  }

  if (payType === 'ACH') {
    const routing = digitsOnly(tp.ckaba);
    const account = digitsOnly(tp.ckacc);
    if (routing.length !== 9 || !isUsableAchAccount(tp.ckacc, account)) return null;
    const accountTypeRaw = String(tp.ckaccounttype || '').trim().toLowerCase();
    const accountType = accountTypeRaw.includes('sav') ? 'Savings' : 'Checking';
    return {
      paymentMethodType: 'ACH',
      routingNumber: routing,
      accountNumber: account,
      accountType,
      accountHolderName: cardholderName,
      bankName: tp.ckbankname || tp.bankname || null,
      billingAddress: tp.address || null,
      billingCity: tp.city || null,
      billingState: tp.state || null,
      billingZip: tp.zip || null,
      billingCountry: tp.country || 'US',
      sourceE123Tpid: tp.tpid || null,
      sourceE123TransId: tp.transid || null
    };
  }

  return null;
}

function hasMaskedPaymentHint(transactions, userId) {
  const uid = String(userId || '');
  for (const tx of transactions || []) {
    if (String(tx.userid || '') !== uid || isDeletedFlag(tx.bdeleted)) continue;
    for (const tp of tx.transactionpayments || []) {
      const payType = normalizePayType(tx.paytype, tp);
      if (payType === 'CreditCard' && digitsOnly(tp.cclast4) && !isUsableCreditCardPan(tp.ccnum)) return true;
      if (payType === 'ACH' && (tp.ckaba || tp.ckacc) && (
        digitsOnly(tp.ckaba).length !== 9 || !isUsableAchAccount(tp.ckacc)
      )) return true;
    }
  }
  return false;
}

function pickBestPaymentForUser(transactions, userId) {
  const uid = String(userId || '');
  const userTx = (transactions || [])
    .filter((tx) => String(tx.userid || '') === uid && !isDeletedFlag(tx.bdeleted));

  userTx.sort((a, b) => parseTransactionDate(b) - parseTransactionDate(a));

  for (const tx of userTx) {
    for (const tp of tx.transactionpayments || []) {
      const extracted = extractPaymentFromTransactionPayment(tp, tx.paytype);
      if (extracted) return extracted;
    }
  }
  return null;
}

function computeFetchCoverageStats(households) {
  let primarySsnCount = 0;
  let dependentSsnCount = 0;
  let dependentCount = 0;
  let paymentMethodCount = 0;
  let paymentMaskedOnly = 0;

  for (const hh of households || []) {
    if (hh.primary?.ssn) primarySsnCount += 1;
    for (const dep of hh.dependents || []) {
      dependentCount += 1;
      if (dep.ssn) dependentSsnCount += 1;
    }
    if (hh.paymentMethod?.paymentMethodType) paymentMethodCount += 1;
    else if (hh.paymentMethodMeta?.maskedOnly) paymentMaskedOnly += 1;
  }

  return {
    householdCount: households?.length || 0,
    primarySsnCount,
    dependentCount,
    dependentSsnCount,
    paymentMethodCount,
    paymentMaskedOnly
  };
}

module.exports = {
  pickBestPaymentForUser,
  extractPaymentFromTransactionPayment,
  hasMaskedPaymentHint,
  computeFetchCoverageStats,
  isUsableAchAccount,
  isUsableCreditCardPan,
  hasMaskCharacters,
  MIN_ACH_ACCOUNT_DIGITS
};
