// backend/routes/me/vendor/payments.js
const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { getPool } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

// GET vendor payment history
router.get('/', authorize(['VendorAdmin', 'VendorAgent']), async (req, res) => {
    try {
        const pool = await getPool();
        const userId = req.user?.UserId || req.user?.userId;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated'
            });
        }

        // Get vendor ID from user
        const userRequest = pool.request();
        userRequest.input('userId', sql.UniqueIdentifier, userId);
        const userResult = await userRequest.query(`
            SELECT VendorId
            FROM oe.Users
            WHERE UserId = @userId
        `);

        if (userResult.recordset.length === 0 || !userResult.recordset[0].VendorId) {
            return res.status(404).json({
                success: false,
                message: 'Vendor not found for this user'
            });
        }

        const vendorId = userResult.recordset[0].VendorId;

        // Get payment history for this vendor
        // Note: This assumes there's a vendor payments table or relationship
        // Adjust query based on actual payment schema
        const paymentsRequest = pool.request();
        paymentsRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        
        // This is a placeholder query - adjust based on actual payment schema
        const paymentsResult = await paymentsRequest.query(`
            SELECT 
                PaymentId,
                Amount,
                PaymentDate,
                Status,
                ReferenceNumber,
                CreatedDate
            FROM oe.VendorPayments
            WHERE VendorId = @vendorId
            ORDER BY PaymentDate DESC
        `);

        res.json({
            success: true,
            data: paymentsResult.recordset
        });

    } catch (error) {
        console.error('Error fetching vendor payments:', error);
        // If table doesn't exist, return empty array
        if (error.message && error.message.includes('Invalid object name')) {
            return res.json({
                success: true,
                data: [],
                message: 'Payment history not available'
            });
        }
        res.status(500).json({
            success: false,
            message: 'Failed to fetch vendor payments',
            error: error.message
        });
    }
});

module.exports = router;

