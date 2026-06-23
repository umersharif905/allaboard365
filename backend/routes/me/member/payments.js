const express = require('express');
const router = express.Router();
const { getEffectiveUserId } = require('../../../middleware/attachMemberHouseholdContext');
const { getPool, sql } = require('../../../config/database');

// Get member's payment history
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const tenantId = req.user.TenantId;
        
        // Get MemberId from UserId
        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        const memberResult = await memberRequest.query(`
            SELECT MemberId FROM oe.Members WHERE UserId = @userId
        `);
        
        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member record not found'
            });
        }
        
        const memberId = memberResult.recordset[0].MemberId;

        // Get member's payment history from oe.Payments table
        // Updated to join via HouseholdId since payments are now household-based
        const paymentsQuery = `
            SELECT 
                p.PaymentId,
                p.InvoiceId,
                p.Amount,
                p.PaymentDate,
                p.Status,
                p.PaymentMethod,
                p.TransactionType,
                p.EnrollmentId,
                p.NextBillingDate,
                p.ProcessorTransactionId,
                p.FailureReason,
                p.ACHReturnCode,
                p.ACHReturnReason,
                p.ChargebackReason,
                p.OriginalPaymentId,
                -- Get payment method details from MemberPaymentMethods
                mpm.PaymentMethodType,
                mpm.CardLast4,
                mpm.CardBrand,
                mpm.AccountNumberLast4,
                mpm.AccountType,
                -- Get product names from household enrollments that were active at payment time
                -- Shows historical enrollments even if terminated now
                STUFF((
                    SELECT ', ' + pr.Name
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products pr ON e.ProductId = pr.ProductId
                    WHERE e.HouseholdId = p.HouseholdId 
                      AND (
                        -- Enrollment was created before or at payment date
                        e.CreatedDate <= p.PaymentDate
                        -- And either still active OR was active during payment
                        AND (e.Status = 'Active' OR 
                             (e.EffectiveDate <= p.PaymentDate AND 
                              (e.TerminationDate IS NULL OR e.TerminationDate >= p.PaymentDate)))
                      )
                    FOR XML PATH(''), TYPE
                ).value('.', 'NVARCHAR(MAX)'), 1, 2, '') as ProductName,
                'Active' as EnrollmentStatus,
                -- Calculate LastPaymentDate for each household
                LAG(p.PaymentDate) OVER (PARTITION BY p.HouseholdId ORDER BY p.PaymentDate DESC) as LastPaymentDate
            FROM oe.Payments p
            INNER JOIN oe.Members m ON p.HouseholdId = m.HouseholdId
            LEFT JOIN oe.MemberPaymentMethods mpm ON m.MemberId = mpm.MemberId AND mpm.IsDefault = 1 AND mpm.Status = 'Active'
            WHERE m.MemberId = @memberId
                AND m.TenantId = @tenantId
            ORDER BY p.PaymentDate DESC
        `;

        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, memberId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        console.log('🔍 GET /api/me/member/payments - Querying with:', { userId, memberId, tenantId });
        const result = await request.query(paymentsQuery);
        console.log('🔍 Payment query result:', { recordCount: result.recordset.length, firstRecord: result.recordset[0] });

        const payments = result.recordset.map(payment => ({
            PaymentId: payment.PaymentId,
            InvoiceId: payment.InvoiceId,
            Amount: payment.Amount,
            PaymentDate: payment.PaymentDate,
            Status: payment.Status,
            PaymentMethod: payment.PaymentMethod,
            TransactionType: payment.TransactionType,
            EnrollmentId: payment.EnrollmentId,
            NextBillingDate: payment.NextBillingDate,
            ProcessorTransactionId: payment.ProcessorTransactionId,
            FailureReason: payment.FailureReason,
            ACHReturnCode: payment.ACHReturnCode,
            ACHReturnReason: payment.ACHReturnReason,
            ChargebackReason: payment.ChargebackReason,
            OriginalPaymentId: payment.OriginalPaymentId,
            ProductName: payment.ProductName,
            EnrollmentStatus: payment.EnrollmentStatus,
            // Payment method details for display
            PaymentMethodType: payment.PaymentMethodType,
            CardLast4: payment.CardLast4,
            CardBrand: payment.CardBrand,
            AccountNumberLast4: payment.AccountNumberLast4,
            AccountType: payment.AccountType
        }));

        res.json({
            success: true,
            data: payments,
            message: 'Payments retrieved successfully'
        });

    } catch (error) {
        console.error('Error fetching member payments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payments',
            error: {
                message: error.message,
                code: 'PAYMENTS_FETCH_ERROR'
            }
        });
    }
});

