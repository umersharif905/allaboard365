/**
 * Vendor Group ID Generation Service
 * 
 * Generates vendor-specific Group IDs for groups that have products associated with a vendor.
 * Default ARM pattern: prefix + seed + (groupIndex * 5).
 *
 * Per-vendor configuration on oe.Vendors:
 *  - GroupIdPrefix (NVarChar, optional) — the affix string (e.g. "MW", "90").
 *  - GroupIdSeedNumber (Int, required for generation) — starting numeric part for the
 *    first new group's Master ID.
 *  - GroupIdAffixPosition (NVarChar, NULL → "Prefix") — where the affix sits relative
 *    to the numeric part. "Prefix" → "MW1001"; "Suffix" → "1001MW".
 *  - GroupIdBetweenGroupsIncrement (Int, NULL → 5) — spacing between successive
 *    employer-group numeric bases. e.g. 5 keeps ARM behavior; 1 yields consecutive
 *    Master IDs (MW1000, MW1001, MW1002 across groups).
 *
 * Affix-flip migration policy: existing oe.GroupProductVendorGroupIds rows keep their
 * stored value; only NEW IDs adopt the new affix shape after a flip. Helpers therefore
 * use anchored start/end strip (NEVER substring replace) so digit-rich prefixes (e.g.
 * "90") do not mangle stored numbers.
 *
 * Also supports manual Group ID creation for any vendor.
 */

const { getPool } = require('../config/database');
const sql = require('mssql');

const DEFAULT_BETWEEN_GROUPS_STEP = 5;
const ALLOWED_AFFIX_POSITIONS = new Set(['Prefix', 'Suffix']);

class VendorGroupIdService {
    /**
     * Normalize the configured affix position to either 'Prefix' or 'Suffix'.
     * NULL/unknown → 'Prefix' (legacy default).
     *
     * @param {string|null|undefined} pos
     * @returns {'Prefix'|'Suffix'}
     */
    static normalizeAffixPosition(pos) {
        if (typeof pos === 'string') {
            const trimmed = pos.trim();
            if (ALLOWED_AFFIX_POSITIONS.has(trimmed)) return trimmed;
            // Accept lowercase variants for safety.
            const cap = trimmed.length ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase() : '';
            if (ALLOWED_AFFIX_POSITIONS.has(cap)) return cap;
        }
        return 'Prefix';
    }

