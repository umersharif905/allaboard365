'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const { getProductDocumentsForProductIds } = require('../shared/product-documents.service');

function parseJsonField(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hasText(value) {
  if (value == null) return false;
  const text = String(value).trim();
  return text !== '' && text.toUpperCase() !== 'NULL';
}

function isShellPlatformVendor(vendorName) {
  const normalized = String(vendorName || '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('sharewell')
    || normalized.includes('mightywell')
    || normalized.includes('mighty well')
    || normalized.includes('merchant fee')
    || normalized.includes('mwp admin')
    || normalized.includes('unified tpa')
    || normalized.includes('lyric')
  );
}

function pickTemplatePrimaryIncludedProduct(includedRows = []) {
  const withVendorGroup = includedRows.find((row) => {
    const raw = row.VendorGroupIdProductType;
    return raw != null && String(raw).trim() !== '' && String(raw).trim().toLowerCase() !== 'none';
  });
  if (withVendorGroup) return withVendorGroup;

  const carrier = includedRows.find((row) => row.VendorName && !isShellPlatformVendor(row.VendorName));
  return carrier || includedRows[0] || null;
}

function mergeBundleTemplateShell(bundleRow, includedRows = []) {
  const merged = { ...bundleRow };
  const primary = pickTemplatePrimaryIncludedProduct(includedRows);

  const contentTextFields = [
    'Description',
    'ProductImageUrl',
    'ProductLogoUrl',
    'ProductDocumentUrl'
  ];
  const contentJsonFields = [
    'IDCardData',
    'PlanDetailsData',
    'AcknowledgementQuestions',
    'ProductQuestionnaires',
    'RequiredASA',
    'TrainingConfig',
    'MedicalNeedsLinksConfig',
    'RequiredDataFields',
    'AllowedStates',
    'RequiredLicenses'
  ];

  for (const includedRow of includedRows) {
    for (const field of contentTextFields) {
      if (!hasText(merged[field]) && hasText(includedRow[field])) {
        merged[field] = includedRow[field];
      }
    }
    for (const field of contentJsonFields) {
      if (!hasText(merged[field]) && hasText(includedRow[field])) {
        merged[field] = includedRow[field];
      }
    }
  }

  if (primary) {
    const settingsFields = [
      'VendorId',
      'VendorName',
      'VendorGroupIdProductType',
      'EligibilityIndividualVendorGroupId',
      'EligibilityVendorGroupFallbackProductId',
      'ProductType',
      'IsVendorPrice',
      'VendorCommission'
    ];
    for (const field of settingsFields) {
      const value = primary[field];
      if (value == null) continue;
      if (typeof value === 'string' && !hasText(value)) continue;
      if (field === 'VendorGroupIdProductType' && String(value).trim().toLowerCase() === 'none') continue;
      merged[field] = value;
    }

    if (primary.ShowGroupIdOnIDCard != null) merged.ShowGroupIdOnIDCard = primary.ShowGroupIdOnIDCard;
    if (primary.MinAge != null) merged.MinAge = primary.MinAge;
    if (primary.MaxAge != null) merged.MaxAge = primary.MaxAge;
    if (primary.RequiresTobaccoInfo != null) merged.RequiresTobaccoInfo = primary.RequiresTobaccoInfo;
    if (primary.IsSSNRequired != null) merged.IsSSNRequired = primary.IsSSNRequired;
    if (primary.MaxEffectiveDateDays != null) merged.MaxEffectiveDateDays = primary.MaxEffectiveDateDays;
    if (hasText(primary.EffectiveDateLogic) && !hasText(merged.EffectiveDateLogic)) {
      merged.EffectiveDateLogic = primary.EffectiveDateLogic;
    }
    if (hasText(primary.PremiumReportingCategory) && !hasText(merged.PremiumReportingCategory)) {
      merged.PremiumReportingCategory = primary.PremiumReportingCategory;
    }

    if ((merged.Description || '').length < 80 && hasText(primary.Description)) {
      merged.Description = primary.Description;
    }
  }

  if (!hasText(merged.SalesType)) {
    merged.SalesType = primary?.SalesType || merged.SalesType;
  }

  return merged;
}

function mergeProductShellRow(primary, fallback) {
  if (!fallback) return { ...primary };
  const merged = { ...primary };

  const textFields = [
    'Description',
    'ProductType',
    'SalesType',
    'TerminationLogic',
    'VendorGroupIdProductType',
    'EligibilityIndividualVendorGroupId',
    'EligibilityVendorGroupFallbackProductId',
    'IDCardMemberIdPrefixMask',
    'ProductImageUrl',
    'ProductLogoUrl',
    'ProductDocumentUrl',
    'PremiumReportingCategory',
    'EffectiveDateLogic'
  ];
  for (const field of textFields) {
    if (!hasText(merged[field]) && hasText(fallback[field])) {
      merged[field] = fallback[field];
    }
  }

  const jsonFields = [
    'RequiredDataFields',
    'AllowedStates',
    'RequiredLicenses',
    'AcknowledgementQuestions',
    'ProductQuestionnaires',
    'IDCardData',
    'PlanDetailsData',
    'RequiredASA',
    'TrainingConfig',
    'MedicalNeedsLinksConfig'
  ];
  for (const field of jsonFields) {
    if (!hasText(merged[field]) && hasText(fallback[field])) {
      merged[field] = fallback[field];
    }
  }

  if ((merged.MinAge == null || merged.MinAge === 18) && fallback.MinAge != null && fallback.MinAge !== 18) {
    merged.MinAge = fallback.MinAge;
  }
  if ((merged.MaxAge == null || merged.MaxAge === 64) && fallback.MaxAge != null && fallback.MaxAge !== 64) {
    merged.MaxAge = fallback.MaxAge;
  }
  if ((merged.MaxEffectiveDateDays == null || merged.MaxEffectiveDateDays === 60)
    && fallback.MaxEffectiveDateDays != null
    && fallback.MaxEffectiveDateDays !== 60) {
    merged.MaxEffectiveDateDays = fallback.MaxEffectiveDateDays;
  }

  if (fallback.IsVendorPrice != null && !merged.IsVendorPrice) merged.IsVendorPrice = fallback.IsVendorPrice;
  if (fallback.VendorCommission != null && !merged.VendorCommission) merged.VendorCommission = fallback.VendorCommission;
  if (fallback.ShowGroupIdOnIDCard != null && !merged.ShowGroupIdOnIDCard) {
    merged.ShowGroupIdOnIDCard = fallback.ShowGroupIdOnIDCard;
  }
  if (fallback.RequiresTobaccoInfo != null && !merged.RequiresTobaccoInfo) {
    merged.RequiresTobaccoInfo = fallback.RequiresTobaccoInfo;
  }
  if (fallback.IsSSNRequired != null && !merged.IsSSNRequired) merged.IsSSNRequired = fallback.IsSSNRequired;

  const primaryPlatformVendor = isShellPlatformVendor(merged.VendorName);
  if ((primaryPlatformVendor || !merged.VendorId) && fallback.VendorId) {
    merged.VendorId = fallback.VendorId;
    merged.VendorName = fallback.VendorName || merged.VendorName;
  }

  return merged;
}

async function loadBundleIncludedProductRows(pool, bundleProductId) {
  const result = await pool.request()
    .input('bundleProductId', sql.UniqueIdentifier, bundleProductId)
    .query(`
      SELECT
        p.*,
        v.VendorName
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
      LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE pb.BundleProductId = @bundleProductId
        AND p.Status = 'Active'
      ORDER BY pb.SortOrder
    `);
  return result.recordset || [];
}

async function resolveWizardShellProduct(pool, productRow, productId) {
  if (!productRow?.IsBundle) return productRow;
  const includedRows = await loadBundleIncludedProductRows(pool, productId);
  return mergeBundleTemplateShell(productRow, includedRows);
}

async function loadWizardTemplateAssets(pool, productIds = []) {
  const uniqueIds = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!uniqueIds.length) {
    return { productDocuments: [], aiChunks: [] };
  }

  const docsMap = await getProductDocumentsForProductIds(pool, uniqueIds, sql);
  const productDocuments = [];
  for (const productId of uniqueIds) {
    const docs = docsMap.get(String(productId).toLowerCase()) || [];
    productDocuments.push(...docs);
  }

  const idList = uniqueIds.map((id) => `'${id}'`).join(',');
  const chunksResult = await pool.request().query(`
    SELECT AIChunkId AS id, ChunkText AS chunk_text, CreatedDate AS created_at
    FROM oe.AIChunks
    WHERE ProductId IN (${idList})
      AND Status = 'Active'
    ORDER BY CreatedDate
  `);

  return {
    productDocuments,
    aiChunks: chunksResult.recordset || []
  };
}

