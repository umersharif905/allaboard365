// backend/services/proposalGenerator.service.js
// Service for generating proposal PDFs with filled fields

const sql = require('mssql');
const { getPool } = require('../config/database');
const { PDFDocument, rgb } = require('pdf-lib');
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');
let fontkit = null;
try {
  fontkit = require('@pdf-lib/fontkit');
} catch (e) {
  // Optional dependency; we gracefully fall back to standard fonts if unavailable.
  fontkit = null;
}
const ProposalDocumentService = require('./proposalDocument.service');
const PricingEngine = require('./pricing/PricingEngine');
const { loadProposalFeeContext, applyQuoteFeesToParts, round2: round2Fee } = require('./proposalCalculation.service');

class ProposalGeneratorService {
  /**
   * Wrap text into lines that fit within a max width (in PDF points), using the provided font metrics.
   * Preserves explicit newlines by treating each paragraph separately.
   * @param {string} text
   * @param {import('pdf-lib').PDFFont} font
   * @param {number} fontSize
   * @param {number} maxWidth
   * @returns {string[]}
   */
  static wrapTextToLines(text, font, fontSize, maxWidth) {
    if (!text) return [''];
    if (!font || !Number.isFinite(fontSize) || !Number.isFinite(maxWidth) || maxWidth <= 0) {
      return String(text).split(/\r?\n/);
    }

    const paragraphs = String(text).split(/\r?\n/);
    const lines = [];

    const measure = (s) => font.widthOfTextAtSize(s, fontSize);

    for (const paragraph of paragraphs) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        // Preserve blank line between paragraphs
        lines.push('');
        continue;
      }

