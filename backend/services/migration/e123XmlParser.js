'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => [
    'user', 'dependent', 'product', 'productfee',
    'transaction', 'transactionpayment', 'transactiondetail', 'transactionfee'
  ].includes(name)
});

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (typeof node === 'object' && node['#text'] != null) return String(node['#text']).trim();
  return '';
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_')) continue;
    out[key] = textValue(value);
  }
  return out;
}

function parseUserGetAllResponse(xml) {
  if (!xml || !String(xml).trim()) {
    return { authFailed: true, users: [], dependents: [], products: [], transactions: [], usersTotal: 0 };
  }

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`Failed to parse E123 XML: ${err.message}`);
  }

  const method = parsed?.method || parsed?.Method || {};
  const usersBlock = method.users || method.Users || {};
  const depsBlock = method.dependents || method.Dependents || {};
  const productsBlock = method.products || method.Products || {};
  const transactionsBlock = method.transactions || method.Transactions || {};

  const usersTotal = Number(usersBlock['@_total'] ?? usersBlock['@_Total'] ?? 0);
  const users = asArray(usersBlock.user || usersBlock.User).map(normalizeRecord);
  const dependents = asArray(depsBlock.dependent || depsBlock.Dependent).map(normalizeRecord);
  const products = asArray(productsBlock.product || productsBlock.Product).map((product) => {
    const normalized = normalizeRecord(product);
    const feesBlock = product?.productfees || product?.ProductFees || {};
    const fees = asArray(feesBlock.productfee || feesBlock.ProductFee).map(normalizeRecord);
    normalized.productfees = fees;
    return normalized;
  });
  const transactions = asArray(transactionsBlock.transaction || transactionsBlock.Transaction).map((tx) => {
    const normalized = normalizeRecord(tx);
    const payBlock = tx?.transactionpayments || tx?.TransactionPayments || {};
    normalized.transactionpayments = asArray(
      payBlock.transactionpayment || payBlock.TransactionPayment
    ).map(normalizeRecord);
    const detBlock = tx?.transactiondetails || tx?.TransactionDetails || {};
    normalized.transactiondetails = asArray(
      detBlock.transactiondetail || detBlock.TransactionDetail
    ).map(normalizeRecord);
    return normalized;
  });

  return { authFailed: false, users, dependents, products, transactions, usersTotal };
}

module.exports = {
  parseUserGetAllResponse,
  normalizeRecord,
  asArray,
  textValue
};