function groupPricingRows(rows = []) {
  const tierMap = new Map();
  for (const pricing of rows) {
    const key = `${pricing.TierType}_${pricing.Label || 'default'}`;
    if (!tierMap.has(key)) {
      tierMap.set(key, {
        id: uuidv4(),
        tierType: pricing.TierType,
        label: pricing.Label || '',
        ageBands: []
      });
    }
    const netRate = parseFloat(pricing.NetRate) || 0;
    const overrideRate = parseFloat(pricing.OverrideRate) || 0;
    const commission = parseFloat(pricing.VendorCommission) || 0;
    tierMap.get(key).ageBands.push({
      id: pricing.ProductPricingId || uuidv4(),
      tobaccoStatus: pricing.TobaccoStatus || 'No',
      minAge: pricing.MinAge ?? 18,
      maxAge: pricing.MaxAge ?? 64,
      netRate,
      overrideRate,
      commission,
      systemFees: parseFloat(pricing.SystemFees) || 0,
      msrpRate: parseFloat(pricing.MSRPRate) || (netRate + overrideRate + commission),
      includedProcessingFee: parseFloat(pricing.IncludedProcessingFee) || 0,
      affiliateRate: netRate + overrideRate,
      locked: Boolean(pricing.Locked),
      effectiveDate: pricing.EffectiveDate
        ? new Date(pricing.EffectiveDate).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0],
      terminationDate: pricing.TerminationDate
        ? new Date(pricing.TerminationDate).toISOString().split('T')[0]
        : null,
      configValue1: pricing.ConfigValue1 || '',
      configValue2: pricing.ConfigValue2 || '',
      configValue3: pricing.ConfigValue3 || '',
      configValue4: pricing.ConfigValue4 || '',
      configValue5: pricing.ConfigValue5 || '',
      configField1: pricing.ConfigField1 || '',
      configField2: pricing.ConfigField2 || '',
      configField3: pricing.ConfigField3 || '',
      configField4: pricing.ConfigField4 || '',
      configField5: pricing.ConfigField5 || '',
      productPricingId: pricing.ProductPricingId || null
    });
  }
  return [...tierMap.values()];
}