      let currentLine = '';
      for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (measure(candidate) <= maxWidth) {
          currentLine = candidate;
        } else {
          // Never split words: push current line and move whole word to next line.
          if (currentLine) {
            lines.push(currentLine);
          }
          currentLine = word;
        }
      }

      if (currentLine) lines.push(currentLine);
    }

    return lines.length ? lines : [''];
  }

  static parseFieldConfigValue(configValue) {
    if (!configValue || typeof configValue !== 'string') return null;
    try {
      const parsed = JSON.parse(configValue);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  static getPriceConfigValue(configValue) {
    const parsed = this.parseFieldConfigValue(configValue);
    if (parsed && typeof parsed._priceConfig === 'string') {
      return parsed._priceConfig;
    }
    return configValue;
  }

  /** Per-field "Show as whole number" flag stored on price ConfigValue JSON. */
  static getFieldWholeNumberFlag(field) {
    const configValue = field.ConfigValue || field.configValue;
    const parsed = this.parseFieldConfigValue(configValue);
    return parsed && parsed.wholeNumber === true;
  }

  static getFieldFontFamily(field) {
    const configValue = field.ConfigValue || field.configValue;
    const parsed = this.parseFieldConfigValue(configValue);
    return (parsed && typeof parsed.fontFamily === 'string' && parsed.fontFamily.trim())
      ? parsed.fontFamily.trim()
      : 'Outfit';
  }

  static getFieldVerticalAlign(field) {
    const configValue = field.ConfigValue || field.configValue;
    const parsed = this.parseFieldConfigValue(configValue);
    const rawAlign = (parsed && parsed.verticalAlign) || field.VerticalAlign || field.verticalAlign || 'top';
    const verticalAlign = typeof rawAlign === 'string' ? rawAlign.toLowerCase() : 'top';
    return ['top', 'middle', 'bottom'].includes(verticalAlign) ? verticalAlign : 'top';
  }

  static pickFont(fontFamily, isBold, fontSet) {
    const family = String(fontFamily || '').toLowerCase();
    if (family === 'outfit') {
      return (isBold ? fontSet.outfitBoldFont : fontSet.outfitRegularFont)
        || (isBold ? fontSet.boldFont : fontSet.regularFont)
        || fontSet.regularFont
        || fontSet.outfitRegularFont
        || undefined;
    }
    return (isBold ? fontSet.boldFont : fontSet.regularFont)
      || fontSet.regularFont
      || fontSet.outfitRegularFont
      || undefined;
  }

  static tryLoadOutfitFontBytes(weight = 400) {
    const weights = weight >= 700 ? ['700'] : ['400'];
    const candidateDirs = [
      path.join(__dirname, '..', 'node_modules', '@fontsource', 'outfit', 'files'),
      path.join(process.cwd(), 'node_modules', '@fontsource', 'outfit', 'files')
    ];

    for (const dir of candidateDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const w of weights) {
          const match = files.find(name =>
            name.includes(`outfit-latin-${w}-normal`) &&
            (name.endsWith('.woff') || name.endsWith('.woff2') || name.endsWith('.ttf') || name.endsWith('.otf'))
          );
          if (match) {
            return fs.readFileSync(path.join(dir, match));
          }
        }
      } catch (e) {
        // Ignore and continue to next candidate directory.
      }
    }
    return null;
  }

  /**
   * Get agent information for proposal generation
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} - Agent information
   */
  static async getAgentInfo(agentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('agentId', sql.UniqueIdentifier, agentId);
      
      const result = await request.query(`
        SELECT 
          a.AgentId,
          a.UserId,
          a.TenantId,
          u.FirstName,
          u.LastName,
          u.Email,
          u.PhoneNumber,
          u.ProfileImageUrl,
          a.Address1,
          a.Address2,
          a.City,
          a.State,
          a.ZipCode,
          ag.AgencyName
        FROM oe.Agents a
        JOIN oe.Users u ON a.UserId = u.UserId
        LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
        WHERE a.AgentId = @agentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      
      const agent = result.recordset[0];
      
      // Format address
      const addressParts = [];
      if (agent.Address1) addressParts.push(agent.Address1);
      if (agent.Address2) addressParts.push(agent.Address2);
      if (agent.City) addressParts.push(agent.City);
      if (agent.State) addressParts.push(agent.State);
      if (agent.ZipCode) addressParts.push(agent.ZipCode);
      const formattedAddress = addressParts.join(', ');
      
      return {
        agentId: agent.AgentId,
        tenantId: agent.TenantId || null,
        firstName: agent.FirstName,
        lastName: agent.LastName,
        fullName: `${agent.FirstName} ${agent.LastName}`.trim(),
        email: agent.Email,
        phone: agent.PhoneNumber,
        photoUrl: agent.ProfileImageUrl || null,
        address: formattedAddress,
        address1: agent.Address1,
        address2: agent.Address2,
        city: agent.City,
        state: agent.State,
        zipCode: agent.ZipCode,
        agencyName: agent.AgencyName
      };
    } catch (error) {
      console.error('❌ Error getting agent info:', error);
      throw error;
    }
  }

  /**
   * Download PDF from Azure Blob Storage
   * @param {Object} document - Document object from FileUploads
   * @returns {Promise<Buffer>} - PDF buffer
   */
  static async downloadPDFFromAzure(document) {
    try {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
      }
      
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      
      // Determine container and blob name from FilePath
      let containerName = 'agreements'; // Default container
      let blobName;
      
      if (document.FilePath) {
        // Extract container and blob name from FilePath URL
        const urlParts = document.FilePath.split('/');
        const blobIndex = urlParts.findIndex(part => part.includes('.blob.core.windows.net'));
        
        if (blobIndex >= 0 && urlParts.length > blobIndex + 2) {
          containerName = urlParts[blobIndex + 1] || containerName;
          const blobPathWithQuery = urlParts.slice(blobIndex + 2).join('/');
          blobName = blobPathWithQuery.split('?')[0];
        } else {
          // Fallback: try to extract from URL path
          const pathMatch = document.FilePath.match(/\/agreements\/(.+?)(\?|$)/);
          if (pathMatch) {
            containerName = 'agreements';
            blobName = pathMatch[1];
          } else {
            blobName = document.StoredFileName || document.FileName;
          }
        }
      } else {
        blobName = document.StoredFileName || document.FileName;
      }
      
      const containerClient = blobServiceClient.getContainerClient(containerName);
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      const exists = await blockBlobClient.exists();
      if (!exists) {
        throw new Error(`PDF not found at ${containerName}/${blobName}`);
      }
      
      const downloadResponse = await blockBlobClient.download();
      const chunks = [];
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(chunk);
      }
      
      return Buffer.concat(chunks);
    } catch (error) {
      console.error('❌ Error downloading PDF from Azure:', error);
      throw error;
    }
  }

  /**
   * Get document from FileUploads table
   * @param {string} documentId - Document ID
   * @returns {Promise<Object>} - Document information
   */
  static async getDocument(documentId) {
    try {
      const pool = await getPool();
      const request = pool.request();
      
      request.input('documentId', sql.UniqueIdentifier, documentId);
      
      const result = await request.query(`
        SELECT 
          FileId,
          FileName,
          StoredFileName,
          FilePath,
          FileSize,
          MimeType,
          UploadType,
          TenantId
        FROM oe.FileUploads
        WHERE FileId = @documentId
      `);
      
      if (result.recordset.length === 0) {
        throw new Error('Document not found');
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('❌ Error getting document:', error);
      throw error;
    }
  }

  /**
   * Format currency value
   * @param {number} amount - Amount to format
   * @returns {string} - Formatted currency string
   */
  static formatCurrency(amount, options = {}) {
    const wholeNumber = options.wholeNumber === true;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: wholeNumber ? 0 : 2,
      maximumFractionDigits: wholeNumber ? 0 : 2
    }).format(amount);
  }

  /**
   * Format phone number to (XXX) XXX-XXXX format
   * Handles various input formats:
   * - Plain digits: "8043866934" -> "(804) 386-6934"
   * - Already formatted: "(404) 210-6031" -> "(404) 210-6031" (normalized)
   * - With country code: "18043866934" -> "(804) 386-6934"
   * @param {string} phone - Phone number in any format
   * @returns {string} - Formatted phone number as (XXX) XXX-XXXX
   */
  static formatPhoneNumber(phone) {
    if (!phone) return '';
    
    // Extract only digits
    const digits = phone.replace(/\D/g, '');
    
    // If we have 10 digits, format as (XXX) XXX-XXXX
    if (digits.length === 10) {
      return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
    }
    
    // If we have 11 digits and starts with 1, assume US number and format as (XXX) XXX-XXXX
    // Strip the leading 1 (country code)
    if (digits.length === 11 && digits.startsWith('1')) {
      const tenDigits = digits.substring(1);
      return `(${tenDigits.substring(0, 3)}) ${tenDigits.substring(3, 6)}-${tenDigits.substring(6)}`;
    }
    
    // If we have exactly 10 digits after stripping non-digits, format it
    // This handles cases where the input might have extra characters but is still a valid US number
    if (digits.length > 0 && digits.length < 10) {
      // Too few digits - return original (might be partial/invalid)
      return phone;
    }
    
    // For other formats (international numbers, invalid lengths), return as-is
    // This preserves international numbers and doesn't break existing formatted numbers
    // that might have been stored in a different format
    return phone;
  }

  /**
   * Calculate price for a price field
   * @param {string} productId - Product ID
   * @param {string} configValue - Configuration value (e.g., "1500", "3000")
   * @param {Object} memberCriteria - Member criteria (tier, age, tobaccoUse)
   * @param {string|null} tenantId - Optional tenant id for included processing fee display pricing
   * @param {string|null} effectiveDate - Optional effective date (YYYY-MM-DD) for pricing lookup
   * @returns {Promise<number>} - Calculated monthly premium
   */
  static async calculatePriceForField(productId, configValue, memberCriteria, tenantId = null, effectiveDate = null) {
    try {
      // Build configValues object for PricingEngine
      // ConfigValue maps to ConfigValue1 in the pricing engine
      const configValues = configValue ? { ConfigValue1: configValue } : {};

      // Default to today so pricing queries filter by EffectiveDate/TerminationDate
      const resolvedDate = effectiveDate || new Date().toISOString().slice(0, 10);

      // Check if this is a bundle product
      const BundleProcessor = require('./pricing/BundleProcessor');
      const isBundle = await BundleProcessor.isBundleProduct(productId);

      let pricingResult;
      if (isBundle) {
        // Use BundleProcessor for bundle products
        pricingResult = await BundleProcessor.processBundleProduct(
          productId,
          memberCriteria,
          configValues,
          resolvedDate
        );
      } else {
        // Use PricingEngine for regular products
        pricingResult = await PricingEngine.calculateProductPricing(
          productId,
          memberCriteria,
          configValues,
          resolvedDate
        );
      }
      
      // If configValue was specified, try to find the matching pricing variation
      let selectedVariation = null;
      if (configValue && pricingResult.pricingVariations) {
        selectedVariation = pricingResult.pricingVariations.find(
          p => p.configValue === configValue
        );
      }
      
      // Use the selected variation or the main result
      const pricing = selectedVariation || pricingResult;
      
      // Collect underlying product parts with their base premiums
      const parts = [];
      if (pricingResult.isBundle && pricingResult.includedProducts && Array.isArray(pricingResult.includedProducts)) {
        for (const includedProduct of pricingResult.includedProducts) {
          const prodPremium = Number(includedProduct.monthlyPremium || 0);
          if (prodPremium > 0 && includedProduct.productId) {
            parts.push({ productId: String(includedProduct.productId), basePremium: round2Fee(prodPremium) });
          }
        }
        const bundleDiscount = Number(pricingResult.bundleDiscount || 0);
        if (bundleDiscount > 0) {
          const totalBefore = parts.reduce((s, p) => s + p.basePremium, 0);
          const adjusted = round2Fee(Math.max(0, totalBefore - bundleDiscount));
          if (totalBefore > 0) {
            const ratio = adjusted / totalBefore;
            for (const part of parts) {
              part.basePremium = round2Fee(part.basePremium * ratio);
            }
          }
        }
      } else {
        const basePremium = Number(pricing.monthlyPremium || 0);
        if (basePremium > 0) {
          parts.push({ productId: String(productId), basePremium: round2Fee(basePremium) });
        }
      }

      if (!tenantId || parts.length === 0) {
        return parts.reduce((s, p) => s + p.basePremium, 0);
      }

      const feeCtx = await loadProposalFeeContext(tenantId, parts.map(p => p.productId));
      if (!feeCtx) {
        return parts.reduce((s, p) => s + p.basePremium, 0);
      }
      const result = await applyQuoteFeesToParts(parts, feeCtx, 'ACH');
      return result.totalPremium;
    } catch (error) {
      console.error(`❌ Error calculating price for product ${productId}, config ${configValue}:`, error);
      // Return 0 as fallback
      return 0;
    }
  }

  /**
   * Generate proposal PDF with filled fields
   * @param {string} proposalDocumentId - Proposal Document ID
   * @param {string} agentId - Agent ID
   * @param {string} productId - Product ID
   * @param {Object} prospectInfo - Prospect information { name, email, phone, address, dateOfBirth }
   * @param {string} tier - Tier (EE, ES, EC, EF)
   * @param {boolean} tobaccoUse - Tobacco use status
   * @param {number} age - Prospect age
   * @param {Object} enrollmentLinkUrls - Map of EnrollmentLinkTemplateId to URL
   * @param {Object} customFieldValues - Map of fieldId to value for custom fields
   * @returns {Promise<Buffer>} - Generated PDF buffer
   */
  static async generateProposalPDF(proposalDocumentId, agentId, productId, prospectInfo, tier, tobaccoUse, age, enrollmentLinkUrls = {}, customFieldValues = {}, calculationResults = {}, effectiveDate = null, options = {}) {
    try {
      // Pull optional employee-doc context (tierPricing + groupContributions) from trailing options arg
      const { employeeContext = {} } = options;

      console.log('🔄 ========== GENERATE PROPOSAL PDF ==========');
      console.log(`📄 Proposal Document ID: ${proposalDocumentId}`);
      console.log(`👤 Agent ID: ${agentId}`);
      console.log(`📦 Product ID: ${productId}`);
      console.log(`👥 Prospect: ${prospectInfo.name}`);
      
      // Get proposal document with fields
      const proposalDoc = await ProposalDocumentService.getProposalDocument(proposalDocumentId);
      if (!proposalDoc) {
        throw new Error('Proposal document not found');
      }
      
      // Get agent information
      console.log('📥 Fetching agent information...');
      const agentInfo = await this.getAgentInfo(agentId);
      console.log('✅ Agent info loaded:', agentInfo.fullName);
      
      // Get original PDF document
      console.log('📥 Fetching original PDF document...');
      const document = await this.getDocument(proposalDoc.DocumentId);
      console.log('✅ Document found:', document.FileName);
      
      // Download PDF from Azure
      console.log('📥 Downloading PDF from Azure...');
      const originalPdfBytes = await this.downloadPDFFromAzure(document);
      console.log(`✅ PDF downloaded, size: ${originalPdfBytes.length} bytes`);
      
      // Load PDF
      console.log('📄 Loading PDF document...');
      const pdfDoc = await PDFDocument.load(originalPdfBytes);
      const pages = pdfDoc.getPages();
      console.log(`✅ PDF loaded, ${pages.length} pages found`);

      // Pre-embed standard fonts for consistent measurement + rendering
      // (Avoids measuring with one font and rendering with another.)
      let regularFont = null;
      let boldFont = null;
      let outfitRegularFont = null;
      let outfitBoldFont = null;
      try {
        regularFont = pdfDoc.embedStandardFont('Helvetica');
      } catch (fontError) {
        console.warn('⚠️ Could not embed regular font, pdf-lib will use default:', fontError);
      }
      try {
        boldFont = pdfDoc.embedStandardFont('Helvetica-Bold');
      } catch (fontError) {
        console.warn('⚠️ Could not embed bold font, using regular:', fontError);
      }
      // Try to embed Outfit for proposal text styling; fall back to Helvetica if unavailable.
      if (fontkit) {
        try {
          pdfDoc.registerFontkit(fontkit);
          const outfitRegularBytes = this.tryLoadOutfitFontBytes(400);
          const outfitBoldBytes = this.tryLoadOutfitFontBytes(700);
          if (outfitRegularBytes) {
            outfitRegularFont = await pdfDoc.embedFont(outfitRegularBytes, { subset: true });
          }
          if (outfitBoldBytes) {
            outfitBoldFont = await pdfDoc.embedFont(outfitBoldBytes, { subset: true });
          }
        } catch (fontError) {
          console.warn('⚠️ Could not embed Outfit fonts, using Helvetica fallback:', fontError.message);
        }
      }
      const fontSet = { regularFont, boldFont, outfitRegularFont, outfitBoldFont };
      
      // Get fields
      const fields = proposalDoc.fields || [];
      console.log(`📋 Processing ${fields.length} fields...`);
      
      // Calculate prices for all price fields first
      const priceCache = new Map();
      // Convert boolean tobaccoUse to string format expected by PricingEngine
      const tobaccoStatus = typeof tobaccoUse === 'boolean' 
        ? (tobaccoUse ? 'yes' : 'no')
        : tobaccoUse;
      const memberCriteria = { tier, age, tobaccoUse: tobaccoStatus };
      
      for (const field of fields) {
        if (field.FieldType === 'price' && field.ProductId && field.ConfigValue) {
          const rawPriceConfig = this.getPriceConfigValue(field.ConfigValue);
          // Per-field tier: use the field's Tier if set and not "document", otherwise fall back to global tier
          const fieldTierRaw = field.Tier || field.tier;
          const fieldTier = (fieldTierRaw && fieldTierRaw !== 'document') ? fieldTierRaw : tier;
          const fieldMemberCriteria = fieldTier !== tier ? { ...memberCriteria, tier: fieldTier } : memberCriteria;
          const cacheKey = `${field.ProductId}_${rawPriceConfig}_${fieldTier}_${age}`;
          if (!priceCache.has(cacheKey)) {
            console.log(`💰 Calculating price for product ${field.ProductId}, config ${rawPriceConfig}, tier ${fieldTier}, age ${age}...`);
            const price = await this.calculatePriceForField(
              field.ProductId,
              rawPriceConfig,
              fieldMemberCriteria,
              agentInfo.tenantId || null,
              effectiveDate
            );
            priceCache.set(cacheKey, price);
            console.log(`✅ Calculated price: ${this.formatCurrency(price)}`);
          }
        }
      }
      
      // Pre-calculate prices for dynamicPrice calculation fields
      const productSlots = proposalDoc.productSlots || [];
      for (const field of fields) {
        if (field.FieldType === 'calculation') {
          const calcType = field.FieldName || field.fieldName;
          if (calcType === 'dynamicPrice' && field.ConfigValue) {
            let dpConfig = null;
            try { dpConfig = JSON.parse(field.ConfigValue); } catch (e) { /* ignore */ }
            if (dpConfig && dpConfig.dynamicPrice) {
              const dpSlot = dpConfig.productSlot || 1;
              const dpTierRaw = dpConfig.tier || 'EE';
              // Map E1 → ES for database lookup (E1 = Employee+One, ES = Employee+Spouse — same pricing)
              const TIER_MAP = { EE: 'EE', E1: 'ES', ES: 'ES', EC: 'EC', EF: 'EF' };
              const dpTier = TIER_MAP[dpTierRaw] || dpTierRaw;
              const dpConfigValue = dpConfig.configValue || null;
              // Resolve product ID from slot
              const slotEntry = productSlots.find(s => s.slotNumber === dpSlot);
              const dpProductId = slotEntry ? slotEntry.productId : null;
              if (dpProductId) {
                const dpMemberCriteria = { tier: dpTier, age: 40, tobaccoUse: tobaccoStatus };
                const cacheKey = `${dpProductId}_${dpConfigValue}_${dpTier}_40`;
                if (!priceCache.has(cacheKey)) {
                  console.log(`💰 [dynamicPrice] Calculating price for product ${dpProductId}, config ${dpConfigValue}, tier ${dpTier}, age 40...`);
                  const price = await this.calculatePriceForField(
                    dpProductId,
                    dpConfigValue,
                    dpMemberCriteria,
                    agentInfo.tenantId || null,
                    effectiveDate
                  );
                  priceCache.set(cacheKey, price);
                  console.log(`✅ [dynamicPrice] Calculated price: ${this.formatCurrency(price)}`);
                }
              }
            }
          }
        }
      }

      // Pre-calculate prices for combinedPrice calculation fields (sum of multiple product slots)
      // Uses the same per-field pricing as a `price` field: the form tier (or per-field override)
      // and the prospect's real age — just summed across slots.
      for (const field of fields) {
        if (field.FieldType === 'calculation'
            && (field.FieldName || field.fieldName) === 'combinedPrice'
            && field.ConfigValue) {
          let cpConfig = null;
          try { cpConfig = JSON.parse(field.ConfigValue); } catch (e) { /* ignore */ }
          if (cpConfig && Array.isArray(cpConfig.addends)) {
            const CP_TIER_MAP = { EE: 'EE', E1: 'ES', ES: 'ES', EC: 'EC', EF: 'EF' };
            const cpTierRaw = (cpConfig.tier && cpConfig.tier !== 'document') ? cpConfig.tier : tier;
            const cpTier = CP_TIER_MAP[cpTierRaw] || cpTierRaw;
            for (const addend of cpConfig.addends) {
              const slotEntry = productSlots.find(s => s.slotNumber === (addend.productSlot || 0));
              const cpProductId = slotEntry ? slotEntry.productId : null;
              if (!cpProductId) continue;
              const cpConfigValue = addend.configValue || null;
              const cacheKey = `combined_${cpProductId}_${cpConfigValue}_${cpTier}_${age}`;
              if (!priceCache.has(cacheKey)) {
                console.log(`💰 [combinedPrice] Calculating slot ${addend.productSlot} product ${cpProductId}, config ${cpConfigValue}, tier ${cpTier}, age ${age}...`);
                const price = await this.calculatePriceForField(
                  cpProductId,
                  cpConfigValue,
                  { tier: cpTier, age, tobaccoUse: tobaccoStatus },
                  agentInfo.tenantId || null,
                  effectiveDate
                );
                priceCache.set(cacheKey, price);
                console.log(`✅ [combinedPrice] Calculated price: ${this.formatCurrency(price)}`);
              }
            }
          }
        }
      }

      // Format prospect address
      const prospectAddress = prospectInfo.address || '';
      
      // First pass: Collect all link field data
      // We'll add annotations AFTER all content is drawn
      const linkAnnotations = [];
      
      // Process each field
      for (const field of fields) {
        // Check if field should repeat on all pages (stored in ConfigValue JSON)
        let repeatOnAllPages = false;
        if (field.ConfigValue) {
          try {
            const cv = JSON.parse(field.ConfigValue);
            if (cv && typeof cv === 'object' && cv.repeatOnAllPages === true) {
              repeatOnAllPages = true;
            }
          } catch (e) { /* not JSON or no repeatOnAllPages flag */ }
        }
        
        if (repeatOnAllPages) {
          console.log(`🔁 Field ${field.FieldId} (${field.FieldType}/${field.FieldName || ''}) will repeat on ALL ${pages.length} pages`);
        }

        // Determine which pages to stamp this field on
        const targetPages = repeatOnAllPages
          ? pages.map((p, i) => ({ page: p, index: i }))
          : [{ page: pages[field.PageNumber - 1], index: field.PageNumber - 1 }];

        for (const { page, index: pageIndex } of targetPages) {
        if (!page) {
          console.warn(`⚠️ Page ${pageIndex + 1} not found, skipping field ${field.FieldId}`);
          continue;
        }
        
        const pageWidth = page.getWidth();
        const pageHeight = page.getHeight();
        
        // Convert normalized coordinates to absolute coordinates
        const x = field.XPosition * pageWidth;
        const width = field.Width * pageWidth;
        const height = field.Height * pageHeight;
        let y = field.YPosition * pageHeight;
        
        // Ensure field fits on page
        if (y + height > pageHeight) {
          y = pageHeight - height;
        }
        if (y < 0) {
          y = 0;
        }
        
        // Handle different field types
        if (field.FieldType === 'text' || field.FieldType === 'custom') {
          // Draw background if fillBackground is true or backgroundColor is set
          const fillBackground = field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : true);
          if (fillBackground || field.BackgroundColor || field.backgroundColor) {
            let bgColor = rgb(1, 1, 1); // Default white
            
            if (field.BackgroundColor || field.backgroundColor) {
              const hex = (field.BackgroundColor || field.backgroundColor).replace('#', '');
              const r = parseInt(hex.substring(0, 2), 16) / 255;
              const g = parseInt(hex.substring(2, 4), 16) / 255;
              const b = parseInt(hex.substring(4, 6), 16) / 255;
              bgColor = rgb(r, g, b);
            }
            
            const finalX = Math.max(0, Math.min(x, pageWidth - width));
            const finalY = Math.max(0, Math.min(y, pageHeight - height));
            const finalWidth = Math.min(width, pageWidth - finalX);
            const finalHeight = Math.min(height, pageHeight - finalY);
            
            page.drawRectangle({
              x: finalX,
              y: finalY,
              width: finalWidth,
              height: finalHeight,
              color: bgColor,
              borderColor: bgColor,
              borderWidth: 0
            });
          }
          
          let textValue = '';
          let textColor = rgb(0, 0, 0); // Default black
          
          // Parse text color if provided
          if (field.TextColor || field.textColor) {
            const hex = (field.TextColor || field.textColor).replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16) / 255;
            const g = parseInt(hex.substring(2, 4), 16) / 255;
            const b = parseInt(hex.substring(4, 6), 16) / 255;
            textColor = rgb(r, g, b);
          }
          
          // Get text value based on AutoFillType
          switch (field.AutoFillType) {
            case 'AgentName':
              textValue = agentInfo.fullName;
              break;
            case 'AgentAddress':
              // Check addressFormat property: 'full' (default), 'streetOnly', or 'multiline'
              if (field.AddressFormat === 'streetOnly' || field.addressFormat === 'streetOnly') {
                textValue = agentInfo.address1 || '';
              } else if (field.AddressFormat === 'multiline' || field.addressFormat === 'multiline') {
                // Format as multi-line: street on first line, city/state/zip on second
                const lines = [];
                if (agentInfo.address1) lines.push(agentInfo.address1);
                if (agentInfo.address2) lines.push(agentInfo.address2);
                
                // Build city/state/zip line
                const cityStateZip = [];
                if (agentInfo.city) cityStateZip.push(agentInfo.city);
                if (agentInfo.state) cityStateZip.push(agentInfo.state);
                if (agentInfo.zipCode) cityStateZip.push(agentInfo.zipCode);
                
                if (cityStateZip.length > 0) {
                  lines.push(cityStateZip.join(' '));
                }
                
                textValue = lines.join('\n');
              } else {
                textValue = agentInfo.address;
              }
              break;
            case 'AgentPhone':
              textValue = this.formatPhoneNumber(agentInfo.phone || '');
              break;
            case 'AgentEmail':
              textValue = agentInfo.email || '';
              break;
            case 'AgencyName':
              textValue = agentInfo.agencyName || '';
              break;
            case 'ClientName':
              textValue = prospectInfo.name || '';
              break;
            case 'ClientAddress':
              // Check addressFormat property: 'full' (default), 'streetOnly', or 'multiline'
              if (field.AddressFormat === 'streetOnly' || field.addressFormat === 'streetOnly') {
                // Extract just the street address (first line before comma)
                // prospectAddress format: "16112 Scottwood Rd, Midlothian, VA 23112"
                // We want: "16112 Scottwood Rd"
                if (prospectAddress) {
                  const firstCommaIndex = prospectAddress.indexOf(',');
                  textValue = firstCommaIndex > 0 
                    ? prospectAddress.substring(0, firstCommaIndex).trim()
                    : prospectAddress.trim();
                } else {
                  textValue = '';
                }
              } else if (field.AddressFormat === 'multiline' || field.addressFormat === 'multiline') {
                // Format as multi-line: parse the address string and split into lines
                // Common format: "16112 Scottwood Rd, Midlothian, VA 23112"
                // We want: "16112 Scottwood Rd\nMidlothian, VA 23112"
                if (prospectAddress) {
                  const parts = prospectAddress.split(',').map(p => p.trim());
                  if (parts.length >= 2) {
                    // First part is street, rest is city/state/zip
                    const street = parts[0];
                    const cityStateZip = parts.slice(1).join(', ');
                    textValue = `${street}\n${cityStateZip}`;
                  } else {
                    // If no commas, just use as-is
                    textValue = prospectAddress;
                  }
                } else {
                  textValue = '';
                }
              } else {
                textValue = prospectAddress;
              }
              break;
            case 'TierDescription':
              textValue = this.generateTierDescription(tier, prospectInfo);
              break;
            case 'TodaysDate':
              textValue = this.generateTodaysDate();
              break;
            case 'TodaysDateNumeric':
              textValue = this.generateTodaysDateNumeric();
              break;
            case 'CustomText':
              textValue = field.FieldName || field.fieldName || '';
              break;
            default: {
              // Employee-doc autofill types (GroupContributionEE/ES/EC/EF, EmployeeCostEE/ES/EC/EF)
              const employeeValue = resolveEmployeeDocAutoFill(field.AutoFillType, employeeContext);
              if (employeeValue !== undefined) {
                textValue = this.formatCurrency(employeeValue);
              } else {
                textValue = '';
              }
            }
          }
          
          // Handle custom fields - if fieldType is 'custom', get value from customFieldValues
          // Use CustomFieldId if available, otherwise fall back to FieldId
          if (field.FieldType === 'custom') {
            const lookupKey = field.CustomFieldId || field.FieldId;
            if (lookupKey) {
              textValue = customFieldValues[lookupKey] || '';
            }
          }
          
          if (textValue) {
            // Use fontSize from field if available, otherwise calculate
            const fontSize = field.FontSize || field.fontSize || Math.min(height * 0.6, 12);
            
            // No left/right padding - text starts at the left edge of the field
            const textX = Math.max(0, Math.min(x, pageWidth - width));

            const isBold = !!(field.IsBold || field.isBold);
            const fontFamily = this.getFieldFontFamily(field);
            const verticalAlign = this.getFieldVerticalAlign(field);
            const fontToUse = this.pickFont(fontFamily, isBold, fontSet);

            // Wrap long text to field width and clamp to field height
            const lineHeight = Math.max(fontSize * 1.2, fontSize + 2);
            const maxLines = Math.max(1, Math.floor(height / lineHeight));
            const maxWidth = Math.max(1, width);
            const wrappedLines = this.wrapTextToLines(textValue, fontToUse || regularFont || outfitRegularFont, fontSize, maxWidth);
            const finalText = wrappedLines.slice(0, maxLines).join('\n');
            const finalLineCount = Math.max(1, finalText.split('\n').length);
            const textBlockHeight = fontSize + ((finalLineCount - 1) * lineHeight);

            // Vertical positioning: top (default), middle, bottom.
            let textY = y + height - fontSize;
            if (verticalAlign === 'middle') {
              const textTop = y + ((height + textBlockHeight) / 2);
              textY = textTop - fontSize;
            } else if (verticalAlign === 'bottom') {
              const textTop = y + textBlockHeight;
              textY = textTop - fontSize;
            }
            textY = Math.max(fontSize, Math.min(textY, pageHeight - fontSize));

            // Calculate text alignment
            const textAlign = field.TextAlign || field.textAlign || 'left';
            let alignedX = textX;
            if (textAlign === 'center' || textAlign === 'right') {
              // Calculate text width for the first line (or longest line)
              const lines = finalText.split('\n');
              const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b);
              const textWidth = fontToUse ? fontToUse.widthOfTextAtSize(longestLine, fontSize) : longestLine.length * fontSize * 0.6;
              
              if (textAlign === 'center') {
                alignedX = x + (width / 2) - (textWidth / 2);
              } else if (textAlign === 'right') {
                alignedX = x + width - textWidth;
              }
              alignedX = Math.max(x, Math.min(alignedX, x + width - textWidth));
            }

            page.drawText(finalText, {
              x: alignedX,
              y: textY,
              size: fontSize,
              color: textColor,
              font: fontToUse,
              lineHeight
            });
          }
        } else if (field.FieldType === 'image') {
          // Handle image fields (AgentPhoto)
          if (field.AutoFillType === 'AgentPhoto' && agentInfo.photoUrl) {
            try {
              console.log(`📷 Downloading agent photo from: ${agentInfo.photoUrl}`);
              
              let imageBuffer;
              const imageUrl = agentInfo.photoUrl;
              
              // Check if it's an Azure Blob Storage URL
              if (imageUrl.includes('blob.core.windows.net')) {
                // Use Azure Blob Storage client to download
                const { BlobServiceClient } = require('@azure/storage-blob');
                const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
                if (!connectionString) {
                  throw new Error('Azure Storage connection string not configured');
                }
                
                const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
                
                // Parse blob URL to get container and blob name
                const urlObj = new URL(imageUrl.split('?')[0]); // Remove query params for parsing
                const pathParts = urlObj.pathname.split('/').filter(p => p);
                const containerName = pathParts[0];
                const blobName = pathParts.slice(1).join('/');
                
                console.log(`📷 Parsed Azure blob - Container: ${containerName}, Blob: ${blobName}`);
                
                const containerClient = blobServiceClient.getContainerClient(containerName);
                const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                
                // Download from Azure Blob Storage
                const downloadResponse = await blockBlobClient.download(0);
                
                // Convert stream to buffer
                const chunks = [];
                for await (const chunk of downloadResponse.readableStreamBody) {
                  chunks.push(chunk);
                }
                imageBuffer = Buffer.concat(chunks);
                console.log(`✅ Downloaded image from Azure, size: ${imageBuffer.length} bytes`);
              } else {
                // Download from regular HTTP/HTTPS URL
                const https = require('https');
                const http = require('http');
                const url = require('url');
                
                const parsedUrl = url.parse(imageUrl);
                const client = parsedUrl.protocol === 'https:' ? https : http;
                
                imageBuffer = await new Promise((resolve, reject) => {
                  const request = client.get(imageUrl, (response) => {
                    // Check for redirects
                    if (response.statusCode === 301 || response.statusCode === 302) {
                      return client.get(response.headers.location, (redirectResponse) => {
                        const chunks = [];
                        redirectResponse.on('data', (chunk) => chunks.push(chunk));
                        redirectResponse.on('end', () => resolve(Buffer.concat(chunks)));
                        redirectResponse.on('error', reject);
                      }).on('error', reject);
                    }
                    
                    // Check if response is successful
                    if (response.statusCode !== 200) {
                      return reject(new Error(`Failed to download image: ${response.statusCode} ${response.statusMessage}`));
                    }
                    
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                      const buffer = Buffer.concat(chunks);
                      console.log(`✅ Downloaded image, size: ${buffer.length} bytes`);
                      resolve(buffer);
                    });
                    response.on('error', reject);
                  });
                  
                  request.on('error', reject);
                });
              }
              
              if (!imageBuffer || imageBuffer.length === 0) {
                throw new Error('Image buffer is empty');
              }
              
              // Get image shape (circle or square) - default to square
              const imageShape = field.ImageShape || field.imageShape || 'square';

              // Parse border settings from ConfigValue JSON
              let imageBorderColor = null;
              let imageBorderWidth = 0;
              const rawConfigValue = field.ConfigValue || field.configValue;
              if (rawConfigValue && typeof rawConfigValue === 'string') {
                try {
                  const cfg = JSON.parse(rawConfigValue);
                  if (cfg && typeof cfg === 'object') {
                    if (typeof cfg.borderColor === 'string') imageBorderColor = cfg.borderColor;
                    if (typeof cfg.borderWidth === 'number' && cfg.borderWidth > 0) imageBorderWidth = cfg.borderWidth;
                  }
                } catch {
                  // ignore malformed config
                }
              }
              
              // Get field dimensions first to know target size
              // Ensure 1:1 aspect ratio - use the smaller dimension
              const fieldX = Math.max(0, Math.min(x, pageWidth - width));
              const fieldY = Math.max(0, Math.min(y, pageHeight - height));
              const fieldWidth = Math.min(width, pageWidth - fieldX);
              const fieldHeight = Math.min(height, pageHeight - fieldY);
              
              // Use the smaller dimension to maintain 1:1 aspect ratio
              // Round to integer for sharp resize (sharp requires integers)
              const fieldSize = Math.round(Math.min(fieldWidth, fieldHeight));
              
              // Pre-process image: crop to square and resize to field size, apply circular mask if needed
              let processedImageBuffer = imageBuffer;
              try {
                const sharp = require('sharp');
                
                // Get image metadata to determine dimensions
                const metadata = await sharp(imageBuffer).metadata();
                const originalWidth = metadata.width;
                const originalHeight = metadata.height;
                
                console.log(`📷 Original image dimensions: ${originalWidth}x${originalHeight}, target field size: ${fieldSize}`);
                
                // Calculate the crop size (use the smaller dimension for square)
                const cropSize = Math.min(originalWidth, originalHeight);
                
                // Calculate crop coordinates to center the crop
                const left = Math.floor((originalWidth - cropSize) / 2);
                const top = Math.floor((originalHeight - cropSize) / 2);
                
                // Resize to higher resolution for better quality (2x for sharper results)
                // PDF coordinates are in points (1/72 inch), so we can use higher resolution
                const targetSize = Math.max(fieldSize * 2, 200); // At least 2x field size, minimum 200px for quality
                
                let sharpInstance = sharp(imageBuffer)
                  .extract({ left, top, width: cropSize, height: cropSize })
                  .resize(targetSize, targetSize, {
                    kernel: 'lanczos3', // High-quality resampling algorithm
                    fit: 'fill'
                  }); // Resize to higher resolution for quality
                
                // Apply circular mask if needed
                if (imageShape === 'circle') {
                  // Create a circular mask using SVG
                  // White circle on transparent background - dest-in will keep only the circle area
                  const radius = targetSize / 2;
                  const svgMask = `<svg width="${targetSize}" height="${targetSize}">
                    <circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>
                  </svg>`;
                  
                  // Apply mask using composite with dest-in blend mode
                  // This keeps only the parts of the image that overlap with the white circle
                  const maskBuffer = Buffer.from(svgMask);
                  sharpInstance = sharpInstance
                    .composite([{
                      input: maskBuffer,
                      blend: 'dest-in'
                    }]);
                }
                
                // Convert to PNG to support transparency for circles
                // Use high quality PNG compression
                processedImageBuffer = await sharpInstance.png({ 
                  quality: 100,
                  compressionLevel: 6 
                }).toBuffer();
                
                console.log(`✅ Image pre-processed: cropped and resized to ${targetSize}x${targetSize} (field: ${fieldSize}x${fieldSize}), shape: ${imageShape}`);
              } catch (sharpError) {
                console.warn('⚠️ Sharp not available or error processing image, using original:', sharpError.message);
                // Fall back to original image if sharp fails
                processedImageBuffer = imageBuffer;
              }
              
              // Embed processed image in PDF
              let image;
              try {
                // Determine format based on buffer content and whether it was processed
                const wasProcessed = processedImageBuffer !== imageBuffer;
                const isJpg = processedImageBuffer[0] === 0xFF && processedImageBuffer[1] === 0xD8;
                
                if (wasProcessed) {
                  // Processed images are always PNG (to support transparency for circles)
                  console.log('📷 Embedding as PNG (processed)');
                  image = await pdfDoc.embedPng(processedImageBuffer);
                } else if (isJpg) {
                  // Original unprocessed JPG
                  console.log('📷 Embedding as JPG (original)');
                  image = await pdfDoc.embedJpg(processedImageBuffer);
                } else {
                  // Original unprocessed PNG or other format
                  console.log('📷 Embedding as PNG (original)');
                  image = await pdfDoc.embedPng(processedImageBuffer);
                }
                console.log(`✅ Image embedded, dimensions: ${image.width}x${image.height}`);
              } catch (embedError) {
                console.error('❌ Error embedding image:', embedError);
                throw embedError;
              }
              
              // Use the field dimensions we calculated earlier
              const finalX = fieldX;
              const finalY = fieldY;
              const size = fieldSize;
              
              // Center coordinates
              const centerX = finalX + (size / 2);
              const centerY = finalY + (size / 2);
              const radius = size / 2;
              
              // Draw background for circle if needed (draw BEFORE image so image is on top)
              if (imageShape === 'circle' && (field.FillBackground || field.fillBackground)) {
                const bgColor = field.BackgroundColor || field.backgroundColor || '#FFFFFF';
                const hex = bgColor.replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                
                // Draw circular background
                page.drawCircle({
                  x: centerX,
                  y: centerY,
                  size: radius,
                  color: rgb(r, g, b)
                });
                console.log(`✅ Drew circular background at (${centerX}, ${centerY}), radius: ${radius}`);
              }
              
              // Since the image is already pre-processed to be square/circular,
              // we can draw it at the exact size needed (no overflow, no masking needed)
              // The image is already cropped to square, so we just draw it at the field size
              page.drawImage(image, {
                x: finalX,
                y: finalY,
                width: size,
                height: size
              });

              // Draw border around image if configured
              if (imageBorderWidth > 0) {
                const borderHex = (imageBorderColor || '#000000').replace('#', '');
                const br = parseInt(borderHex.substring(0, 2), 16) / 255;
                const bg = parseInt(borderHex.substring(2, 4), 16) / 255;
                const bb = parseInt(borderHex.substring(4, 6), 16) / 255;

                if (imageShape === 'circle') {
                  page.drawCircle({
                    x: centerX,
                    y: centerY,
                    size: radius - (imageBorderWidth / 2),
                    borderColor: rgb(br, bg, bb),
                    borderWidth: imageBorderWidth
                  });
                } else {
                  page.drawRectangle({
                    x: finalX + (imageBorderWidth / 2),
                    y: finalY + (imageBorderWidth / 2),
                    width: size - imageBorderWidth,
                    height: size - imageBorderWidth,
                    borderColor: rgb(br, bg, bb),
                    borderWidth: imageBorderWidth
                  });
                }
              }

              console.log(`✅ Image drawn at (${finalX}, ${finalY}), size: ${size}x${size}, shape: ${imageShape} (pre-processed)`);
            } catch (imageError) {
              console.error(`❌ Error embedding agent photo:`, imageError);
              console.error(`❌ Error details:`, {
                message: imageError.message,
                stack: imageError.stack,
                photoUrl: agentInfo.photoUrl
              });
            }
          }
        } else if (field.FieldType === 'price') {
          // Handle price fields
          if (field.ProductId && field.ConfigValue) {
            // Draw background if fillBackground is true or backgroundColor is set
            const fillBackground = field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : true);
            if (fillBackground || field.BackgroundColor || field.backgroundColor) {
              let bgColor = rgb(1, 1, 1); // Default white
              
              if (field.BackgroundColor || field.backgroundColor) {
                const hex = (field.BackgroundColor || field.backgroundColor).replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                bgColor = rgb(r, g, b);
              }
              
              const finalX = Math.max(0, Math.min(x, pageWidth - width));
              const finalY = Math.max(0, Math.min(y, pageHeight - height));
              const finalWidth = Math.min(width, pageWidth - finalX);
              const finalHeight = Math.min(height, pageHeight - finalY);
              
              page.drawRectangle({
                x: finalX,
                y: finalY,
                width: finalWidth,
                height: finalHeight,
                color: bgColor,
                borderColor: bgColor,
                borderWidth: 0
              });
            }
            
            const rawPriceConfig = this.getPriceConfigValue(field.ConfigValue);
            const fieldTierRaw = field.Tier || field.tier;
            const fieldTier = (fieldTierRaw && fieldTierRaw !== 'document') ? fieldTierRaw : tier;
            const cacheKey = `${field.ProductId}_${rawPriceConfig}_${fieldTier}_${age}`;
            const price = priceCache.get(cacheKey) || 0;
            const wholeNumber = this.getFieldWholeNumberFlag(field);
            const formattedPrice = this.formatCurrency(price, { wholeNumber });
            
            let textColor = rgb(0, 0, 0); // Default black
            if (field.TextColor || field.textColor) {
              const hex = (field.TextColor || field.textColor).replace('#', '');
              const r = parseInt(hex.substring(0, 2), 16) / 255;
              const g = parseInt(hex.substring(2, 4), 16) / 255;
              const b = parseInt(hex.substring(4, 6), 16) / 255;
              textColor = rgb(r, g, b);
            }
            
            // Use fontSize from field if available, otherwise calculate
            const fontSize = field.FontSize || field.fontSize || Math.min(height * 0.6, 12);
            const verticalAlign = this.getFieldVerticalAlign(field);
            let textY = y + height - fontSize;
            if (verticalAlign === 'middle') {
              textY = y + ((height - fontSize) / 2);
            } else if (verticalAlign === 'bottom') {
              textY = y;
            }
            textY = Math.max(fontSize, Math.min(textY, pageHeight - fontSize));
            
            // No left/right padding - text starts at the left edge of the field
            const textX = Math.max(0, Math.min(x, pageWidth - width));
            
            const isBold = !!(field.IsBold || field.isBold);
            const fontFamily = this.getFieldFontFamily(field);
            const font = this.pickFont(fontFamily, isBold, fontSet);
            
            // Calculate horizontal alignment for price values.
            const textAlign = field.TextAlign || field.textAlign || 'left';
            let alignedX = textX;
            if (textAlign === 'center' || textAlign === 'right') {
              const textWidth = font ? font.widthOfTextAtSize(formattedPrice, fontSize) : formattedPrice.length * fontSize * 0.6;
              if (textAlign === 'center') {
                alignedX = x + (width / 2) - (textWidth / 2);
              } else if (textAlign === 'right') {
                alignedX = x + width - textWidth;
              }
              alignedX = Math.max(x, Math.min(alignedX, x + width - textWidth));
            }

            page.drawText(formattedPrice, {
              x: alignedX,
              y: textY,
              size: fontSize,
              color: textColor,
              font: font
            });
          }
        } else if (field.FieldType === 'whitespace') {
          // Handle whitespace/eraser fields - draw white rectangle to cover text
          let bgColor = rgb(1, 1, 1); // Default white
          
          if (field.BackgroundColor) {
            const hex = field.BackgroundColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16) / 255;
            const g = parseInt(hex.substring(2, 4), 16) / 255;
            const b = parseInt(hex.substring(4, 6), 16) / 255;
            bgColor = rgb(r, g, b);
          }
          
          const finalX = Math.max(0, Math.min(x, pageWidth - width));
          const finalY = Math.max(0, Math.min(y, pageHeight - height));
          const finalWidth = Math.min(width, pageWidth - finalX);
          const finalHeight = Math.min(height, pageHeight - finalY);
          
          page.drawRectangle({
            x: finalX,
            y: finalY,
            width: finalWidth,
            height: finalHeight,
            color: bgColor,
            borderColor: bgColor,
            borderWidth: 0
          });
        } else if (field.FieldType === 'link') {
          // Handle link fields - create clickable annotation
          let linkUrl = null;
          
          // Check if there's a custom URL override in enrollmentLinkUrls (fieldId -> url)
          // This allows frontend to pass custom URLs for any link field
          const fieldIdKey = `field_${field.FieldId}`;
          let customUrl = null;
          if (enrollmentLinkUrls[fieldIdKey]) {
            customUrl = enrollmentLinkUrls[fieldIdKey];
          }
          
          if (field.LinkType === 'static_url') {
            // Use custom URL if provided, otherwise use saved LinkUrl
            linkUrl = customUrl || field.LinkUrl;
          } else if (field.LinkType === 'enrollment_link') {
            // For enrollment links, get URL from the enrollmentLinkUrls map
            // Try field.EnrollmentLinkTemplateId first (for backwards compatibility)
            // Otherwise, try to find any matching URL (since agents may have different templates)
            if (field.EnrollmentLinkTemplateId && enrollmentLinkUrls[field.EnrollmentLinkTemplateId]) {
              linkUrl = enrollmentLinkUrls[field.EnrollmentLinkTemplateId];
            } else {
              // Check for custom URL override first
              if (customUrl) {
                linkUrl = customUrl;
              } else {
                // If no pre-selected template, use the first available URL from the map
                // This handles cases where agents have different templates than what was originally configured
                const availableTemplateIds = Object.keys(enrollmentLinkUrls).filter(k => !k.startsWith('field_'));
                if (availableTemplateIds.length > 0) {
                  linkUrl = enrollmentLinkUrls[availableTemplateIds[0]];
                  console.log(`ℹ️ Using enrollment link URL from template ${availableTemplateIds[0]} for field ${field.FieldId}`);
                }
              }
            }
            if (!linkUrl) {
              console.warn(`⚠️ No enrollment link URL provided for enrollment link field ${field.FieldId}`);
              continue;
            }
          } else if (field.LinkType === 'dynamic_url') {
            // Dynamic URLs should be provided by the caller
            // For now, we'll skip if no URL is provided
            continue;
          }
          
          if (linkUrl) {
            // Use the exact field dimensions - don't constrain them
            // The clickable area should match exactly what the user resized the field to
            const finalX = x;
            const finalY = y;
            const finalWidth = width;
            const finalHeight = height;
            
            // Debug overlay (disabled by default)
            // If you need to debug link placement again, set PROPOSAL_LINK_DEBUG_OVERLAY=true
            if (String(process.env.PROPOSAL_LINK_DEBUG_OVERLAY).toLowerCase() === 'true') {
              try {
                page.drawRectangle({
                  x: finalX,
                  y: finalY,
                  width: finalWidth,
                  height: finalHeight,
                  color: rgb(0.5, 0.5, 0.5),
                  opacity: 0.25,
                  borderColor: rgb(0.2, 0.2, 0.2),
                  borderWidth: 1,
                  borderOpacity: 0.5
                });
                console.log(`🔍 Drew link debug rectangle at (${finalX}, ${finalY}) size (${finalWidth}x${finalHeight})`);
              } catch (debugError) {
                console.warn(`⚠️ Could not draw debug rectangle:`, debugError.message);
              }
            }
            
            // Store link annotation data to add AFTER all content is drawn
            // IMPORTANT: `finalX/finalY` are ALREADY in PDF coordinates (bottom-left origin),
            // because we draw the debug rectangle using these values and it appears in the correct place.
            // So the annotation Rect should match these exact coordinates (no Y-flip).
            const pdfRight = finalX + finalWidth;
            const pdfTop = finalY + finalHeight;
            
            linkAnnotations.push({
              page,
              pageHeight,
              rect: [finalX, finalY, pdfRight, pdfTop],
              url: linkUrl,
              originalXY: `${finalX}, ${finalY}`,
              originalSize: `${finalWidth}x${finalHeight}`
            });
            
            console.log(`📝 Collected link annotation data - Rect: [${finalX}, ${finalY}, ${pdfRight}, ${pdfTop}] size: ${finalWidth}x${finalHeight} URL: ${linkUrl}`);
          }
        } else if (field.FieldType === 'calculation') {
          // Handle calculation fields - render pre-computed values from calculationResults
          // calculationType is stored in the FieldName column (no dedicated DB column)
          const calculationType = field.FieldName || field.fieldName;

          // ── dynamicPrice: resolve price from cache at render time ──
          if (calculationType === 'dynamicPrice' && field.ConfigValue) {
            let dpConfig = null;
            try { dpConfig = JSON.parse(field.ConfigValue); } catch (e) { /* ignore */ }
            if (dpConfig && dpConfig.dynamicPrice) {
              const dpSlot = dpConfig.productSlot || 1;
              const dpTierRaw = dpConfig.tier || 'EE';
              const DP_TIER_MAP = { EE: 'EE', E1: 'ES', ES: 'ES', EC: 'EC', EF: 'EF' };
              const dpTier = DP_TIER_MAP[dpTierRaw] || dpTierRaw;
              const dpConfigValue = dpConfig.configValue || null;
              const slotEntry = (proposalDoc.productSlots || []).find(s => s.slotNumber === dpSlot);
              const dpProductId = slotEntry ? slotEntry.productId : null;
              const cacheKey = dpProductId ? `${dpProductId}_${dpConfigValue}_${dpTier}_40` : null;
              let dpPrice = cacheKey ? (priceCache.get(cacheKey) || 0) : 0;

              // If displayMode is 'employeeCost', subtract employer contribution
              const displayMode = dpConfig.displayMode || 'fullPrice';
              if (displayMode === 'employeeCost' && calculationResults) {
                const contribValueTypes = calculationResults._contribValueTypes || {};
                const contribValues = calculationResults._contribValues || {};
                const eeContribType = contribValueTypes['EE'] || 'percentage';
                const eeContribValue = contribValues['EE'] || 0;

                // Detect "Apply EE to All" pattern: EE is percentage, E1/EF are dollar
                // In this case, recalculate the contribution from EE% applied to the EE price
                // at THIS config level, not the primary slot's EE price
                const CONTRIB_TIER_MAP = { EE: 'EE', ES: 'E1', E1: 'E1', EC: 'EC', EF: 'EF' };
                const contribTier = CONTRIB_TIER_MAP[dpTier] || dpTierRaw;
                const contribType = contribValueTypes[contribTier] || 'percentage';

                let employerContrib;
                if (contribTier === 'EE') {
                  // EE tier: apply contribution directly to this price
                  if (contribType === 'dollar') {
                    employerContrib = Math.min(eeContribValue, dpPrice);
                  } else {
                    employerContrib = dpPrice * (eeContribValue / 100);
                  }
                } else if (eeContribType === 'percentage' && contribType === 'dollar') {
                  // "Apply EE to All" pattern detected: E1/EF are dollar but EE is percentage
                  // Recalculate: find EE price for this same config, apply EE%, use that dollar amount
                  const eeTier = 'EE';
                  const eeCacheKey = dpProductId ? `${dpProductId}_${dpConfigValue}_${eeTier}_40` : null;
                  const eePrice = eeCacheKey ? (priceCache.get(eeCacheKey) || 0) : 0;
                  employerContrib = Math.round(eePrice * (eeContribValue / 100));
                  employerContrib = Math.min(employerContrib, dpPrice);
                } else {
                  // Standard: use the tier's own contribution value/type
                  const rawContribValue = contribValues[contribTier] || 0;
                  if (contribType === 'dollar') {
                    employerContrib = Math.min(rawContribValue, dpPrice);
                  } else {
                    employerContrib = dpPrice * (rawContribValue / 100);
                  }
                }
                employerContrib = Math.round(Math.min(Math.max(employerContrib, 0), dpPrice));
                dpPrice = Math.max(dpPrice - employerContrib, 0);
              }

              // Round to whole dollar if roundPrice is enabled (default: true)
              const shouldRound = dpConfig.roundPrice !== false;
              if (shouldRound) dpPrice = Math.round(dpPrice);
              const textValue = shouldRound
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(dpPrice)
                : this.formatCurrency(dpPrice);

              // Draw background
              const fillBackground = field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : true);
              if (fillBackground || field.BackgroundColor || field.backgroundColor) {
                let bgColor = rgb(1, 1, 1);
                if (field.BackgroundColor || field.backgroundColor) {
                  const hex = (field.BackgroundColor || field.backgroundColor).replace('#', '');
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  bgColor = rgb(r, g, b);
                }
                const finalX = Math.max(0, Math.min(x, pageWidth - width));
                const finalY = Math.max(0, Math.min(y, pageHeight - height));
                const finalWidth = Math.min(width, pageWidth - finalX);
                const finalHeight = Math.min(height, pageHeight - finalY);
                page.drawRectangle({ x: finalX, y: finalY, width: finalWidth, height: finalHeight, color: bgColor, borderColor: bgColor, borderWidth: 0 });
              }

              // Draw text
              let textColor = rgb(0, 0, 0);
              if (field.TextColor || field.textColor) {
                const hex = (field.TextColor || field.textColor).replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                textColor = rgb(r, g, b);
              }

              const fontSize = field.FontSize || field.fontSize || Math.min(height * 0.6, 12);
              const isBold = !!(field.IsBold || field.isBold);
              const fontFamily = this.getFieldFontFamily(field);
              const verticalAlign = this.getFieldVerticalAlign(field);
              const fontToUse = this.pickFont(fontFamily, isBold, fontSet);

              let textY = y + height - fontSize;
              if (verticalAlign === 'middle') {
                textY = y + ((height - fontSize) / 2);
              } else if (verticalAlign === 'bottom') {
                textY = y;
              }
              textY = Math.max(fontSize, Math.min(textY, pageHeight - fontSize));

              const textAlign = field.TextAlign || field.textAlign || 'left';
              let textX = Math.max(0, Math.min(x, pageWidth - width));
              if (textAlign === 'center' || textAlign === 'right') {
                const textWidth = fontToUse ? fontToUse.widthOfTextAtSize(textValue, fontSize) : textValue.length * fontSize * 0.6;
                if (textAlign === 'center') {
                  textX = x + (width / 2) - (textWidth / 2);
                } else {
                  textX = x + width - textWidth;
                }
                textX = Math.max(x, Math.min(textX, x + width - textWidth));
              }

              page.drawText(textValue, { x: textX, y: textY, size: fontSize, color: textColor, font: fontToUse });
              console.log(`📊 [dynamicPrice] Drew field: slot=${dpSlot}, tier=${dpTier}, config=${dpConfigValue} → "${textValue}" at (${textX}, ${textY})`);
              continue;
            }
          }

          // ── combinedPrice: sum prices from multiple product slots ──
          if (calculationType === 'combinedPrice' && field.ConfigValue) {
            let cpConfig = null;
            try { cpConfig = JSON.parse(field.ConfigValue); } catch (e) { /* ignore */ }
            if (cpConfig && Array.isArray(cpConfig.addends)) {
              const CP_TIER_MAP = { EE: 'EE', E1: 'ES', ES: 'ES', EC: 'EC', EF: 'EF' };
              const cpTierRaw = (cpConfig.tier && cpConfig.tier !== 'document') ? cpConfig.tier : tier;
              const cpTier = CP_TIER_MAP[cpTierRaw] || cpTierRaw;
              let cpTotal = 0;
              for (const addend of cpConfig.addends) {
                const slotEntry = (proposalDoc.productSlots || []).find(s => s.slotNumber === (addend.productSlot || 0));
                const cpProductId = slotEntry ? slotEntry.productId : null;
                if (!cpProductId) continue;
                const cpConfigValue = addend.configValue || null;
                const cacheKey = `combined_${cpProductId}_${cpConfigValue}_${cpTier}_${age}`;
                cpTotal += (priceCache.get(cacheKey) || 0);
              }

              // Round once after summing (default: round to whole dollars)
              const shouldRound = cpConfig.roundPrice !== false;
              if (shouldRound) cpTotal = Math.round(cpTotal);
              const textValue = shouldRound
                ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(cpTotal)
                : this.formatCurrency(cpTotal);

              // Draw background
              const fillBackground = field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : true);
              if (fillBackground || field.BackgroundColor || field.backgroundColor) {
                let bgColor = rgb(1, 1, 1);
                if (field.BackgroundColor || field.backgroundColor) {
                  const hex = (field.BackgroundColor || field.backgroundColor).replace('#', '');
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  bgColor = rgb(r, g, b);
                }
                const finalX = Math.max(0, Math.min(x, pageWidth - width));
                const finalY = Math.max(0, Math.min(y, pageHeight - height));
                const finalWidth = Math.min(width, pageWidth - finalX);
                const finalHeight = Math.min(height, pageHeight - finalY);
                page.drawRectangle({ x: finalX, y: finalY, width: finalWidth, height: finalHeight, color: bgColor, borderColor: bgColor, borderWidth: 0 });
              }

              // Draw text
              let textColor = rgb(0, 0, 0);
              if (field.TextColor || field.textColor) {
                const hex = (field.TextColor || field.textColor).replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                textColor = rgb(r, g, b);
              }

              const fontSize = field.FontSize || field.fontSize || Math.min(height * 0.6, 12);
              const isBold = !!(field.IsBold || field.isBold);
              const fontFamily = this.getFieldFontFamily(field);
              const verticalAlign = this.getFieldVerticalAlign(field);
              const fontToUse = this.pickFont(fontFamily, isBold, fontSet);

              let textY = y + height - fontSize;
              if (verticalAlign === 'middle') {
                textY = y + ((height - fontSize) / 2);
              } else if (verticalAlign === 'bottom') {
                textY = y;
              }
              textY = Math.max(fontSize, Math.min(textY, pageHeight - fontSize));

              const textAlign = field.TextAlign || field.textAlign || 'left';
              let textX = Math.max(0, Math.min(x, pageWidth - width));
              if (textAlign === 'center' || textAlign === 'right') {
                const textWidth = fontToUse ? fontToUse.widthOfTextAtSize(textValue, fontSize) : textValue.length * fontSize * 0.6;
                if (textAlign === 'center') {
                  textX = x + (width / 2) - (textWidth / 2);
                } else {
                  textX = x + width - textWidth;
                }
                textX = Math.max(x, Math.min(textX, x + width - textWidth));
              }

              page.drawText(textValue, { x: textX, y: textY, size: fontSize, color: textColor, font: fontToUse });
              console.log(`📊 [combinedPrice] Drew field: tier=${cpTier}, addends=${cpConfig.addends.length} → "${textValue}" at (${textX}, ${textY})`);
              continue;
            }
          }

          if (calculationType && calculationResults && Object.keys(calculationResults).length > 0) {
            // Parse slot + unshared-amount (configValue) assignment from ConfigValue JSON
            //   productSlot: 1..N — which product-slot to price against
            //   configValue: e.g. "2500" — the Unshared Amount variant to use
            // Multi-variant proposals pass keys like "calcEmployeeCost_EE_slot_2_ua_2500"
            let productSlot = null;
            let ua = null;
            if (field.ConfigValue) {
              try {
                const cv = JSON.parse(field.ConfigValue);
                if (cv && typeof cv === 'object') {
                  if (cv.productSlot) productSlot = cv.productSlot;
                  if (cv.configValue != null && cv.configValue !== '') ua = String(cv.configValue);
                }
              } catch (e) { /* not JSON */ }
            }

            // Look up value: prefer slot+ua, then slot, then base.
            let value;
            const uaSlotKey = (productSlot && ua) ? `${calculationType}_slot_${productSlot}_ua_${ua}` : null;
            const slotKey = productSlot ? `${calculationType}_slot_${productSlot}` : null;
            if (uaSlotKey && calculationResults[uaSlotKey] !== undefined) {
              value = calculationResults[uaSlotKey];
              console.log(`📊 Calculation field ${calculationType} using slot+ua key: ${uaSlotKey} = "${value}"`);
            } else if (slotKey && calculationResults[slotKey] !== undefined) {
              value = calculationResults[slotKey];
              console.log(`📊 Calculation field ${calculationType} using slot-specific key: ${slotKey} = "${value}"`);
            } else {
              value = calculationResults[calculationType];
              if (productSlot || ua) {
                console.log(`📊 Calculation field ${calculationType} (slot ${productSlot}, ua ${ua}): no specific key found, falling back to base key = "${value}"`);
              }
            }
            
            if (value !== undefined && value !== null && value !== '') {
              const textValue = String(value);
              
              // Draw background if fillBackground is true or backgroundColor is set
              const fillBackground = field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : true);
              if (fillBackground || field.BackgroundColor || field.backgroundColor) {
                let bgColor = rgb(1, 1, 1); // Default white
                
                if (field.BackgroundColor || field.backgroundColor) {
                  const hex = (field.BackgroundColor || field.backgroundColor).replace('#', '');
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  bgColor = rgb(r, g, b);
                }
                
                const finalX = Math.max(0, Math.min(x, pageWidth - width));
                const finalY = Math.max(0, Math.min(y, pageHeight - height));
                const finalWidth = Math.min(width, pageWidth - finalX);
                const finalHeight = Math.min(height, pageHeight - finalY);
                
                page.drawRectangle({
                  x: finalX,
                  y: finalY,
                  width: finalWidth,
                  height: finalHeight,
                  color: bgColor,
                  borderColor: bgColor,
                  borderWidth: 0
                });
              }
              
              // Parse text color
              let textColor = rgb(0, 0, 0); // Default black
              if (field.TextColor || field.textColor) {
                const hex = (field.TextColor || field.textColor).replace('#', '');
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                textColor = rgb(r, g, b);
              }
              
              const fontSize = field.FontSize || field.fontSize || Math.min(height * 0.6, 12);
              const textX = Math.max(0, Math.min(x, pageWidth - width));
              
              const isBold = !!(field.IsBold || field.isBold);
              const fontFamily = this.getFieldFontFamily(field);
              const verticalAlign = this.getFieldVerticalAlign(field);
              const fontToUse = this.pickFont(fontFamily, isBold, fontSet);
              
              // Wrap text and calculate alignment
              const lineHeight = Math.max(fontSize * 1.2, fontSize + 2);
              const maxLines = Math.max(1, Math.floor(height / lineHeight));
              const maxWidth = Math.max(1, width);
              const wrappedLines = this.wrapTextToLines(textValue, fontToUse || regularFont || outfitRegularFont, fontSize, maxWidth);
              // For single-line calculation values (no explicit newlines), if the text
              // would be hard-broken and truncated (e.g. "~(43.75%)" → "~(43.75"),
              // preserve the full text so formatted values aren't silently chopped.
              // The text may overflow the field boundary slightly but stays complete.
              const finalText = (!textValue.includes('\n') && wrappedLines.length > maxLines)
                ? textValue
                : wrappedLines.slice(0, maxLines).join('\n');
              const finalLineCount = Math.max(1, finalText.split('\n').length);
              const textBlockHeight = fontSize + ((finalLineCount - 1) * lineHeight);

              let textY = y + height - fontSize;
              if (verticalAlign === 'middle') {
                const textTop = y + ((height + textBlockHeight) / 2);
                textY = textTop - fontSize;
              } else if (verticalAlign === 'bottom') {
                const textTop = y + textBlockHeight;
                textY = textTop - fontSize;
              }
              textY = Math.max(fontSize, Math.min(textY, pageHeight - fontSize));
              
              const textAlign = field.TextAlign || field.textAlign || 'left';
              let alignedX = textX;
              if (textAlign === 'center' || textAlign === 'right') {
                const lines = finalText.split('\n');
                const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b);
                const textWidth = fontToUse ? fontToUse.widthOfTextAtSize(longestLine, fontSize) : longestLine.length * fontSize * 0.6;
                
                if (textAlign === 'center') {
                  alignedX = x + (width / 2) - (textWidth / 2);
                } else if (textAlign === 'right') {
                  alignedX = x + width - textWidth;
                }
                alignedX = Math.max(x, Math.min(alignedX, x + width - textWidth));
              }
              
              page.drawText(finalText, {
                x: alignedX,
                y: textY,
                size: fontSize,
                color: textColor,
                font: fontToUse,
                lineHeight
              });
              
              console.log(`📊 Drew calculation field: ${calculationType} = "${textValue}" at (${alignedX}, ${textY})`);
            } else {
              console.log(`📊 Skipping calculation field: ${calculationType} (no value in calculationResults)`);
            }
          }
        }
        } // end for targetPages
      } // end for fields
      
      // Second pass: Add all link annotations AFTER all content is drawn
      // This ensures annotations are on top and properly registered
      console.log(`\n🔗 Adding ${linkAnnotations.length} link annotation(s) after all content is drawn...`);
      for (const linkData of linkAnnotations) {
        try {
          const { PDFName, PDFString, PDFArray, PDFBool } = require('pdf-lib');
          const { page, pageHeight, rect, url, originalXY, originalSize } = linkData;
          
          console.log(`🔗 Creating link annotation:`, {
            originalXY,
            originalSize,
            pdfRect: `[${rect.join(', ')}]`,
            url
          });
          
          // Create link annotation using context.obj() directly
          // IMPORTANT: Create action dictionary inline (not as separate object)
          // This ensures the action is properly linked
          // F flag: 0 = visible and printable (required for interactive annotations)
          const linkAnnotation = pdfDoc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rect, // [left, bottom, right, top] in bottom-left coordinates  
            Border: [0, 0, 0], // No border: [horizontal_radius, vertical_radius, width]
            F: 0, // Flags: 0 = visible and printable (required for interactive annotations)
            A: {
              Type: 'Action',
              S: 'URI',
              URI: PDFString.of(url), // Use PDFString.of() for proper PDF string encoding
              // Hint to open in a new window/tab (viewer-dependent; some viewers ignore this for URI actions)
              NewWindow: PDFBool.True
            }
          });
          
          // Register the annotation to get a reference
          const linkRef = pdfDoc.context.register(linkAnnotation);
          
          // Use the exact approach from pdf-lib examples, BUT with proper PDFName keys.
          // In pdf-lib, dict keys must be PDFName objects; using a JS string breaks serialization
          // (`key.sizeInBytes is not a function`).
          const annotsKey = PDFName.of('Annots');

          // Preserve existing annotations and append ours (don't break existing links/annots)
          const existingAnnotsArray = page.node.lookupMaybe(annotsKey, PDFArray);
          if (existingAnnotsArray) {
            existingAnnotsArray.push(linkRef);
            console.log(`   Existing Annots count: ${existingAnnotsArray.size() - 1} → ${existingAnnotsArray.size()}`);
          } else {
            page.node.set(annotsKey, pdfDoc.context.obj([linkRef]));
            console.log(`   Existing Annots count: 0 → 1`);
          }
          
          console.log(`✅ Added link annotation - Rect: [${rect.join(', ')}] URL: ${url}`);
          console.log(`   Annotation ref: ${linkRef.toString()}`);
        } catch (linkError) {
          console.error(`❌ Error adding link annotation:`, linkError);
          console.error(`   Error details:`, linkError.stack || linkError.message);
        }
      }
      
      // Save PDF
      console.log(`\n💾 Saving PDF...`);
      const pdfBytes = await pdfDoc.save({ useObjectStreams: false });
      console.log(`✅ PDF saved, size: ${pdfBytes.length} bytes`);
      
      return Buffer.from(pdfBytes);
    } catch (error) {
      console.error('❌ Error generating proposal PDF:', error);
      throw error;
    }
  }

  /**
   * Upload generated proposal PDF to Azure Blob Storage
   * @param {Buffer} pdfBuffer - PDF buffer
   * @param {string} prospectName - Prospect name (for file naming)
   * @returns {Promise<string>} - URL of uploaded PDF
   */
  static async uploadProposalPDF(pdfBuffer, prospectName) {
    try {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('Azure Storage connection string not configured');
      }
      
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerName = 'proposals';
      const containerClient = blobServiceClient.getContainerClient(containerName);
      
      // Create container if it doesn't exist
      // Use 'blob' access level to allow public read access to blobs via signed URLs
      // Note: Container-level access is private, but individual blobs can be accessed via SAS tokens
      await containerClient.createIfNotExists({ access: 'blob' });
      
      // Generate blob name
      const { v4: uuidv4 } = require('uuid');
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
      const sanitizedName = prospectName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const blobName = `proposals/${uuidv4()}_${sanitizedName}_${timestamp}.pdf`;
      
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      console.log(`📤 Uploading proposal PDF to ${containerName}/${blobName}, size: ${pdfBuffer.length} bytes`);
      
      await blockBlobClient.uploadData(pdfBuffer, {
        blobHTTPHeaders: {
          blobContentType: 'application/pdf'
        },
        metadata: {
          prospectName: prospectName,
          generatedDate: new Date().toISOString(),
          uploadType: 'proposal'
        }
      });
      
      console.log(`✅ Successfully uploaded proposal PDF`);
      
      // Generate a signed URL (SAS token) with long expiration for public access
      // This allows the PDF to be accessed without authentication for SMS links
      const { generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
      
      // Set expiration to 30 days from now (proposals should be accessible for a reasonable time)
      const expiresOn = new Date();
      expiresOn.setDate(expiresOn.getDate() + 30);
      
      // Generate SAS token with read permissions
      const sasToken = generateBlobSASQueryParameters({
        containerName: containerName,
        blobName: blobName,
        permissions: BlobSASPermissions.parse('r'), // Read-only
        expiresOn: expiresOn,
        startsOn: new Date()
      }, blobServiceClient.credential).toString();
      
      // Return signed URL
      const pdfUrl = `${blockBlobClient.url}?${sasToken}`;
      return pdfUrl;
    } catch (error) {
      console.error('❌ Error uploading proposal PDF:', error);
      throw error;
    }
  }

  /**
   * Generate a human-readable tier description using common language
   * @param {string} tier - Tier code (EE, ES, EC, EF)
   * @param {Object} prospectInfo - Prospect information including hasSpouse and childrenCount
   * @returns {string} - Human-readable tier description
   */
  static generateTierDescription(tier, prospectInfo) {
    const hasSpouse = prospectInfo.hasSpouse || false;
    const childrenCount = prospectInfo.childrenCount || 0;

    switch (tier) {
      case 'EE':
        // Employee Only - just one individual
        return 'Individual';
      
      case 'ES':
        // Employee + Spouse - husband and wife, no children
        return 'Husband + Wife';
      
      case 'EC':
        // Employee + Children - 1 parent with children, no spouse
        if (childrenCount === 0) {
          // Shouldn't happen for EC tier, but handle gracefully
          return 'Individual';
        } else if (childrenCount === 1) {
          return '1 Parent + 1 Child';
        } else {
          return `1 Parent + ${childrenCount} Children`;
        }
      
      case 'EF':
        // Employee + Family - husband, wife, and children
        if (hasSpouse && childrenCount === 0) {
          // Husband and wife, no children
          return 'Husband + Wife';
        } else if (hasSpouse && childrenCount === 1) {
          // Husband, wife, and 1 child
          return 'Husband + Wife + 1 Child';
        } else if (hasSpouse && childrenCount > 1) {
          // Husband, wife, and multiple children
          return `Husband + Wife + ${childrenCount} Children`;
        } else {
          // Fallback if hasSpouse is false but tier is EF (shouldn't happen, but handle gracefully)
          if (childrenCount === 0) {
            return 'Individual';
          } else if (childrenCount === 1) {
            return '1 Parent + 1 Child';
          } else {
            return `1 Parent + ${childrenCount} Children`;
          }
        }
      
      default:
        return tier || 'Unknown Tier';
    }
  }

  /**
   * Generate today's date in a readable format
   * Uses UTC timezone to ensure consistent date display
   * @returns {string} - Formatted date string (e.g., "November 5, 2025")
   */
  static generateTodaysDate() {
    // Get current date in UTC to avoid timezone issues
    const now = new Date();
    const utcDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    
    // Format as readable date (e.g., "November 5, 2025")
    const options = { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      timeZone: 'UTC'
    };
    
    return utcDate.toLocaleDateString('en-US', options);
  }

  /**
   * Generate today's date in numeric format (MM/DD/YYYY)
   * Uses UTC timezone to ensure consistent date display.
   * @returns {string} - Formatted date string (e.g., "11/05/2025")
   */
  static generateTodaysDateNumeric() {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const year = String(now.getUTCFullYear());
    return `${month}/${day}/${year}`;
  }
}

// ---------------------------------------------------------------------------
// Employee-doc autofill resolver
// ---------------------------------------------------------------------------

const EMPLOYEE_CONTRIB_TYPES = ['GroupContributionEE', 'GroupContributionES', 'GroupContributionEC', 'GroupContributionEF'];
const EMPLOYEE_COST_TYPES    = ['EmployeeCostEE',       'EmployeeCostES',       'EmployeeCostEC',       'EmployeeCostEF'];
const TIER_KEY = {
  GroupContributionEE: 'EE', GroupContributionES: 'ES', GroupContributionEC: 'EC', GroupContributionEF: 'EF',
  EmployeeCostEE:      'EE', EmployeeCostES:      'ES', EmployeeCostEC:      'EC', EmployeeCostEF:      'EF',
};

function resolveContributionDollars(tierKey, ctx) {
  const tc = ctx?.groupContributions?.tierContributions?.[tierKey];
  if (!tc || tc.amount == null) return 0;
  const amount = Number(tc.amount) || 0;
  if (tc.type === 'percentage') {
    const price = Number(ctx?.tierPricing?.[tierKey]) || 0;
    return (price * amount) / 100;
  }
  return amount;
}

function resolveEmployeeDocAutoFill(type, ctx) {
  if (EMPLOYEE_CONTRIB_TYPES.includes(type)) {
    return resolveContributionDollars(TIER_KEY[type], ctx);
  }
  if (EMPLOYEE_COST_TYPES.includes(type)) {
    const tier = TIER_KEY[type];
    const price = Number(ctx?.tierPricing?.[tier]) || 0;
    const contribution = resolveContributionDollars(tier, ctx);
    return Math.max(0, price - contribution);
  }
  return undefined;
}

// Attach to the class so internal callers can use ProposalGeneratorService.resolveEmployeeDocAutoFill(...)
ProposalGeneratorService.resolveEmployeeDocAutoFill = resolveEmployeeDocAutoFill;

module.exports = ProposalGeneratorService;
// Also expose as a named export so destructuring works: const { resolveEmployeeDocAutoFill } = require(...)
module.exports.resolveEmployeeDocAutoFill = resolveEmployeeDocAutoFill;

