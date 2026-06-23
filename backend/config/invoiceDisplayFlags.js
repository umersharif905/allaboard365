'use strict';

/**
 * Invoice PDF presentation toggles (not persisted; flip here and redeploy).
 *
 * When false, invoice PDFs omit a separate "Processing Fees" line and merge
 * that amount into premium line(s) so Subtotal aligns with Total Due without
 * a fee breakout. Group invoices: bundled into "Monthly Premium". Individual
 * PDFs: allocated across product/bundle rows in proportion to each row amount.
 */
const SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM = false;

module.exports = {
  SHOW_INVOICE_PROCESSING_FEES_LINE_ITEM
};
