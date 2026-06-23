const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../config/database');
const { authorize, getUserRoles } = require('../middleware/auth');
const { GROUP_DETAIL_READ_STATUS_SQL } = require('../utils/groupRouteAccess');

// GET /api/groups/:groupId/contributions - Get all contribution rules for a group
router.get('/:groupId/contributions', async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        
        // Verify group exists and user has access
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId, g.Name 
            FROM oe.Groups g 
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Check if new columns exist (for backward compatibility)
        let ageRulesColumnExists = false;
        let jobPositionsColumnExists = false;
        let equivalentTierColumnExists = false;
        try {
            const ageRulesCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'AgeRules'
            `);
            ageRulesColumnExists = ageRulesCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify AgeRules column existence:', checkError.message);
            ageRulesColumnExists = false;
        }
        
        try {
            const jobPositionsCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'JobPositions'
            `);
            jobPositionsColumnExists = jobPositionsCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify JobPositions column existence:', checkError.message);
            jobPositionsColumnExists = false;
        }
        
        try {
            const equivalentTierCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'EquivalentTier'
            `);
            equivalentTierColumnExists = equivalentTierCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify EquivalentTier column existence:', checkError.message);
            equivalentTierColumnExists = false;
        }
        let productIdsColumnExists = false;
        try {
            const productIdsCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'ProductIds'
            `);
            productIdsColumnExists = productIdsCheck.recordset.length > 0;
        } catch (checkError) {
            productIdsColumnExists = false;
        }
        
        // Build SELECT columns dynamically based on what exists
        const selectColumns = [
            'gc.ContributionId',
            'gc.GroupId',
            'gc.ProductId',
            ...(productIdsColumnExists ? ['gc.ProductIds'] : []),
            'p.Name as ProductName',
            'gc.Name',
            'gc.Description',
            'gc.ContributionType',
            'gc.ContributionDirection',
            'gc.FlatRateAmount',
            'gc.PercentageAmount',
            ...(equivalentTierColumnExists ? ['gc.EquivalentTier'] : []),
            'gc.TierContributions',
            'gc.RoleContributions',
            'gc.TenureRules',
            ...(ageRulesColumnExists ? ['gc.AgeRules'] : []),
            ...(jobPositionsColumnExists ? ['gc.JobPositions'] : []),
            'gc.DivisionRules',
            'gc.OverrideType',
            'gc.OverrideAmount',
            'gc.MinimumAmount',
            'gc.Priority',
            'gc.Stacking',
            'gc.AppliesTo',
            'gc.EffectiveDate',
            'gc.EndDate',
            'gc.Status',
            'gc.CreatedDate',
            'gc.ModifiedDate'
        ].join(', ');
        
        // Get contribution rules
        const contributionsQuery = `
            SELECT 
                ${selectColumns}
            FROM oe.GroupContributions gc
            LEFT JOIN oe.Products p ON gc.ProductId = p.ProductId
            WHERE gc.GroupId = @groupId
            ORDER BY gc.Priority, gc.CreatedDate
        `;
        
        const contributionsRequest = pool.request();
        contributionsRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const contributionsResult = await contributionsRequest.query(contributionsQuery);
        
        // Parse JSON fields; support productIds (multi) with productId (single) fallback
        const contributions = contributionsResult.recordset.map(contrib => {
            let productIds = [];
            if (productIdsColumnExists && contrib.ProductIds) {
                try {
                    productIds = Array.isArray(contrib.ProductIds) ? contrib.ProductIds : JSON.parse(contrib.ProductIds || '[]');
                } catch (_) {
                    productIds = [];
                }
            }
            if (productIds.length === 0 && contrib.ProductId) {
                productIds = [contrib.ProductId];
            }
            const productId = productIds.length === 1 ? productIds[0] : (contrib.ProductId || null);
            return {
                ...contrib,
                productId,
                productIds: productIds.length > 0 ? productIds : undefined,
                equivalentTier: equivalentTierColumnExists ? (contrib.EquivalentTier || null) : null,
                tierContributions: contrib.TierContributions ? JSON.parse(contrib.TierContributions) : null,
                roleContributions: contrib.RoleContributions ? JSON.parse(contrib.RoleContributions) : null,
                tenureRules: contrib.TenureRules ? JSON.parse(contrib.TenureRules) : null,
                ageRules: ageRulesColumnExists && contrib.AgeRules ? JSON.parse(contrib.AgeRules) : null,
                jobPositions: jobPositionsColumnExists && contrib.JobPositions ? JSON.parse(contrib.JobPositions) : null,
                divisionRules: contrib.DivisionRules ? JSON.parse(contrib.DivisionRules) : null,
                appliesTo: contrib.AppliesTo ? JSON.parse(contrib.AppliesTo) : null
            };
        });
        
        res.json({
            success: true,
            data: contributions
        });
        
        console.log(`✅ Retrieved ${contributions.length} contribution rules for group ${groupId}`);
        
    } catch (error) {
        console.error('❌ Error fetching contribution rules:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch contribution rules'
        });
    }
});

