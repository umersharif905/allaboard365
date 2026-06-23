/**
 * Quick-quote result shaping (pure helpers).
 *
 * A quick quote can select multiple products, and each product can have multiple
 * unshared-amount options. Two display modes fall out of that:
 *
 *   - "basket": every product has exactly one amount, so the quote is a single
 *     determinate basket with one combined total (the original single-quote view).
 *   - "comparison": at least one product has multiple amounts. Instead of a
 *     confusing cartesian product of every cross-product combination, we show
 *     each product's amount options side by side and omit a combined total
 *     (a basket total is ambiguous when several amounts are in play per product).
 *
 * Keeping the mode decision + response shape here (DB/pricing free) makes the
 * branching unit-testable in isolation from the route's authority calls.
 */

const ZERO_TOTALS = Object.freeze({
  subtotalPremium: 0,
  processingFee: 0,
  systemFees: 0,
  totalPremium: 0
});

/**
 * @param {Array<{ productId: string }>} breakdown one entry per product x amount
 * @returns {'basket' | 'comparison'}
 */
function classifyQuoteMode(breakdown) {
  const items = Array.isArray(breakdown) ? breakdown : [];
  const distinctProductCount = new Set(items.map((b) => String(b.productId))).size;
  return items.length > distinctProductCount ? 'comparison' : 'basket';
}

/**
 * @param {object} args
 * @param {Array} args.breakdown full priced breakdown (one entry per product x amount)
 * @param {'basket' | 'comparison'} args.mode
 * @param {object} [args.basketTotals] combined totals (used in basket mode only)
 * @returns {{ breakdown: Array, totals: object, quoteOptions: Array, comparison: boolean }}
 */
function buildQuickQuoteResult({ breakdown, mode, basketTotals }) {
  const items = Array.isArray(breakdown) ? breakdown : [];

  if (mode === 'comparison') {
    return {
      breakdown: items,
      totals: { ...ZERO_TOTALS },
      quoteOptions: [],
      comparison: true
    };
  }

  const totals = basketTotals || { ...ZERO_TOTALS };
  return {
    breakdown: items,
    totals,
    quoteOptions: [
      {
        optionId: 'option-1',
        optionLabel: 'Option 1',
        breakdown: items,
        totals
      }
    ],
    comparison: false
  };
}

module.exports = { classifyQuoteMode, buildQuickQuoteResult, ZERO_TOTALS };
