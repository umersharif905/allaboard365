'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql } = require('../../config/database');
const encryptionService = require('../encryptionService');
const dimeCardBrand = require('../dimeCardBrand');
const {
  isUsableAchAccount,
  isUsableCreditCardPan
} = require('./e123PaymentExtract.service');

function validateMigrationPaymentMethod(paymentMethod) {
  if (!paymentMethod?.paymentMethodType) return null;
  const normalized = { ...paymentMethod };

  if (normalized.paymentMethodType === 'CreditCard') {
    const pan = String(normalized.cardNumber || '').replace(/\D/g, '');
    if (!isUsableCreditCardPan(normalized.cardNumber, pan)) return null;
    normalized.cardNumber = pan;
    return normalized;
  }

  if (normalized.paymentMethodType === 'ACH') {
    const routing = String(normalized.routingNumber || '').replace(/\D/g, '');
    const account = String(normalized.accountNumber || '').replace(/\D/g, '');
    if (routing.length !== 9 || !isUsableAchAccount(normalized.accountNumber, account)) return null;
    normalized.routingNumber = routing;
    normalized.accountNumber = account;
    return normalized;
  }

  return null;
}

async function upsertMigrationPaymentMethod({
  transaction,
  memberId,
  tenantId,
  paymentMethod,
  createdBy
}) {
  const validated = validateMigrationPaymentMethod(paymentMethod);
  if (!validated) return null;

  const encryptedPaymentData = encryptionService.encryptPaymentData(validated);
  const { paymentMethodType } = encryptedPaymentData;

  let accountNumberLast4 = null;
  let cardLast4 = null;
  if (paymentMethodType === 'ACH' && validated.accountNumber) {
    accountNumberLast4 = validated.accountNumber.slice(-4);
  } else if (paymentMethodType === 'CreditCard' && validated.cardNumber) {
    cardLast4 = validated.cardNumber.slice(-4);
  }

  let cardBrand = null;
  if (paymentMethodType === 'CreditCard' && validated.cardNumber) {
    cardBrand = validated.cardBrand || dimeCardBrand.getCardBrandOrNull(validated.cardNumber) || null;
  }

  await transaction.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      DELETE FROM oe.MemberPaymentMethods
      WHERE MemberId = @memberId
        AND ProcessorPaymentMethodId IS NULL
        AND ProcessorCustomerId IS NULL
    `);

  const defaultResult = await transaction.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`
      SELECT TOP 1 PaymentMethodId
      FROM oe.MemberPaymentMethods
      WHERE MemberId = @memberId
        AND IsDefault = 1
        AND Status = 'Active'
    `);

  const isDefault = !(defaultResult.recordset?.length);

  const paymentMethodId = uuidv4();
  await transaction.request()
    .input('paymentMethodId', sql.UniqueIdentifier, paymentMethodId)
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('paymentMethodType', sql.NVarChar, paymentMethodType)
    .input('isDefault', sql.Bit, isDefault ? 1 : 0)
    .input('bankName', sql.NVarChar, validated.bankName || null)
    .input('accountType', sql.NVarChar, validated.accountType || null)
    .input('accountNumberLast4', sql.NVarChar, accountNumberLast4)
    .input('accountHolderName', sql.NVarChar, validated.accountHolderName || validated.cardholderName || null)
    .input('routingNumber', sql.NVarChar, validated.routingNumber || null)
    .input('cardBrand', sql.NVarChar, cardBrand)
    .input('cardLast4', sql.NVarChar, cardLast4)
    .input('expiryMonth', sql.Int, validated.expiryMonth || null)
    .input('expiryYear', sql.Int, validated.expiryYear || null)
    .input('cardholderName', sql.NVarChar, validated.cardholderName || null)
    .input('billingAddress', sql.NVarChar, validated.billingAddress || null)
    .input('billingAddress2', sql.NVarChar, validated.billingAddress2 || null)
    .input('billingCity', sql.NVarChar, validated.billingCity || null)
    .input('billingState', sql.NVarChar, validated.billingState || null)
    .input('billingZip', sql.NVarChar, validated.billingZip || null)
    .input('billingCountry', sql.NVarChar, validated.billingCountry || 'US')
    .input('cardNumberEncrypted', sql.NVarChar, encryptedPaymentData.cardNumberEncrypted || null)
    .input('accountNumberEncrypted', sql.NVarChar, encryptedPaymentData.accountNumberEncrypted || null)
    .input('routingNumberEncrypted', sql.NVarChar, encryptedPaymentData.routingNumberEncrypted || null)
    .input('userId', sql.UniqueIdentifier, createdBy || null)
    .query(`
      INSERT INTO oe.MemberPaymentMethods (
        PaymentMethodId, MemberId, TenantId, PaymentMethodType, IsDefault, Status,
        BankName, AccountType, AccountNumberLast4, AccountHolderName, RoutingNumber,
        CardBrand, CardLast4, ExpiryMonth, ExpiryYear, CardholderName,
        BillingAddress, BillingAddress2, BillingCity, BillingState, BillingZip, BillingCountry,
        ProcessorToken, ProcessorCustomerId, ProcessorPaymentMethodId,
        CardNumberEncrypted, AccountNumberEncrypted, RoutingNumberEncrypted,
        CreatedBy, ModifiedBy, CreatedDate, ModifiedDate
      ) VALUES (
        @paymentMethodId, @memberId, @tenantId, @paymentMethodType, @isDefault, 'Active',
        @bankName, @accountType, @accountNumberLast4, @accountHolderName, @routingNumber,
        @cardBrand, @cardLast4, @expiryMonth, @expiryYear, @cardholderName,
        @billingAddress, @billingAddress2, @billingCity, @billingState, @billingZip, @billingCountry,
        NULL, NULL, NULL,
        @cardNumberEncrypted, @accountNumberEncrypted, @routingNumberEncrypted,
        @userId, @userId, GETUTCDATE(), GETUTCDATE()
      )
    `);

  return paymentMethodId;
}

module.exports = {
  upsertMigrationPaymentMethod,
  validateMigrationPaymentMethod
};
