const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const {
  getEffectiveUserId,
  getActorUserId,
} = require('../../../middleware/attachMemberHouseholdContext');
const DimeService = require('../../../services/dimeService');
const PaymentMethodService = require('../../../services/PaymentMethodService');
const {
    fetchPreviousDefaultProcessorPmId,
    runPaymentMethodRecurringSync,
} = require('../../../services/paymentMethodRecurringRouteHelper');
const posthog = require('../../../config/posthog');

// =============================================
// GET /api/me/member/payment-methods
// Get member's payment methods
// =============================================
router.get('/', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const auditUserId = getActorUserId(req);
        const tenantId = req.user.TenantId;

        // Get member's payment methods
        const query = `
            SELECT 
                mpm.PaymentMethodId,
                mpm.PaymentMethodType,
                mpm.IsDefault,
                mpm.Status,
                mpm.BankName,
                mpm.AccountType,
                mpm.RoutingNumber,
                mpm.AccountNumberLast4,
                mpm.AccountHolderName,
                mpm.CardBrand,
                mpm.CardLast4,
                mpm.ExpiryMonth,
                mpm.ExpiryYear,
                mpm.CardholderName,
                mpm.BillingAddress,
                mpm.BillingAddress2,
                mpm.BillingCity,
                mpm.BillingState,
                mpm.BillingZip,
                mpm.BillingCountry,
                mpm.ProcessorToken,
                mpm.ProcessorCustomerId,
                mpm.ProcessorPaymentMethodId,
                mpm.CreatedDate,
                mpm.ModifiedDate
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE m.UserId = @userId
                AND mpm.TenantId = @tenantId
                AND mpm.Status = 'Active'
            ORDER BY mpm.IsDefault DESC, mpm.CreatedDate DESC
        `;

        const request = pool.request();
        request.input('userId', sql.UniqueIdentifier, userId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        const result = await request.query(query);

        const paymentMethods = result.recordset.map(pm => ({
            paymentMethodId: pm.PaymentMethodId,
            paymentMethodType: pm.PaymentMethodType,
            isDefault: pm.IsDefault,
            status: pm.Status,
            bankName: pm.BankName,
            accountType: pm.AccountType,
            routingNumber: pm.RoutingNumber, // Note: This will be null for new DIME tokenized methods
            accountNumberLast4: pm.AccountNumberLast4,
            accountHolderName: pm.AccountHolderName,
            cardBrand: pm.CardBrand,
            cardLast4: pm.CardLast4,
            expiryMonth: pm.ExpiryMonth,
            expiryYear: pm.ExpiryYear,
            cardholderName: pm.CardholderName,
            billingAddress: pm.BillingAddress,
            billingAddress2: pm.BillingAddress2,
            billingCity: pm.BillingCity,
            billingState: pm.BillingState,
            billingZip: pm.BillingZip,
            billingCountry: pm.BillingCountry,
            processorToken: pm.ProcessorToken,
            processorCustomerId: pm.ProcessorCustomerId,
            processorPaymentMethodId: pm.ProcessorPaymentMethodId,
            createdDate: pm.CreatedDate,
            modifiedDate: pm.ModifiedDate
        }));

        // Validate DIME payment methods
        const validatedPaymentMethods = [];
        for (const paymentMethod of paymentMethods) {
            if (paymentMethod.processorToken && paymentMethod.processorCustomerId && paymentMethod.processorPaymentMethodId) {
                // Temporarily disable DIME validation due to 404 errors
                // TODO: Fix DIME validation endpoint or implement alternative validation
                console.log(`🔍 Skipping DIME validation for payment method ${paymentMethod.paymentMethodId} (temporarily disabled)`);
                
                // try {
                //     const validation = await DimeService.validatePaymentMethod(
                //         paymentMethod.processorPaymentMethodId, 
                //         paymentMethod.processorCustomerId
                //     );
                //     
                //     if (!validation.isValid) {
                //         console.log(`⚠️ Payment method ${paymentMethod.paymentMethodId} is no longer valid in DIME`);
                //         // Mark as inactive in database
                //         const updateQuery = `
                //             UPDATE oe.MemberPaymentMethods 
                //             SET Status = 'Inactive', ModifiedDate = GETUTCDATE(), ModifiedBy = @auditUserId
                //             WHERE PaymentMethodId = @paymentMethodId
                //         `;
                //         const updateRequest = pool.request();
                //         updateRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
                //         updateRequest.input('paymentMethodId', sql.UniqueIdentifier, paymentMethod.paymentMethodId);
                //         await updateRequest.query(updateQuery);
                //         continue; // Skip adding to results
                //     }
                // } catch (validationError) {
                //     console.error('Error validating payment method:', validationError);
                //     // Continue with the payment method if validation fails
                // }
            }
            validatedPaymentMethods.push(paymentMethod);
        }

        console.log(`✅ ${validatedPaymentMethods.length} payment methods validated and returned`);

        res.json({
            success: true,
            data: validatedPaymentMethods,
            message: 'Payment methods retrieved successfully'
        });

    } catch (error) {
        console.error('Error fetching member payment methods:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payment methods',
            error: {
                message: error.message,
                code: 'PAYMENT_METHODS_FETCH_ERROR'
            }
        });
    }
});

