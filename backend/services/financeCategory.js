// services/financeCategory.js
//
// Single source of truth that normalizes Share Request transaction "types"
// (free-text NVarChar on oe.ShareRequestTransactions) into a small, stable set
// of categories. The back office reduced the offered types down to a clean set
// in 2026-05 (see docs/billing-rework), but historical rows still carry the old
// strings. Everything that aggregates money — the finance-summary service, the
// vendor dashboard, and any future AI/report layer — should key off the
// categories here instead of matching raw type strings, so old and new data
// roll up identically.

// Canonical categories.
const CATEGORY = Object.freeze({
  PAYMENT_TO_PROVIDER: 'payment_to_provider',
  MEMBER_PAYMENT: 'member_payment',
  UA_PAYMENT: 'ua_payment',
  UA_REDUCTION: 'ua_reduction',
  REIMBURSEMENT: 'reimbursement',
  DISCOUNT: 'discount',
  FINANCIAL_AID: 'financial_aid',
  OTHER: 'other',
});

// Money direction relative to the share request, for reporting:
//   out        – money paid out (to provider, or back to the member)
//   in         – money received from the member toward their responsibility
//   adjustment – a reduction in what is owed (not cash movement)
const DIRECTION = Object.freeze({
  out: 'out',
  in: 'in',
  adjustment: 'adjustment',
});

// Current (post-2026-05) transaction types offered in the UI.
const CURRENT_TYPES = Object.freeze([
  'Payment to Provider',
  'Member Payment',
  'UA Payment',
  'UA Reduction',
  'Reimbursement',
  'Discount',
  'Financial Aid',
]);

// type string -> category. Includes legacy strings for backward compatibility.
// Legacy "Discount from Emry FA" is mapped to financial_aid (it always was
// financial assistance); "Discount from Emry RBP" and "Negotiation" are plain
// discounts.
const TYPE_TO_CATEGORY = Object.freeze({
  'Payment to Provider': CATEGORY.PAYMENT_TO_PROVIDER,
  'Member Payment': CATEGORY.MEMBER_PAYMENT,
  'UA Payment': CATEGORY.UA_PAYMENT,
  'UA Reduction': CATEGORY.UA_REDUCTION,
  'Reimbursement': CATEGORY.REIMBURSEMENT,
  'Discount': CATEGORY.DISCOUNT,
  'Financial Aid': CATEGORY.FINANCIAL_AID,
  // ---- legacy ----
  'Discount from Provider': CATEGORY.DISCOUNT,
  'Discount from Emry RBP': CATEGORY.DISCOUNT,
  'Negotiation': CATEGORY.DISCOUNT,
  'Discount from Emry FA': CATEGORY.FINANCIAL_AID,
});

const CATEGORY_TO_DIRECTION = Object.freeze({
  [CATEGORY.PAYMENT_TO_PROVIDER]: DIRECTION.out,
  [CATEGORY.REIMBURSEMENT]: DIRECTION.out,
  [CATEGORY.MEMBER_PAYMENT]: DIRECTION.in,
  [CATEGORY.UA_PAYMENT]: DIRECTION.in,
  [CATEGORY.UA_REDUCTION]: DIRECTION.adjustment,
  [CATEGORY.DISCOUNT]: DIRECTION.adjustment,
  [CATEGORY.FINANCIAL_AID]: DIRECTION.adjustment,
  [CATEGORY.OTHER]: DIRECTION.adjustment,
});

function categoryOf(transactionType) {
  return TYPE_TO_CATEGORY[transactionType] || CATEGORY.OTHER;
}

function directionOf(transactionType) {
  return CATEGORY_TO_DIRECTION[categoryOf(transactionType)];
}

// All raw type strings (old + new) that map to a given category. Useful for
// building SQL `IN (...)` lists so aggregation captures legacy rows too.
function typesForCategory(category) {
  return Object.keys(TYPE_TO_CATEGORY).filter((t) => TYPE_TO_CATEGORY[t] === category);
}

// Render a category's type strings as a SQL-quoted CSV, e.g. "'Discount','Negotiation'".
// Values are hard-coded constants here (never user input), so direct quoting is safe.
function sqlInList(category) {
  return typesForCategory(category)
    .map((t) => `'${t.replace(/'/g, "''")}'`)
    .join(', ');
}

module.exports = {
  CATEGORY,
  DIRECTION,
  CURRENT_TYPES,
  TYPE_TO_CATEGORY,
  categoryOf,
  directionOf,
  typesForCategory,
  sqlInList,
};