/**
 * Load active oe.ProductPricing rows grouped for AddProductWizard / edit flows.
 */
async function loadWizardPricingTiersForProduct(pool, productId) {
  const pricingResult = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT
        ProductPricingId,
        PricingName,
        Label,
        NetRate,
        OverrideRate,
        VendorCommission,
        SystemFees,
        MSRPRate,
        IncludedProcessingFee,
        MinAge,
        MaxAge,
        TierType,
        TobaccoStatus,
        ConfigValue1,
        ConfigValue2,
        ConfigValue3,
        ConfigValue4,
        ConfigValue5,
        ConfigField1,
        ConfigField2,
        ConfigField3,
        ConfigField4,
        ConfigField5,
        Locked,
        EffectiveDate,
        TerminationDate
      FROM oe.ProductPricing
      WHERE ProductId = @productId
        AND Status = 'Active'
      ORDER BY TierType, Label, TobaccoStatus, MinAge
    `);

  const tiers = groupPricingRows(pricingResult.recordset || []);
  const overridesByPricingId = await loadProductPricingOverrides(productId);
  for (const tier of tiers) {
    for (const band of tier.ageBands) {
      const key = String(band.productPricingId || band.id || '').toLowerCase();
      band.overrides = key ? (overridesByPricingId.get(key) || []) : [];
    }
  }
  return tiers;
}

function mapProductRecordToWizardForm(product, { pricingTiers = [], productDocuments = [], aiChunks = [] } = {}) {
  const configurationFields = parseJsonField(product.RequiredDataFields, []);
  const allowedStates = parseJsonField(product.AllowedStates, []);
  const requiredLicenses = parseJsonField(product.RequiredLicenses, []);
  const acknowledgementQuestions = parseJsonField(product.AcknowledgementQuestions, []);
  const productQuestionnaires = parseJsonField(product.ProductQuestionnaires, undefined);
  const idCardData = parseJsonField(product.IDCardData, null);
  const planDetailsData = parseJsonField(product.PlanDetailsData, {});
  const requiredASA = parseJsonField(product.RequiredASA, undefined);
  const trainingConfig = parseJsonField(product.TrainingConfig, undefined);
  const medicalNeedsLinksConfig = parseJsonField(product.MedicalNeedsLinksConfig, undefined);

  return {
    vendorId: product.VendorId || '',
    isVendorPricing: Boolean(product.IsVendorPrice),
    vendorCommission: parseFloat(product.VendorCommission) || 0,
    vendorGroupIdProductType: product.VendorGroupIdProductType != null
      ? String(product.VendorGroupIdProductType)
      : '',
    eligibilityIndividualVendorGroupId: product.EligibilityIndividualVendorGroupId || '',
    eligibilityVendorGroupFallbackProductId: product.EligibilityVendorGroupFallbackProductId
      ? String(product.EligibilityVendorGroupFallbackProductId)
      : '',
    showGroupIdOnIDCard: Boolean(product.ShowGroupIdOnIDCard),
    partNumber: product.PartNumber || '',
    name: product.Name || '',
    description: product.Description || '',
    productType: product.ProductType || '',
    productOwnerId: product.ProductOwnerId || '',
    salesType: product.SalesType || 'Both',
    minAge: product.MinAge ?? 18,
    maxAge: product.MaxAge ?? 64,
    allowedStates: Array.isArray(allowedStates) ? allowedStates : [],
    requiresTobaccoInfo: Boolean(product.RequiresTobaccoInfo),
    effectiveDateLogic: product.EffectiveDateLogic === 'SelectedDay' ? 'SameDay' : (product.EffectiveDateLogic || 'FirstOfMonth'),
    maxEffectiveDateDays: product.MaxEffectiveDateDays ?? 60,
    terminationLogic: product.TerminationLogic || '',
    requiredLicenses: Array.isArray(requiredLicenses) ? requiredLicenses : [],
    isPublic: Boolean(product.IsPublic),
    isHidden: Boolean(product.IsHidden),
    isSSNRequired: Boolean(product.IsSSNRequired),
    premiumReportingCategory: product.PremiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit',
    includeProcessingFee: product.IncludeProcessingFee === true || product.IncludeProcessingFee === 1,
    roundUpProcessingFee: product.RoundUpProcessingFee !== false && product.RoundUpProcessingFee !== 0,
    processingFeePercentage: product.ProcessingFeePercentage != null
      ? Number(product.ProcessingFeePercentage)
      : null,
    configurationFields: Array.isArray(configurationFields) ? configurationFields : [],
    pricingTiers,
    acknowledgementQuestions: Array.isArray(acknowledgementQuestions) ? acknowledgementQuestions : [],
    productQuestionnaires,
    productImageFile: null,
    productLogoFile: null,
    productDocumentFile: null,
    productDocumentFiles: [],
    productImageUrl: product.ProductImageUrl && product.ProductImageUrl !== 'NULL' ? product.ProductImageUrl : '',
    productLogoUrl: product.ProductLogoUrl && product.ProductLogoUrl !== 'NULL' ? product.ProductLogoUrl : '',
    productDocumentUrl: product.ProductDocumentUrl && product.ProductDocumentUrl !== 'NULL'
      ? product.ProductDocumentUrl
      : '',
    productDocuments: (productDocuments || []).map((doc, index) => ({
      productDocumentId: doc.productDocumentId || doc.ProductDocumentId,
      documentUrl: doc.documentUrl || doc.DocumentUrl,
      displayName: doc.displayName || doc.DisplayName || 'Document',
      sortOrder: doc.sortOrder ?? doc.SortOrder ?? index
    })),
    idCardLogoFile: null,
    idCardMemberIdPrefixMask: product.IDCardMemberIdPrefixMask || '',
    idCardData: idCardData || undefined,
    planDetailsData: planDetailsData || {},
    aiChunks: (aiChunks || []).map((chunk) => ({
      id: chunk.id || chunk.AIChunkId || uuidv4(),
      chunk_text: chunk.chunk_text || chunk.ChunkData || '',
      created_at: chunk.created_at || chunk.CreatedDate || new Date().toISOString()
    })),
    requiredASA,
    trainingConfig,
    medicalNeedsLinksConfig
  };
}

async function loadTenantLogoUrl(tenantId) {
  if (!tenantId) return null;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 CustomLogoUrl, Name
        FROM oe.Tenants
        WHERE TenantId = @tenantId
      `);
    const row = result.recordset?.[0];
    const logoUrl = row?.CustomLogoUrl;
    if (!logoUrl || logoUrl === 'NULL') return null;
    return { logoUrl, tenantName: row.Name || null };
  } catch {
    return null;
  }
}

