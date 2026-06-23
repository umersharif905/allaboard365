const { getPool, sql } = require('../config/database');

/**
 * PaymentAttemptService
 * Durable idempotency + recovery record for external payment processor calls.
 *
 * This is intentionally DB-backed (not in-memory) so:
 * - Retries after a server crash remain safe
 * - Multiple app instances cannot double-charge on the same idempotency key
 */
class PaymentAttemptService {
  static async getByIdempotencyKey(idempotencyKey, transaction = null) {
    const pool = await getPool();
    const req = transaction ? transaction.request() : pool.request();
    const result = await req
      .input('idempotencyKey', sql.NVarChar(255), String(idempotencyKey))
      .query(`
        SELECT TOP 1 *
        FROM oe.PaymentAttempts
        WHERE IdempotencyKey = @idempotencyKey
        ORDER BY CreatedDate DESC
      `);
    return result.recordset?.[0] || null;
  }

  /**
   * Try to claim an attempt so only one request performs the processor charge.
   * Returns { claimed: boolean, attempt: row|null }.
   */
  static async claimForCharge(idempotencyKey, transaction = null) {
    const pool = await getPool();
    const req = transaction ? transaction.request() : pool.request();
    const result = await req
      .input('idempotencyKey', sql.NVarChar(255), String(idempotencyKey))
      .query(`
        DECLARE @claimed INT = 0;
        UPDATE oe.PaymentAttempts
        SET Status = 'Charging',
            ErrorMessage = NULL,
            ModifiedDate = SYSUTCDATETIME()
        WHERE IdempotencyKey = @idempotencyKey
          AND ProcessorTransactionId IS NULL
          AND (Status IS NULL OR Status NOT IN ('Charging', 'Charged', 'Completed'));
        SET @claimed = @@ROWCOUNT;

        SELECT @claimed AS claimed;
        SELECT TOP 1 *
        FROM oe.PaymentAttempts
        WHERE IdempotencyKey = @idempotencyKey
        ORDER BY CreatedDate DESC;
      `);

    const claimed = (result.recordsets?.[0]?.[0]?.claimed || 0) > 0;
    const attempt = result.recordsets?.[1]?.[0] || null;
    return { claimed, attempt };
  }

  static async createOrGetAttempt(attempt, transaction = null) {
    const {
      idempotencyKey,
      linkToken = null,
      tenantId = null,
      memberId = null,
      householdId = null,
      amount = null,
      paymentMethodType = null,
      status = 'Processing'
    } = attempt || {};

    const pool = await getPool();
    const req = transaction ? transaction.request() : pool.request();

    try {
      const insertResult = await req
        .input('idempotencyKey', sql.NVarChar(255), String(idempotencyKey))
        .input('linkToken', sql.NVarChar(255), linkToken)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('amount', sql.Decimal(10, 2), typeof amount === 'number' ? amount : (amount == null ? null : Number(amount)))
        .input('paymentMethodType', sql.NVarChar(20), paymentMethodType)
        .input('status', sql.NVarChar(50), status)
        .query(`
          INSERT INTO oe.PaymentAttempts (
            IdempotencyKey, LinkToken, TenantId, MemberId, HouseholdId, Amount, PaymentMethodType, Status,
            CreatedDate, ModifiedDate
          )
          VALUES (
            @idempotencyKey, @linkToken, @tenantId, @memberId, @householdId, @amount, @paymentMethodType, @status,
            SYSUTCDATETIME(), SYSUTCDATETIME()
          );

          SELECT TOP 1 *
          FROM oe.PaymentAttempts
          WHERE IdempotencyKey = @idempotencyKey
          ORDER BY CreatedDate DESC;
        `);
      return insertResult.recordset?.[0] || null;
    } catch (err) {
      // Unique constraint violation (another request already created it)
      if (err && (err.number === 2627 || err.number === 2601)) {
        return await this.getByIdempotencyKey(idempotencyKey, transaction);
      }
      throw err;
    }
  }

  static async updateAttemptByKey(idempotencyKey, patch, transaction = null) {
    const pool = await getPool();
    const req = transaction ? transaction.request() : pool.request();

    const status = patch?.status ?? null;
    const processorTransactionId = patch?.processorTransactionId ?? null;
    const processorResponse = patch?.processorResponse ?? null;
    const errorMessage = patch?.errorMessage ?? null;

    const result = await req
      .input('idempotencyKey', sql.NVarChar(255), String(idempotencyKey))
      .input('status', sql.NVarChar(50), status)
      .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
      .input('processorResponse', sql.NVarChar(sql.MAX), processorResponse)
      .input('errorMessage', sql.NVarChar(sql.MAX), errorMessage)
      .query(`
        UPDATE oe.PaymentAttempts
        SET
          Status = COALESCE(@status, Status),
          ProcessorTransactionId = COALESCE(@processorTransactionId, ProcessorTransactionId),
          ProcessorResponse = COALESCE(@processorResponse, ProcessorResponse),
          ErrorMessage = @errorMessage,
          ModifiedDate = SYSUTCDATETIME()
        WHERE IdempotencyKey = @idempotencyKey;

        SELECT TOP 1 *
        FROM oe.PaymentAttempts
        WHERE IdempotencyKey = @idempotencyKey
        ORDER BY CreatedDate DESC;
      `);

    return result.recordset?.[0] || null;
  }
}

module.exports = PaymentAttemptService;