// POST /api/groups/:groupId/contributions - Create a new contribution rule
router.post('/:groupId/contributions', authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const {
            productId: productIdBody,
            productIds: productIdsBody,
            name,
            description,
            contributionType,
            contributionDirection = 'Employer', // NEW: Default to 'Employer' for backward compatibility
            flatRateAmount,
            percentageAmount,
            tierContributions,
            roleContributions,
            tenureRules,
            ageRules,
            jobPositions,
            divisionRules,
            overrideType,
            overrideAmount,
            minimumAmount,
            priority = 1,
            stacking = true,
            appliesTo,
            effectiveDate,
            endDate,
            status = 'Active',
            equivalentTier
        } = req.body;
        
        // Validation
        if (!name || !contributionType || !effectiveDate) {
            return res.status(400).json({
                success: false,
                message: 'Name, contribution type, and effective date are required'
            });
        }
        
        const validContributionTypes = ['flat_rate', 'percentage', 'tier_based', 'role_based', 'tenure_based', 'age_based', 'division_based', 'override', 'minimum_threshold'];
        if (!validContributionTypes.includes(contributionType)) {
            return res.status(400).json({
                success: false,
                message: `Invalid contribution type. Must be one of: ${validContributionTypes.join(', ')}`
            });
        }
        const validEquivalentTiers = ['EE', 'ES', 'EC', 'EF'];
        if (equivalentTier != null && equivalentTier !== '') {
            if (contributionType !== 'percentage') {
                return res.status(400).json({
                    success: false,
                    message: 'equivalentTier is only valid when contributionType is percentage'
                });
            }
            if (!validEquivalentTiers.includes(equivalentTier)) {
                return res.status(400).json({
                    success: false,
                    message: `equivalentTier must be one of: ${validEquivalentTiers.join(', ')} or null`
                });
            }
        }
        
        const pool = await getPool();
        
        // Verify group exists and user has access
        let groupCheckQuery = `
            SELECT g.GroupId, g.TenantId 
            FROM oe.Groups g 
            WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupCheckQuery += ' AND g.TenantId = @userTenantId';
            groupCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Group not found or access denied'
            });
        }
        
        // Normalize product selection: productIds (array) takes precedence; fallback to single productId
        let productId = null;
        let productIdsJson = null;
        if (Array.isArray(productIdsBody) && productIdsBody.length > 0) {
            productId = productIdsBody.length === 1 ? productIdsBody[0] : null;
            productIdsJson = productIdsBody.length > 1 ? JSON.stringify(productIdsBody) : null;
        } else {
            productId = productIdBody || null;
        }
        
        // Verify product(s) exist
        const idsToVerify = productIdsJson ? JSON.parse(productIdsJson) : (productId ? [productId] : []);
        for (const pid of idsToVerify) {
            const productCheckRequest = pool.request();
            productCheckRequest.input('productId', sql.UniqueIdentifier, pid);
            const productResult = await productCheckRequest.query('SELECT ProductId FROM oe.Products WHERE ProductId = @productId');
            if (productResult.recordset.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid product ID: ' + pid
                });
            }
        }

        // Duplicate check: same product scope + same job position filter = cannot add
        const existingRequest = pool.request();
        existingRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const existingQuery = `
            SELECT ProductId, JobPositions
            FROM oe.GroupContributions
            WHERE GroupId = @groupId AND Status = 'Active'
        `;
        const existingResult = await existingRequest.query(existingQuery);
        const normalizeJobPositions = (val) => {
            if (val == null) return [];
            const arr = typeof val === 'string' ? (() => { try { return JSON.parse(val); } catch { return []; } })() : (Array.isArray(val) ? val : []);
            return (Array.isArray(arr) ? arr : []).filter(Boolean).map(String).sort();
        };
        const newProductId = productId || null;
        const newJobPositionsKey = JSON.stringify(normalizeJobPositions(jobPositions));
        for (const row of existingResult.recordset || []) {
            const existingProductId = row.ProductId || null;
            const existingJobPositionsKey = JSON.stringify(normalizeJobPositions(row.JobPositions));
            if (existingProductId === newProductId && existingJobPositionsKey === newJobPositionsKey) {
                const scope = newProductId ? 'this product' : 'all products';
                const roleDesc = newJobPositionsKey === '[]' ? '' : ` with the same job position filter`;
                return res.status(400).json({
                    success: false,
                    message: `A contribution rule for ${scope}${roleDesc} already exists. You cannot add a duplicate.`
                });
            }
        }

        // Check if new columns exist (for backward compatibility)
        let ageRulesColumnExists = false;
        let jobPositionsColumnExists = false;
        try {
            const ageRulesCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'AgeRules'
            `);
            ageRulesColumnExists = ageRulesCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify AgeRules column existence:', checkError.message);
            ageRulesColumnExists = false;
        }
        
        try {
            const jobPositionsCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'JobPositions'
            `);
            jobPositionsColumnExists = jobPositionsCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify JobPositions column existence:', checkError.message);
            jobPositionsColumnExists = false;
        }
        
        let equivalentTierColumnExists = false;
        try {
            const equivalentTierCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'EquivalentTier'
            `);
            equivalentTierColumnExists = equivalentTierCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify EquivalentTier column existence:', checkError.message);
            equivalentTierColumnExists = false;
        }
        let productIdsColumnExistsInsert = false;
        try {
            const pc = await pool.request().query(`
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
            `);
            productIdsColumnExistsInsert = (pc.recordset || []).length > 0;
        } catch (_) {
            productIdsColumnExistsInsert = false;
        }
        
        const contributionId = require('crypto').randomUUID();
        
        const insertRequest = pool.request();
        insertRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        insertRequest.input('groupId', sql.UniqueIdentifier, groupId);
        insertRequest.input('productId', sql.UniqueIdentifier, productId || null);
        if (productIdsColumnExistsInsert) {
            insertRequest.input('productIds', sql.NVarChar, productIdsJson);
        }
        insertRequest.input('name', sql.NVarChar, name);
        insertRequest.input('description', sql.NVarChar, description || null);
        insertRequest.input('contributionType', sql.NVarChar, contributionType);
        insertRequest.input('contributionDirection', sql.NVarChar, contributionDirection || 'Employer');
        // Round to 2 decimals to prevent floating point errors (e.g., 178.0000001 -> 178.00)
        insertRequest.input('flatRateAmount', sql.Decimal(18,2), flatRateAmount ? Math.round(flatRateAmount * 100) / 100 : null);
        insertRequest.input('percentageAmount', sql.Decimal(5,2), percentageAmount ? Math.round(percentageAmount * 100) / 100 : null);
        const equivalentTierValue = (contributionType === 'percentage' && equivalentTier != null && equivalentTier !== '')
          ? String(equivalentTier).trim().toUpperCase()
          : null;
        if (equivalentTierColumnExists) {
            insertRequest.input('equivalentTier', sql.NVarChar(10), equivalentTierValue);
        }
        // Round tier contribution amounts to 2 decimals
        const roundedTierContributions = tierContributions ? {
          ...tierContributions,
          employee_only: tierContributions.employee_only ? Math.round(tierContributions.employee_only * 100) / 100 : undefined,
          employee_spouse: tierContributions.employee_spouse ? Math.round(tierContributions.employee_spouse * 100) / 100 : undefined,
          employee_children: tierContributions.employee_children ? Math.round(tierContributions.employee_children * 100) / 100 : undefined,
          family: tierContributions.family ? Math.round(tierContributions.family * 100) / 100 : undefined
        } : null;
        insertRequest.input('tierContributions', sql.NVarChar, roundedTierContributions ? JSON.stringify(roundedTierContributions) : null);
        
        // Round role contribution amounts to 2 decimals
        const roundedRoleContributions = roleContributions ? roleContributions.map((r) => ({
          ...r,
          contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
        })) : null;
        insertRequest.input('roleContributions', sql.NVarChar, roundedRoleContributions ? JSON.stringify(roundedRoleContributions) : null);
        
        // Round tenure rule amounts to 2 decimals
        const roundedTenureRules = tenureRules ? tenureRules.map((r) => ({
          ...r,
          contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
        })) : null;
        insertRequest.input('tenureRules', sql.NVarChar, roundedTenureRules ? JSON.stringify(roundedTenureRules) : null);
        
        insertRequest.input('divisionRules', sql.NVarChar, divisionRules ? JSON.stringify(divisionRules) : null);
        insertRequest.input('overrideType', sql.NVarChar, overrideType || null);
        // Round to 2 decimals to prevent floating point errors
        insertRequest.input('overrideAmount', sql.Decimal(18,2), overrideAmount ? Math.round(overrideAmount * 100) / 100 : null);
        insertRequest.input('minimumAmount', sql.Decimal(18,2), minimumAmount ? Math.round(minimumAmount * 100) / 100 : null);
        insertRequest.input('priority', sql.Int, priority);
        insertRequest.input('stacking', sql.Bit, stacking);
        insertRequest.input('appliesTo', sql.NVarChar, appliesTo ? JSON.stringify(appliesTo) : null);
        insertRequest.input('effectiveDate', sql.Date, effectiveDate);
        insertRequest.input('endDate', sql.Date, endDate || null);
        insertRequest.input('status', sql.NVarChar, status);
        insertRequest.input('createdBy', sql.UniqueIdentifier, req.user.UserId);
        
        // Conditionally add new columns if they exist
        if (ageRulesColumnExists) {
            // Round age rule amounts to 2 decimals (only for flat amounts, percentages stay as-is)
            const roundedAgeRules = ageRules ? ageRules.map((r) => ({
              ...r,
              contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
            })) : null;
            insertRequest.input('ageRules', sql.NVarChar, roundedAgeRules ? JSON.stringify(roundedAgeRules) : null);
        }
        if (jobPositionsColumnExists) {
            insertRequest.input('jobPositions', sql.NVarChar, jobPositions ? JSON.stringify(jobPositions) : null);
        }
        
        // Build column and value lists dynamically
        const baseColumns = [
            'ContributionId', 'GroupId', 'ProductId', 'Name', 'Description', 'ContributionType', 'ContributionDirection',
            'FlatRateAmount', 'PercentageAmount', 'TierContributions', 'RoleContributions',
            'TenureRules', 'DivisionRules', 'OverrideType', 'OverrideAmount', 'MinimumAmount',
            'Priority', 'Stacking', 'AppliesTo', 'EffectiveDate', 'EndDate', 'Status',
            'CreatedDate', 'ModifiedDate', 'CreatedBy', 'ModifiedBy'
        ];
        const baseValues = [
            '@contributionId', '@groupId', '@productId', '@name', '@description', '@contributionType', '@contributionDirection',
            '@flatRateAmount', '@percentageAmount', '@tierContributions', '@roleContributions',
            '@tenureRules', '@divisionRules', '@overrideType', '@overrideAmount', '@minimumAmount',
            '@priority', '@stacking', '@appliesTo', '@effectiveDate', '@endDate', '@status',
            'GETDATE()', 'GETDATE()', '@createdBy', '@createdBy'
        ];
        if (productIdsColumnExistsInsert) {
            baseColumns.splice(baseColumns.indexOf('ProductId') + 1, 0, 'ProductIds');
            baseValues.splice(baseValues.indexOf('@productId') + 1, 0, '@productIds');
        }
        
        // Insert AgeRules and JobPositions in the correct position (after TenureRules, before DivisionRules)
        const tenureIndex = baseColumns.indexOf('TenureRules');
        if (ageRulesColumnExists) {
            baseColumns.splice(tenureIndex + 1, 0, 'AgeRules');
            baseValues.splice(tenureIndex + 1, 0, '@ageRules');
        }
        if (jobPositionsColumnExists) {
            const insertIndex = ageRulesColumnExists ? tenureIndex + 2 : tenureIndex + 1;
            baseColumns.splice(insertIndex, 0, 'JobPositions');
            baseValues.splice(insertIndex, 0, '@jobPositions');
        }
        if (equivalentTierColumnExists) {
            const pctIndex = baseColumns.indexOf('PercentageAmount');
            baseColumns.splice(pctIndex + 1, 0, 'EquivalentTier');
            baseValues.splice(pctIndex + 1, 0, '@equivalentTier');
        }
        
        const insertQuery = `
            INSERT INTO oe.GroupContributions (
                ${baseColumns.join(', ')}
            ) VALUES (
                ${baseValues.join(', ')}
            )
        `;
        
        await insertRequest.query(insertQuery);
        
        res.status(201).json({
            success: true,
            message: 'Contribution rule created successfully',
            data: { contributionId, name, contributionType }
        });
        
        console.log(`✅ Contribution rule created: ${name} (${contributionType}) for group ${groupId}`);
        
    } catch (error) {
        console.error('❌ Error creating contribution rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create contribution rule'
        });
    }
});