async function loadProductWizardTemplate(productId) {
  if (!productId) return null;
  const pool = await getPool();

  const productResult = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT
        p.*,
        v.VendorName
      FROM oe.Products p
      LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE p.ProductId = @productId
        AND p.Status = 'Active'
    `);

  const product = productResult.recordset?.[0];
  if (!product) return null;

  const includedRows = product.IsBundle
    ? await loadBundleIncludedProductRows(pool, productId)
    : [];
  const shellProduct = await resolveWizardShellProduct(pool, product, productId);
  const assetProductIds = product.IsBundle
    ? [productId, ...includedRows.map((row) => row.ProductId)]
    : [productId];

  const pricingResult = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT
        ProductPricingId,
        PricingName,
        Label,
        NetRate,
        OverrideRate,
        VendorCommission,
        SystemFees,
        MSRPRate,
        MinAge,
        MaxAge,
        TierType,
        TobaccoStatus,
        ConfigValue1,
        ConfigValue2,
        ConfigValue3,
        ConfigValue4,
        ConfigValue5,
        ConfigField1,
        ConfigField2,
        ConfigField3,
        ConfigField4,
        ConfigField5,
        Locked,
        EffectiveDate,
        TerminationDate
      FROM oe.ProductPricing
      WHERE ProductId = @productId
        AND Status = 'Active'
      ORDER BY TierType, Label, TobaccoStatus, MinAge
    `);

  const { productDocuments, aiChunks } = await loadWizardTemplateAssets(pool, assetProductIds);

  const formData = mapProductRecordToWizardForm(shellProduct, {
    pricingTiers: groupPricingRows(pricingResult.recordset || []),
    productDocuments,
    aiChunks
  });

  return {
    productId,
    productName: shellProduct.Name || product.Name,
    vendorName: shellProduct.VendorName || product.VendorName || null,
    isBundle: !!product.IsBundle,
    formData
  };
}

