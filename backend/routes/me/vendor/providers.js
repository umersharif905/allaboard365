// routes/me/vendor/providers.js
// Provider Management routes for Vendor Portal

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');
const ProviderService = require('../../../services/providerService');

// All routes require authentication and vendor access
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(requireShareRequestAccess);

// ============================================================================
// PROVIDER CRUD
// ============================================================================

/**
 * GET /api/me/vendor/providers
 * Get all providers with filtering and pagination
 */
router.get('/', async (req, res) => {
    try {
        const result = await ProviderService.getProviders(req.vendor.VendorId, {
            page: req.query.page,
            limit: req.query.limit,
            search: req.query.search,
            providerType: req.query.providerType,
            isActive: req.query.isActive,
            sortBy: req.query.sortBy,
            sortOrder: req.query.sortOrder
        });

        res.json({
            success: true,
            data: result.data,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('❌ Error fetching providers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch providers',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/search
 * Search providers for autocomplete
 */
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;

        if (!q || q.length < 2) {
            return res.json({
                success: true,
                data: []
            });
        }

        const providers = await ProviderService.searchProviders(
            req.vendor.VendorId,
            q,
            parseInt(limit)
        );

        res.json({
            success: true,
            data: providers
        });
    } catch (error) {
        console.error('❌ Error searching providers:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search providers',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/types
 * Get distinct provider types
 */
router.get('/types', async (req, res) => {
    try {
        const types = await ProviderService.getProviderTypes(req.vendor.VendorId);

        res.json({
            success: true,
            data: types
        });
    } catch (error) {
        console.error('❌ Error fetching provider types:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch provider types',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/stats
 * Get provider statistics
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await ProviderService.getProviderStats(req.vendor.VendorId);

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('❌ Error fetching provider stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch provider statistics',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/providers/:id
 * Get a single provider by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const provider = await ProviderService.getProviderById(
            req.params.id,
            req.vendor.VendorId
        );

        if (!provider) {
            return res.status(404).json({
                success: false,
                message: 'Provider not found'
            });
        }

        res.json({
            success: true,
            data: provider
        });
    } catch (error) {
        console.error('❌ Error fetching provider:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch provider',
            error: error.message
        });
    }
});

/**
 * POST /api/me/vendor/providers
 * Create a new provider
 */
router.post('/', async (req, res) => {
    try {
        console.log('📝 Creating new provider:', {
            vendorId: req.vendor?.VendorId,
            providerName: req.body.providerName,
            npi: req.body.npi,
            userId: req.user?.UserId
        });

        const { providerName } = req.body;

        if (!providerName) {
            console.log('❌ Provider name is required');
            return res.status(400).json({
                success: false,
                message: 'Provider name is required'
            });
        }

        const result = await ProviderService.createProvider(
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );

        console.log('✅ Provider created successfully:', result);

        res.status(201).json({
            success: true,
            data: result,
            message: 'Provider created successfully'
        });
    } catch (error) {
        console.error('❌ Error creating provider:', error);
        
        // Check if it's a duplicate error
        if (error.message && (error.message.includes('already exists') || error.message.includes('duplicate'))) {
            return res.status(409).json({
                success: false,
                message: error.message,
                code: 'DUPLICATE_PROVIDER'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to create provider',
            error: error.message
        });
    }
});

/**
 * PUT /api/me/vendor/providers/:id
 * Update a provider
 */
router.put('/:id', async (req, res) => {
    try {
        const result = await ProviderService.updateProvider(
            req.params.id,
            req.vendor.VendorId,
            req.body,
            req.user.UserId
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: 'Provider updated successfully'
        });
    } catch (error) {
        console.error('❌ Error updating provider:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update provider',
            error: error.message
        });
    }
});

/**
 * DELETE /api/me/vendor/providers/:id
 * Delete a provider
 */
router.delete('/:id', async (req, res) => {
    try {
        const result = await ProviderService.deleteProvider(
            req.params.id,
            req.vendor.VendorId,
            req.user.UserId
        );

        if (!result.success) {
            return res.status(400).json({
                success: false,
                message: result.message
            });
        }

        res.json({
            success: true,
            message: result.message || 'Provider deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting provider:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete provider',
            error: error.message
        });
    }
});

console.log('✅ Mounted Provider routes');

module.exports = router;