// Normalize GUID for product-scope comparison (consistent with ContributionCalculator._normalizeId)
function _normalizeProductId(id) {
    if (id == null) return '';
    return String(id).toLowerCase().trim();
}

// POST /api/groups/:groupId/contributions/calculate - Calculate contributions for a sample scenario
router.post('/:groupId/contributions/calculate', async (req, res) => {
    try {
        const { groupId } = req.params;
        const { employee, plan } = req.body;
        
        if (!employee || !plan) {
            return res.status(400).json({
                success: false,
                message: 'Employee and plan data are required for calculation'
            });
        }
        
        const pool = await getPool();
        
        // Check for ProductIds column so we respect product-specific rules
        let productIdsColumnExistsCalc = false;
        try {
            const pc = await pool.request().query(`
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
            `);
            productIdsColumnExistsCalc = (pc.recordset || []).length > 0;
        } catch (_) {
            productIdsColumnExistsCalc = false;
        }
        // Get contribution rules for the group (include ProductIds so product-specific rules apply only to matching plans)
        const contributionsQuery = `
            SELECT 
                gc.ContributionId,
                gc.Name,
                gc.ContributionType,
                gc.FlatRateAmount,
                gc.PercentageAmount,
                gc.TierContributions,
                gc.RoleContributions,
                gc.TenureRules,
                gc.DivisionRules,
                gc.OverrideType,
                gc.OverrideAmount,
                gc.MinimumAmount,
                gc.Priority,
                gc.Stacking,
                gc.AppliesTo,
                gc.ProductId${productIdsColumnExistsCalc ? ', gc.ProductIds' : ''}
            FROM oe.GroupContributions gc
            WHERE gc.GroupId = @groupId 
              AND gc.Status = 'Active'
              AND gc.EffectiveDate <= GETDATE()
              AND (gc.EndDate IS NULL OR gc.EndDate >= GETDATE())
            ORDER BY gc.Priority
        `;
        
        const contributionsRequest = pool.request();
        contributionsRequest.input('groupId', sql.UniqueIdentifier, groupId);
        const contributionsResult = await contributionsRequest.query(contributionsQuery);
        
        const planProductIdNorm = _normalizeProductId(plan.planId);
        
        // Calculate contribution using the same logic as frontend
        let contribution = 0;
        let appliedRules = [];
        
        for (const rule of contributionsResult.recordset) {
            // Build rule's product scope: product-specific iff it has ProductId or ProductIds
            let ruleProductIds = [];
            if (productIdsColumnExistsCalc && rule.ProductIds) {
                try {
                    ruleProductIds = Array.isArray(rule.ProductIds) ? rule.ProductIds : JSON.parse(rule.ProductIds || '[]');
                } catch (_) {
                    ruleProductIds = [];
                }
            }
            if (ruleProductIds.length === 0 && rule.ProductId) {
                ruleProductIds = [rule.ProductId];
            }
            const ruleIsProductSpecific = ruleProductIds.length > 0;
            if (ruleIsProductSpecific) {
                const ruleProductIdsNorm = new Set(ruleProductIds.map(_normalizeProductId));
                if (!ruleProductIdsNorm.has(planProductIdNorm)) continue;
            }

            // Parse JSON fields
            const tierContributions = rule.TierContributions ? JSON.parse(rule.TierContributions) : null;
            const roleContributions = rule.RoleContributions ? JSON.parse(rule.RoleContributions) : null;
            const tenureRules = rule.TenureRules ? JSON.parse(rule.TenureRules) : null;
            const appliesTo = rule.AppliesTo ? JSON.parse(rule.AppliesTo) : null;
            
            // Check appliesTo filters (employmentClass, planType)
            if (appliesTo?.employmentClass && !appliesTo.employmentClass.includes(employee.employmentClass)) continue;
            if (appliesTo?.planType && !appliesTo.planType.includes(plan.planType)) continue;
            
            // Apply rule
            switch (rule.ContributionType) {
                case 'flat_rate':
                    if (rule.FlatRateAmount) {
                        contribution += rule.FlatRateAmount;
                        appliedRules.push(`${rule.Name}: +${rule.FlatRateAmount}`);
                    }
                    break;
                    
                case 'percentage':
                    if (rule.PercentageAmount) {
                        const pctAmount = plan.monthlyPremium * (rule.PercentageAmount / 100);
                        contribution += pctAmount;
                        appliedRules.push(`${rule.Name}: +${pctAmount.toFixed(2)} (${rule.PercentageAmount}%)`);
                    }
                    break;
                    
                case 'tier_based':
                    if (tierContributions) {
                        const tierKey = employee.coverageTier;
                        const tierAmount = tierContributions[tierKey] || 0;
                        contribution += tierAmount;
                        appliedRules.push(`${rule.Name}: +${tierAmount} (${tierKey})`);
                    }
                    break;
                    
                case 'override':
                    if (rule.OverrideType === 'full_premium') {
                        return res.json({
                            success: true,
                            data: {
                                totalContribution: plan.monthlyPremium,
                                appliedRules: [`${rule.Name}: Full premium coverage (${plan.monthlyPremium})`]
                            }
                        });
                    }
                    break;
            }
            
            if (!rule.Stacking) break;
        }
        
        res.json({
            success: true,
            data: {
                totalContribution: Math.round(contribution * 100) / 100,
                appliedRules: appliedRules
            }
        });
        
    } catch (error) {
        console.error('❌ Error calculating contributions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to calculate contributions'
        });
    }
});

