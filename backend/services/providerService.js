// services/providerService.js
// Service layer for Provider Management

const { getPool, sql } = require('../config/database');
const crypto = require('crypto');

class ProviderService {
    
    /**
     * Get all providers for a vendor with filtering and pagination
     */
    static async getProviders(vendorId, options = {}) {
        const {
            page = 1,
            limit = 25,
            search,
            providerType,
            isActive,
            sortBy = 'ProviderName',
            sortOrder = 'ASC'
        } = options;

        const offset = (page - 1) * limit;
        const pool = await getPool();
        const request = pool.request();
        
        let whereConditions = ['VendorId = @vendorId'];
        request.input('vendorId', sql.UniqueIdentifier, vendorId);

        if (search) {
            whereConditions.push(`(
                ProviderName LIKE @search 
                OR NPI LIKE @search 
                OR City LIKE @search
                OR Email LIKE @search
            )`);
            request.input('search', sql.NVarChar, `%${search}%`);
        }

        if (providerType) {
            whereConditions.push('ProviderType = @providerType');
            request.input('providerType', sql.NVarChar, providerType);
        }

        if (isActive !== undefined) {
            whereConditions.push('IsActive = @isActive');
            request.input('isActive', sql.Bit, isActive === true || isActive === 'true');
        }

        const whereClause = 'WHERE ' + whereConditions.join(' AND ');
        
        // Validate sort columns
        const validSortColumns = ['ProviderName', 'ProviderType', 'City', 'State', 'CreatedDate'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'ProviderName';
        const safeSortOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        // Count query
        const countResult = await request.query(`
            SELECT COUNT(*) as total
            FROM oe.Providers
            ${whereClause}
        `);
        const total = countResult.recordset[0].total;

        // Data query
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));

        const dataResult = await request.query(`
            SELECT 
                p.*,
                (SELECT COUNT(*) FROM oe.ShareRequestProviders WHERE ProviderId = p.ProviderId) as RequestCount
            FROM oe.Providers p
            ${whereClause}
            ORDER BY p.${safeSort} ${safeSortOrder}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `);

