// routes/me/vendor/npi.js
// NPI Registry lookup routes for Vendor Portal

const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../../../middleware/auth');
const { requireShareRequestAccess } = require('../../../middleware/shareRequestAccess');
const NPIService = require('../../../services/npiService');

// Full US state/territory names -> 2-letter code, so the single "location" box
// accepts "Wyoming" as well as "WY".
const US_STATE_NAME_TO_CODE = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
    colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
    florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
    indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
    maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
    mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
    oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
    virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
    wyoming: 'WY', 'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI',
};

// All routes require authentication and vendor access
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(requireShareRequestAccess);

/**
 * GET /api/me/vendor/npi/lookup/:npiNumber
 * Look up a provider by NPI number
 */
router.get('/lookup/:npiNumber', async (req, res) => {
    try {
        const { npiNumber } = req.params;
        
        // Validate NPI format
        if (!/^\d{10}$/.test(npiNumber)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid NPI number. Must be exactly 10 digits.'
            });
        }
        
        console.log(`🔍 Looking up NPI: ${npiNumber}`);
        
        const provider = await NPIService.lookupByNPI(npiNumber);
        
        if (!provider) {
            return res.status(404).json({
                success: false,
                message: 'NPI not found in the registry'
            });
        }
        
        res.json({
            success: true,
            data: provider
        });
    } catch (error) {
        console.error('❌ Error looking up NPI:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to lookup NPI',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/npi/search
 * Search NPI Registry by name/organization
 * Query params: q (general search), firstName, lastName, organizationName, city, state, limit
 */
router.get('/search', async (req, res) => {
    try {
        const { q, firstName, lastName, organizationName, city, state, postalCode, location, limit = 20 } = req.query;

        let searchParams = {
            city,
            state,
            postalCode,
            limit: Math.min(parseInt(limit) || 20, 50)
        };

        // A single free-text "location" box (zip OR city OR state). Resolve it:
        //   digits (full or partial) -> ZIP; a partial ZIP is a fuzzy prefix
        //                               match (e.g. "100" -> 100xx), exact when 5.
        //   2 letters                -> state code
        //   a full state name        -> that state's code (e.g. "Wyoming" -> WY)
        //   anything else            -> city name
        if (location) {
            const loc = String(location).trim();
            if (/^\d{1,5}$/.test(loc)) {
                searchParams.postalCode = loc; // npiService handles exact vs prefix
            } else if (/^[A-Za-z]{2}$/.test(loc)) {
                searchParams.state = loc.toUpperCase();
            } else if (US_STATE_NAME_TO_CODE[loc.toLowerCase()]) {
                searchParams.state = US_STATE_NAME_TO_CODE[loc.toLowerCase()];
            } else if (loc) {
                searchParams.city = loc;
            }
        }
        
        // If general query 'q' is provided, determine search type
        if (q) {
            const query = q.trim();
            
            // Check if it looks like an NPI number
            if (/^\d{10}$/.test(query)) {
                // Direct NPI lookup
                const provider = await NPIService.lookupByNPI(query);
                return res.json({
                    success: true,
                    data: provider ? [provider] : [],
                    count: provider ? 1 : 0
                });
            }
            
            // Check if query contains a comma (Last, First format)
            if (query.includes(',')) {
                const parts = query.split(',').map(p => p.trim());
                searchParams.lastName = parts[0];
                if (parts[1]) searchParams.firstName = parts[1];
            }
            // Check if query has multiple words (could be First Last)
            else if (query.includes(' ')) {
                const parts = query.split(' ').filter(p => p.length > 0);
                // If 2 parts, treat as First Last
                if (parts.length === 2) {
                    searchParams.firstName = parts[0];
                    searchParams.lastName = parts[1];
                } else {
                    // Multiple words - likely organization name or complex name
                    // Search as both org name and last name
                    searchParams.organizationName = query;
                    searchParams.lastName = parts[parts.length - 1]; // Use last word as last name
                }
            } else {
                // Single word - search as last name AND organization name
                searchParams.lastName = query;
                searchParams.organizationName = query;
            }
        } else {
            // Use explicit parameters
            if (firstName) searchParams.firstName = firstName;
            if (lastName) searchParams.lastName = lastName;
            if (organizationName) searchParams.organizationName = organizationName;
        }
        
        // Require at least one search parameter
        if (!searchParams.firstName && !searchParams.lastName && !searchParams.organizationName) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a search term'
            });
        }
        
        console.log(`🔍 Searching NPI Registry:`, searchParams);
        
        const providers = await NPIService.searchProviders(searchParams);
        
        res.json({
            success: true,
            data: providers,
            count: providers.length
        });
    } catch (error) {
        console.error('❌ Error searching NPI Registry:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search NPI Registry',
            error: error.message
        });
    }
});

module.exports = router;