// Get member's payment method information (for individual billing)
router.get('/payment-method', async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const tenantId = req.user.TenantId;

        // Check if member is in a group (LB) or individual (SB)
        const memberQuery = `
            SELECT 
                m.MemberId,
                CASE WHEN m.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
                g.GroupId,
                g.GroupName
            FROM oe.Members m
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE m.UserId = @userId
                AND m.TenantId = @tenantId
        `;

        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        memberRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const memberResult = await memberRequest.query(memberQuery);

        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found',
                error: {
                    message: 'Member not found',
                    code: 'MEMBER_NOT_FOUND'
                }
            });
        }

        const member = memberResult.recordset[0];

        if (member.BillType === 'LB') {
            // Group billing - payment method managed by group
            const groupPaymentMethodQuery = `
                SELECT 
                    gpm.PaymentMethodId,
                    gpm.PaymentMethodType,
                    gpm.RoutingNumber,
                    gpm.CardLastFour,
                    gpm.CardExpiryMonth,
                    gpm.CardExpiryYear,
                    gpm.IsDefault,
                    gpm.Status
                FROM oe.GroupPaymentMethods gpm
                WHERE gpm.GroupId = @groupId
                    AND gpm.TenantId = @tenantId
                    AND gpm.Status = 'Active'
                ORDER BY gpm.IsDefault DESC, gpm.CreatedDate DESC
            `;

            const groupPaymentRequest = pool.request();
            groupPaymentRequest.input('groupId', sql.UniqueIdentifier, member.GroupId);
            groupPaymentRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            const groupPaymentResult = await groupPaymentRequest.query(groupPaymentMethodQuery);

            return res.json({
                success: true,
                data: {
                    billType: 'LB',
                    groupId: member.GroupId,
                    groupName: member.GroupName,
                    paymentMethods: groupPaymentResult.recordset,
                    message: 'Group payment methods retrieved successfully'
                }
            });

        } else {
            // Individual billing - get payment method from recent payments
            // Updated to join via HouseholdId since payments are now household-based
            const individualPaymentMethodQuery = `
                SELECT TOP 1
                    p.PaymentMethod,
                    p.PaymentDate,
                    p.Status
                FROM oe.Payments p
                INNER JOIN oe.Members m ON p.HouseholdId = m.HouseholdId
                WHERE m.MemberId = @memberId
                    AND m.TenantId = @tenantId
                    AND p.PaymentMethod IS NOT NULL
                ORDER BY p.PaymentDate DESC
            `;

            const individualPaymentRequest = pool.request();
            individualPaymentRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            individualPaymentRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            const individualPaymentResult = await individualPaymentRequest.query(individualPaymentMethodQuery);

            return res.json({
                success: true,
                data: {
                    billType: 'SB',
                    paymentMethod: individualPaymentResult.recordset[0]?.PaymentMethod || null,
                    lastPaymentDate: individualPaymentResult.recordset[0]?.PaymentDate || null,
                    lastPaymentStatus: individualPaymentResult.recordset[0]?.Status || null,
                    message: 'Individual payment method retrieved successfully'
                }
            });
        }

    } catch (error) {
        console.error('Error fetching member payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment method',
            error: {
                message: error.message,
                code: 'PAYMENT_METHOD_FETCH_ERROR'
            }
        });
    }
});

