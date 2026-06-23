// services/npiService.js
// NPI Registry API Service
// Uses NPPES NPI Registry API v2.1
// Documentation: https://npiregistry.cms.hhs.gov/api-page

const https = require('https');

const NPI_API_BASE = 'https://npiregistry.cms.hhs.gov/api';
const API_VERSION = '2.1';

class NPIService {
    
    /**
     * Search the NPI Registry by various criteria
     * @param {Object} params - Search parameters
     * @param {string} params.number - NPI number (exact match)
     * @param {string} params.enumeration_type - 'NPI-1' (individual) or 'NPI-2' (organization)
     * @param {string} params.first_name - Provider first name
     * @param {string} params.last_name - Provider last name
     * @param {string} params.organization_name - Organization name
     * @param {string} params.city - City
     * @param {string} params.state - State (2-letter code)
     * @param {string} params.postal_code - ZIP code
     * @param {number} params.limit - Max results (1-200, default 10)
     * @param {number} params.skip - Skip N records for pagination (max 1000)
     * @returns {Promise<Object>} - API response with results
     */
    static async search(params = {}) {
        const queryParams = new URLSearchParams();
        queryParams.append('version', API_VERSION);
        
        // Add search parameters
        if (params.number) queryParams.append('number', params.number);
        if (params.enumeration_type) queryParams.append('enumeration_type', params.enumeration_type);
        if (params.first_name) queryParams.append('first_name', params.first_name);
        if (params.last_name) queryParams.append('last_name', params.last_name);
        if (params.organization_name) queryParams.append('organization_name', params.organization_name);
        if (params.city) queryParams.append('city', params.city);
        if (params.state) queryParams.append('state', params.state);
        if (params.postal_code) queryParams.append('postal_code', params.postal_code);
        if (params.taxonomy_description) queryParams.append('taxonomy_description', params.taxonomy_description);
        if (params.limit) queryParams.append('limit', Math.min(params.limit, 200).toString());
        if (params.skip) queryParams.append('skip', Math.min(params.skip, 1000).toString());
        
        const url = `${NPI_API_BASE}/?${queryParams.toString()}`;
        
        return new Promise((resolve, reject) => {
            https.get(url, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (err) {
                        reject(new Error('Failed to parse NPI Registry response'));
                    }
                });
            }).on('error', (err) => {
                reject(new Error(`NPI Registry API error: ${err.message}`));
            });
        });
    }
    
    /**
     * Look up a specific NPI number
     * @param {string} npiNumber - 10-digit NPI number
     * @returns {Promise<Object|null>} - Provider data or null if not found
     */
    static async lookupByNPI(npiNumber) {
        if (!npiNumber || !/^\d{10}$/.test(npiNumber)) {
            throw new Error('Invalid NPI number. Must be exactly 10 digits.');
        }
        
        const result = await this.search({ number: npiNumber, limit: 1 });
        
        if (result.result_count === 0 || !result.results || result.results.length === 0) {
            return null;
        }
        
        return this.formatProviderData(result.results[0]);
    }
    
    /**
     * Search for providers by name
     * @param {Object} params - Search params
     * @param {string} params.firstName - First name (for individual providers)
     * @param {string} params.lastName - Last name (for individual providers)
     * @param {string} params.organizationName - Organization name
     * @param {string} params.state - State filter
     * @param {string} params.city - City filter
     * @param {number} params.limit - Max results
     * @returns {Promise<Array>} - Array of formatted provider data
     */
    static async searchProviders(params = {}) {
        const limit = params.limit || 20;
        const results = [];
        const seenNPIs = new Set();
        
        // If we have both lastName and organizationName (from a single-word search),
        // run two parallel searches
        if (params.lastName && params.organizationName && params.lastName === params.organizationName) {
            // Search individuals by last name
            const individualParams = {
                enumeration_type: 'NPI-1', // Individuals only
                last_name: params.lastName,
                limit: Math.ceil(limit / 2)
            };
            if (params.firstName) individualParams.first_name = params.firstName;
            if (params.state) individualParams.state = params.state;
            if (params.city) individualParams.city = params.city;
            if (params.postalCode) individualParams.postal_code = this.zipForNppes(params.postalCode);

            // Search organizations by name
            const orgParams = {
                enumeration_type: 'NPI-2', // Organizations only
                organization_name: params.organizationName,
                limit: Math.ceil(limit / 2)
            };
            if (params.state) orgParams.state = params.state;
            if (params.city) orgParams.city = params.city;
            if (params.postalCode) orgParams.postal_code = this.zipForNppes(params.postalCode);
            
            try {
                const [individualResult, orgResult] = await Promise.all([
                    this.search(individualParams),
                    this.search(orgParams)
                ]);
                
                // Combine results, deduping by NPI
                if (individualResult.results) {
                    for (const r of individualResult.results) {
                        if (!seenNPIs.has(r.number)) {
                            seenNPIs.add(r.number);
                            results.push(this.formatProviderData(r));
                        }
                    }
                }
                
                if (orgResult.results) {
                    for (const r of orgResult.results) {
                        if (!seenNPIs.has(r.number)) {
                            seenNPIs.add(r.number);
                            results.push(this.formatProviderData(r));
                        }
                    }
                }
                
                return this.sortByZipPrecision(results, params.postalCode).slice(0, limit);
            } catch (err) {
                console.error('Error in parallel NPI search:', err);
                // Fall back to single search
            }
        }
        
        // Standard single search
        const searchParams = { limit };
        
        if (params.firstName) searchParams.first_name = params.firstName;
        if (params.lastName) searchParams.last_name = params.lastName;
        if (params.organizationName && params.lastName !== params.organizationName) {
            searchParams.organization_name = params.organizationName;
        }
        if (params.state) searchParams.state = params.state;
        if (params.city) searchParams.city = params.city;
        if (params.postalCode) searchParams.postal_code = this.zipForNppes(params.postalCode);

        const result = await this.search(searchParams);

        if (!result.results || result.results.length === 0) {
            return [];
        }

        const formatted = result.results.map(r => this.formatProviderData(r));
        return this.sortByZipPrecision(formatted, params.postalCode);
    }

    /**
     * NPPES needs a trailing '*' to match a partial (prefix) ZIP. A full 5-digit
     * ZIP is used as-is (exact). Strips any caller-supplied '*' first.
     */
    static zipForNppes(zip) {
        if (!zip) return zip;
        const digits = String(zip).replace(/\D/g, '');
        if (!digits) return zip;
        return digits.length >= 5 ? digits.slice(0, 5) : `${digits}*`;
    }

    /**
     * Rank results so the most precise ZIP matches surface first when the user
     * searched by ZIP (exact full match > shares the typed prefix > everything
     * else). Stable for non-ZIP searches (returns input order).
     */
    static sortByZipPrecision(providers, searchedZip) {
        const digits = String(searchedZip || '').replace(/\D/g, '');
        if (!digits) return providers;
        const score = (p) => {
            const z = String(p.zipCode || '').replace(/\D/g, '');
            if (!z) return 3;
            if (z === digits) return 0;            // exact full match
            if (z.startsWith(digits)) return 1;    // shares typed prefix
            return 2;                              // matched on a non-display address
        };
        return providers
            .map((p, i) => ({ p, i, s: score(p) }))
            .sort((a, b) => (a.s - b.s) || (a.i - b.i))
            .map((x) => x.p);
    }

    /**
     * Format raw NPI Registry data into a cleaner structure
     * @param {Object} rawData - Raw API response data
     * @returns {Object} - Formatted provider data
     */
    static formatProviderData(rawData) {
        const isOrganization = rawData.enumeration_type === 'NPI-2';
        const basic = rawData.basic || {};
        const addresses = rawData.addresses || [];
        const taxonomies = rawData.taxonomies || [];
        
        // Get location address (prefer LOCATION over MAILING)
        const locationAddress = addresses.find(a => a.address_purpose === 'LOCATION') || addresses[0] || {};
        const mailingAddress = addresses.find(a => a.address_purpose === 'MAILING') || locationAddress;
        
        // Get primary taxonomy
        const primaryTaxonomy = taxonomies.find(t => t.primary) || taxonomies[0] || {};
        
        // Build provider name
        let providerName = '';
        if (isOrganization) {
            providerName = basic.organization_name || '';
        } else {
            const parts = [];
            if (basic.name_prefix) parts.push(basic.name_prefix);
            if (basic.first_name) parts.push(basic.first_name);
            if (basic.middle_name) parts.push(basic.middle_name);
            if (basic.last_name) parts.push(basic.last_name);
            if (basic.credential) parts.push(`, ${basic.credential}`);
            providerName = parts.join(' ').replace(' ,', ',');
        }
        
        // Determine provider type from taxonomy
        let providerType = 'Other';
        const taxonomyDesc = primaryTaxonomy.desc || '';
        if (taxonomyDesc.includes('Hospital')) providerType = 'Hospital';
        else if (taxonomyDesc.includes('Physician') || taxonomyDesc.includes('MD') || taxonomyDesc.includes('DO')) providerType = 'Physician';
        else if (taxonomyDesc.includes('Clinic')) providerType = 'Clinic';
        else if (taxonomyDesc.includes('Lab')) providerType = 'Lab';
        else if (taxonomyDesc.includes('Pharmac')) providerType = 'Pharmacy';
        else if (taxonomyDesc.includes('Imaging') || taxonomyDesc.includes('Radiology')) providerType = 'Imaging';
        else if (taxonomyDesc.includes('Nurse Practitioner') || taxonomyDesc.includes('NP')) providerType = 'Nurse Practitioner';
        else if (taxonomyDesc.includes('Specialist')) providerType = 'Specialist';
        else if (isOrganization) providerType = 'Facility';
        else providerType = 'Provider';
        
        return {
            npi: rawData.number,
            providerName: providerName.trim(),
            providerType,
            isOrganization,
            
            // Contact info
            phone: locationAddress.telephone_number || null,
            fax: locationAddress.fax_number || null,
            
            // Location address
            address1: locationAddress.address_1 || null,
            address2: locationAddress.address_2 || null,
            city: locationAddress.city || null,
            state: locationAddress.state || null,
            zipCode: locationAddress.postal_code ? locationAddress.postal_code.substring(0, 5) : null,
            
            // Mailing address (if different)
            mailingAddress1: mailingAddress.address_1 || null,
            mailingCity: mailingAddress.city || null,
            mailingState: mailingAddress.state || null,
            mailingZipCode: mailingAddress.postal_code ? mailingAddress.postal_code.substring(0, 5) : null,
            
            // Professional info
            credential: basic.credential || null,
            specialty: primaryTaxonomy.desc || null,
            taxonomyCode: primaryTaxonomy.code || null,
            licenseNumber: primaryTaxonomy.license || null,
            licenseState: primaryTaxonomy.state || null,
            
            // Basic info
            firstName: basic.first_name || null,
            lastName: basic.last_name || null,
            middleName: basic.middle_name || null,
            organizationName: basic.organization_name || null,
            sex: basic.sex || null,
            
            // Status
            status: basic.status === 'A' ? 'Active' : 'Inactive',
            enumerationDate: basic.enumeration_date || null,
            lastUpdated: basic.last_updated || null,
            
            // Raw data for reference
            _raw: {
                taxonomies,
                addresses,
                enumeration_type: rawData.enumeration_type
            }
        };
    }
}

module.exports = NPIService;