        return {
            data: dataResult.recordset,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    /**
     * Get a single provider by ID
     */
    static async getProviderById(providerId, vendorId = null) {
        const pool = await getPool();
        const request = pool.request();
        request.input('providerId', sql.UniqueIdentifier, providerId);

        let whereClause = 'WHERE ProviderId = @providerId';
        if (vendorId) {
            whereClause += ' AND VendorId = @vendorId';
            request.input('vendorId', sql.UniqueIdentifier, vendorId);
        }

        const result = await request.query(`
            SELECT 
                p.*,
                createdUser.FirstName as CreatedByFirstName,
                createdUser.LastName as CreatedByLastName,
                modifiedUser.FirstName as ModifiedByFirstName,
                modifiedUser.LastName as ModifiedByLastName
            FROM oe.Providers p
            LEFT JOIN oe.Users createdUser ON p.CreatedBy = createdUser.UserId
            LEFT JOIN oe.Users modifiedUser ON p.ModifiedBy = modifiedUser.UserId
            ${whereClause}
        `);

        return result.recordset[0] || null;
    }

    /**
     * Create a new provider
     */
    static async createProvider(vendorId, data, userId) {
        console.log('📝 ProviderService.createProvider called:', { vendorId, userId, providerName: data.providerName });
        
        const pool = await getPool();
        
        // Check for duplicates - by NPI if provided, otherwise by name
        if (data.npi) {
            const npiCheck = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('npi', sql.NVarChar, data.npi)
                .query(`
                    SELECT ProviderId, ProviderName 
                    FROM oe.Providers 
                    WHERE VendorId = @vendorId AND NPI = @npi
                `);
            
            if (npiCheck.recordset.length > 0) {
                const existing = npiCheck.recordset[0];
                throw new Error(`A provider with NPI ${data.npi} already exists: "${existing.ProviderName}"`);
            }
        }
        
        // Check for duplicate name + location combination (case-insensitive)
        // Allow same name with different locations (city/state)
        const nameLocationCheck = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('providerName', sql.NVarChar, data.providerName.trim())
            .input('city', sql.NVarChar, (data.city || '').trim())
            .input('state', sql.NVarChar, (data.state || '').trim())
            .query(`
                SELECT ProviderId, ProviderName, NPI, City, State
                FROM oe.Providers 
                WHERE VendorId = @vendorId 
                AND LOWER(ProviderName) = LOWER(@providerName)
                AND LOWER(ISNULL(City, '')) = LOWER(@city)
                AND LOWER(ISNULL(State, '')) = LOWER(@state)
            `);
        
        if (nameLocationCheck.recordset.length > 0) {
            const existing = nameLocationCheck.recordset[0];
            const location = existing.City && existing.State 
                ? ` in ${existing.City}, ${existing.State}`
                : existing.City 
                    ? ` in ${existing.City}`
                    : existing.State
                        ? ` in ${existing.State}`
                        : '';
            throw new Error(`A provider named "${existing.ProviderName}"${location} already exists${existing.NPI ? ` (NPI: ${existing.NPI})` : ''}`);
        }
        
        const providerId = crypto.randomUUID();
        
        console.log('📝 Generated providerId:', providerId);

        try {
            await pool.request()
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('providerName', sql.NVarChar, data.providerName)
                .input('providerType', sql.NVarChar, data.providerType || null)
                .input('npi', sql.NVarChar, data.npi || null)
                .input('taxId', sql.NVarChar, data.taxId || null)
                .input('phone', sql.NVarChar, data.phone || null)
                .input('fax', sql.NVarChar, data.fax || null)
                .input('email', sql.NVarChar, data.email || null)
                .input('website', sql.NVarChar, data.website || null)
                .input('address1', sql.NVarChar, data.address1 || null)
                .input('address2', sql.NVarChar, data.address2 || null)
                .input('city', sql.NVarChar, data.city || null)
                .input('state', sql.NVarChar, data.state || null)
                .input('zipCode', sql.NVarChar, data.zipCode || null)
                .input('country', sql.NVarChar, data.country || 'USA')
                .input('notes', sql.NVarChar, data.notes || null)
                .input('isActive', sql.Bit, data.isActive !== false)
                .input('createdBy', sql.UniqueIdentifier, userId)
                .query(`
                    INSERT INTO oe.Providers (
                        ProviderId, VendorId, ProviderName, ProviderType, NPI, TaxId,
                        Phone, Fax, Email, Website, Address1, Address2,
                        City, State, ZipCode, Country, Notes, IsActive,
                        CreatedDate, CreatedBy
                    ) VALUES (
                        @providerId, @vendorId, @providerName, @providerType, @npi, @taxId,
                        @phone, @fax, @email, @website, @address1, @address2,
                        @city, @state, @zipCode, @country, @notes, @isActive,
                        GETDATE(), @createdBy
                    )
                `);
            
            console.log('✅ Provider inserted successfully:', providerId);
            return { providerId };
        } catch (err) {
            console.error('❌ SQL Error in createProvider:', err.message);
            console.error('❌ SQL Error details:', err);
            throw err;
        }
    }

    /**
     * Update a provider
     */
    static async updateProvider(providerId, vendorId, data, userId) {
        const pool = await getPool();
        const request = pool.request();
        request.input('providerId', sql.UniqueIdentifier, providerId);
        request.input('vendorId', sql.UniqueIdentifier, vendorId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);

        const updateFields = [];

        if (data.providerName !== undefined) {
            updateFields.push('ProviderName = @providerName');
            request.input('providerName', sql.NVarChar, data.providerName);
        }
        if (data.providerType !== undefined) {
            updateFields.push('ProviderType = @providerType');
            request.input('providerType', sql.NVarChar, data.providerType);
        }
        if (data.npi !== undefined) {
            updateFields.push('NPI = @npi');
            request.input('npi', sql.NVarChar, data.npi);
        }
        if (data.taxId !== undefined) {
            updateFields.push('TaxId = @taxId');
            request.input('taxId', sql.NVarChar, data.taxId);
        }
        if (data.phone !== undefined) {
            updateFields.push('Phone = @phone');
            request.input('phone', sql.NVarChar, data.phone);
        }
        if (data.fax !== undefined) {
            updateFields.push('Fax = @fax');
            request.input('fax', sql.NVarChar, data.fax);
        }
        if (data.email !== undefined) {
            updateFields.push('Email = @email');
            request.input('email', sql.NVarChar, data.email);
        }
        if (data.website !== undefined) {
            updateFields.push('Website = @website');
            request.input('website', sql.NVarChar, data.website);
        }
        if (data.address1 !== undefined) {
            updateFields.push('Address1 = @address1');
            request.input('address1', sql.NVarChar, data.address1);
        }
        if (data.address2 !== undefined) {
            updateFields.push('Address2 = @address2');
            request.input('address2', sql.NVarChar, data.address2);
        }
        if (data.city !== undefined) {
            updateFields.push('City = @city');
            request.input('city', sql.NVarChar, data.city);
        }
        if (data.state !== undefined) {
            updateFields.push('State = @state');
            request.input('state', sql.NVarChar, data.state);
        }
        if (data.zipCode !== undefined) {
            updateFields.push('ZipCode = @zipCode');
            request.input('zipCode', sql.NVarChar, data.zipCode);
        }
        if (data.country !== undefined) {
            updateFields.push('Country = @country');
            request.input('country', sql.NVarChar, data.country);
        }
        if (data.notes !== undefined) {
            updateFields.push('Notes = @notes');
            request.input('notes', sql.NVarChar, data.notes);
        }
        if (data.isActive !== undefined) {
            updateFields.push('IsActive = @isActive');
            request.input('isActive', sql.Bit, data.isActive);
        }

        if (updateFields.length === 0) {
            return { success: false, message: 'No fields to update' };
        }

        // Check for duplicate name + location if name, city, or state is being updated
        if (data.providerName !== undefined || data.city !== undefined || data.state !== undefined) {
            // Get current provider values to determine what we're checking against
            const currentProvider = await pool.request()
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .query(`
                    SELECT ProviderName, City, State
                    FROM oe.Providers
                    WHERE ProviderId = @providerId AND VendorId = @vendorId
                `);

            if (currentProvider.recordset.length === 0) {
                return { success: false, message: 'Provider not found' };
            }

            const current = currentProvider.recordset[0];
            const checkName = data.providerName !== undefined ? data.providerName.trim() : current.ProviderName;
            const checkCity = data.city !== undefined ? (data.city || '').trim() : (current.City || '');
            const checkState = data.state !== undefined ? (data.state || '').trim() : (current.State || '');

            const duplicateCheck = await pool.request()
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('providerName', sql.NVarChar, checkName)
                .input('city', sql.NVarChar, checkCity)
                .input('state', sql.NVarChar, checkState)
                .query(`
                    SELECT ProviderId, ProviderName, City, State
                    FROM oe.Providers
                    WHERE VendorId = @vendorId
                    AND ProviderId != @providerId
                    AND LOWER(ProviderName) = LOWER(@providerName)
                    AND LOWER(ISNULL(City, '')) = LOWER(@city)
                    AND LOWER(ISNULL(State, '')) = LOWER(@state)
                `);

            if (duplicateCheck.recordset.length > 0) {
                const existing = duplicateCheck.recordset[0];
                const location = existing.City && existing.State 
                    ? ` in ${existing.City}, ${existing.State}`
                    : existing.City 
                        ? ` in ${existing.City}`
                        : existing.State
                            ? ` in ${existing.State}`
                            : '';
                return { 
                    success: false, 
                    message: `A provider named "${existing.ProviderName}"${location} already exists` 
                };
            }
        }

        updateFields.push('ModifiedDate = GETDATE()');
        updateFields.push('ModifiedBy = @modifiedBy');

        const result = await request.query(`
            UPDATE oe.Providers
            SET ${updateFields.join(', ')}
            WHERE ProviderId = @providerId
            AND VendorId = @vendorId
        `);

        if (result.rowsAffected[0] === 0) {
            return { success: false, message: 'Provider not found' };
        }

        return { success: true };
    }

    /**
     * Delete a provider (soft delete by setting IsActive = 0)
     */
    static async deleteProvider(providerId, vendorId, userId) {
        const pool = await getPool();
        
        // Check if provider is in use
        const usageResult = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .query(`
                SELECT COUNT(*) as count 
                FROM oe.ShareRequestProviders 
                WHERE ProviderId = @providerId
            `);

        if (usageResult.recordset[0].count > 0) {
            // Soft delete - just deactivate
            await pool.request()
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('vendorId', sql.UniqueIdentifier, vendorId)
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    UPDATE oe.Providers
                    SET IsActive = 0, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                    WHERE ProviderId = @providerId AND VendorId = @vendorId
                `);
            
            return { success: true, message: 'Provider deactivated (in use by share requests)' };
        }

        // Hard delete if not in use
        const result = await pool.request()
            .input('providerId', sql.UniqueIdentifier, providerId)
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                DELETE FROM oe.Providers
                WHERE ProviderId = @providerId AND VendorId = @vendorId
            `);

        if (result.rowsAffected[0] === 0) {
            return { success: false, message: 'Provider not found' };
        }

        return { success: true };
    }

    /**
     * Search providers for autocomplete
     */
    static async searchProviders(vendorId, query, limit = 10) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('search', sql.NVarChar, `%${query}%`)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT TOP (@limit)
                    ProviderId,
                    ProviderName,
                    ProviderType,
                    NPI,
                    City,
                    State
                FROM oe.Providers
                WHERE VendorId = @vendorId
                AND IsActive = 1
                AND (
                    ProviderName LIKE @search 
                    OR NPI LIKE @search
                )
                ORDER BY ProviderName
            `);

        return result.recordset;
    }

    /**
     * Get provider types (distinct list)
     */
    static async getProviderTypes(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT DISTINCT ProviderType
                FROM oe.Providers
                WHERE VendorId = @vendorId
                AND ProviderType IS NOT NULL
                AND ProviderType != ''
                ORDER BY ProviderType
            `);

        return result.recordset.map(r => r.ProviderType);
    }

    /**
     * Get provider statistics
     */
    static async getProviderStats(vendorId) {
        const pool = await getPool();
        const result = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT 
                    COUNT(*) as TotalProviders,
                    SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) as ActiveProviders,
                    SUM(CASE WHEN IsActive = 0 THEN 1 ELSE 0 END) as InactiveProviders,
                    COUNT(DISTINCT ProviderType) as ProviderTypeCount
                FROM oe.Providers
                WHERE VendorId = @vendorId
            `);

        return result.recordset[0];
    }
}

module.exports = ProviderService;