    /**
     * Resolve the per-vendor between-groups step, defaulting to 5 when NULL or invalid.
     *
     * @param {*} value GroupIdBetweenGroupsIncrement column value (Int|null)
     * @returns {number} positive integer step (>= 1)
     */
    static normalizeBetweenGroupsStep(value) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1) return Math.floor(n);
        return DEFAULT_BETWEEN_GROUPS_STEP;
    }

    /**
     * True when the product should get its own oe.GroupProductVendorGroupIds row (auto path).
     * Excludes None/empty, Master, and numeric offset 0: those share the group master number.
     * Matches ensureGroupProductsForVendorProducts filters and cleanup SQL.
     *
     * @param {string|null|undefined} vendorGroupIdProductType
     * @returns {boolean}
     */
    static productHasVendorGroupIdIncrementSetup(vendorGroupIdProductType) {
        if (vendorGroupIdProductType == null) return false;
        const t = String(vendorGroupIdProductType).trim();
        if (!t.length) return false;
        const lower = t.toLowerCase();
        if (lower === 'none') return false;
        if (lower === 'master') return false;
        if (/^-?\d+$/.test(t)) {
            const n = parseInt(t, 10);
            if (!Number.isNaN(n) && n === 0) return false;
        }
        return true;
    }

    /**
     * Build a vendor group ID string from its parts using the vendor's affix position.
     * Pure helper — never reads from the DB.
     *
     * @param {string|null|undefined} prefix Vendor GroupIdPrefix (may be empty/null).
     * @param {number|string} numericPart The numeric portion (e.g. 1001).
     * @param {string|null|undefined} affixPosition 'Prefix' (default) or 'Suffix'.
     * @returns {string} e.g. "MW1001" or "1001MW".
     */
    static formatVendorGroupId(prefix, numericPart, affixPosition) {
        const numStr = numericPart === null || numericPart === undefined
            ? ''
            : String(numericPart);
        if (!prefix) return numStr;
        return this.normalizeAffixPosition(affixPosition) === 'Suffix'
            ? `${numStr}${prefix}`
            : `${prefix}${numStr}`;
    }

    /**
     * Anchored numeric extraction for stored vendor group IDs. Never uses substring
     * replace, so prefixes that contain digits (e.g. "90") cannot mangle the numeric
     * portion when it happens to repeat the prefix.
     *
     * @param {string} vendorGroupIdStr Stored VendorGroupId value.
     * @param {string|null|undefined} prefix Vendor GroupIdPrefix.
     * @param {string|null|undefined} affixPosition 'Prefix' (default) or 'Suffix'.
     * @returns {number} Parsed integer; NaN when the input does not match the configured shape.
     */
    static parseNumericPartFromVendorGroupId(vendorGroupIdStr, prefix, affixPosition) {
        const raw = String(vendorGroupIdStr == null ? '' : vendorGroupIdStr).trim();
        if (!raw.length) return NaN;
        if (!prefix) {
            const n = parseInt(raw, 10);
            return Number.isNaN(n) ? NaN : n;
        }
        const pos = this.normalizeAffixPosition(affixPosition);
        if (pos === 'Suffix') {
            if (raw.length > prefix.length && raw.endsWith(prefix)) {
                const candidate = raw.slice(0, raw.length - prefix.length);
                const n = parseInt(candidate, 10);
                return Number.isNaN(n) ? NaN : n;
            }
            return NaN;
        }
        if (raw.length > prefix.length && raw.startsWith(prefix)) {
            const candidate = raw.slice(prefix.length);
            const n = parseInt(candidate, 10);
            return Number.isNaN(n) ? NaN : n;
        }
        return NaN;
    }

    /**
     * Build a SQL expression that yields the numeric part of a stored VendorGroupId
     * (or NULL when the stored shape does not match the vendor's configured affix).
     * Use anchored LEFT/RIGHT comparisons rather than REPLACE to support digit-rich
     * affixes safely.
     *
     * The caller MUST also bind the affix value when prefix is non-empty:
     *   request.input(affixParamName, sql.NVarChar(50), prefix);
     *
     * @param {string} columnExpr SQL column expression for the stored ID (e.g. "vgi.VendorGroupId").
     * @param {string|null|undefined} prefix Vendor GroupIdPrefix.
     * @param {string|null|undefined} affixPosition 'Prefix' (default) or 'Suffix'.
     * @param {string} affixParamName parameter name (without leading @) holding the affix value.
     * @returns {string} SQL expression yielding INT or NULL.
     */
    static buildNumericPartSqlExpr(columnExpr, prefix, affixPosition, affixParamName) {
        if (!prefix) return `TRY_CAST(${columnExpr} AS INT)`;
        const len = prefix.length;
        if (this.normalizeAffixPosition(affixPosition) === 'Suffix') {
            return `CASE WHEN LEN(${columnExpr}) > ${len} AND RIGHT(${columnExpr}, ${len}) = @${affixParamName}
                          THEN TRY_CAST(LEFT(${columnExpr}, LEN(${columnExpr}) - ${len}) AS INT)
                          ELSE NULL END`;
        }
        return `CASE WHEN LEN(${columnExpr}) > ${len} AND LEFT(${columnExpr}, ${len}) = @${affixParamName}
                      THEN TRY_CAST(SUBSTRING(${columnExpr}, ${len + 1}, LEN(${columnExpr})) AS INT)
                      ELSE NULL END`;
    }

    /**
     * Generate vendor-specific Group ID for a GroupProduct (auto path only).
     * Requires oe.Products.VendorGroupIdProductType configured (same rules as bulk preview): no name-based guessing.
     *
     * @param {string} groupProductId - The GroupProductId
     * @param {string} vendorId - The VendorId
     * @param {string|null} productType - Offset key (Master, CoPay, HSA, 0–9); when null, uses the product's VendorGroupIdProductType
     * @param {string} userId - User ID for audit fields
     * @param {Object} transactionOrRequest - Optional transaction or request object to use (for transaction support)
     * @returns {Promise<Object>} { success: boolean, vendorGroupId: string, error?: string }
     */
    static async generateAndStoreGroupId(groupProductId, vendorId, productType = null, userId = null, transactionOrRequest = null) {
        try {
            // Use provided transaction/request or create new connection
            const useTransaction = transactionOrRequest !== null;
            const pool = useTransaction ? null : await getPool();
            const request = useTransaction ? transactionOrRequest : pool.request();
            
            // Helper function to create a request (from transaction or pool)
            const createRequest = () => {
                return useTransaction ? transactionOrRequest : pool.request();
            };
            
            // Check if Group ID already exists for this GroupProduct-Vendor combination
            const existingCheck = createRequest();
            existingCheck.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            existingCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            const existingResult = await existingCheck.query(`
                SELECT VendorGroupId, ProductType
                FROM oe.GroupProductVendorGroupIds
                WHERE GroupProductId = @groupProductId
                  AND VendorId = @vendorId
                  AND IsActive = 1
            `);
            
            if (existingResult.recordset.length > 0) {
                // Group ID already exists, return it
                return {
                    success: true,
                    vendorGroupId: existingResult.recordset[0].VendorGroupId,
                    productType: existingResult.recordset[0].ProductType,
                    alreadyExists: true
                };
            }
            
            // Get vendor's Group ID settings
            const vendorCheck = createRequest();
            vendorCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            const vendorResult = await vendorCheck.query(`
                SELECT GroupIdPrefix, GroupIdSeedNumber, GroupIdAffixPosition, GroupIdBetweenGroupsIncrement
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);
            
            if (vendorResult.recordset.length === 0) {
                return {
                    success: false,
                    error: 'Vendor not found'
                };
            }
            
            const vendor = vendorResult.recordset[0];
            
            // Check if vendor has Group ID settings configured
            // GroupIdPrefix is optional, but GroupIdSeedNumber is required
            if (vendor.GroupIdSeedNumber === null || vendor.GroupIdSeedNumber === undefined) {
                return {
                    success: false,
                    error: 'Vendor does not have Group ID settings configured (GroupIdSeedNumber is required)'
                };
            }
            
            // Get the GroupId from GroupProduct
            const groupProductCheck = createRequest();
            groupProductCheck.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            const groupProductResult = await groupProductCheck.query(`
                SELECT gp.GroupId, p.ProductId, p.Name as ProductName, p.VendorGroupIdProductType
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                WHERE gp.GroupProductId = @groupProductId
            `);
            
            if (groupProductResult.recordset.length === 0) {
                return {
                    success: false,
                    error: 'GroupProduct not found'
                };
            }
            
            const groupProduct = groupProductResult.recordset[0];
            const groupId = groupProduct.GroupId;

            if (!this.productHasVendorGroupIdIncrementSetup(groupProduct.VendorGroupIdProductType)) {
                return {
                    success: false,
                    error: 'Product does not have Vendor Group ID increment configuration (VendorGroupIdProductType). Configure it on the product before generating an ID.'
                };
            }

            // Prefer group-level Master (GroupId set, GroupProductId NULL) to establish base
            const masterBaseCheck = createRequest();
            masterBaseCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            masterBaseCheck.input('groupId', sql.UniqueIdentifier, groupId);
            const masterBaseResult = await masterBaseCheck.query(`
                SELECT VendorGroupId, ProductType FROM oe.GroupProductVendorGroupIds
                WHERE GroupId = @groupId AND VendorId = @vendorId AND ProductType = 'Master' AND GroupProductId IS NULL AND IsActive = 1
            `);

            const affixPosition = this.normalizeAffixPosition(vendor.GroupIdAffixPosition);
            const step = this.normalizeBetweenGroupsStep(vendor.GroupIdBetweenGroupsIncrement);

            let baseGroupId;
            if (masterBaseResult.recordset.length > 0) {
                // Anchored parse — handles both Prefix ("MW1001") and Suffix ("1001MW") shapes
                // and digit-rich prefixes safely.
                baseGroupId = this.parseNumericPartFromVendorGroupId(
                    masterBaseResult.recordset[0].VendorGroupId,
                    vendor.GroupIdPrefix || '',
                    affixPosition
                ); // Master is offset 0
            } else {
                // Check if this group already has a Group ID for this vendor (product-level)
                const existingGroupIdCheck = createRequest();
                existingGroupIdCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                existingGroupIdCheck.input('groupId', sql.UniqueIdentifier, groupId);
                const existingGroupIdResult = await existingGroupIdCheck.query(`
                    SELECT TOP 1 vgi.VendorGroupId, vgi.ProductType
                    FROM oe.GroupProductVendorGroupIds vgi
                    INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                    WHERE gp.GroupId = @groupId
                      AND vgi.VendorId = @vendorId
                      AND vgi.IsActive = 1
                    ORDER BY vgi.CreatedDate ASC
                `);

                if (existingGroupIdResult.recordset.length > 0) {
                    // This group already has a Group ID for this vendor (product-level)
                    const existingVendorGroupId = existingGroupIdResult.recordset[0].VendorGroupId;
                    const existingProductType = existingGroupIdResult.recordset[0].ProductType;
                    const numericPart = this.parseNumericPartFromVendorGroupId(
                        existingVendorGroupId,
                        vendor.GroupIdPrefix || '',
                        affixPosition
                    );
                    const productTypeOffset = this.getProductTypeOffset(existingProductType);
                    baseGroupId = numericPart - productTypeOffset;
                } else {
                // This is a NEW group - count how many groups already have Group IDs
                // This includes both old groups (90285, 90290) and new groups (90500+)
                // New groups start from the seed (90500) regardless of old group IDs
                const groupCountCheck = createRequest();
                groupCountCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                const groupCountResult = await groupCountCheck.query(`
                    SELECT COUNT(DISTINCT gp.GroupId) as GroupCount
                    FROM oe.GroupProducts gp
                    INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                    INNER JOIN oe.GroupProductVendorGroupIds vgi ON gp.GroupProductId = vgi.GroupProductId
                    WHERE p.VendorId = @vendorId
                      AND vgi.VendorId = @vendorId
                      AND vgi.IsActive = 1
                      AND gp.IsActive = 1
                `);
                
                // Count how many NEW groups (starting from seed) already exist.
                // NEW groups = those whose Master/Product VendorGroupId numeric part is >= seed.
                // Affix-safe: when a prefix is configured, anchor the comparison via
                // buildNumericPartSqlExpr so digit-rich prefixes and suffix mode
                // ("1001MW") never break across digit-width boundaries (e.g. "999MW"
                // vs "1000MW") that lexical >= would mishandle.
                const prefix = vendor.GroupIdPrefix || '';

                const newGroupCountCheck = createRequest();
                newGroupCountCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                newGroupCountCheck.input('seedNumber', sql.Int, vendor.GroupIdSeedNumber);
                if (prefix) newGroupCountCheck.input('numericAffix', sql.NVarChar(50), prefix);

                const numericExpr = this.buildNumericPartSqlExpr(
                    'vgi.VendorGroupId',
                    prefix,
                    affixPosition,
                    'numericAffix'
                );
                const newGroupCountQuery = `
                    SELECT COUNT(DISTINCT g) AS NewGroupCount FROM (
                        SELECT vgi.GroupId AS g FROM oe.GroupProductVendorGroupIds vgi
                        WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND vgi.GroupId IS NOT NULL
                          AND ${numericExpr} >= @seedNumber
                        UNION
                        SELECT gp.GroupId FROM oe.GroupProductVendorGroupIds vgi
                        INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                        INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                        WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND p.VendorId = @vendorId AND gp.IsActive = 1
                          AND ${numericExpr} >= @seedNumber
                    ) AS groups
                `;

                const newGroupCountResult = await newGroupCountCheck.query(newGroupCountQuery);

                // For new groups, start from seed and increment by `step` for each new group.
                // step defaults to 5 (legacy ARM behavior) when GroupIdBetweenGroupsIncrement is NULL.
                // First new group: seed (e.g. 90500); second: seed + step; etc.
                const newGroupCount = newGroupCountResult.recordset[0].NewGroupCount || 0;
                baseGroupId = vendor.GroupIdSeedNumber + (newGroupCount * step);
                }
            }
            
            // Explicit param or product column only — no name heuristic (increment must be configured on the product).
            let finalProductType = productType || groupProduct.VendorGroupIdProductType;
            finalProductType = finalProductType != null ? String(finalProductType).trim() : '';
            if (!finalProductType) {
                return {
                    success: false,
                    error: 'Product type for vendor group ID could not be determined'
                };
            }
            
            // Start at baseGroupId + offset. If that exact VendorGroupId is already active for this
            // vendor (other group, or stale row), bump by 1 to find the next free slot so we don't
            // hit the UQ_GroupProductVendorGroupIds_Vendor_VendorGroupId_Active unique index.
            const productTypeOffset = this.getProductTypeOffset(finalProductType);
            let finalGroupIdNumber = baseGroupId + productTypeOffset;
            let vendorGroupId = this.formatVendorGroupId(
                vendor.GroupIdPrefix || '',
                finalGroupIdNumber,
                affixPosition
            );
            for (let attempts = 0; attempts < 100; attempts++) {
                const inUseCheck = createRequest();
                inUseCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                inUseCheck.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
                const inUseResult = await inUseCheck.query(`
                    SELECT 1 FROM oe.GroupProductVendorGroupIds
                    WHERE VendorId = @vendorId AND VendorGroupId = @vendorGroupId AND IsActive = 1
                `);
                if (inUseResult.recordset.length === 0) break;
                finalGroupIdNumber += 1;
                vendorGroupId = this.formatVendorGroupId(
                    vendor.GroupIdPrefix || '',
                    finalGroupIdNumber,
                    affixPosition
                );
            }

            // Store the Group ID
            const insertRequest = createRequest();
            insertRequest.input('groupProductVendorGroupIdId', sql.UniqueIdentifier, require('crypto').randomUUID());
            insertRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            insertRequest.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
            insertRequest.input('productType', sql.NVarChar(50), finalProductType);
            insertRequest.input('isAutoGenerated', sql.Bit, 1); // Mark as auto-generated
            insertRequest.input('createdBy', sql.UniqueIdentifier, userId);
            insertRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
            await insertRequest.query(`
                INSERT INTO oe.GroupProductVendorGroupIds
                (GroupProductVendorGroupIdId, GroupProductId, VendorId, VendorGroupId, ProductType, IsAutoGenerated, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES
                (@groupProductVendorGroupIdId, @groupProductId, @vendorId, @vendorGroupId, @productType, @isAutoGenerated, 1, GETDATE(), GETDATE(), @createdBy, @modifiedBy)
            `);
            
            return {
                success: true,
                vendorGroupId: vendorGroupId,
                productType: finalProductType,
                baseGroupId: baseGroupId
            };
            
        } catch (error) {
            console.error('❌ Error generating Group ID:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get product type offset for Group ID calculation
     * Master = 0, CoPay = 1, HSA = 2
     * 
     * @param {string} productType - Product type
     * @returns {number} Offset value
     */
    static getProductTypeOffset(productType) {
        if (productType === null || productType === undefined || productType === '') return 0;
        // Allow explicit numeric offset (e.g. "0", "1", "2" from product field)
        const num = parseInt(String(productType), 10);
        if (!Number.isNaN(num) && num >= 0) return num;
        // Fallback: Master/CoPay/HSA by name
        const type = String(productType).toLowerCase();
        if (type.includes('copay') || type.includes('co-pay')) return 1;
        if (type.includes('hsa')) return 2;
        return 0; // Default to Master
    }
    
    /**
     * Determine product type from product name
     * 
     * @param {string} productName - Product name
     * @returns {string} Product type: 'Master', 'CoPay', or 'HSA'
     */
    static determineProductType(productName) {
        if (!productName) return 'Master';
        
        const name = productName.toLowerCase();
        if (name.includes('copay') || name.includes('co-pay')) return 'CoPay';
        if (name.includes('hsa')) return 'HSA';
        return 'Master'; // Default
    }
    
    /**
     * Get vendor Group ID for a GroupProduct
     * 
     * @param {string} groupProductId - The GroupProductId
     * @param {string} vendorId - The VendorId
     * @returns {Promise<Object>} { success: boolean, vendorGroupId?: string, error?: string }
     */
    static async getVendorGroupId(groupProductId, vendorId) {
        try {
            const pool = await getPool();
            
            const result = await pool.request()
                .input('groupProductId', sql.UniqueIdentifier, groupProductId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT VendorGroupId, ProductType
                    FROM oe.GroupProductVendorGroupIds
                    WHERE GroupProductId = @groupProductId
                      AND VendorId = @vendorId
                      AND IsActive = 1
                `);
            
            if (result.recordset.length === 0) {
                return {
                    success: false,
                    error: 'Vendor Group ID not found'
                };
            }
            
            return {
                success: true,
                vendorGroupId: result.recordset[0].VendorGroupId,
                productType: result.recordset[0].ProductType
            };
            
        } catch (error) {
            console.error('❌ Error getting Vendor Group ID:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Manually create a Group ID for a Group-Vendor or GroupProduct-Vendor combination
     * 
     * @param {string} groupId - The GroupId (required for Master Group IDs)
     * @param {string} groupProductId - The GroupProductId (required for product-specific Group IDs, null for Master)
     * @param {string} vendorId - The VendorId
     * @param {string} vendorGroupId - The Group ID to assign (e.g., "90500")
     * @param {string} productType - Product type (Master, CoPay, HSA, etc.) - required for Master
     * @param {string} userId - User ID for audit fields
     * @param {Object} transactionOrRequest - Optional transaction or request object
     * @returns {Promise<Object>} { success: boolean, vendorGroupId?: string, error?: string }
     */
    static async createManualGroupId(groupId, groupProductId, vendorId, vendorGroupId, productType = null, userId = null, transactionOrRequest = null) {
        try {
            const useTransaction = transactionOrRequest !== null;
            const pool = useTransaction ? null : await getPool();
            const createRequest = () => useTransaction ? transactionOrRequest : pool.request();
            
            // Validate vendor exists
            const vendorCheck = createRequest();
            vendorCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            const vendorResult = await vendorCheck.query(`
                SELECT VendorId, VendorName
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);
            
            if (vendorResult.recordset.length === 0) {
                return {
                    success: false,
                    error: 'Vendor not found'
                };
            }
            
            // Determine if this is a Master Group ID (no GroupProductId) or product-specific
            const isMaster = !groupProductId && productType === 'Master';
            
            if (isMaster) {
                // Master Group ID: validate Group exists
                if (!groupId) {
                    return {
                        success: false,
                        error: 'GroupId is required for Master Group IDs'
                    };
                }
                
                const groupCheck = createRequest();
                groupCheck.input('groupId', sql.UniqueIdentifier, groupId);
                const groupResult = await groupCheck.query(`
                    SELECT GroupId, Name
                    FROM oe.Groups
                    WHERE GroupId = @groupId
                `);
                
                if (groupResult.recordset.length === 0) {
                    return {
                        success: false,
                        error: 'Group not found'
                    };
                }
                
                // Check if Master Group ID already exists for this Group-Vendor combination
                const existingCheck = createRequest();
                existingCheck.input('groupId', sql.UniqueIdentifier, groupId);
                existingCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                const existingResult = await existingCheck.query(`
                    SELECT VendorGroupId
                    FROM oe.GroupProductVendorGroupIds
                    WHERE GroupId = @groupId
                      AND VendorId = @vendorId
                      AND ProductType = 'Master'
                      AND GroupProductId IS NULL
                      AND IsActive = 1
                `);
                
                if (existingResult.recordset.length > 0) {
                    return {
                        success: false,
                        error: `Master Group ID already exists for this Group-Vendor combination: ${existingResult.recordset[0].VendorGroupId}`
                    };
                }
            } else {
                // Product-specific Group ID: validate GroupProduct exists
                if (!groupProductId) {
                    return {
                        success: false,
                        error: 'GroupProductId is required for product-specific Group IDs'
                    };
                }
                
                const groupProductCheck = createRequest();
                groupProductCheck.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                const groupProductResult = await groupProductCheck.query(`
                    SELECT gp.GroupProductId, gp.GroupId, p.ProductId, p.Name as ProductName
                    FROM oe.GroupProducts gp
                    INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                    WHERE gp.GroupProductId = @groupProductId
                `);
                
                if (groupProductResult.recordset.length === 0) {
                    return {
                        success: false,
                        error: 'GroupProduct not found'
                    };
                }
                
                // Use the GroupId from the GroupProduct
                if (!groupId) {
                    groupId = groupProductResult.recordset[0].GroupId;
                }
                
                // Check if Group ID already exists for this GroupProduct-Vendor combination
                const existingCheck = createRequest();
                existingCheck.input('groupProductId', sql.UniqueIdentifier, groupProductId);
                existingCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                const existingResult = await existingCheck.query(`
                    SELECT VendorGroupId
                    FROM oe.GroupProductVendorGroupIds
                    WHERE GroupProductId = @groupProductId
                      AND VendorId = @vendorId
                      AND IsActive = 1
                `);
                
                if (existingResult.recordset.length > 0) {
                    return {
                        success: false,
                        error: `Group ID already exists for this GroupProduct-Vendor combination: ${existingResult.recordset[0].VendorGroupId}`
                    };
                }
                
                // Auto-detect product type if not provided
                if (!productType) {
                    productType = this.determineProductType(groupProductResult.recordset[0].ProductName);
                }
            }
            
            // Check if this VendorGroupId is already in use for this vendor
            const duplicateCheck = createRequest();
            duplicateCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            duplicateCheck.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
            const duplicateResult = await duplicateCheck.query(`
                SELECT VendorGroupId, GroupProductId, GroupId
                FROM oe.GroupProductVendorGroupIds
                WHERE VendorId = @vendorId
                  AND VendorGroupId = @vendorGroupId
                  AND IsActive = 1
            `);
            
            if (duplicateResult.recordset.length > 0) {
                return {
                    success: false,
                    error: `Group ID "${vendorGroupId}" is already in use for this vendor`
                };
            }
            
            // Insert the manual Group ID
            const insertRequest = createRequest();
            insertRequest.input('groupProductVendorGroupIdId', sql.UniqueIdentifier, require('crypto').randomUUID());
            
            // For Master Group IDs: set GroupId, GroupProductId = NULL
            // For product-specific Group IDs: set GroupProductId, GroupId = NULL (per CHECK constraint)
            if (isMaster) {
                insertRequest.input('groupId', sql.UniqueIdentifier, groupId);
                // For NULL values, we need to explicitly set the parameter to null without type
                insertRequest.input('groupProductId', sql.UniqueIdentifier, sql.NULL);
            } else {
                // For product-specific, GroupId must be NULL
                insertRequest.input('groupId', sql.UniqueIdentifier, sql.NULL);
                insertRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            }
            
            insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            insertRequest.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
            insertRequest.input('productType', sql.NVarChar(50), productType || 'Master');
            insertRequest.input('isAutoGenerated', sql.Bit, 0); // Mark as manually created
            insertRequest.input('createdBy', sql.UniqueIdentifier, userId);
            insertRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
            
            console.log('🔍 Inserting Group ID:', {
                isMaster,
                groupId: isMaster ? groupId : 'NULL',
                groupProductId: isMaster ? 'NULL' : groupProductId,
                vendorId,
                vendorGroupId,
                productType: productType || 'Master'
            });
            
            await insertRequest.query(`
                INSERT INTO oe.GroupProductVendorGroupIds
                (GroupProductVendorGroupIdId, GroupId, GroupProductId, VendorId, VendorGroupId, ProductType, IsAutoGenerated, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES
                (@groupProductVendorGroupIdId, @groupId, @groupProductId, @vendorId, @vendorGroupId, @productType, @isAutoGenerated, 1, GETDATE(), GETDATE(), @createdBy, @modifiedBy)
            `);
            
            return {
                success: true,
                vendorGroupId: vendorGroupId,
                productType: productType || 'Master',
                isAutoGenerated: false
            };
            
        } catch (error) {
            console.error('❌ Error creating manual Group ID:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Update an existing Group ID
     * 
     * @param {string} groupProductId - The GroupProductId
     * @param {string} vendorId - The VendorId
     * @param {string} vendorGroupId - The new Group ID to assign
     * @param {string} userId - User ID for audit fields
     * @returns {Promise<Object>} { success: boolean, error?: string }
     */
    static async updateGroupId(groupProductId, vendorId, vendorGroupId, userId = null) {
        try {
            const pool = await getPool();
            
            // Check if Group ID exists
            const existingCheck = pool.request();
            existingCheck.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            existingCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
            const existingResult = await existingCheck.query(`
                SELECT VendorGroupId
                FROM oe.GroupProductVendorGroupIds
                WHERE GroupProductId = @groupProductId
                  AND VendorId = @vendorId
                  AND IsActive = 1
            `);
            
            if (existingResult.recordset.length === 0) {
                return {
                    success: false,
                    error: 'Group ID not found for this GroupProduct-Vendor combination'
                };
            }
            
            // Check if new VendorGroupId is already in use for this vendor
            if (existingResult.recordset[0].VendorGroupId !== vendorGroupId) {
                const duplicateCheck = pool.request();
                duplicateCheck.input('vendorId', sql.UniqueIdentifier, vendorId);
                duplicateCheck.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
                const duplicateResult = await duplicateCheck.query(`
                    SELECT VendorGroupId
                    FROM oe.GroupProductVendorGroupIds
                    WHERE VendorId = @vendorId
                      AND VendorGroupId = @vendorGroupId
                      AND IsActive = 1
                `);
                
                if (duplicateResult.recordset.length > 0) {
                    return {
                        success: false,
                        error: `Group ID "${vendorGroupId}" is already in use for this vendor`
                    };
                }
            }
            
            // Update the Group ID
            const updateRequest = pool.request();
            updateRequest.input('groupProductId', sql.UniqueIdentifier, groupProductId);
            updateRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            updateRequest.input('vendorGroupId', sql.NVarChar(50), vendorGroupId);
            updateRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
            await updateRequest.query(`
                UPDATE oe.GroupProductVendorGroupIds
                SET VendorGroupId = @vendorGroupId,
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE GroupProductId = @groupProductId
                  AND VendorId = @vendorId
                  AND IsActive = 1
            `);
            
            return {
                success: true,
                vendorGroupId: vendorGroupId
            };
            
        } catch (error) {
            console.error('❌ Error updating Group ID:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * UQ_GroupProducts_GroupProduct is on (GroupId, ProductId) regardless of IsActive.
     * Prior logic only skipped when IsActive=1, so an inactive row caused INSERT → duplicate key.
     * Ensures one active row: reactivate if inactive exists, else insert (retry UPDATE on unique race).
     *
     * @returns {Promise<0|1>} 1 if row was inserted or reactivated, 0 if already active
     */
    static async upsertActiveGroupProduct(groupId, productId, userId = null) {
        const pool = await getPool();
        const createdBy = userId || '00000000-0000-0000-0000-000000000000';
        const req = pool.request();
        req.input('groupId', sql.UniqueIdentifier, groupId);
        req.input('productId', sql.UniqueIdentifier, productId);
        const existing = await req.query(`
            SELECT GroupProductId, IsActive FROM oe.GroupProducts
            WHERE GroupId = @groupId AND ProductId = @productId
        `);
        const row = existing.recordset && existing.recordset[0];
        if (row) {
            if (row.IsActive === true || row.IsActive === 1) {
                return 0;
            }
            const up = pool.request();
            up.input('groupId', sql.UniqueIdentifier, groupId);
            up.input('productId', sql.UniqueIdentifier, productId);
            up.input('createdBy', sql.UniqueIdentifier, createdBy);
            await up.query(`
                UPDATE oe.GroupProducts
                SET IsActive = 1, ModifiedDate = GETDATE(), ModifiedBy = @createdBy
                WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 0
            `);
            return 1;
        }
        const groupProductId = require('crypto').randomUUID();
        const ins = pool.request();
        ins.input('groupProductId', sql.UniqueIdentifier, groupProductId);
        ins.input('groupId', sql.UniqueIdentifier, groupId);
        ins.input('productId', sql.UniqueIdentifier, productId);
        ins.input('createdBy', sql.UniqueIdentifier, createdBy);
        try {
            await ins.query(`
                INSERT INTO oe.GroupProducts
                (GroupProductId, GroupId, ProductId, IsActive, CustomSettings, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES (@groupProductId, @groupId, @productId, 1, NULL, GETDATE(), GETDATE(), @createdBy, @createdBy)
            `);
            return 1;
        } catch (e) {
            const n = e && (e.number ?? e.originalError?.number ?? e.originalError?.info?.number);
            if (n === 2627 || n === 2601) {
                const up2 = pool.request();
                up2.input('groupId', sql.UniqueIdentifier, groupId);
                up2.input('productId', sql.UniqueIdentifier, productId);
                up2.input('createdBy', sql.UniqueIdentifier, createdBy);
                const upRes = await up2.query(`
                    UPDATE oe.GroupProducts
                    SET IsActive = 1, ModifiedDate = GETDATE(), ModifiedBy = @createdBy
                    WHERE GroupId = @groupId AND ProductId = @productId AND IsActive = 0
                `);
                const affected = upRes.rowsAffected && upRes.rowsAffected[0];
                return affected > 0 ? 1 : 0;
            }
            throw e;
        }
    }

    /**
     * Ensure GroupProduct rows exist for every product the vendor has that needs distinct vendor group IDs
     * (VendorGroupIdProductType set but not Master / numeric 0 / None; vendor has GroupIdSeedNumber).
     *
     * @param {string} groupId - The GroupId
     * @param {string} vendorId - The VendorId
     * @param {string|null} userId - User ID for CreatedBy/ModifiedBy (optional)
     * @returns {Promise<{ ensured: number }>}
     */
    static async ensureGroupProductsForVendorProducts(groupId, vendorId, userId = null) {
        const pool = await getPool();
        const req = pool.request();
        req.input('groupId', sql.UniqueIdentifier, groupId);
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        const products = await req.query(`
            SELECT p.ProductId
            FROM oe.Products p
            INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
            WHERE p.VendorId = @vendorId
              AND v.GroupIdSeedNumber IS NOT NULL
              AND p.VendorGroupIdProductType IS NOT NULL
              AND LTRIM(RTRIM(ISNULL(p.VendorGroupIdProductType, ''))) != ''
              AND LTRIM(RTRIM(p.VendorGroupIdProductType)) != 'None'
              AND LOWER(LTRIM(RTRIM(p.VendorGroupIdProductType))) != N'master'
              AND NOT (
                  TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) = 0
                  AND TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) IS NOT NULL
              )
              AND (p.Status = 'Active' OR p.Status IS NULL)
              AND NOT EXISTS (
                SELECT 1 FROM oe.GroupProducts gp
                WHERE gp.GroupId = @groupId AND gp.ProductId = p.ProductId AND gp.IsActive = 1
              )
        `);
        let ensured = 0;
        for (const row of products.recordset || []) {
            const n = await this.upsertActiveGroupProduct(groupId, row.ProductId, userId);
            ensured += n;
        }
        if (ensured > 0 && process.env.NODE_ENV === 'development') {
            console.log(`[VendorGroupId] Ensured ${ensured} GroupProduct row(s) for vendor ${vendorId} products (group IDs applicable)`);
        }
        return { ensured };
    }

    /**
     * Ensure GroupProduct rows exist for products that are inside bundles in this group.
     * When a group has a bundle in its product list, the bundle's included products need
     * GroupProduct rows so we can generate product-specific vendor group IDs (CoPay, HSA, etc.).
     *
     * @param {string} groupId - The GroupId
     * @param {string|null} userId - User ID for CreatedBy/ModifiedBy (optional)
     * @returns {Promise<{ ensured: number }>}
     */
    static async ensureGroupProductsForBundleComponents(groupId, userId = null) {
        const pool = await getPool();
        const req = pool.request();
        req.input('groupId', sql.UniqueIdentifier, groupId);
        const bundleComponents = await req.query(`
            SELECT DISTINCT pb.IncludedProductId AS ProductId
            FROM oe.GroupProducts gp
            INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
            WHERE gp.GroupId = @groupId AND gp.IsActive = 1
            AND NOT EXISTS (
                SELECT 1 FROM oe.GroupProducts gp2
                WHERE gp2.GroupId = @groupId AND gp2.ProductId = pb.IncludedProductId AND gp2.IsActive = 1
            )
        `);
        let ensured = 0;
        for (const row of bundleComponents.recordset || []) {
            const n = await this.upsertActiveGroupProduct(groupId, row.ProductId, userId);
            ensured += n;
        }
        if (ensured > 0) {
            console.log(`✅ Ensured ${ensured} GroupProduct row(s) for bundle components in group ${groupId}`);
        }
        return { ensured };
    }

    /**
     * Preview proposed vendor group IDs for a group (and optional vendor).
     * Includes direct group products and products inside bundles. Does not insert IDs; returns list of proposed or existing IDs per group product.
     *
     * @param {string} groupId - The GroupId
     * @param {string|null} vendorId - Optional VendorId to limit to one vendor
     * @returns {Promise<Object>} { success, preview: [{ groupProductId, productId, productName, vendorId, vendorName, productType, vendorGroupId, alreadyExists }], error? }
     */
    static async previewGenerateForGroup(groupId, vendorId = null) {
        try {
            const pool = await getPool();
            const request = pool.request();
            request.input('groupId', sql.UniqueIdentifier, groupId);
            if (vendorId) request.input('vendorId', sql.UniqueIdentifier, vendorId);

            const productRows = await request.query(`
                SELECT gp.GroupProductId, gp.ProductId, p.Name AS ProductName, p.VendorId, p.VendorGroupIdProductType, p.EligibilityVendorGroupFallbackProductId, v.VendorName, v.GroupIdPrefix, v.GroupIdSeedNumber, v.GroupIdAffixPosition, v.GroupIdBetweenGroupsIncrement
                FROM oe.GroupProducts gp
                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
                WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p.VendorId IS NOT NULL AND v.GroupIdSeedNumber IS NOT NULL
                ${vendorId ? 'AND p.VendorId = @vendorId' : ''}
                UNION
                SELECT gp2.GroupProductId, gp2.ProductId, p2.Name AS ProductName, p2.VendorId, p2.VendorGroupIdProductType, p2.EligibilityVendorGroupFallbackProductId, v2.VendorName, v2.GroupIdPrefix, v2.GroupIdSeedNumber, v2.GroupIdAffixPosition, v2.GroupIdBetweenGroupsIncrement
                FROM oe.GroupProducts gp
                INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = gp.ProductId
                INNER JOIN oe.GroupProducts gp2 ON gp2.GroupId = gp.GroupId AND gp2.ProductId = pb.IncludedProductId AND gp2.IsActive = 1
                INNER JOIN oe.Products p2 ON gp2.ProductId = p2.ProductId
                INNER JOIN oe.Vendors v2 ON p2.VendorId = v2.VendorId
                WHERE gp.GroupId = @groupId AND gp.IsActive = 1 AND p2.VendorId IS NOT NULL AND v2.GroupIdSeedNumber IS NOT NULL
                ${vendorId ? 'AND p2.VendorId = @vendorId' : ''}
            `);

            const seen = new Set();
            const productRowsDeduped = (productRows.recordset || []).filter((r) => {
                const key = (r.GroupProductId || '').toString();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            if (process.env.NODE_ENV === 'development') {
                console.log(`[VendorGroupId] preview group ${groupId}: ${productRowsDeduped.length} product(s): ${productRowsDeduped.map(r => `${r.ProductName} (${r.VendorGroupIdProductType || 'no-type'})`).join(', ')}`);
            }

            if (!productRowsDeduped.length) {
                return { success: true, preview: [] };
            }

            // Product-specific IDs only when VendorGroupIdProductType is configured on the product (no name guessing).
            const optedInRows = productRowsDeduped.filter((r) =>
                this.productHasVendorGroupIdIncrementSetup(r.VendorGroupIdProductType)
            );
            const preview = [];
            // Build vendor list from all group products (direct + bundle components) so we always can add Master per vendor
            const byVendor = new Map();
            for (const row of productRowsDeduped) {
                const vid = row.VendorId;
                if (!byVendor.has(vid)) byVendor.set(vid, { vendor: row, optedInRows: [] });
            }
            for (const row of optedInRows) {
                byVendor.get(row.VendorId).optedInRows.push(row);
            }

            if (process.env.NODE_ENV === 'development') {
                console.log(`[VendorGroupId] preview group ${groupId}: ${optedInRows.length} opted-in product(s) (will get product-specific IDs)`);
            }

            for (const [vId, { vendor: vendorRow, optedInRows: rows }] of byVendor) {
                let baseGroupId;
                // Per-vendor configuration drives format/parse + step. NULL/unknown values
                // fall back to legacy defaults (Prefix position, step 5).
                const vendorAffixPosition = this.normalizeAffixPosition(vendorRow.GroupIdAffixPosition);
                const vendorStep = this.normalizeBetweenGroupsStep(vendorRow.GroupIdBetweenGroupsIncrement);
                const vendorPrefix = vendorRow.GroupIdPrefix || '';
                // Track Group IDs this preview has tentatively assigned for this vendor, so two
                // products with the same offset (e.g. both VendorGroupIdProductType = "0") don't
                // collide on the same number in the preview.
                const tentativeIds = new Set();
                // Prefer group-level Master (GroupId set, GroupProductId NULL) to establish base
                const masterReq = pool.request();
                masterReq.input('groupId', sql.UniqueIdentifier, groupId);
                masterReq.input('vendorId', sql.UniqueIdentifier, vId);
                const masterResult = await masterReq.query(`
                    SELECT VendorGroupId FROM oe.GroupProductVendorGroupIds
                    WHERE GroupId = @groupId AND VendorId = @vendorId AND ProductType = 'Master' AND GroupProductId IS NULL AND IsActive = 1
                `);
                const hasGroupMaster = masterResult.recordset.length > 0;

                if (hasGroupMaster) {
                    baseGroupId = this.parseNumericPartFromVendorGroupId(
                        masterResult.recordset[0].VendorGroupId,
                        vendorPrefix,
                        vendorAffixPosition
                    ); // Master is offset 0
                } else {
                    const existingReq = pool.request();
                    existingReq.input('groupId', sql.UniqueIdentifier, groupId);
                    existingReq.input('vendorId', sql.UniqueIdentifier, vId);
                    const existingGroup = await existingReq.query(`
                        SELECT TOP 1 vgi.VendorGroupId, vgi.ProductType
                        FROM oe.GroupProductVendorGroupIds vgi
                        INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                        WHERE gp.GroupId = @groupId AND vgi.VendorId = @vendorId AND vgi.IsActive = 1
                        ORDER BY vgi.CreatedDate ASC
                    `);

                    if (existingGroup.recordset.length > 0) {
                        const numericPart = this.parseNumericPartFromVendorGroupId(
                            existingGroup.recordset[0].VendorGroupId,
                            vendorPrefix,
                            vendorAffixPosition
                        );
                        const offset = this.getProductTypeOffset(existingGroup.recordset[0].ProductType);
                        baseGroupId = numericPart - offset;
                    } else {
                        // Count groups that have any vendor group ID whose numeric part >= seed
                        // (product-level or group-level Master). Mirrors generateAndStoreGroupId
                        // so preview and apply pick the same baseGroupId for prefix and suffix.
                        const countReq = pool.request();
                        countReq.input('vendorId', sql.UniqueIdentifier, vId);
                        countReq.input('seedNumber', sql.Int, vendorRow.GroupIdSeedNumber);
                        if (vendorPrefix) countReq.input('numericAffix', sql.NVarChar(50), vendorPrefix);
                        const numericExpr = this.buildNumericPartSqlExpr(
                            'vgi.VendorGroupId',
                            vendorPrefix,
                            vendorAffixPosition,
                            'numericAffix'
                        );
                        const countResult = await countReq.query(`
                            SELECT COUNT(DISTINCT g) AS NewGroupCount FROM (
                                SELECT vgi.GroupId AS g FROM oe.GroupProductVendorGroupIds vgi
                                WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND vgi.GroupId IS NOT NULL
                                  AND ${numericExpr} >= @seedNumber
                                UNION
                                SELECT gp.GroupId FROM oe.GroupProductVendorGroupIds vgi
                                INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                                WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND p.VendorId = @vendorId AND gp.IsActive = 1
                                  AND ${numericExpr} >= @seedNumber
                            ) AS groups
                        `);
                        const newGroupCount = countResult.recordset[0]?.NewGroupCount || 0;
                        baseGroupId = vendorRow.GroupIdSeedNumber + (newGroupCount * vendorStep);
                    }
                }

                // Always include a Master (group-level) row: base ID (offset 0) so CoPay/HSA can use base+1, base+2
                let masterVendorGroupId = this.formatVendorGroupId(vendorPrefix, baseGroupId, vendorAffixPosition);
                if (!hasGroupMaster) {
                    for (let attempts = 0; attempts < 100; attempts++) {
                        const inUseCheck = await pool.request()
                            .input('vendorId', sql.UniqueIdentifier, vId)
                            .input('vendorGroupId', sql.NVarChar(50), masterVendorGroupId)
                            .query(`
                                SELECT 1 FROM oe.GroupProductVendorGroupIds
                                WHERE VendorId = @vendorId AND VendorGroupId = @vendorGroupId AND IsActive = 1
                            `);
                        if (inUseCheck.recordset.length === 0 && !tentativeIds.has(masterVendorGroupId)) break;
                        // Bump by configured step so suffix vendors get the same spacing rules.
                        baseGroupId += vendorStep;
                        masterVendorGroupId = this.formatVendorGroupId(vendorPrefix, baseGroupId, vendorAffixPosition);
                    }
                } else {
                    masterVendorGroupId = masterResult.recordset[0].VendorGroupId;
                }
                tentativeIds.add(masterVendorGroupId);
                preview.push({
                    groupProductId: null,
                    productId: null,
                    productName: 'Master (group)',
                    vendorId: vId,
                    vendorName: vendorRow.VendorName,
                    productType: 'Master',
                    vendorGroupId: masterVendorGroupId,
                    alreadyExists: hasGroupMaster,
                    idInUse: false,
                    isMaster: true
                });

                // Two-pass processing so products with an EligibilityVendorGroupFallbackProductId
                // ("Use other product's vendor group ID") can resolve to the target product's
                // vendorGroupId after it's been computed. We also don't consume a slot for
                // fallback-linked products, since they share another product's ID.
                const productIdToVendorGroupId = new Map();
                const rowsWithoutFallback = rows.filter((r) => !r.EligibilityVendorGroupFallbackProductId);
                const rowsWithFallback = rows.filter((r) => !!r.EligibilityVendorGroupFallbackProductId);

                const computeRow = async (row) => {
                    const existingCheck = await pool.request()
                        .input('groupProductId', sql.UniqueIdentifier, row.GroupProductId)
                        .input('vendorId', sql.UniqueIdentifier, vId)
                        .query(`
                            SELECT VendorGroupId, ProductType FROM oe.GroupProductVendorGroupIds
                            WHERE GroupProductId = @groupProductId AND VendorId = @vendorId AND IsActive = 1
                        `);
                    const productType = existingCheck.recordset[0]
                        ? existingCheck.recordset[0].ProductType
                        : String(row.VendorGroupIdProductType || '').trim();
                    const offset = this.getProductTypeOffset(productType);
                    const alreadyExists = existingCheck.recordset.length > 0;
                    // Start at baseGroupId + offset. If that exact VendorGroupId is already active
                    // for this vendor (due to another group or an existing row), bump by 1 to find
                    // the next free slot so we don't hit the
                    // UQ_GroupProductVendorGroupIds_Vendor_VendorGroupId_Active unique index.
                    let finalNum = baseGroupId + offset;
                    let computedVendorGroupId = this.formatVendorGroupId(vendorPrefix, finalNum, vendorAffixPosition);
                    if (!alreadyExists) {
                        for (let attempts = 0; attempts < 100; attempts++) {
                            const inUseCheck = await pool.request()
                                .input('vendorId', sql.UniqueIdentifier, vId)
                                .input('vendorGroupId', sql.NVarChar(50), computedVendorGroupId)
                                .query(`
                                    SELECT 1 FROM oe.GroupProductVendorGroupIds
                                    WHERE VendorId = @vendorId AND VendorGroupId = @vendorGroupId AND IsActive = 1
                                `);
                            if (inUseCheck.recordset.length === 0) break;
                            finalNum += 1;
                            computedVendorGroupId = this.formatVendorGroupId(vendorPrefix, finalNum, vendorAffixPosition);
                        }
                    }
                    const chosenVendorGroupId = alreadyExists ? existingCheck.recordset[0].VendorGroupId : computedVendorGroupId;
                    if (row.ProductId && chosenVendorGroupId) {
                        productIdToVendorGroupId.set(String(row.ProductId).toLowerCase(), chosenVendorGroupId);
                    }
                    preview.push({
                        groupProductId: row.GroupProductId,
                        productId: row.ProductId,
                        productName: row.ProductName,
                        vendorId: vId,
                        vendorName: vendorRow.VendorName,
                        productType,
                        vendorGroupId: chosenVendorGroupId,
                        alreadyExists,
                        idInUse: false,
                        isMaster: false
                    });
                };

                // Pass 1: products that compute their own slot
                for (const row of rowsWithoutFallback) {
                    await computeRow(row);
                }

                // Pass 2: products that reuse another product's vendor group ID via fallback
                for (const row of rowsWithFallback) {
                    const existingCheck = await pool.request()
                        .input('groupProductId', sql.UniqueIdentifier, row.GroupProductId)
                        .input('vendorId', sql.UniqueIdentifier, vId)
                        .query(`
                            SELECT VendorGroupId, ProductType FROM oe.GroupProductVendorGroupIds
                            WHERE GroupProductId = @groupProductId AND VendorId = @vendorId AND IsActive = 1
                        `);

                    const fallbackKey = String(row.EligibilityVendorGroupFallbackProductId).toLowerCase();
                    // First check the in-memory map (product resolved in pass 1).
                    let resolvedVendorGroupId = productIdToVendorGroupId.get(fallbackKey) || null;
                    let fallbackProductName = null;
                    // If not in this preview's map, look it up in the DB for this group
                    if (!resolvedVendorGroupId) {
                        const fallbackLookup = await pool.request()
                            .input('groupId', sql.UniqueIdentifier, groupId)
                            .input('vendorId', sql.UniqueIdentifier, vId)
                            .input('fallbackProductId', sql.UniqueIdentifier, row.EligibilityVendorGroupFallbackProductId)
                            .query(`
                                SELECT TOP 1 vgi.VendorGroupId, p.Name AS ProductName
                                FROM oe.GroupProductVendorGroupIds vgi
                                INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                                INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                                WHERE gp.GroupId = @groupId AND vgi.VendorId = @vendorId AND vgi.IsActive = 1
                                  AND p.ProductId = @fallbackProductId
                                ORDER BY vgi.CreatedDate ASC
                            `);
                        if (fallbackLookup.recordset.length > 0) {
                            resolvedVendorGroupId = fallbackLookup.recordset[0].VendorGroupId;
                            fallbackProductName = fallbackLookup.recordset[0].ProductName;
                        }
                    }
                    // Get target product's display name for the status badge (even if resolved via map)
                    if (!fallbackProductName) {
                        const nameLookup = await pool.request()
                            .input('productId', sql.UniqueIdentifier, row.EligibilityVendorGroupFallbackProductId)
                            .query(`SELECT Name FROM oe.Products WHERE ProductId = @productId`);
                        if (nameLookup.recordset.length > 0) fallbackProductName = nameLookup.recordset[0].Name;
                    }

                    const alreadyExists = existingCheck.recordset.length > 0;
                    const productType = existingCheck.recordset[0]
                        ? existingCheck.recordset[0].ProductType
                        : String(row.VendorGroupIdProductType || '').trim();
                    // If the product already has its own row stored, surface that ID; otherwise use
                    // the resolved fallback ID and flag the row so apply won't create a duplicate.
                    const vendorGroupId = alreadyExists
                        ? existingCheck.recordset[0].VendorGroupId
                        : resolvedVendorGroupId;
                    preview.push({
                        groupProductId: row.GroupProductId,
                        productId: row.ProductId,
                        productName: row.ProductName,
                        vendorId: vId,
                        vendorName: vendorRow.VendorName,
                        productType,
                        vendorGroupId,
                        // When linked via fallback, this product doesn't need its own row - it
                        // resolves through EligibilityVendorGroupFallbackProductId at export time.
                        // Mark it as alreadyExists so the apply path skips creating one.
                        alreadyExists: alreadyExists || !!resolvedVendorGroupId,
                        idInUse: false,
                        isMaster: false,
                        sharesWithFallback: !alreadyExists && !!resolvedVendorGroupId,
                        sharesWithProductName: fallbackProductName
                    });
                }
            }

            return { success: true, preview };
        } catch (error) {
            console.error('❌ Error previewing group IDs:', error);
            return { success: false, error: error.message, preview: [] };
        }
    }

    /**
     * Soft-delete auto-generated product-level vendor group IDs when the product shares the group
     * master number only: VendorGroupIdProductType unset / None / Master / numeric 0 — or legacy rows from
     * name-heuristic (null type). Mirrors productHasVendorGroupIdIncrementSetup.
     *
     * Does not touch master (group-level), manual rows (!IsAutoGenerated), or inactive rows.
     *
     * @param {string} groupId
     * @param {string|null} vendorId - Limit to one vendor; null = all vendors for this group
     * @param {string|null} userId - ModifiedBy
     * @returns {Promise<{ deactivated: number }>}
     */
    static async deactivateAutoVendorGroupIdsWithoutProductIncrement(groupId, vendorId, userId = null) {
        const pool = await getPool();
        const modifiedBy = userId || '00000000-0000-0000-0000-000000000000';
        const req = pool.request();
        req.input('groupId', sql.UniqueIdentifier, groupId);
        req.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
        let vendorClause = '';
        if (vendorId) {
            req.input('scopedVendorId', sql.UniqueIdentifier, vendorId);
            vendorClause = ' AND vgi.VendorId = @scopedVendorId';
        }
        const result = await req.query(`
            UPDATE vgi
            SET vgi.IsActive = 0,
                vgi.ModifiedDate = GETDATE(),
                vgi.ModifiedBy = @modifiedBy
            FROM oe.GroupProductVendorGroupIds vgi
            INNER JOIN oe.GroupProducts gp ON gp.GroupProductId = vgi.GroupProductId
              AND gp.GroupId = @groupId
              AND gp.IsActive = 1
            INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
            WHERE vgi.IsActive = 1
              AND vgi.IsAutoGenerated = 1
              AND vgi.GroupProductId IS NOT NULL
              AND (
                  p.VendorGroupIdProductType IS NULL
                  OR LTRIM(RTRIM(p.VendorGroupIdProductType)) = N''
                  OR LOWER(LTRIM(RTRIM(p.VendorGroupIdProductType))) IN (N'none', N'master')
                  OR (
                      TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) = 0
                      AND TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(p.VendorGroupIdProductType)), N'')) IS NOT NULL
                  )
              )
              ${vendorClause}
        `);
        const deactivated =
            typeof result.rowsAffected?.[0] === 'number' ? result.rowsAffected[0] : 0;
        return { deactivated };
    }

    /**
     * Apply generate: create vendor group ID rows for group products that don't have one yet.
     *
     * @param {string} groupId - The GroupId (unused but kept for API consistency)
     * @param {string|null} vendorId - Optional VendorId to limit to one vendor
     * @param {string} userId - User ID for audit
     * @returns {Promise<Object>} { success, created: number, errors: string[], deactivatedAutoUntyped?, error? }
     */
    static async applyGenerateForGroup(groupId, vendorId, userId) {
        try {
            await this.ensureGroupProductsForBundleComponents(groupId, userId);
            if (vendorId) {
                await this.ensureGroupProductsForVendorProducts(groupId, vendorId, userId);
            }
            const cleanup = await this.deactivateAutoVendorGroupIdsWithoutProductIncrement(
                groupId,
                vendorId,
                userId
            );
            const previewResult = await this.previewGenerateForGroup(groupId, vendorId);
            if (!previewResult.success) return { success: false, error: previewResult.error, created: 0, errors: [] };
            const toCreate = previewResult.preview.filter(p => !p.alreadyExists);
            const masterRows = toCreate.filter(p => p.isMaster);
            const productRows = toCreate.filter(p => !p.isMaster);
            let created = 0;
            const errors = [];
            // Create Master (group-level) IDs first so base is set for CoPay/HSA
            for (const p of masterRows) {
                const result = await this.createManualGroupId(groupId, null, p.vendorId, p.vendorGroupId, 'Master', userId, null);
                if (result.success) created++;
                else if (!result.success) errors.push(`${p.productName}: ${result.error}`);
            }
            for (const p of productRows) {
                const result = await this.generateAndStoreGroupId(p.groupProductId, p.vendorId, p.productType, userId, null);
                if (result.success && !result.alreadyExists) created++;
                else if (!result.success) errors.push(`${p.productName}: ${result.error}`);
            }
            return { success: true, created, errors, deactivatedAutoUntyped: cleanup.deactivated };
        } catch (error) {
            console.error('❌ Error applying generate group IDs:', error);
            return { success: false, error: error.message, created: 0, errors: [] };
        }
    }

    /**
     * Get all vendor Group IDs for a group
     * 
     * @param {string} groupId - The GroupId
     * @param {string} vendorId - The VendorId
     * @returns {Promise<Object>} { success: boolean, groupIds?: Array, error?: string }
     */
    static async getGroupVendorGroupIds(groupId, vendorId) {
        try {
            const pool = await getPool();
            
            // Query for both group-level (Master) and product-level (CoPay, HSA) Group IDs
            const result = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    -- Master Group IDs (group-level, no GroupProductId)
                    SELECT 
                        vgi.VendorGroupId,
                        vgi.ProductType,
                        vgi.IsAutoGenerated,
                        NULL as GroupProductId,
                        NULL as ProductId,
                        'Master' as ProductName,
                        vgi.GroupId,
                        0 as SortOrder
                    FROM oe.GroupProductVendorGroupIds vgi
                    WHERE vgi.GroupId = @groupId
                      AND vgi.VendorId = @vendorId
                      AND vgi.ProductType = 'Master'
                      AND vgi.GroupProductId IS NULL
                      AND vgi.IsActive = 1
                    
                    UNION ALL
                    
                    -- Product-specific Group IDs (CoPay, HSA, etc.)
                    SELECT 
                        vgi.VendorGroupId,
                        vgi.ProductType,
                        vgi.IsAutoGenerated,
                        gp.GroupProductId,
                        p.ProductId,
                        p.Name as ProductName,
                        NULL as GroupId,
                        1 as SortOrder
                    FROM oe.GroupProductVendorGroupIds vgi
                    INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                    INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                    WHERE gp.GroupId = @groupId
                      AND vgi.VendorId = @vendorId
                      AND vgi.GroupProductId IS NOT NULL
                      AND vgi.IsActive = 1
                      AND gp.IsActive = 1
                    
                    ORDER BY 
                        SortOrder,
                        ProductType,
                        ProductName
                `);
            
            return {
                success: true,
                groupIds: result.recordset
            };
            
        } catch (error) {
            console.error('❌ Error getting Group Vendor Group IDs:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // ============================================================
    // LOCATION VENDOR ID METHODS
    // ============================================================

    /**
     * Check if a VendorLocationId is already in use for the given vendor across
     * both GroupProductVendorGroupIds and GroupLocationVendorIds tables.
     *
     * @param {Object} pool - DB pool
     * @param {string} vendorId
     * @param {string} vendorLocationId
     * @param {string|null} excludeLocationId - exclude this locationId from the check (for update scenarios)
     * @returns {Promise<boolean>}
     */
    static async isLocationVendorIdInUse(pool, vendorId, vendorLocationId, excludeLocationId = null) {
        // Check GroupProductVendorGroupIds (master group IDs share the same namespace)
        const gvgiReq = pool.request();
        gvgiReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        gvgiReq.input('vendorLocationId', sql.NVarChar(50), vendorLocationId);
        const gvgiResult = await gvgiReq.query(`
            SELECT 1 FROM oe.GroupProductVendorGroupIds
            WHERE VendorId = @vendorId AND VendorGroupId = @vendorLocationId AND IsActive = 1
        `);
        if (gvgiResult.recordset.length > 0) return true;

        // Check GroupLocationVendorIds
        const lviReq = pool.request();
        lviReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        lviReq.input('vendorLocationId', sql.NVarChar(50), vendorLocationId);
        let excludeClause = '';
        if (excludeLocationId) {
            lviReq.input('excludeLocationId', sql.UniqueIdentifier, excludeLocationId);
            excludeClause = ' AND LocationId != @excludeLocationId';
        }
        const lviResult = await lviReq.query(`
            SELECT 1 FROM oe.GroupLocationVendorIds
            WHERE VendorId = @vendorId AND VendorLocationId = @vendorLocationId AND IsActive = 1
            ${excludeClause}
        `);
        return lviResult.recordset.length > 0;
    }

    /**
     * Get the location-vendor-group-ids setting for a (group, vendor) pair.
     * Returns null if no setting row exists yet (defaults: disabled).
     *
     * @param {string} groupId
     * @param {string} vendorId
     * @returns {Promise<Object|null>}
     */
    static async getLocationSetting(groupId, vendorId) {
        const pool = await getPool();
        const req = pool.request();
        req.input('groupId', sql.UniqueIdentifier, groupId);
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        const result = await req.query(`
            SELECT SettingId, GroupId, VendorId, TenantId,
                   LocationVendorGroupIdsEnabled, CreatedDate, ModifiedDate
            FROM oe.GroupVendorLocationIdSettings
            WHERE GroupId = @groupId AND VendorId = @vendorId
        `);
        return result.recordset.length > 0 ? result.recordset[0] : null;
    }

    /**
     * Upsert the location-vendor-group-ids setting for a (group, vendor) pair.
     *
     * @param {string} groupId
     * @param {string} vendorId
     * @param {boolean} enabled
     * @param {string} tenantId
     * @param {string} userId
     * @returns {Promise<Object>} { success, data }
     */
    static async upsertLocationSetting(groupId, vendorId, enabled, tenantId, userId) {
        const pool = await getPool();
        const existingReq = pool.request();
        existingReq.input('groupId', sql.UniqueIdentifier, groupId);
        existingReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        const existing = await existingReq.query(`
            SELECT SettingId FROM oe.GroupVendorLocationIdSettings
            WHERE GroupId = @groupId AND VendorId = @vendorId
        `);

        if (existing.recordset.length > 0) {
            const updReq = pool.request();
            updReq.input('groupId', sql.UniqueIdentifier, groupId);
            updReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            updReq.input('enabled', sql.Bit, enabled ? 1 : 0);
            updReq.input('modifiedBy', sql.UniqueIdentifier, userId);
            await updReq.query(`
                UPDATE oe.GroupVendorLocationIdSettings
                SET LocationVendorGroupIdsEnabled = @enabled,
                    ModifiedDate = GETDATE(),
                    ModifiedBy   = @modifiedBy
                WHERE GroupId = @groupId AND VendorId = @vendorId
            `);
        } else {
            const insReq = pool.request();
            insReq.input('settingId', sql.UniqueIdentifier, require('crypto').randomUUID());
            insReq.input('groupId', sql.UniqueIdentifier, groupId);
            insReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            insReq.input('tenantId', sql.UniqueIdentifier, tenantId);
            insReq.input('enabled', sql.Bit, enabled ? 1 : 0);
            insReq.input('createdBy', sql.UniqueIdentifier, userId);
            insReq.input('modifiedBy', sql.UniqueIdentifier, userId);
            await insReq.query(`
                INSERT INTO oe.GroupVendorLocationIdSettings
                    (SettingId, GroupId, VendorId, TenantId, LocationVendorGroupIdsEnabled,
                     CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                VALUES
                    (@settingId, @groupId, @vendorId, @tenantId, @enabled,
                     GETDATE(), GETDATE(), @createdBy, @modifiedBy)
            `);
        }

        return { success: true, data: { LocationVendorGroupIdsEnabled: !!enabled } };
    }

    /**
     * Preview location vendor IDs for a (group, vendor) pair.
     * Returns one entry per active GroupLocations row, showing the existing or proposed
     * VendorLocationId (using the same prefix/seed/increment as master IDs).
     *
     * @param {string} groupId
     * @param {string} vendorId
     * @returns {Promise<Object>} { success, preview: Array<{locationId, locationName, vendorLocationId, alreadyExists}> }
     */
    static async previewLocationVendorGroupIds(groupId, vendorId) {
        try {
            const pool = await getPool();

            // Get vendor configuration
            const vendorReq = pool.request();
            vendorReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            const vendorResult = await vendorReq.query(`
                SELECT GroupIdPrefix, GroupIdSeedNumber, GroupIdAffixPosition, GroupIdBetweenGroupsIncrement
                FROM oe.Vendors WHERE VendorId = @vendorId
            `);
            if (vendorResult.recordset.length === 0) {
                return { success: false, error: 'Vendor not found', preview: [] };
            }
            const vendor = vendorResult.recordset[0];
            if (vendor.GroupIdSeedNumber === null || vendor.GroupIdSeedNumber === undefined) {
                return { success: false, error: 'Vendor does not have GroupIdSeedNumber configured', preview: [] };
            }

            const affixPosition = this.normalizeAffixPosition(vendor.GroupIdAffixPosition);
            const step = this.normalizeBetweenGroupsStep(vendor.GroupIdBetweenGroupsIncrement);
            const prefix = vendor.GroupIdPrefix || '';

            // Get active locations for this group
            const locsReq = pool.request();
            locsReq.input('groupId', sql.UniqueIdentifier, groupId);
            const locsResult = await locsReq.query(`
                SELECT LocationId, Name, IsPrimary
                FROM oe.GroupLocations
                WHERE GroupId = @groupId AND Status = 'Active'
                ORDER BY IsPrimary DESC, CreatedDate ASC
            `);
            const locations = locsResult.recordset || [];
            if (locations.length === 0) {
                return { success: true, preview: [] };
            }

            // Get existing location vendor IDs for this group+vendor
            const existingReq = pool.request();
            existingReq.input('groupId', sql.UniqueIdentifier, groupId);
            existingReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            const existingResult = await existingReq.query(`
                SELECT lvi.LocationId, lvi.VendorLocationId
                FROM oe.GroupLocationVendorIds lvi
                INNER JOIN oe.GroupLocations gl ON lvi.LocationId = gl.LocationId
                WHERE gl.GroupId = @groupId AND lvi.VendorId = @vendorId AND lvi.IsActive = 1
            `);
            const existingMap = new Map(
                (existingResult.recordset || []).map(r => [String(r.LocationId), r.VendorLocationId])
            );

            // Determine base number for this group (use master vendor group ID if present)
            const masterReq = pool.request();
            masterReq.input('groupId', sql.UniqueIdentifier, groupId);
            masterReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            const masterResult = await masterReq.query(`
                SELECT VendorGroupId FROM oe.GroupProductVendorGroupIds
                WHERE GroupId = @groupId AND VendorId = @vendorId
                  AND ProductType = 'Master' AND GroupProductId IS NULL AND IsActive = 1
            `);

            let baseGroupId;
            if (masterResult.recordset.length > 0) {
                baseGroupId = this.parseNumericPartFromVendorGroupId(
                    masterResult.recordset[0].VendorGroupId,
                    prefix,
                    affixPosition
                );
            } else {
                // Count new groups to determine next base, same as generateAndStoreGroupId
                const countReq = pool.request();
                countReq.input('vendorId', sql.UniqueIdentifier, vendorId);
                countReq.input('seedNumber', sql.Int, vendor.GroupIdSeedNumber);
                if (prefix) countReq.input('numericAffix', sql.NVarChar(50), prefix);
                const numericExpr = this.buildNumericPartSqlExpr('vgi.VendorGroupId', prefix, affixPosition, 'numericAffix');
                const countResult = await countReq.query(`
                    SELECT COUNT(DISTINCT g) AS NewGroupCount FROM (
                        SELECT vgi.GroupId AS g FROM oe.GroupProductVendorGroupIds vgi
                        WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND vgi.GroupId IS NOT NULL
                          AND ${numericExpr} >= @seedNumber
                        UNION
                        SELECT gp.GroupId FROM oe.GroupProductVendorGroupIds vgi
                        INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
                        INNER JOIN oe.Products p ON gp.ProductId = p.ProductId
                        WHERE vgi.VendorId = @vendorId AND vgi.IsActive = 1 AND p.VendorId = @vendorId AND gp.IsActive = 1
                          AND ${numericExpr} >= @seedNumber
                    ) AS groups
                `);
                const newGroupCount = countResult.recordset[0]?.NewGroupCount || 0;
                baseGroupId = vendor.GroupIdSeedNumber + (newGroupCount * step);
            }

            // Assign a sequential sub-number for each location (base + location index)
            // Location 0 = base, location 1 = base + 1, etc.
            const tentativeIds = new Set();
            // Pre-populate tentative with existing ones
            for (const vid of existingMap.values()) tentativeIds.add(vid);

            const preview = [];
            for (let i = 0; i < locations.length; i++) {
                const loc = locations[i];
                const locIdStr = String(loc.LocationId);
                if (existingMap.has(locIdStr)) {
                    preview.push({
                        locationId: loc.LocationId,
                        locationName: loc.Name || '',
                        isPrimary: !!loc.IsPrimary,
                        vendorLocationId: existingMap.get(locIdStr),
                        alreadyExists: true,
                    });
                    continue;
                }

                // Compute next available ID starting at base + i
                let candidateNum = baseGroupId + i;
                let candidateId = this.formatVendorGroupId(prefix, candidateNum, affixPosition);
                for (let attempts = 0; attempts < 100; attempts++) {
                    const inUse = await this.isLocationVendorIdInUse(pool, vendorId, candidateId);
                    if (!inUse && !tentativeIds.has(candidateId)) break;
                    candidateNum += 1;
                    candidateId = this.formatVendorGroupId(prefix, candidateNum, affixPosition);
                }
                tentativeIds.add(candidateId);
                preview.push({
                    locationId: loc.LocationId,
                    locationName: loc.Name || '',
                    isPrimary: !!loc.IsPrimary,
                    vendorLocationId: candidateId,
                    alreadyExists: false,
                });
            }

            return { success: true, preview };
        } catch (error) {
            console.error('❌ Error previewing location vendor group IDs:', error);
            return { success: false, error: error.message, preview: [] };
        }
    }

    /**
     * Generate and persist location vendor IDs for all active GroupLocations
     * in this group that are missing one for the given vendor.
     *
     * Uses the same prefix/seed/increment as master IDs.
     * Uniqueness: location vendor IDs are checked against both
     * GroupProductVendorGroupIds and GroupLocationVendorIds (same vendor namespace).
     *
     * @param {string} groupId
     * @param {string} vendorId
     * @param {string} userId
     * @returns {Promise<Object>} { success, created, errors }
     */
    static async generateLocationVendorGroupIds(groupId, vendorId, userId) {
        try {
            const pool = await getPool();

            // Get tenant from group
            const groupReq = pool.request();
            groupReq.input('groupId', sql.UniqueIdentifier, groupId);
            const groupResult = await groupReq.query(`
                SELECT TenantId FROM oe.Groups WHERE GroupId = @groupId
            `);
            if (groupResult.recordset.length === 0) {
                return { success: false, error: 'Group not found', created: 0, errors: [] };
            }
            const tenantId = groupResult.recordset[0].TenantId;

            const previewResult = await this.previewLocationVendorGroupIds(groupId, vendorId);
            if (!previewResult.success) {
                return { success: false, error: previewResult.error, created: 0, errors: [] };
            }

            const toCreate = previewResult.preview.filter(p => !p.alreadyExists);
            let created = 0;
            const errors = [];

            for (const row of toCreate) {
                try {
                    const insReq = pool.request();
                    insReq.input('rowId', sql.UniqueIdentifier, require('crypto').randomUUID());
                    insReq.input('locationId', sql.UniqueIdentifier, row.locationId);
                    insReq.input('vendorId', sql.UniqueIdentifier, vendorId);
                    insReq.input('tenantId', sql.UniqueIdentifier, tenantId);
                    insReq.input('vendorLocationId', sql.NVarChar(50), row.vendorLocationId);
                    insReq.input('isAutoGenerated', sql.Bit, 1);
                    insReq.input('createdBy', sql.UniqueIdentifier, userId);
                    insReq.input('modifiedBy', sql.UniqueIdentifier, userId);
                    await insReq.query(`
                        INSERT INTO oe.GroupLocationVendorIds
                            (LocationVendorIdRow, LocationId, VendorId, TenantId, VendorLocationId,
                             IsAutoGenerated, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                        VALUES
                            (@rowId, @locationId, @vendorId, @tenantId, @vendorLocationId,
                             @isAutoGenerated, 1, GETDATE(), GETDATE(), @createdBy, @modifiedBy)
                    `);
                    created++;
                } catch (e) {
                    errors.push(`Location ${row.locationId}: ${e.message}`);
                }
            }

            return { success: true, created, errors };
        } catch (error) {
            console.error('❌ Error generating location vendor group IDs:', error);
            return { success: false, error: error.message, created: 0, errors: [] };
        }
    }

    /**
     * Auto-generate a location vendor ID for a single newly-created location,
     * for all vendors that have LocationVendorGroupIdsEnabled = 1 for this group.
     *
     * Called from groupLocations POST after the location is inserted.
     *
     * @param {string} groupId
     * @param {string} locationId
     * @param {string} tenantId
     * @param {string} userId
     * @returns {Promise<{ vendorsProcessed: number, created: number, errors: string[] }>}
     */
    static async autoGenerateForNewLocation(groupId, locationId, tenantId, userId) {
        const pool = await getPool();

        // Find vendors with LocationVendorGroupIdsEnabled for this group
        const settingsReq = pool.request();
        settingsReq.input('groupId', sql.UniqueIdentifier, groupId);
        const settingsResult = await settingsReq.query(`
            SELECT VendorId FROM oe.GroupVendorLocationIdSettings
            WHERE GroupId = @groupId AND LocationVendorGroupIdsEnabled = 1
        `);
        const vendors = settingsResult.recordset || [];
        if (vendors.length === 0) return { vendorsProcessed: 0, created: 0, errors: [] };

        let created = 0;
        const errors = [];

        for (const row of vendors) {
            const vendorId = String(row.VendorId);
            // Only generate if this location doesn't already have one for this vendor
            const checkReq = pool.request();
            checkReq.input('locationId', sql.UniqueIdentifier, locationId);
            checkReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            const checkResult = await checkReq.query(`
                SELECT 1 FROM oe.GroupLocationVendorIds
                WHERE LocationId = @locationId AND VendorId = @vendorId AND IsActive = 1
            `);
            if (checkResult.recordset.length > 0) continue;

            // Run the full group generate which will fill in the new location's slot
            const genResult = await this.generateLocationVendorGroupIds(groupId, vendorId, userId);
            if (genResult.success) {
                created += genResult.created;
            } else {
                errors.push(`Vendor ${vendorId}: ${genResult.error}`);
            }
        }

        return { vendorsProcessed: vendors.length, created, errors };
    }

    /**
     * Get all location vendor IDs for a group + vendor combination.
     *
     * @param {string} groupId
     * @param {string} vendorId
     * @returns {Promise<Object>} { success, locationIds: Array }
     */
    static async getLocationVendorIds(groupId, vendorId) {
        try {
            const pool = await getPool();
            const req = pool.request();
            req.input('groupId', sql.UniqueIdentifier, groupId);
            req.input('vendorId', sql.UniqueIdentifier, vendorId);
            const result = await req.query(`
                SELECT lvi.LocationVendorIdRow, lvi.LocationId, lvi.VendorLocationId,
                       lvi.IsAutoGenerated, lvi.IsActive,
                       gl.Name AS LocationName, gl.IsPrimary
                FROM oe.GroupLocationVendorIds lvi
                INNER JOIN oe.GroupLocations gl ON lvi.LocationId = gl.LocationId
                WHERE gl.GroupId = @groupId AND lvi.VendorId = @vendorId AND lvi.IsActive = 1
                ORDER BY gl.IsPrimary DESC, gl.CreatedDate ASC
            `);
            return { success: true, locationIds: result.recordset || [] };
        } catch (error) {
            console.error('❌ Error getting location vendor IDs:', error);
            return { success: false, error: error.message, locationIds: [] };
        }
    }

    /**
     * Manually override (or create) the VendorLocationId for a specific location + vendor.
     *
     * @param {string} locationId
     * @param {string} vendorId
     * @param {string} vendorLocationId
     * @param {string} tenantId
     * @param {string} userId
     * @returns {Promise<Object>} { success, error? }
     */
    static async upsertLocationVendorId(locationId, vendorId, vendorLocationId, tenantId, userId) {
        try {
            const pool = await getPool();

            // Validate not already in use by another location
            const inUse = await this.isLocationVendorIdInUse(pool, vendorId, vendorLocationId, locationId);
            if (inUse) {
                return { success: false, error: `Vendor location ID "${vendorLocationId}" is already in use for this vendor` };
            }

            // Check if an active row exists for this location+vendor
            const checkReq = pool.request();
            checkReq.input('locationId', sql.UniqueIdentifier, locationId);
            checkReq.input('vendorId', sql.UniqueIdentifier, vendorId);
            const checkResult = await checkReq.query(`
                SELECT LocationVendorIdRow FROM oe.GroupLocationVendorIds
                WHERE LocationId = @locationId AND VendorId = @vendorId AND IsActive = 1
            `);

            if (checkResult.recordset.length > 0) {
                const updReq = pool.request();
                updReq.input('locationId', sql.UniqueIdentifier, locationId);
                updReq.input('vendorId', sql.UniqueIdentifier, vendorId);
                updReq.input('vendorLocationId', sql.NVarChar(50), vendorLocationId);
                updReq.input('modifiedBy', sql.UniqueIdentifier, userId);
                await updReq.query(`
                    UPDATE oe.GroupLocationVendorIds
                    SET VendorLocationId = @vendorLocationId,
                        IsAutoGenerated  = 0,
                        ModifiedDate     = GETDATE(),
                        ModifiedBy       = @modifiedBy
                    WHERE LocationId = @locationId AND VendorId = @vendorId AND IsActive = 1
                `);
            } else {
                const insReq = pool.request();
                insReq.input('rowId', sql.UniqueIdentifier, require('crypto').randomUUID());
                insReq.input('locationId', sql.UniqueIdentifier, locationId);
                insReq.input('vendorId', sql.UniqueIdentifier, vendorId);
                insReq.input('tenantId', sql.UniqueIdentifier, tenantId);
                insReq.input('vendorLocationId', sql.NVarChar(50), vendorLocationId);
                insReq.input('createdBy', sql.UniqueIdentifier, userId);
                insReq.input('modifiedBy', sql.UniqueIdentifier, userId);
                await insReq.query(`
                    INSERT INTO oe.GroupLocationVendorIds
                        (LocationVendorIdRow, LocationId, VendorId, TenantId, VendorLocationId,
                         IsAutoGenerated, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
                    VALUES
                        (@rowId, @locationId, @vendorId, @tenantId, @vendorLocationId,
                         0, 1, GETDATE(), GETDATE(), @createdBy, @modifiedBy)
                `);
            }

            return { success: true, vendorLocationId };
        } catch (error) {
            console.error('❌ Error upserting location vendor ID:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = VendorGroupIdService;
