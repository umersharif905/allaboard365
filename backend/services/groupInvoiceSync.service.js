'use strict';

// Deprecated: use invoiceSync.service.js instead. This file is kept for backward compatibility.
const { syncInvoiceAfterPaymentStatusChange, syncGroupInvoiceAfterPaymentStatusChange } = require('./invoiceSync.service');

module.exports = { syncGroupInvoiceAfterPaymentStatusChange, syncInvoiceAfterPaymentStatusChange };