// Get member's enrollments with payment status and last payment date
router.get('/enrollments', async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const tenantId = req.user.TenantId;

        // Get enrollments with payment status and last payment date
        // Updated to join via HouseholdId since payments are now household-based
        const enrollmentsQuery = `
            SELECT 
                e.EnrollmentId,
                e.MemberId,
                e.ProductId,
                e.Status as EnrollmentStatus,
                e.EffectiveDate,
                e.TerminationDate,
                e.PremiumAmount,
                e.PaymentFrequency,
                pr.Name as ProductName,
                pr.ProductType,
                -- Get last payment date and status from household payments
                (SELECT TOP 1 p.PaymentDate 
                 FROM oe.Payments p 
                 WHERE p.HouseholdId = e.HouseholdId 
                 ORDER BY p.PaymentDate DESC) as LastPaymentDate,
                (SELECT TOP 1 p.Status 
                 FROM oe.Payments p 
                 WHERE p.HouseholdId = e.HouseholdId 
                 ORDER BY p.PaymentDate DESC) as PaymentStatus,
                -- Get next billing date from household payments
                (SELECT TOP 1 p.NextBillingDate 
                 FROM oe.Payments p 
                 WHERE p.HouseholdId = e.HouseholdId 
                 ORDER BY p.PaymentDate DESC) as NextBillingDate
            FROM oe.Enrollments e
            LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE m.UserId = @userId
                AND m.TenantId = @tenantId
                AND e.Status = 'Active'
                AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                AND e.ProductId != '00000000-0000-0000-0000-000000000000'
            ORDER BY e.EffectiveDate DESC
        `;

        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, userId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        const result = await request.query(enrollmentsQuery);

        const enrollments = result.recordset.map(enrollment => ({
            EnrollmentId: enrollment.EnrollmentId,
            MemberId: enrollment.MemberId,
            ProductId: enrollment.ProductId,
            ProductName: enrollment.ProductName,
            ProductType: enrollment.ProductType,
            EnrollmentStatus: enrollment.EnrollmentStatus,
            EffectiveDate: enrollment.EffectiveDate,
            TerminationDate: enrollment.TerminationDate,
            PremiumAmount: enrollment.PremiumAmount,
            PaymentFrequency: enrollment.PaymentFrequency,
            LastPaymentDate: enrollment.LastPaymentDate,
            PaymentStatus: enrollment.PaymentStatus,
            NextBillingDate: enrollment.NextBillingDate
        }));

        res.json({
            success: true,
            data: enrollments
        });

    } catch (error) {
        console.error('❌ Error fetching member enrollments with payment status:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching member enrollments',
            error: error.message
        });
    }
});

// Terminate a member's enrollment plan
router.post('/terminate-plan', async (req, res) => {
    try {
        const pool = await getPool();
        const { uid } = req.user;
        const tenantId = req.user.TenantId;
        const { enrollmentId, terminationReason } = req.body;

        if (!enrollmentId) {
            return res.status(400).json({
                success: false,
                message: 'EnrollmentId is required',
                error: {
                    message: 'EnrollmentId is required for plan termination',
                    code: 'MISSING_ENROLLMENT_ID'
                }
            });
        }

        // Verify the enrollment belongs to the member
        const verifyQuery = `
            SELECT e.EnrollmentId, e.Status, e.EffectiveDate, e.PaymentFrequency,
                   pr.Name as ProductName, m.GroupId
            FROM oe.Enrollments e
            LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            WHERE e.EnrollmentId = @enrollmentId
                AND m.MemberId = @memberId
                AND m.TenantId = @tenantId
        `;

        const verifyRequest = pool.request();
        verifyRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        verifyRequest.input('memberId', sql.UniqueIdentifier, uid);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const verifyResult = await verifyRequest.query(verifyQuery);

        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Enrollment not found or access denied',
                error: {
                    message: 'Enrollment not found or you do not have permission to terminate this plan',
                    code: 'ENROLLMENT_NOT_FOUND'
                }
            });
        }

        const enrollment = verifyResult.recordset[0];

        if (enrollment.Status !== 'Active') {
            return res.status(400).json({
                success: false,
                message: 'Cannot terminate inactive enrollment',
                error: {
                    message: 'This enrollment is not active and cannot be terminated',
                    code: 'ENROLLMENT_NOT_ACTIVE'
                }
            });
        }

        // Calculate termination date based on billing type
        let terminationDate;
        const today = new Date();
        
        if (enrollment.GroupId) {
            // Group billing (LB) - terminate at end of current month
            terminationDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        } else {
            // Individual billing (SB) - terminate at end of current billing cycle
            // For now, set to end of current month (can be enhanced with EffectiveDateLogic)
            terminationDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        }

        // Update the enrollment with termination date
        const terminateQuery = `
            UPDATE oe.Enrollments 
            SET TerminationDate = @terminationDate,
                Status = 'Terminated',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @memberId
            WHERE EnrollmentId = @enrollmentId
        `;

        const terminateRequest = pool.request();
        terminateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
        terminateRequest.input('terminationDate', sql.Date, terminationDate);
        terminateRequest.input('memberId', sql.UniqueIdentifier, uid);
        await terminateRequest.query(terminateQuery);

        res.json({
            success: true,
            data: {
                EnrollmentId: enrollmentId,
                ProductName: enrollment.ProductName,
                TerminationDate: terminationDate,
                TerminationReason: terminationReason || 'Member requested termination'
            },
            message: 'Plan terminated successfully. Termination will be effective at the end of the current billing cycle.'
        });

    } catch (error) {
        console.error('❌ Error terminating enrollment:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while terminating enrollment',
            error: error.message
        });
    }
});