// =============================================
// POST /api/me/member/payment-methods
// Add new payment method for member (DIME Integration)
// =============================================
router.post('/', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const auditUserId = getActorUserId(req);
        const tenantId = req.user.TenantId;
        const {
            paymentMethodType,
            bankName,
            accountType,
            routingNumber,
            accountNumber,
            accountHolderName,
            cardBrand,
            cardNumber,
            expiryMonth,
            expiryYear,
            cvv,
            cardholderName,
            billingAddress,
            billingAddress2,
            billingCity,
            billingState,
            billingZip,
            billingCountry,
            isDefault
        } = req.body;

        console.log('🔍 DEBUG: Received payment method data:', {
            paymentMethodType,
            cardNumber: cardNumber ? `${cardNumber.slice(0, 4)}****${cardNumber.slice(-4)}` : 'undefined',
            expiryMonth,
            expiryYear,
            cvv: cvv ? '***' : 'undefined',
            cardholderName,
            billingAddress,
            billingCity,
            billingState,
            billingZip,
            billingCountry
        });

        if (!paymentMethodType) {
            return res.status(400).json({
                success: false,
                message: 'Payment method type is required',
                error: {
                    message: 'Payment method type is required',
                    code: 'MISSING_PAYMENT_METHOD_TYPE'
                }
            });
        }

        // Validate member exists and is SB (Single Billing)
        const memberQuery = `
            SELECT m.MemberId, m.HouseholdId, m.GroupId, m.UserId, m.TenantId, m.ProcessorCustomerId,
                   u.FirstName, u.LastName, u.Email, u.PhoneNumber
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
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

        if (member.GroupId) {
            return res.status(400).json({
                success: false,
                message: 'Payment methods cannot be managed for group members',
                error: {
                    message: 'Group members (LB) cannot manage their own payment methods',
                    code: 'GROUP_MEMBER_PAYMENT_MANAGEMENT_NOT_ALLOWED'
                }
            });
        }

        const previousProcessorPaymentMethodId = await fetchPreviousDefaultProcessorPmId(
            pool,
            member.MemberId
        );

        // If this is being set as default, remove default from other payment methods
        if (isDefault) {
            const removeDefaultQuery = `
                UPDATE oe.MemberPaymentMethods
                SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @auditUserId
                WHERE MemberId = @memberId AND TenantId = @tenantId
            `;
            
            const removeDefaultRequest = pool.request();
            removeDefaultRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
            removeDefaultRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            removeDefaultRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
            await removeDefaultRequest.query(removeDefaultQuery);
        }

        // Prepare billing address for DIME
        const billingAddressData = {
            address: billingAddress || '',
            address2: billingAddress2 || '',
            city: billingCity || '',
            state: billingState || '',
            zip: billingZip || '',
            country: billingCountry || 'US'
        };

        // Ensure DIME customer exists using unified service
        const customerData = {
            firstName: member.FirstName,
            lastName: member.LastName,
            email: member.Email,
            phone: req.body.phoneNumber || member.PhoneNumber || '',
            billingAddress: billingAddress,
            billingCity: billingCity,
            billingState: billingState,
            billingZip: billingZip,
            billingCountry: billingCountry || 'US'
        };

        console.log('🔍 DEBUG: Customer data being passed to DIME:', JSON.stringify(customerData, null, 2));
        
        const customerResult = await PaymentMethodService.ensureDimeCustomer(customerData, 'member', member.MemberId, member.TenantId);
        if (!customerResult.success) {
            console.error('❌ Failed to ensure DIME customer:', customerResult.error);
            return res.status(500).json({
                success: false,
                message: 'Failed to create payment processor customer',
                error: {
                    message: customerResult.error?.message || 'Customer creation failed',
                    code: 'CUSTOMER_CREATION_FAILED'
                }
            });
        }
        
        const dimeCustomerId = customerResult.customerId;

        // Validate payment method data
        const validation = PaymentMethodService.validatePaymentMethodData(req.body, paymentMethodType);
        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment method data',
                error: {
                    message: 'Validation failed',
                    code: 'VALIDATION_FAILED',
                    details: validation.errors
                }
            });
        }

        // Create payment method with DIME using unified service (includes proper tokenization)
        const dimeResult = await PaymentMethodService.createPaymentMethod(req.body, dimeCustomerId, member.TenantId);

        // Check if DIME payment method creation was successful
        if (!dimeResult.success) {
            console.error('❌ DIME payment method creation failed:', dimeResult.error);
            return res.status(400).json({
                success: false,
                message: 'Failed to create payment method',
                error: {
                    message: dimeResult.error.message,
                    code: dimeResult.error.code || 'PAYMENT_METHOD_CREATION_FAILED'
                }
            });
        }

        console.log('✅ DIME payment method creation successful:', {
            hasToken: !!dimeResult.token,
            hasCustomerId: !!dimeResult.customerId,
            hasPaymentMethodId: !!dimeResult.paymentMethodId
        });

        // Insert payment method using unified service (includes encryption)
        const insertResult =         await PaymentMethodService.insertPaymentMethod(
            req.body, 
            'member', 
            member.MemberId, 
            dimeResult, 
            auditUserId, 
            tenantId
        );
        
        if (!insertResult.success) {
            return res.status(500).json({
                success: false,
                message: 'Failed to save payment method to database',
                error: {
                    message: insertResult.error.message,
                    code: insertResult.error.code
                }
            });
        }

        console.log('✅ Payment method saved to database with DIME tokens');

        // Verify the payment method was created with DIME fields
        const verifyQuery = `
            SELECT ProcessorCustomerId, ProcessorPaymentMethodId, ProcessorToken
            FROM oe.MemberPaymentMethods 
            WHERE MemberId = @memberId 
                AND TenantId = @tenantId 
                AND Status = 'Active'
            ORDER BY CreatedDate DESC
        `;
        
        const verifyRequest = pool.request();
        verifyRequest.input('memberId', sql.UniqueIdentifier, member.MemberId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const verifyResult = await verifyRequest.query(verifyQuery);
        
        if (verifyResult.recordset.length === 0) {
            console.error('❌ Payment method not found after insert');
            return res.status(500).json({
                success: false,
                message: 'Payment method creation failed - verification error',
                error: {
                    message: 'Payment method not found after creation',
                    code: 'VERIFICATION_FAILED'
                }
            });
        }
        
        const savedPaymentMethod = verifyResult.recordset[0];
        if (!savedPaymentMethod.ProcessorCustomerId || !savedPaymentMethod.ProcessorPaymentMethodId) {
            console.error('❌ Payment method created without DIME fields:', savedPaymentMethod);
            return res.status(500).json({
                success: false,
                message: 'Payment method created without required DIME integration',
                error: {
                    message: 'DIME integration fields missing from saved payment method',
                    code: 'DIME_FIELDS_MISSING'
                }
            });
        }
        
        console.log('✅ Payment method verified with DIME fields:', {
            hasCustomerId: !!savedPaymentMethod.ProcessorCustomerId,
            hasPaymentMethodId: !!savedPaymentMethod.ProcessorPaymentMethodId,
            hasToken: !!savedPaymentMethod.ProcessorToken
        });

        // Update payment method defaults using unified service
        // Always make new payment methods default
        await PaymentMethodService.updatePaymentMethodDefaults('member', member.MemberId, insertResult.paymentMethodId, auditUserId, tenantId);

        const recurringSync = member.HouseholdId
            ? await runPaymentMethodRecurringSync(pool, {
                householdId: member.HouseholdId,
                tenantId,
                paymentMethodId: insertResult.paymentMethodId,
                previousProcessorPaymentMethodId,
            })
            : {};

        posthog.capture({
            distinctId: String(userId),
            event: 'payment method added',
            properties: {
                payment_method_type: paymentMethodType,
                member_id: String(member.MemberId),
                tenant_id: tenantId ? String(tenantId) : undefined,
            },
        });

        res.json({
            success: true,
            message: 'Payment method added successfully',
            data: {
                paymentMethodType,
                isDefault: true, // Always default for new payment methods
                processorToken: dimeResult.token,
                processorCustomerId: dimeResult.customerId,
                processorPaymentMethodId: dimeResult.paymentMethodId,
                ...recurringSync,
            }
        });

    } catch (error) {
        posthog.captureException(error, req.user?.UserId ? String(req.user.UserId) : undefined);
        console.error('Error adding payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add payment method',
            error: {
                message: error.message,
                code: 'PAYMENT_METHOD_ADD_ERROR'
            }
        });
    }
});

// =============================================
// PUT /api/me/member/payment-methods/:id
// Update existing payment method
// =============================================
router.put('/:id', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const auditUserId = getActorUserId(req);
        const tenantId = req.user.TenantId;
        const { id } = req.params;
        const {
            bankName,
            accountType,
            routingNumber,
            accountNumber,
            accountHolderName,
            cardBrand,
            cardNumber,
            expiryMonth,
            expiryYear,
            cardholderName,
            billingAddress,
            billingAddress2,
            billingCity,
            billingState,
            billingZip,
            billingCountry,
            isDefault
        } = req.body;

        // Verify payment method belongs to member
        const verifyQuery = `
            SELECT mpm.PaymentMethodId, mpm.PaymentMethodType, mpm.IsDefault
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE mpm.PaymentMethodId = @paymentMethodId
                AND m.UserId = @userId
                AND mpm.TenantId = @tenantId
                AND mpm.Status = 'Active'
        `;

        const verifyRequest = pool.request();
        verifyRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        verifyRequest.input('userId', sql.UniqueIdentifier, userId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const verifyResult = await verifyRequest.query(verifyQuery);

        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Payment method not found or access denied',
                error: {
                    message: 'Payment method not found or you do not have permission to update it',
                    code: 'PAYMENT_METHOD_NOT_FOUND'
                }
            });
        }

        const paymentMethod = verifyResult.recordset[0];

        // If this is being set as default, remove default from other payment methods
        if (isDefault && !paymentMethod.IsDefault) {
            const removeDefaultQuery = `
                UPDATE oe.MemberPaymentMethods
                SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @auditUserId
                FROM oe.MemberPaymentMethods mpm
                INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
                WHERE m.UserId = @userId AND mpm.TenantId = @tenantId AND mpm.PaymentMethodId != @paymentMethodId
            `;
            
            const removeDefaultRequest = pool.request();
            removeDefaultRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
            removeDefaultRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            removeDefaultRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
            await removeDefaultRequest.query(removeDefaultQuery);
        }

        // Prepare data based on payment method type
        let accountNumberLast4 = null;
        let cardLast4 = null;

        if (paymentMethod.PaymentMethodType === 'ACH' && accountNumber) {
            accountNumberLast4 = accountNumber.slice(-4);
        } else if (paymentMethod.PaymentMethodType === 'CreditCard' && cardNumber) {
            cardLast4 = cardNumber.slice(-4);
        }

        // Update payment method
        const updateQuery = `
            UPDATE oe.MemberPaymentMethods
            SET BankName = @bankName,
                AccountType = @accountType,
                RoutingNumber = @routingNumber,
                AccountNumberLast4 = @accountNumberLast4,
                AccountHolderName = @accountHolderName,
                CardBrand = @cardBrand,
                CardLast4 = @cardLast4,
                ExpiryMonth = @expiryMonth,
                ExpiryYear = @expiryYear,
                CardholderName = @cardholderName,
                BillingAddress = @billingAddress,
                BillingAddress2 = @billingAddress2,
                BillingCity = @billingCity,
                BillingState = @billingState,
                BillingZip = @billingZip,
                BillingCountry = @billingCountry,
                IsDefault = @isDefault,
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @auditUserId
            WHERE PaymentMethodId = @paymentMethodId
        `;

        const updateRequest = pool.request();
        updateRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        updateRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
        updateRequest.input('bankName', sql.NVarChar, bankName || null);
        updateRequest.input('accountType', sql.NVarChar, accountType || null);
        updateRequest.input('routingNumber', sql.NVarChar, routingNumber || null);
        updateRequest.input('accountNumberLast4', sql.NVarChar, accountNumberLast4);
        updateRequest.input('accountHolderName', sql.NVarChar, accountHolderName || null);
        updateRequest.input('cardBrand', sql.NVarChar, cardBrand || null);
        updateRequest.input('cardLast4', sql.NVarChar, cardLast4);
        updateRequest.input('expiryMonth', sql.Int, expiryMonth || null);
        updateRequest.input('expiryYear', sql.Int, expiryYear || null);
        updateRequest.input('cardholderName', sql.NVarChar, cardholderName || null);
        updateRequest.input('billingAddress', sql.NVarChar, billingAddress || null);
        updateRequest.input('billingAddress2', sql.NVarChar, billingAddress2 || null);
        updateRequest.input('billingCity', sql.NVarChar, billingCity || null);
        updateRequest.input('billingState', sql.NVarChar, billingState || null);
        updateRequest.input('billingZip', sql.NVarChar, billingZip || null);
        updateRequest.input('billingCountry', sql.NVarChar, billingCountry || 'US');
        updateRequest.input('isDefault', sql.Bit, isDefault || false);

        await updateRequest.query(updateQuery);

        res.json({
            success: true,
            message: 'Payment method updated successfully'
        });

    } catch (error) {
        console.error('Error updating payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update payment method',
            error: {
                message: error.message,
                code: 'PAYMENT_METHOD_UPDATE_ERROR'
            }
        });
    }
});

// =============================================
// DELETE /api/me/member/payment-methods/:id
// Delete payment method (soft delete)
// =============================================
router.delete('/:id', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const auditUserId = getActorUserId(req);
        const tenantId = req.user.TenantId;
        const { id } = req.params;

        // Verify payment method belongs to member
        const verifyQuery = `
            SELECT mpm.PaymentMethodId, mpm.IsDefault, mpm.ProcessorPaymentMethodId
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE mpm.PaymentMethodId = @paymentMethodId
                AND m.UserId = @userId
                AND mpm.TenantId = @tenantId
                AND mpm.Status = 'Active'
        `;

        const verifyRequest = pool.request();
        verifyRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        verifyRequest.input('userId', sql.UniqueIdentifier, userId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const verifyResult = await verifyRequest.query(verifyQuery);

        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Payment method not found or access denied',
                error: {
                    message: 'Payment method not found or you do not have permission to delete it',
                    code: 'PAYMENT_METHOD_NOT_FOUND'
                }
            });
        }

        const paymentMethod = verifyResult.recordset[0];

        // Delete payment method from DIME if it exists
        if (paymentMethod.ProcessorPaymentMethodId) {
            console.log('🔍 DEBUG: Deleting payment method from DIME:', {
                processorPaymentMethodId: paymentMethod.ProcessorPaymentMethodId
            });

            const dimeDeleteResult = await DimeService.deletePaymentMethod(paymentMethod.ProcessorPaymentMethodId, tenantId);
            
            if (dimeDeleteResult.success) {
                console.log('✅ Payment method deleted from DIME successfully');
            } else {
                console.warn('⚠️ Failed to delete payment method from DIME:', dimeDeleteResult.error);
                // Continue with local deletion even if DIME deletion fails
            }
        }

        // Soft delete the payment method from database
        const deleteQuery = `
            UPDATE oe.MemberPaymentMethods
            SET Status = 'Inactive',
                ModifiedDate = GETUTCDATE(),
                ModifiedBy = @auditUserId
            WHERE PaymentMethodId = @paymentMethodId
        `;

        const deleteRequest = pool.request();
        deleteRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        deleteRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
        await deleteRequest.query(deleteQuery);

        // If this was the default payment method, set another one as default
        if (paymentMethod.IsDefault) {
            const setNewDefaultQuery = `
                UPDATE TOP 1 oe.MemberPaymentMethods
                SET IsDefault = 1,
                    ModifiedDate = GETUTCDATE(),
                    ModifiedBy = @auditUserId
                WHERE PaymentMethodId IN (
                    SELECT TOP 1 mpm.PaymentMethodId
                    FROM oe.MemberPaymentMethods mpm
                    INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
                    WHERE m.UserId = @userId 
                        AND mpm.TenantId = @tenantId 
                        AND mpm.Status = 'Active'
                        AND mpm.PaymentMethodId != @paymentMethodId
                    ORDER BY mpm.CreatedDate DESC
                )
            `;
            
            const setNewDefaultRequest = pool.request();
            setNewDefaultRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
            setNewDefaultRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            setNewDefaultRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
            await setNewDefaultRequest.query(setNewDefaultQuery);
        }

        res.json({
            success: true,
            message: 'Payment method deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete payment method',
            error: {
                message: error.message,
                code: 'PAYMENT_METHOD_DELETE_ERROR'
            }
        });
    }
});

// =============================================
// PUT /api/me/member/payment-methods/:id/set-default
// Set payment method as default
// =============================================
router.put('/:id/set-default', authorize(['Member']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = getEffectiveUserId(req);
        const auditUserId = getActorUserId(req);
        const tenantId = req.user.TenantId;
        const { id } = req.params;

        // Verify payment method belongs to member and get DIME info
        const verifyQuery = `
            SELECT mpm.PaymentMethodId, mpm.ProcessorToken, mpm.ProcessorPaymentMethodId,
                   m.HouseholdId, m.MemberId
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE mpm.PaymentMethodId = @paymentMethodId
                AND m.UserId = @userId
                AND mpm.TenantId = @tenantId
                AND mpm.Status = 'Active'
        `;

        const verifyRequest = pool.request();
        verifyRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        verifyRequest.input('userId', sql.UniqueIdentifier, userId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const verifyResult = await verifyRequest.query(verifyQuery);

        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Payment method not found or access denied',
                error: {
                    message: 'Payment method not found or you do not have permission to modify it',
                    code: 'PAYMENT_METHOD_NOT_FOUND'
                }
            });
        }

        const paymentMethod = verifyResult.recordset[0];
        const previousProcessorPaymentMethodId = await fetchPreviousDefaultProcessorPmId(
            pool,
            paymentMethod.MemberId
        );

        // Get all DIME payment methods to update their default status
        const allPaymentMethodsQuery = `
            SELECT mpm.PaymentMethodId, mpm.ProcessorToken, mpm.ProcessorPaymentMethodId
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE m.UserId = @userId 
                AND mpm.TenantId = @tenantId 
                AND mpm.Status = 'Active'
                AND mpm.ProcessorToken IS NOT NULL
        `;

        const allPaymentMethodsRequest = pool.request();
        allPaymentMethodsRequest.input('userId', sql.UniqueIdentifier, userId);
        allPaymentMethodsRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        const allPaymentMethodsResult = await allPaymentMethodsRequest.query(allPaymentMethodsQuery);

        // Update DIME payment methods' default status
        for (const pm of allPaymentMethodsResult.recordset) {
            if (pm.ProcessorPaymentMethodId) {
                const isDefault = pm.PaymentMethodId === id;
                try {
                    await DimeService.updatePaymentMethodDefault(pm.ProcessorPaymentMethodId, isDefault, tenantId);
                    console.log(`✅ Updated DIME payment method ${pm.ProcessorPaymentMethodId} default status to ${isDefault}`);
                } catch (error) {
                    console.error(`❌ Failed to update DIME payment method ${pm.ProcessorPaymentMethodId}:`, error);
                    // Continue with database update even if DIME update fails
                }
            }
        }

        // Remove default from all other payment methods
        const removeDefaultQuery = `
            UPDATE oe.MemberPaymentMethods
            SET IsDefault = 0, ModifiedDate = GETUTCDATE(), ModifiedBy = @auditUserId
            FROM oe.MemberPaymentMethods mpm
            INNER JOIN oe.Members m ON mpm.MemberId = m.MemberId
            WHERE m.UserId = @userId AND mpm.TenantId = @tenantId
        `;
        
        const removeDefaultRequest = pool.request();
        removeDefaultRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
        removeDefaultRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        await removeDefaultRequest.query(removeDefaultQuery);

        // Set this payment method as default
        const setDefaultQuery = `
            UPDATE oe.MemberPaymentMethods
            SET IsDefault = 1, ModifiedDate = GETUTCDATE(), ModifiedBy = @auditUserId
            WHERE PaymentMethodId = @paymentMethodId
        `;
        
        const setDefaultRequest = pool.request();
        setDefaultRequest.input('paymentMethodId', sql.UniqueIdentifier, id);
        setDefaultRequest.input('auditUserId', sql.UniqueIdentifier, auditUserId);
        await setDefaultRequest.query(setDefaultQuery);

        const recurringSync = paymentMethod.HouseholdId
            ? await runPaymentMethodRecurringSync(pool, {
                householdId: paymentMethod.HouseholdId,
                tenantId,
                paymentMethodId: id,
                previousProcessorPaymentMethodId,
            })
            : {};

        res.json({
            success: true,
            message: 'Payment method set as default successfully',
            data: recurringSync,
        });

    } catch (error) {
        console.error('Error setting default payment method:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to set default payment method',
            error: {
                message: error.message,
                code: 'PAYMENT_METHOD_SET_DEFAULT_ERROR'
            }
        });
    }
});

module.exports = router;
