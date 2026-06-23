// File: backend/routes/agent/agent-products.js

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');


/**
 * GET /api/agents/products
 * Get all products available to the agent
 */
router.get('/', authorize(['Agent']), requireTenantAccess, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT 
                p.ProductId, p.Name as ProductName, p.ProductType, p.Description, p.ProductImageUrl, 
                p.ProductLogoUrl, p.ProductDocumentUrl, t.Name as ProductOwnerName
            FROM oe.Products p
            LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            WHERE p.Status = 'Active' 
            AND p.IsMarketplaceProduct = 1
            AND (p.IsHidden IS NULL OR p.IsHidden = 0)
            ORDER BY p.Name
        `);
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('Error fetching agent products:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch products' });
    }
});

/**
 * GET /api/agents/products/:productId
 * Get details for a specific product
 */
router.get('/:productId', authorize(['Agent']), requireTenantAccess, async (req, res) => {
    try {
        const { productId } = req.params;
        const pool = await getPool();
        const result = await pool.request()
            .input('ProductId', sql.UniqueIdentifier, productId)
            .query(`
                SELECT 
                    p.*, t.Name as ProductOwnerName
                FROM oe.Products p
                LEFT JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
                WHERE p.ProductId = @ProductId 
                AND p.Status = 'Active' 
                AND p.IsMarketplaceProduct = 1
                AND (p.IsHidden IS NULL OR p.IsHidden = 0)
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
        res.json({ success: true, data: result.recordset[0] });
    } catch (error) {
        console.error('Error fetching product details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch product details' });
    }
});

module.exports = router; 