async function loadProductPricingOverrides(productId) {
  if (!productId) return new Map();
  const pool = await getPool();
  const result = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT
        po.OverrideId,
        po.ProductId,
        po.ProductPricingId,
        po.TenantId,
        po.OverrideACHId,
        po.OverrideName,
        po.OverrideAmount,
        po.Priority,
        po.IsActive,
        po.EffectiveDate,
        po.ExpirationDate,
        t.Name AS TenantName,
        ach.AccountHolderName AS ACHAccountHolderName,
        ach.BankName AS ACHBankName,
        ach.BankAccountType AS ACHAccountType
      FROM oe.ProductOverrides po
      LEFT JOIN oe.Tenants t ON po.TenantId = t.TenantId
      LEFT JOIN oe.ProductOverrideACH ach ON po.OverrideACHId = ach.OverrideACHId
      WHERE po.ProductId = @productId
        AND po.IsActive = 1
    `);

  const byPricingId = new Map();
  for (const row of result.recordset || []) {
    if (!row.ProductPricingId) continue;
    const key = String(row.ProductPricingId).toLowerCase();
    if (!byPricingId.has(key)) byPricingId.set(key, []);
    byPricingId.get(key).push({
      OverrideId: row.OverrideId,
      ProductId: row.ProductId,
      ProductPricingId: row.ProductPricingId,
      TenantId: row.TenantId,
      OverrideACHId: row.OverrideACHId,
      OverrideName: row.OverrideName,
      OverrideAmount: parseFloat(row.OverrideAmount) || 0,
      Priority: row.Priority,
      IsActive: Boolean(row.IsActive),
      EffectiveDate: row.EffectiveDate,
      ExpirationDate: row.ExpirationDate,
      TenantName: row.TenantName,
      ACHAccountHolderName: row.ACHAccountHolderName,
      ACHBankName: row.ACHBankName,
      ACHAccountType: row.ACHAccountType
    });
  }
  return byPricingId;
}

async function loadReferencePricingRows(productIds = []) {
  const uniqueIds = [...new Set((productIds || []).filter(Boolean).map(String))];
  const rows = [];
  for (const productId of uniqueIds) {
    const [pricingRows, overridesByPricingId] = await Promise.all([
      require('./migrationProductMapping.service').listProductPricingRows(productId),
      loadProductPricingOverrides(productId)
    ]);
    for (const row of pricingRows) {
      const overrideKey = row.productPricingId
        ? String(row.productPricingId).toLowerCase()
        : null;
      rows.push({
        ...row,
        overrides: overrideKey ? (overridesByPricingId.get(overrideKey) || []) : []
      });
    }
  }
  return rows;
}

module.exports = {
  loadProductWizardTemplate,
  loadTenantLogoUrl,
  loadProductPricingOverrides,
  loadWizardPricingTiersForProduct,
  loadReferencePricingRows,
  mapProductRecordToWizardForm,
  groupPricingRows,
  mergeProductShellRow,
  mergeBundleTemplateShell,
  pickTemplatePrimaryIncludedProduct
};
