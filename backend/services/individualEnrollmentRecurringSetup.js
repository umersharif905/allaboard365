const DimeService = require('./dimeService');
const PaymentDatabaseService = require('./paymentDatabaseService');
const encryptionService = require('./encryptionService');

/**
 * Compute the startDate to send to DIME's recurring schedule.
 *   - When `chargeFirstPaymentWithRecurring` is true: use the effective date as-is so DIME
 *     charges the first payment on the member's coverage start day.
 *   - Otherwise (legacy): effective date + 1 month so we charge at enrollment and DIME
 *     handles month 2 onward.
 *
 * @param {string|Date} effectiveDate - YYYY-MM-DD string or Date
 * @param {boolean} chargeFirstPaymentWithRecurring
 * @returns {string} YYYY-MM-DD
 */
function computeRecurringStartDate(effectiveDate, chargeFirstPaymentWithRecurring) {
  const effStr =
    typeof effectiveDate === 'string'
      ? effectiveDate
      : effectiveDate instanceof Date
        ? effectiveDate.toISOString().slice(0, 10)
        : String(effectiveDate);

  if (chargeFirstPaymentWithRecurring) return effStr;

  const ymdMatch = effStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    let newMonth = month + 1;
    let newYear = year;
    if (newMonth > 12) { newMonth = 1; newYear++; }
    return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const nb = new Date(effectiveDate);
  nb.setMonth(nb.getMonth() + 1);
  return nb.toISOString().split('T')[0];
}

/**
 * After an individual (non-group) enrollment payment succeeds, persist a stored payment method in DIME + oe.MemberPaymentMethods
 * and schedule DIME recurring + oe recurring schedule. Best-effort: failures are thrown for caller to log without failing enrollment.
 *
 * @param {object} params
 * @param {import('mssql').ConnectionPool} params.pool
 * @param {object} params.sql - mssql types
 * @param {string} params.tenantId - UUID
 * @param {string} params.memberId - UUID
 * @param {string} params.householdId - UUID
 * @param {object} params.memberInfo
 * @param {object} params.paymentMethod - request payment method (card or ACH)
 * @param {string|Date|null} params.effectiveDate - coverage effective date (recurring starts +1 month)
 * @param {number} params.basePremium - recurring base (excludes setup fee)
 * @param {number} params.paymentProcessingFeeTotal - full processing fee amount used in recurring monthly amount
 * @param {number} params.systemFeesAmount
 * @param {string} params.userId - acting user for MemberPaymentMethods audit
 * @param {string|null} [params.dimeCustomerIdHint] - DIME customer id if already known from charge
 */