// POST /api/groups/:groupId/contributions/bulk-update - Bulk update contribution rules
router.post('/:groupId/contributions/bulk-update', authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const { contributionIds, updates } = req.body;
        
        if (!contributionIds || !Array.isArray(contributionIds) || contributionIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Contribution IDs array is required'
            });
        }
        
        if (!updates || Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Update data is required'
            });
        }
        
        const pool = await getPool();
        const transaction = pool.transaction();
        await transaction.begin();
        
        try {
            let updatedCount = 0;
            
            for (const contributionId of contributionIds) {
                // Verify each contribution exists and user has access
                let contributionCheckQuery = `
                    SELECT gc.ContributionId
                    FROM oe.GroupContributions gc
                    JOIN oe.Groups g ON gc.GroupId = g.GroupId
                    WHERE gc.ContributionId = @contributionId AND gc.GroupId = @groupId
                `;
                
                const contributionCheckRequest = transaction.request();
                contributionCheckRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
                contributionCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
                
                if (!getUserRoles(req.user).includes('SysAdmin')) {
                    contributionCheckQuery += ' AND g.TenantId = @userTenantId';
                    contributionCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
                }
                
                const contributionResult = await contributionCheckRequest.query(contributionCheckQuery);
                
                if (contributionResult.recordset.length === 0) {
                    continue; // Skip if not found or no access
                }
                
                // Build update query
                const updateRequest = transaction.request();
                updateRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
                updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
                
                const updateFields = [];
                const allowedFields = {
                    'status': 'Status',
                    'priority': 'Priority',
                    'effectiveDate': 'EffectiveDate',
                    'endDate': 'EndDate'
                };
                
                Object.keys(allowedFields).forEach(fieldKey => {
                    if (updates[fieldKey] !== undefined) {
                        const sqlField = allowedFields[fieldKey];
                        updateFields.push(`${sqlField} = @${fieldKey}`);
                        
                        if (fieldKey === 'priority') {
                            updateRequest.input(fieldKey, sql.Int, updates[fieldKey]);
                        } else if (['effectiveDate', 'endDate'].includes(fieldKey)) {
                            updateRequest.input(fieldKey, sql.Date, updates[fieldKey]);
                        } else {
                            updateRequest.input(fieldKey, sql.NVarChar, updates[fieldKey]);
                        }
                    }
                });
                
                if (updateFields.length > 0) {
                    updateFields.push('ModifiedDate = GETDATE()');
                    updateFields.push('ModifiedBy = @modifiedBy');
                    
                    await updateRequest.query(`
                        UPDATE oe.GroupContributions 
                        SET ${updateFields.join(', ')}
                        WHERE ContributionId = @contributionId
                    `);
                    
                    updatedCount++;
                }
            }
            
            await transaction.commit();
            
            res.json({
                success: true,
                message: `Successfully updated ${updatedCount} contribution rules`,
                data: { updatedCount }
            });
            
            console.log(`✅ Bulk updated ${updatedCount} contribution rules for group ${groupId}`);
            
        } catch (transactionError) {
            await transaction.rollback();
            throw transactionError;
        }
        
    } catch (error) {
        console.error('❌ Error bulk updating contribution rules:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to bulk update contribution rules'
        });
    }
});