// Update payment method for SB (Single Billing) members
router.put('/payment-method', async (req, res) => {
    try {
        const pool = await getPool();
        const { uid } = req.user;
        const tenantId = req.user.TenantId;
        const { paymentMethod, cardType, last4Digits, expirationDate, bankName } = req.body;

        if (!paymentMethod) {
            return res.status(400).json({
                success: false,
                message: 'Payment method is required',
                error: {
                    message: 'Payment method is required for update',
                    code: 'MISSING_PAYMENT_METHOD'
                }
            });
        }

        // Verify member is SB (Single Billing)
        const memberQuery = `
            SELECT m.MemberId, m.GroupId
            FROM oe.Members m
            WHERE m.MemberId = @memberId
                AND m.TenantId = @tenantId
        `;

        const memberRequest = pool.request();
        memberRequest.input('memberId', sql.UniqueIdentifier, uid);
        memberRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const memberResult = await memberRequest.query(memberQuery);

        if (memberResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found',
                error: {
                    message: 'Member not found',
                    code: 'MEMBER_NOT_FOUND'
                }
            });
        }

        const member = memberResult.recordset[0];

        if (member.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Payment method cannot be updated for group members',
                error: {
                    message: 'Group members (LB) cannot update their own payment methods',
                    code: 'GROUP_MEMBER_PAYMENT_UPDATE_NOT_ALLOWED'
                }
            });
        }

        // Update payment method in the most recent payment record
        // This is a simplified approach - in production, you might want to store payment methods separately
        const updateQuery = `
            UPDATE oe.Payments 
            SET PaymentMethod = @paymentMethod,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @memberId
            WHERE PaymentId = (
                SELECT TOP 1 PaymentId 
                FROM oe.Payments p
                LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
                LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
                WHERE m.MemberId = @memberId
                    AND m.TenantId = @tenantId
                ORDER BY p.PaymentDate DESC
            )
        `;

        const updateRequest = pool.request();
        updateRequest.input('paymentMethod', sql.NVarChar, paymentMethod);
        updateRequest.input('memberId', sql.UniqueIdentifier, uid);
        updateRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        await updateRequest.query(updateQuery);

        res.json({
            success: true,
            data: {
                PaymentMethod: paymentMethod,
                CardType: cardType,
                Last4Digits: last4Digits,
                ExpirationDate: expirationDate,
                BankName: bankName
            },
            message: 'Payment method updated successfully'
        });

    } catch (error) {
        console.error('❌ Error updating payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating payment method',
            error: error.message
        });
    }
});

module.exports = router;