async function setupStoredPaymentMethodAndRecurringForIndividualEnrollment({
  pool,
  sql,
  tenantId,
  memberId,
  householdId,
  memberInfo,
  paymentMethod,
  effectiveDate,
  basePremium,
  paymentProcessingFeeTotal,
  systemFeesAmount,
  userId,
  dimeCustomerIdHint = null,
  // Default ON when the caller doesn't explicitly pass a value. Matches the /enrollment-data
  // handler + route defaults: we'd rather vault + let DIME recurring charge on the effective
  // date than force an immediate charge the caller didn't ask for.
  chargeFirstPaymentWithRecurring = true
}) {
  const isDimeServerError = (errLike) => {
    if (!errLike) return false;
    const status = Number(
      errLike?.error?.statusCode ??
      errLike?.error?.status ??
      errLike?.statusCode ??
      errLike?.status
    );
    // dimeService now sanitizes `message` to a user-facing string and preserves the raw
    // upstream body on `rawMessage`. Prefer raw first so we can still match on infrastructure
    // hiccup strings; fall back to the sanitized message and `details` (Laravel validation).
    const rawMessage = errLike?.error?.rawMessage || errLike?.rawMessage || '';
    const sanitizedMessage = errLike?.error?.message || errLike?.message || '';
    let detailsMessage = '';
    const details = errLike?.error?.details || errLike?.details;
    if (details) {
      try { detailsMessage = JSON.stringify(details); } catch (_) { detailsMessage = String(details); }
    }
    const msg = `${rawMessage} ${sanitizedMessage} ${detailsMessage}`.toLowerCase();
    // Only genuine DIME-infrastructure failures (5xx, gateway timeouts, outright service
    // unavailable) are "transient". NOTE: "Invalid response from upstream API" used to live
    // here but moved to the user-actionable bucket (Apr 2026) after DIME support confirmed
    // it's almost always bad card details — see docs/billing/dime-payments.md → UPSTREAM_UNVERIFIED.
    return (
      (Number.isFinite(status) && status >= 500 && status < 600) ||
      msg.includes('server error') ||
      msg.includes('bad gateway') ||
      msg.includes('gateway timeout') ||
      msg.includes('service unavailable') ||
      msg.includes('timeout')
    );
  };

  // A DIME failure is "user-actionable" when dimeService could map it to a known bucket
  // (validation error or an ISO-8583-style decline). Everything else (unclassified 4xx with
  // opaque body, "unknown reason" rejections) should be treated as transient so we can vault
  // the card locally and let ops retry via Add-to-Processor.
  const isUserActionableDimeFailure = (errLike) => {
    if (!errLike) return false;
    if (errLike?.error?.isUserActionable === true) return true;
    const details = errLike?.error?.details;
    if (details && typeof details === 'object') {
      if (Array.isArray(details)) {
        if (details.length > 0) return true;
      } else if (Object.keys(details).length > 0) {
        return true;
      }
    }
    return false;
  };

  const savePaymentMethodLocally = async ({ processorCustomerId = null, processorPaymentMethodId = null, processorToken = null, status = 'Active' }) => {
    // Keep one default active method. We intentionally clear defaults even for local-only unsynced methods.
    try {
      await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
          UPDATE oe.MemberPaymentMethods
          SET IsDefault = 0, ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId AND Status = 'Active'
        `);
    } catch (e) {}

    // Dedupe existing PendingProcessorVault rows for this same card/account (same member,
    // same type, same last-4) so repeated DIME outages don't stack rows — which is what
    // produced Dawn Taylor's two stranded rows in April 2026. We UPDATE the newest pending
    // row in place (refreshes ciphertext and processorCustomerId) and return early.
    if (status === 'PendingProcessorVault') {
      const pmType = paymentMethod?.paymentMethodType === 'ACH' ? 'ACH' : 'Card';
      const last4 =
        pmType === 'ACH'
          ? String(paymentMethod?.accountNumber || '').slice(-4)
          : String(paymentMethod?.cardNumber || '').slice(-4);

      if (last4) {
        const existingPending = await pool.request()
          .input('memberId', sql.UniqueIdentifier, memberId)
          .input('paymentMethodType', sql.NVarChar(20), pmType)
          .input('last4', sql.NVarChar(4), last4)
          .query(`
            SELECT TOP 1 PaymentMethodId
            FROM oe.MemberPaymentMethods
            WHERE MemberId = @memberId
              AND Status = 'PendingProcessorVault'
              AND PaymentMethodType = @paymentMethodType
              AND (
                (@paymentMethodType = 'Card' AND CardLast4 = @last4)
                OR (@paymentMethodType = 'ACH' AND AccountNumberLast4 = @last4)
              )
            ORDER BY CreatedDate DESC
          `);

        const existingId = existingPending.recordset?.[0]?.PaymentMethodId;
        if (existingId) {
          const enc = encryptionService.encryptPaymentData(paymentMethod || {});
          await pool.request()
            .input('paymentMethodId', sql.UniqueIdentifier, existingId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .input('processorCustomerId', sql.NVarChar(255), processorCustomerId ? String(processorCustomerId) : null)
            .input('processorToken', sql.NVarChar(255), processorToken ? String(processorToken) : null)
            .input('cardNumberEncrypted', sql.NVarChar(sql.MAX), enc.cardNumberEncrypted || null)
            .input('accountNumberEncrypted', sql.NVarChar(sql.MAX), enc.accountNumberEncrypted || null)
            .input('routingNumberEncrypted', sql.NVarChar(sql.MAX), enc.routingNumberEncrypted || null)
            .query(`
              UPDATE oe.MemberPaymentMethods
              SET ProcessorCustomerId = @processorCustomerId,
                  ProcessorToken = @processorToken,
                  CardNumberEncrypted = COALESCE(@cardNumberEncrypted, CardNumberEncrypted),
                  AccountNumberEncrypted = COALESCE(@accountNumberEncrypted, AccountNumberEncrypted),
                  RoutingNumberEncrypted = COALESCE(@routingNumberEncrypted, RoutingNumberEncrypted),
                  ModifiedBy = @modifiedBy,
                  ModifiedDate = GETUTCDATE()
              WHERE PaymentMethodId = @paymentMethodId
            `);
          return;
        }
      }
    }

    const encryptedPaymentData = encryptionService.encryptPaymentData(paymentMethod || {});
    const insertReq = pool.request();
    insertReq.input('memberId', sql.UniqueIdentifier, memberId);
    insertReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    insertReq.input('createdBy', sql.UniqueIdentifier, userId);
    insertReq.input('modifiedBy', sql.UniqueIdentifier, userId);
    insertReq.input('paymentMethodType', sql.NVarChar(20), paymentMethod.paymentMethodType);
    // PendingProcessorVault rows must NOT be Default — they have no processor tokens yet, so
    // nightly billing would trip on them. Only mark Active rows as the default.
    insertReq.input('isDefault', sql.Bit, status === 'Active');
    insertReq.input('status', sql.NVarChar(30), status);
    insertReq.input('processorToken', sql.NVarChar(255), processorToken ? String(processorToken) : null);
    insertReq.input('processorCustomerId', sql.NVarChar(255), processorCustomerId ? String(processorCustomerId) : null);
    insertReq.input('processorPaymentMethodId', sql.NVarChar(255), processorPaymentMethodId ? String(processorPaymentMethodId) : null);
    insertReq.input('billingAddress', sql.NVarChar(255), paymentMethod.billingAddress || '');
    insertReq.input('billingAddress2', sql.NVarChar(255), paymentMethod.billingAddress2 || '');
    insertReq.input('billingCity', sql.NVarChar(100), paymentMethod.billingCity || '');
    insertReq.input('billingState', sql.NVarChar(2), paymentMethod.billingState || '');
    insertReq.input('billingZip', sql.NVarChar(10), paymentMethod.billingZip || '');
    insertReq.input('cardNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.cardNumberEncrypted || null);
    insertReq.input('accountNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.accountNumberEncrypted || null);
    insertReq.input('routingNumberEncrypted', sql.NVarChar(sql.MAX), encryptedPaymentData.routingNumberEncrypted || null);
    // PCI DSS 3.3.1: CVV is never persisted, even encrypted.

    if (paymentMethod.paymentMethodType === 'ACH') {
      insertReq.input('bankName', sql.NVarChar(100), paymentMethod.bankName);
      insertReq.input('accountType', sql.NVarChar(20), paymentMethod.accountType);
      insertReq.input('accountNumberLast4', sql.NVarChar(4), String(paymentMethod.accountNumber || '').slice(-4));
      insertReq.input('accountHolderName', sql.NVarChar(100), paymentMethod.accountHolderName);
      insertReq.input('routingNumber', sql.NVarChar(20), paymentMethod.routingNumber || null);
      await insertReq.query(`
        INSERT INTO oe.MemberPaymentMethods (
          MemberId, TenantId, CreatedBy, ModifiedBy, PaymentMethodType, IsDefault, Status,
          BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
          ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
          CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
          CreatedDate, ModifiedDate
        ) VALUES (
          @memberId, @tenantId, @createdBy, @modifiedBy, @paymentMethodType, @isDefault, @status,
          @bankName, @accountType, @accountNumberLast4, @accountHolderName, @routingNumber,
          @processorToken, @processorCustomerId, @processorPaymentMethodId,
          @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip,
          @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
          GETUTCDATE(), GETUTCDATE()
        )
      `);
    } else {
      const cardLast4 = String(paymentMethod.cardNumber || '').slice(-4);
      const cardBrand = paymentMethod.cardBrand || 'Card';
      const expMonth = paymentMethod.expiryDate ? parseInt(paymentMethod.expiryDate.split('/')[0], 10) : null;
      const expYear = paymentMethod.expiryDate ? parseInt(paymentMethod.expiryDate.split('/')[1], 10) : null;
      insertReq.input('cardBrand', sql.NVarChar(20), cardBrand);
      insertReq.input('cardLast4', sql.NVarChar(4), cardLast4);
      insertReq.input('expiryMonth', sql.Int, expMonth);
      insertReq.input('expiryYear', sql.Int, expYear);
      insertReq.input('cardholderName', sql.NVarChar(100), paymentMethod.cardholderName);
      await insertReq.query(`
        INSERT INTO oe.MemberPaymentMethods (
          MemberId, TenantId, CreatedBy, ModifiedBy, PaymentMethodType, IsDefault, Status,
          CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
          ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
          BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip,
          CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
          CreatedDate, ModifiedDate
        ) VALUES (
          @memberId, @tenantId, @createdBy, @modifiedBy, @paymentMethodType, @isDefault, @status,
          @cardBrand, @cardLast4, @expiryMonth, @expiryYear, @cardholderName,
          @processorToken, @processorCustomerId, @processorPaymentMethodId,
          @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip,
          @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
          GETUTCDATE(), GETUTCDATE()
        )
      `);
    }
  };

  console.log('🔁 PM/Recurring setup start:', {
    tenantId,
    memberId,
    householdId,
    paymentMethodType: paymentMethod?.paymentMethodType,
    effectiveDate
  });
  let resolvedCustomerId = dimeCustomerIdHint || null;
  if (!resolvedCustomerId) {
    const memberCustomerResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(`SELECT ProcessorCustomerId FROM oe.Members WHERE MemberId = @memberId`);
    resolvedCustomerId = memberCustomerResult.recordset?.[0]?.ProcessorCustomerId || null;
  }

  if (!resolvedCustomerId) {
    const emailForLookup = String(memberInfo?.email || paymentMethod?.email || '').trim().toLowerCase();
    if (emailForLookup) {
      const existing = await DimeService.getCustomerByEmail(emailForLookup, tenantId);
      if (existing && existing.success && existing.customerId) {
        resolvedCustomerId = existing.customerId;
        try {
          await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('customerId', sql.NVarChar(255), String(resolvedCustomerId))
            .query(`
              UPDATE oe.Members
              SET ProcessorCustomerId = @customerId,
                  ModifiedDate = GETUTCDATE()
              WHERE MemberId = @memberId
            `);
        } catch (e) {}
      }
    }
  }

  // Deferred-charge path: no charge ran earlier, so there's no DIME customer yet.
  // Create one now so the stored PM + recurring schedule can be attached.
  if (!resolvedCustomerId && chargeFirstPaymentWithRecurring) {
    const customerEmail = String(memberInfo?.email || paymentMethod?.email || '').trim();
    if (customerEmail) {
      console.log('🔁 PM/Recurring: no DIME customer yet (deferred charge) — creating one');
      const createResult = await DimeService.createCustomer({
        firstName: paymentMethod?.cardholderName?.split(' ')[0] || memberInfo?.firstName,
        lastName: paymentMethod?.cardholderName?.split(' ').slice(1).join(' ') || memberInfo?.lastName,
        email: customerEmail,
        phone: paymentMethod?.phone || memberInfo?.phone,
        billingAddress: paymentMethod?.billingAddress || memberInfo?.address || ''
      }, tenantId);
      if (createResult?.success && createResult?.customerId) {
        resolvedCustomerId = createResult.customerId;
        try {
          await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('customerId', sql.NVarChar(255), String(resolvedCustomerId))
            .query(`
              UPDATE oe.Members
              SET ProcessorCustomerId = @customerId,
                  ModifiedDate = GETUTCDATE()
              WHERE MemberId = @memberId
            `);
        } catch (e) {
          console.warn('⚠️ PM/Recurring: failed to persist new ProcessorCustomerId:', e?.message || e);
        }
      } else {
        console.warn('⚠️ PM/Recurring: createCustomer failed during deferred-charge setup:', createResult?.error?.message || 'unknown');
      }
    }
  }

  if (!resolvedCustomerId) {
    await savePaymentMethodLocally({
      processorCustomerId: null,
      processorPaymentMethodId: null,
      processorToken: null
    });
    return {
      paymentMethodSaved: true,
      processorSaved: false,
      recurringScheduled: false,
      recurringSkipReason: 'missing_processor_customer'
    };
  }
  console.log('🔁 PM/Recurring customer resolved:', { memberId, householdId, resolvedCustomerId });

  console.log('💾 POST-COMMIT: Creating stored payment method for recurring billing...');
  let storedPaymentMethodResult;

  if (paymentMethod?.paymentMethodType === 'ACH') {
    storedPaymentMethodResult = await DimeService.createBankAccountPaymentMethod({
      routingNumber: paymentMethod.routingNumber,
      accountNumber: paymentMethod.accountNumber,
      accountType: paymentMethod.accountType || 'Checking',
      accountHolderName: paymentMethod.accountHolderName || `${memberInfo.firstName} ${memberInfo.lastName}`,
      bankName: paymentMethod.bankName,
      billingAddress: {
        address: paymentMethod.billingAddress || memberInfo.address || '',
        address2: paymentMethod.billingAddress2 || '',
        city: paymentMethod.billingCity || memberInfo.city || '',
        state: paymentMethod.billingState || memberInfo.state || '',
        zip: paymentMethod.billingZip || memberInfo.zip || '',
        country: paymentMethod.billingCountry || 'US'
      },
      customerId: resolvedCustomerId
    }, tenantId);
  } else {
    storedPaymentMethodResult = await DimeService.createCreditCardPaymentMethod({
      number: paymentMethod.cardNumber,
      expiryMonth: paymentMethod.expiryDate ? parseInt(paymentMethod.expiryDate.split('/')[0], 10) : undefined,
      expiryYear: paymentMethod.expiryDate ? parseInt(paymentMethod.expiryDate.split('/')[1], 10) : undefined,
      cvv: paymentMethod.cvv,
      cardholderName: paymentMethod.cardholderName,
      billingAddress: {
        address: paymentMethod.billingAddress || memberInfo.address || '',
        address2: paymentMethod.billingAddress2 || '',
        city: paymentMethod.billingCity || memberInfo.city || '',
        state: paymentMethod.billingState || memberInfo.state || '',
        zip: paymentMethod.billingZip || memberInfo.zip || '',
        firstName: paymentMethod.cardholderName?.split(' ')[0] || memberInfo.firstName,
        lastName: paymentMethod.cardholderName?.split(' ').slice(1).join(' ') || memberInfo.lastName
      },
      customerId: resolvedCustomerId
    }, tenantId);
  }

  if (!storedPaymentMethodResult?.success || !storedPaymentMethodResult.paymentMethodId) {
    // Classify the failure so the caller can pick between "block the user, ask them to fix
    // the card" (known failure) and "proceed with enrollment, flag the PM for ops retry"
    // (transient/unclassified).
    const serverErr = isDimeServerError(storedPaymentMethodResult);
    const actionable = isUserActionableDimeFailure(storedPaymentMethodResult);
    let skipReason;
    if (serverErr) {
      skipReason = 'processor_unavailable';
    } else if (!actionable) {
      // Opaque 4xx with no validation body and no recognized decline string — DIME told us
      // nothing actionable. Bucket as transient so ops can retry later via Add-to-Processor.
      skipReason = 'processor_unclassified';
    } else {
      skipReason = 'processor_payment_method_failed';
    }

    // Transient buckets keep the PAN/routing ciphertext on file under PendingProcessorVault
    // so ops (or a future retry job) can redrive the vault. Known failures don't save ANY
    // PM row — the caller (enrollment-links) will roll back the enrollment and the user will
    // re-enter corrected card details next time. This keeps oe.MemberPaymentMethods clean of
    // dead rows and aligns with PCI's data-minimization principle (don't persist ciphertext for
    // cards that never worked). See docs/billing/dime-payments.md → "Save-on-failure policy".
    const isTransient = skipReason === 'processor_unavailable' || skipReason === 'processor_unclassified';
    const paymentMethodSaved = isTransient;
    if (isTransient) {
      await savePaymentMethodLocally({
        processorCustomerId: resolvedCustomerId,
        processorPaymentMethodId: null,
        processorToken: null,
        status: 'PendingProcessorVault'
      });
    }

    // Expose enough of DIME's failure response that the caller can build a user-facing message
    // (Laravel validation errors → field-level feedback, decline code → ISO-8583 catalogue, etc.).
    // Without this the caller can only say "something went wrong" and users blame their card.
    return {
      paymentMethodSaved,
      processorSaved: false,
      recurringScheduled: false,
      recurringSkipReason: skipReason,
      recurringErrorMessage: storedPaymentMethodResult?.error?.message || storedPaymentMethodResult?.message || 'Failed to create stored payment method',
      processorErrorDetails: {
        code: storedPaymentMethodResult?.error?.code || null,
        status: storedPaymentMethodResult?.error?.status || null,
        message: storedPaymentMethodResult?.error?.message || storedPaymentMethodResult?.message || null,
        rawMessage: storedPaymentMethodResult?.error?.rawMessage || null,
        isUserActionable: !!storedPaymentMethodResult?.error?.isUserActionable,
        // Laravel-style validation errors (e.g. { 'data.cc_number': ['The number is invalid.'] })
        validationErrors: storedPaymentMethodResult?.error?.details || null
      }
    };
  }
  console.log('🔁 PM/Recurring stored payment method created:', {
    memberId,
    householdId,
    paymentMethodId: storedPaymentMethodResult.paymentMethodId
  });

  const processorPaymentMethodId = String(storedPaymentMethodResult.paymentMethodId);
  const processorToken = storedPaymentMethodResult.token ? String(storedPaymentMethodResult.token) : null;

  const existingMpm = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('processorPaymentMethodId', sql.NVarChar(255), processorPaymentMethodId)
    .query(`
      SELECT TOP 1 PaymentMethodId
      FROM oe.MemberPaymentMethods
      WHERE MemberId = @memberId
        AND ProcessorPaymentMethodId = @processorPaymentMethodId
        AND Status = 'Active'
      ORDER BY CreatedDate DESC
    `);

  if (!existingMpm.recordset || existingMpm.recordset.length === 0) {
    try {
      await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
          UPDATE oe.MemberPaymentMethods
          SET IsDefault = 0, ModifiedDate = GETUTCDATE()
          WHERE MemberId = @memberId AND Status = 'Active'
        `);
    } catch (e) {}

    await savePaymentMethodLocally({
      processorCustomerId: resolvedCustomerId,
      processorPaymentMethodId,
      processorToken
    });
    console.log('🔁 PM/Recurring payment method inserted into oe.MemberPaymentMethods:', {
      memberId,
      householdId,
      processorPaymentMethodId
    });
  } else {
    console.log('🔒 POST-COMMIT: MemberPaymentMethods already exists for processorPaymentMethodId, skipping insert');
  }

  if (!effectiveDate) {
    console.warn('⚠️ POST-COMMIT: No effectiveDate — skipping DIME recurring schedule for individual enrollment');
    return {
      paymentMethodSaved: true,
      recurringScheduled: false,
      recurringSkipReason: 'missing_effective_date'
    };
  }

  const recurringStartDateStr = computeRecurringStartDate(effectiveDate, chargeFirstPaymentWithRecurring);
  const nextBillingDate = new Date(`${recurringStartDateStr}T00:00:00.000Z`);
  const recurringAmount = Number(basePremium || 0) + Number(paymentProcessingFeeTotal || 0) + Number(systemFeesAmount || 0);
  console.log('🔁 PM/Recurring creating schedule in DIME:', {
    memberId,
    householdId,
    recurringStartDate: recurringStartDateStr,
    recurringAmount
  });
  const recurringResult = await DimeService.setupRecurringPayment({
    customerId: resolvedCustomerId,
    paymentMethodId: storedPaymentMethodResult.paymentMethodId,
    amount: recurringAmount,
    description: `Recurring payment for individual enrollment`,
    householdId: householdId,
    startDate: nextBillingDate
  }, tenantId);

  if (recurringResult?.success && recurringResult.scheduleId) {
    const recurringAmountRounded = Math.round(recurringAmount * 100) / 100;
    const nextBd = recurringResult.nextBillingDate
      ? new Date(recurringResult.nextBillingDate)
      : nextBillingDate;
    await PaymentDatabaseService.persistRecurringScheduleAfterDimeSetup({
      householdId,
      tenantId,
      recurringScheduleId: recurringResult.scheduleId,
      nextBillingDate: nextBd,
      monthlyAmount: recurringAmountRounded
    });
    console.log('✅ PM/Recurring schedule created + persisted:', {
      memberId,
      householdId,
      scheduleId: recurringResult.scheduleId,
      monthlyAmount: recurringAmountRounded
    });
    return {
      paymentMethodSaved: true,
      processorSaved: true,
      recurringScheduled: true,
      scheduleId: recurringResult.scheduleId
    };
  }

  const recurringErrorMessage =
    recurringResult?.error?.message ||
    recurringResult?.message ||
    'Recurring payment schedule setup failed';
  console.warn('⚠️ PM/Recurring: card saved, but recurring schedule failed:', {
    memberId,
    householdId,
    tenantId,
    recurringErrorMessage
  });
  return {
    paymentMethodSaved: true,
    processorSaved: true,
    recurringScheduled: false,
    recurringErrorMessage
  };
}

module.exports = {
  setupStoredPaymentMethodAndRecurringForIndividualEnrollment,
  computeRecurringStartDate
};