const ApplyContributionsToExistingService = require('../services/ApplyContributionsToExistingService');

// GET /api/groups/:groupId/contributions/apply-to-existing/preview - Preview which members would get contributions applied
router.get('/:groupId/contributions/apply-to-existing/preview', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const pool = await getPool();
        let groupCheckQuery = `SELECT g.GroupId, g.TenantId FROM oe.Groups g WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}`;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupCheckQuery += ' AND g.TenantId = @userTenantId';
            groupCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }
        const { members, ruleContributionIds } = await ApplyContributionsToExistingService.previewApplyToExisting(groupId);
        return res.json({ success: true, data: { members, ruleContributionIds } });
    } catch (error) {
        console.error('❌ Error previewing apply contributions to existing:', error);
        return res.status(500).json({ success: false, message: error.message || 'Preview failed' });
    }
});

// POST /api/groups/:groupId/contributions/apply-to-existing - Apply contribution enrollments to existing members
router.post('/:groupId/contributions/apply-to-existing', authorize(['SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId } = req.params;
        const { memberIds } = req.body || {};
        const pool = await getPool();
        let groupCheckQuery = `SELECT g.GroupId, g.TenantId FROM oe.Groups g WHERE g.GroupId = @groupId AND ${GROUP_DETAIL_READ_STATUS_SQL}`;
        const groupCheckRequest = pool.request();
        groupCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            groupCheckQuery += ' AND g.TenantId = @userTenantId';
            groupCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        const groupResult = await groupCheckRequest.query(groupCheckQuery);
        if (groupResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Group not found or access denied' });
        }
        const userId = req.user?.UserId || req.user?.userId;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User context required' });
        }
        const { created, updated, errors } = await ApplyContributionsToExistingService.applyToExisting(
            groupId,
            Array.isArray(memberIds) ? memberIds : undefined,
            userId
        );
        console.log(`Apply contributions to existing: groupId=${groupId}, created=${created}, updated=${updated}, errors=${errors.length}`);
        return res.json({
            success: true,
            data: { created, updated, errors: errors.length ? errors : undefined }
        });
    } catch (error) {
        console.error('❌ Error applying contributions to existing:', error);
        return res.status(500).json({ success: false, message: error.message || 'Apply failed' });
    }
});

