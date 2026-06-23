-- Fix sp_CalculateCommissions: oe.Commissions has no "Percentage" column (causes trigger to fail when marking payment Completed)
-- Run against the database that has the trigger (e.g. allaboard-prod). Then retry mark-payment-completed endpoint.

BEGIN
  IF OBJECT_ID('oe.sp_CalculateCommissions', 'P') IS NULL
  BEGIN
    RAISERROR('oe.sp_CalculateCommissions not found.', 16, 1);
    RETURN;
  END

  -- Alter procedure: remove Percentage from INSERT into oe.Commissions (column does not exist)
  EXEC('
    ALTER PROCEDURE [oe].[sp_CalculateCommissions]
        @PaymentId UNIQUEIDENTIFIER,
        @CalculationDate DATETIME2 = NULL,
        @Debug BIT = 0
    AS
    BEGIN
        SET NOCOUNT ON;

        BEGIN TRY
            BEGIN TRANSACTION;

            IF @CalculationDate IS NULL
                SET @CalculationDate = GETUTCDATE();

            DECLARE @EnrollmentId UNIQUEIDENTIFIER;
            DECLARE @MemberId UNIQUEIDENTIFIER;
            DECLARE @ProductId UNIQUEIDENTIFIER;
            DECLARE @AgentId UNIQUEIDENTIFIER;
            DECLARE @PremiumAmount DECIMAL(10,2);
            DECLARE @PaymentPeriod DATE;
            DECLARE @PaymentStatus NVARCHAR(20);
            DECLARE @CommissionId UNIQUEIDENTIFIER;

            SELECT
                @EnrollmentId = p.EnrollmentId,
                @PremiumAmount = p.Amount,
                @PaymentStatus = p.Status,
                @PaymentPeriod = CASE
                    WHEN DAY(p.PaymentDate) <= 15 THEN DATEFROMPARTS(YEAR(p.PaymentDate), MONTH(p.PaymentDate), 1)
                    ELSE DATEFROMPARTS(YEAR(p.PaymentDate), MONTH(p.PaymentDate), 15)
                END
            FROM oe.Payments p
            WHERE p.PaymentId = @PaymentId;

            IF @PaymentStatus != ''Completed''
            BEGIN
                IF @Debug = 1 PRINT ''Payment is not completed. Skipping commission calculation.'';
                ROLLBACK TRANSACTION;
                RETURN;
            END

            IF EXISTS (SELECT 1 FROM oe.CommissionLogs WHERE PaymentId = @PaymentId)
            BEGIN
                IF @Debug = 1 PRINT ''Commissions already calculated for this payment.'';
                ROLLBACK TRANSACTION;
                RETURN;
            END

            SELECT
                @MemberId = e.MemberId,
                @ProductId = e.ProductId,
                @AgentId = ISNULL(e.AgentId, m.AgentId),
                @PremiumAmount = ISNULL(@PremiumAmount, e.PremiumAmount)
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE e.EnrollmentId = @EnrollmentId;

            IF @Debug = 1
            BEGIN
                PRINT ''Processing Payment: '' + CAST(@PaymentId as NVARCHAR(36));
                PRINT ''Agent: '' + ISNULL(CAST(@AgentId as NVARCHAR(36)), ''NULL'');
                PRINT ''Product: '' + CAST(@ProductId as NVARCHAR(36));
                PRINT ''Premium: $'' + CAST(@PremiumAmount as NVARCHAR(20));
            END

            IF @AgentId IS NULL
            BEGIN
                IF @Debug = 1 PRINT ''No agent assigned. Skipping commission calculation.'';
                ROLLBACK TRANSACTION;
                RETURN;
            END

            SET @CommissionId = NEWID();

            DECLARE @TotalPercentage DECIMAL(5,4) = 0;

            SELECT TOP 1 @TotalPercentage = ISNULL(cr.CommissionRate, 0.0500)
            FROM oe.CommissionRules cr
            WHERE cr.ProductId = @ProductId
                AND cr.EntityType = ''Tier''
                AND cr.TierLevel = 0
                AND cr.Status = ''Active''
                AND cr.EffectiveDate <= @CalculationDate
                AND (cr.TerminationDate IS NULL OR cr.TerminationDate >= @CalculationDate);

            IF @TotalPercentage = 0
                SET @TotalPercentage = 0.0500;

            -- INSERT without Percentage (column does not exist on oe.Commissions)
            INSERT INTO oe.Commissions (
                CommissionId,
                EnrollmentId,
                AgentId,
                PaymentId,
                Amount,
                Status,
                CreatedDate,
                ModifiedDate
            )
            VALUES (
                @CommissionId,
                @EnrollmentId,
                @AgentId,
                @PaymentId,
                0,
                ''Calculated'',
                @CalculationDate,
                @CalculationDate
            );

            INSERT INTO oe.CommissionLogs (
                CommissionId, PaymentId, MemberId, ProductId, EnrollmentId,
                AgentId, BeneficiaryType, BeneficiaryId, TierLevel, RuleId,
                PremiumAmount, CommissionRate, CommissionAmount, CommissionType,
                PaymentPeriod, CalculationDate, HoldUntilDate, PaymentStatus, Notes
            )
            SELECT
                @CommissionId,
                @PaymentId,
                @MemberId,
                @ProductId,
                @EnrollmentId,
                @AgentId,
                upline.EntityType as BeneficiaryType,
                upline.EntityId as BeneficiaryId,
                upline.TierLevel,
                cr.RuleId,
                @PremiumAmount,
                COALESCE(
                    cr.CommissionRate,
                    upline.OverridePercentage,
                    0.0000
                ) as CommissionRate,
                CASE
                    WHEN cr.CommissionType = ''Flat'' THEN cr.FlatAmount
                    ELSE @PremiumAmount * COALESCE(cr.CommissionRate, upline.OverridePercentage, 0.0000)
                END as CommissionAmount,
                CASE
                    WHEN upline.TierLevel = 0 THEN ''New''
                    ELSE ''Override''
                END as CommissionType,
                @PaymentPeriod,
                @CalculationDate,
                DATEADD(DAY, 10, @CalculationDate) as HoldUntilDate,
                ''Hold'' as PaymentStatus,
                ''Auto-calculated from payment '' + CAST(@PaymentId as NVARCHAR(36))
            FROM oe.fn_GetAgentUpline(@AgentId, @CalculationDate) upline
            LEFT JOIN oe.CommissionRules cr ON
                cr.ProductId = @ProductId AND
                cr.Status = ''Active'' AND
                cr.EffectiveDate <= @CalculationDate AND
                (cr.TerminationDate IS NULL OR cr.TerminationDate >= @CalculationDate) AND
                (
                    (cr.EntityType = upline.EntityType AND cr.EntityId = upline.EntityId) OR
                    (cr.EntityType = ''Tier'' AND cr.TierLevel = upline.TierLevel) OR
                    (cr.EntityType = ''Agency'' AND cr.EntityId IS NULL AND upline.EntityType = ''Agency'')
                )
            WHERE
                (
                    COALESCE(cr.CommissionRate, upline.OverridePercentage, 0.0000) > 0 OR
                    COALESCE(cr.FlatAmount, 0) > 0
                )
            ORDER BY upline.TierLevel;

            UPDATE oe.Commissions
            SET Amount = (SELECT ISNULL(SUM(CommissionAmount), 0) FROM oe.CommissionLogs WHERE CommissionId = @CommissionId)
            WHERE CommissionId = @CommissionId;

            IF @Debug = 1
            BEGIN
                SELECT
                    ''Commission Calculated'' as Status,
                    BeneficiaryType,
                    BeneficiaryId,
                    TierLevel,
                    CommissionRate,
                    CommissionAmount
                FROM oe.CommissionLogs
                WHERE CommissionId = @CommissionId
                ORDER BY TierLevel;
            END

            COMMIT TRANSACTION;
        END TRY
        BEGIN CATCH
            IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;

            DECLARE @ErrorMessage NVARCHAR(4000) = ERROR_MESSAGE();
            DECLARE @ErrorSeverity INT = ERROR_SEVERITY();
            DECLARE @ErrorState INT = ERROR_STATE();

            RAISERROR(@ErrorMessage, @ErrorSeverity, @ErrorState);
        END CATCH
    END;
  ');

  PRINT 'oe.sp_CalculateCommissions updated: removed Percentage from INSERT into oe.Commissions.';
END
GO