// GET /api/groups/:groupId/contributions/:contributionId - Get a specific contribution rule
router.get('/:groupId/contributions/:contributionId', async (req, res) => {
    try {
        const { groupId, contributionId } = req.params;
        const pool = await getPool();
        
        // Check if new columns exist (for backward compatibility)
        let ageRulesColumnExists = false;
        let jobPositionsColumnExists = false;
        try {
            const ageRulesCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'AgeRules'
            `);
            ageRulesColumnExists = ageRulesCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify AgeRules column existence:', checkError.message);
            ageRulesColumnExists = false;
        }
        
        try {
            const jobPositionsCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'JobPositions'
            `);
            jobPositionsColumnExists = jobPositionsCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify JobPositions column existence:', checkError.message);
            jobPositionsColumnExists = false;
        }
        
        let equivalentTierColumnExists = false;
        try {
            const equivalentTierCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'EquivalentTier'
            `);
            equivalentTierColumnExists = equivalentTierCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify EquivalentTier column existence:', checkError.message);
            equivalentTierColumnExists = false;
        }
        
        // Build SELECT columns dynamically based on what exists
        const selectColumns = [
            'gc.ContributionId',
            'gc.GroupId',
            'gc.ProductId',
            'p.Name as ProductName',
            'gc.Name',
            'gc.Description',
            'gc.ContributionType',
            'gc.ContributionDirection',
            'gc.FlatRateAmount',
            'gc.PercentageAmount',
            ...(equivalentTierColumnExists ? ['gc.EquivalentTier'] : []),
            'gc.TierContributions',
            'gc.RoleContributions',
            'gc.TenureRules',
            ...(ageRulesColumnExists ? ['gc.AgeRules'] : []),
            ...(jobPositionsColumnExists ? ['gc.JobPositions'] : []),
            'gc.DivisionRules',
            'gc.OverrideType',
            'gc.OverrideAmount',
            'gc.MinimumAmount',
            'gc.Priority',
            'gc.Stacking',
            'gc.AppliesTo',
            'gc.EffectiveDate',
            'gc.EndDate',
            'gc.Status',
            'gc.CreatedDate',
            'gc.ModifiedDate'
        ].join(', ');
        
        // Verify contribution exists and user has access
        let contributionQuery = `
            SELECT 
                ${selectColumns}
            FROM oe.GroupContributions gc
            LEFT JOIN oe.Products p ON gc.ProductId = p.ProductId
            JOIN oe.Groups g ON gc.GroupId = g.GroupId
            WHERE gc.ContributionId = @contributionId 
              AND gc.GroupId = @groupId
              AND ${GROUP_DETAIL_READ_STATUS_SQL}
        `;
        
        const contributionRequest = pool.request();
        contributionRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        contributionRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        // Add tenant filtering for non-SysAdmin users
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            contributionQuery += ' AND g.TenantId = @userTenantId';
            contributionRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const contributionResult = await contributionRequest.query(contributionQuery);
        
        if (contributionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contribution rule not found or access denied'
            });
        }
        
        // Parse JSON fields
        const contribution = contributionResult.recordset[0];
        contribution.tierContributions = contribution.TierContributions ? JSON.parse(contribution.TierContributions) : null;
        contribution.roleContributions = contribution.RoleContributions ? JSON.parse(contribution.RoleContributions) : null;
        contribution.tenureRules = contribution.TenureRules ? JSON.parse(contribution.TenureRules) : null;
        if (ageRulesColumnExists) {
            contribution.ageRules = contribution.AgeRules ? JSON.parse(contribution.AgeRules) : null;
            delete contribution.AgeRules;
        } else {
            contribution.ageRules = null;
        }
        if (jobPositionsColumnExists) {
            contribution.jobPositions = contribution.JobPositions ? JSON.parse(contribution.JobPositions) : null;
            delete contribution.JobPositions;
        } else {
            contribution.jobPositions = null;
        }
        contribution.equivalentTier = equivalentTierColumnExists ? (contribution.EquivalentTier || null) : null;
        if (equivalentTierColumnExists) delete contribution.EquivalentTier;
        contribution.divisionRules = contribution.DivisionRules ? JSON.parse(contribution.DivisionRules) : null;
        contribution.appliesTo = contribution.AppliesTo ? JSON.parse(contribution.AppliesTo) : null;
        
        // Remove the uppercase JSON fields
        delete contribution.TierContributions;
        delete contribution.RoleContributions;
        delete contribution.TenureRules;
        delete contribution.DivisionRules;
        delete contribution.AppliesTo;
        
        res.json({
            success: true,
            data: contribution
        });
        
        console.log(`✅ Retrieved contribution rule ${contributionId} for group ${groupId}`);
        
    } catch (error) {
        console.error('❌ Error fetching contribution rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch contribution rule'
        });
    }
});

// PUT /api/groups/:groupId/contributions/:contributionId - Update a contribution rule
router.put('/:groupId/contributions/:contributionId', authorize(['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin']), async (req, res) => {
    try {
        const { groupId, contributionId } = req.params;
        const updateData = req.body;
        
        const pool = await getPool();
        
        // Check if new columns exist (for backward compatibility)
        let ageRulesColumnExists = false;
        let jobPositionsColumnExists = false;
        try {
            const ageRulesCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'AgeRules'
            `);
            ageRulesColumnExists = ageRulesCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify AgeRules column existence:', checkError.message);
            ageRulesColumnExists = false;
        }
        
        try {
            const jobPositionsCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'JobPositions'
            `);
            jobPositionsColumnExists = jobPositionsCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify JobPositions column existence:', checkError.message);
            jobPositionsColumnExists = false;
        }
        
        let equivalentTierColumnExists = false;
        try {
            const equivalentTierCheck = await pool.request().query(`
                SELECT 1
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe'
                AND TABLE_NAME = 'GroupContributions'
                AND COLUMN_NAME = 'EquivalentTier'
            `);
            equivalentTierColumnExists = equivalentTierCheck.recordset.length > 0;
        } catch (checkError) {
            console.warn('⚠️ Failed to verify EquivalentTier column existence:', checkError.message);
            equivalentTierColumnExists = false;
        }
        let productIdsColumnExistsPut = false;
        try {
            const pc = await pool.request().query(`
                SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'GroupContributions' AND COLUMN_NAME = 'ProductIds'
            `);
            productIdsColumnExistsPut = (pc.recordset || []).length > 0;
        } catch (_) {
            productIdsColumnExistsPut = false;
        }
        
        // Verify contribution rule exists and user has access
        let contributionCheckQuery = `
            SELECT gc.ContributionId, gc.ContributionType
            FROM oe.GroupContributions gc
            JOIN oe.Groups g ON gc.GroupId = g.GroupId
            WHERE gc.ContributionId = @contributionId AND gc.GroupId = @groupId
        `;
        
        const contributionCheckRequest = pool.request();
        contributionCheckRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        contributionCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        const contributionResult = await contributionCheckRequest.query(contributionCheckQuery);
        
        if (contributionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contribution rule not found or access denied'
            });
        }

        // Validate equivalentTier updates (only valid for percentage rules)
        const validEquivalentTiers = ['EE', 'ES', 'EC', 'EF'];
        if (updateData.equivalentTier !== undefined) {
            const val = updateData.equivalentTier;
            const existingType = contributionResult.recordset[0]?.ContributionType;
            const effectiveType = updateData.contributionType || existingType;
            if (val != null && val !== '') {
                if (effectiveType !== 'percentage') {
                    return res.status(400).json({
                        success: false,
                        message: 'equivalentTier is only valid when contributionType is percentage'
                    });
                }
                const normalizedVal = String(val).trim().toUpperCase();
                if (!validEquivalentTiers.includes(normalizedVal)) {
                    return res.status(400).json({
                        success: false,
                        message: `equivalentTier must be one of: ${validEquivalentTiers.join(', ')} or null`
                    });
                }
            }
        }
        
        const updateRequest = pool.request();
        updateRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        updateRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        // Normalize productIds for update: when productIds array provided, set productId (single) and productIds (JSON)
        if (updateData.productIds !== undefined) {
            const arr = Array.isArray(updateData.productIds) ? updateData.productIds : [];
            updateData.productId = arr.length === 1 ? arr[0] : null;
            updateData._productIdsJson = arr.length > 1 ? JSON.stringify(arr) : null;
        }
        const updateFields = [];
        const allowedFields = {
            'name': 'Name',
            'description': 'Description',
            'productId': 'ProductId',
            'contributionType': 'ContributionType',
            'contributionDirection': 'ContributionDirection',
            'flatRateAmount': 'FlatRateAmount',
            'percentageAmount': 'PercentageAmount',
            'tierContributions': 'TierContributions',
            'roleContributions': 'RoleContributions',
            'tenureRules': 'TenureRules',
            'divisionRules': 'DivisionRules',
            'overrideType': 'OverrideType',
            'overrideAmount': 'OverrideAmount',
            'minimumAmount': 'MinimumAmount',
            'priority': 'Priority',
            'stacking': 'Stacking',
            'appliesTo': 'AppliesTo',
            'effectiveDate': 'EffectiveDate',
            'endDate': 'EndDate',
            'status': 'Status'
        };
        
        // Only add new fields if columns exist
        if (ageRulesColumnExists) {
            allowedFields['ageRules'] = 'AgeRules';
        }
        if (jobPositionsColumnExists) {
            allowedFields['jobPositions'] = 'JobPositions';
        }
        if (equivalentTierColumnExists) {
            allowedFields['equivalentTier'] = 'EquivalentTier';
        }
        if (productIdsColumnExistsPut) {
            allowedFields['_productIdsJson'] = 'ProductIds';
        }
        
        Object.keys(allowedFields).forEach(fieldKey => {
            if (updateData[fieldKey] !== undefined) {
                const sqlField = allowedFields[fieldKey];
                updateFields.push(`${sqlField} = @${fieldKey}`);
                
                // Handle JSON fields - round contribution amounts to 2 decimals
                if (fieldKey === 'tierContributions') {
                    const rounded = updateData[fieldKey] ? {
                        ...updateData[fieldKey],
                        employee_only: updateData[fieldKey].employee_only ? Math.round(updateData[fieldKey].employee_only * 100) / 100 : undefined,
                        employee_spouse: updateData[fieldKey].employee_spouse ? Math.round(updateData[fieldKey].employee_spouse * 100) / 100 : undefined,
                        employee_children: updateData[fieldKey].employee_children ? Math.round(updateData[fieldKey].employee_children * 100) / 100 : undefined,
                        family: updateData[fieldKey].family ? Math.round(updateData[fieldKey].family * 100) / 100 : undefined
                    } : null;
                    updateRequest.input(fieldKey, sql.NVarChar, rounded ? JSON.stringify(rounded) : null);
                } else if (fieldKey === 'ageRules') {
                    const rounded = updateData[fieldKey] ? updateData[fieldKey].map((r) => ({
                        ...r,
                        contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
                    })) : null;
                    updateRequest.input(fieldKey, sql.NVarChar, rounded ? JSON.stringify(rounded) : null);
                } else if (fieldKey === 'roleContributions') {
                    const rounded = updateData[fieldKey] ? updateData[fieldKey].map((r) => ({
                        ...r,
                        contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
                    })) : null;
                    updateRequest.input(fieldKey, sql.NVarChar, rounded ? JSON.stringify(rounded) : null);
                } else if (fieldKey === 'tenureRules') {
                    const rounded = updateData[fieldKey] ? updateData[fieldKey].map((r) => ({
                        ...r,
                        contributionAmount: r.contributionType === 'flat' ? Math.round(r.contributionAmount * 100) / 100 : r.contributionAmount
                    })) : null;
                    updateRequest.input(fieldKey, sql.NVarChar, rounded ? JSON.stringify(rounded) : null);
                } else if (['jobPositions', 'divisionRules', 'appliesTo'].includes(fieldKey)) {
                    updateRequest.input(fieldKey, sql.NVarChar, updateData[fieldKey] ? JSON.stringify(updateData[fieldKey]) : null);
                } else if (fieldKey === 'equivalentTier') {
                    const val = updateData[fieldKey];
                    updateRequest.input(
                      fieldKey,
                      sql.NVarChar(10),
                      (val != null && val !== '') ? String(val).trim().toUpperCase() : null
                    );
                } else if (fieldKey === 'productId') {
                    updateRequest.input(fieldKey, sql.UniqueIdentifier, updateData[fieldKey] || null);
                } else if (fieldKey === '_productIdsJson') {
                    updateRequest.input(fieldKey, sql.NVarChar, updateData._productIdsJson);
                } else if (['flatRateAmount', 'overrideAmount', 'minimumAmount'].includes(fieldKey)) {
                    // Round to 2 decimals to prevent floating point errors
                    updateRequest.input(fieldKey, sql.Decimal(18,2), updateData[fieldKey] ? Math.round(updateData[fieldKey] * 100) / 100 : null);
                } else if (fieldKey === 'percentageAmount') {
                    // Round to 2 decimals to prevent floating point errors
                    updateRequest.input(fieldKey, sql.Decimal(5,2), updateData[fieldKey] ? Math.round(updateData[fieldKey] * 100) / 100 : null);
                } else if (['priority'].includes(fieldKey)) {
                    updateRequest.input(fieldKey, sql.Int, updateData[fieldKey]);
                } else if (fieldKey === 'stacking') {
                    updateRequest.input(fieldKey, sql.Bit, updateData[fieldKey]);
                } else if (['effectiveDate', 'endDate'].includes(fieldKey)) {
                    updateRequest.input(fieldKey, sql.Date, updateData[fieldKey]);
                } else {
                    updateRequest.input(fieldKey, sql.NVarChar, updateData[fieldKey]);
                }
            }
        });
        
        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields provided for update'
            });
        }
        
        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');
        
        await updateRequest.query(`
            UPDATE oe.GroupContributions 
            SET ${updateFields.join(', ')}
            WHERE ContributionId = @contributionId
        `);
        
        res.json({
            success: true,
            message: 'Contribution rule updated successfully'
        });
        
        console.log(`✅ Contribution rule updated: ${contributionId}`);
        
    } catch (error) {
        console.error('❌ Error updating contribution rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update contribution rule'
        });
    }
});

// DELETE /api/groups/:groupId/contributions/:contributionId - Delete a contribution rule
router.delete('/:groupId/contributions/:contributionId', authorize(['Admin', 'SysAdmin', 'TenantAdmin', 'GroupAdmin', 'Agent']), async (req, res) => {
    try {
        const { groupId, contributionId } = req.params;
        const pool = await getPool();
        
        // Verify contribution rule exists and user has access
        let contributionCheckQuery = `
            SELECT gc.ContributionId, g.TenantId
            FROM oe.GroupContributions gc
            JOIN oe.Groups g ON gc.GroupId = g.GroupId
            WHERE gc.ContributionId = @contributionId AND gc.GroupId = @groupId
        `;
        
        const contributionCheckRequest = pool.request();
        contributionCheckRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        contributionCheckRequest.input('groupId', sql.UniqueIdentifier, groupId);
        
        if (!getUserRoles(req.user).includes('SysAdmin')) {
            contributionCheckQuery += ' AND g.TenantId = @userTenantId';
            contributionCheckRequest.input('userTenantId', sql.UniqueIdentifier, req.user.TenantId);
        }
        
        const contributionResult = await contributionCheckRequest.query(contributionCheckQuery);
        
        if (contributionResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Contribution rule not found or access denied'
            });
        }
        
        // Soft delete by setting status to Inactive
        const deleteRequest = pool.request();
        deleteRequest.input('contributionId', sql.UniqueIdentifier, contributionId);
        deleteRequest.input('modifiedBy', sql.UniqueIdentifier, req.user.UserId);
        
        await deleteRequest.query(`
            UPDATE oe.GroupContributions 
            SET Status = 'Inactive', 
                ModifiedDate = GETDATE(),
                ModifiedBy = @modifiedBy
            WHERE ContributionId = @contributionId
        `);
        
        res.json({
            success: true,
            message: 'Contribution rule deleted successfully'
        });
        
        console.log(`✅ Contribution rule deleted: ${contributionId}`);
        
    } catch (error) {
        console.error('❌ Error deleting contribution rule:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete contribution rule'
        });
    }
});

module.exports = router;