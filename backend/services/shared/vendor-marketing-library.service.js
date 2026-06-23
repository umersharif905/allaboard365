/**
 * Vendor-scoped resource library. Mirrors agency-marketing-library.service.js per oe.Vendors.
 * See sql-changes/2026-05-11-vendor-marketing-resource-library.sql
 */
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../../config/database');
const { copyDocumentsBlobToNewName, generateSASUrl, MARKETING_RESOURCE_SAS_EXPIRES_MINUTES } = require('../../routes/uploads');
const tenantMk = require('./tenant-marketing-library.service');

const FILE_UPLOAD_TYPE = tenantMk.FILE_UPLOAD_TYPE;
const DOCUMENTS_CONTAINER = tenantMk.DOCUMENTS_CONTAINER;

function isUuid(s) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(s || ''));
}

function normGuid(v) {
  return String(v).replace(/[{}]/g, '').toLowerCase();
}

function optionalUserId(userId) {
  if (userId == null || userId === '') return null;
  const s = String(userId).replace(/[{}]/g, '').trim();
  if (!s || s === 'undefined') return null;
  return isUuid(s) ? s : null;
}

function sasForMarketingFile(storedFileName) {
  if (!storedFileName) return null;
  try {
    return generateSASUrl(DOCUMENTS_CONTAINER, storedFileName, 'r', MARKETING_RESOURCE_SAS_EXPIRES_MINUTES);
  } catch (e) {
    console.warn('[vendor-marketing-library] SAS failed:', e.message);
    return null;
  }
}

function assertHttpUrl(urlString) {
  let u;
  try {
    u = new URL(String(urlString).trim());
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://');
  }
}

function mapVendorResourceRow(row) {
  const base = {
    resourceId: row.ResourceId,
    folderId: row.FolderId,
    title: row.Title,
    description: row.Description,
    resourceType: row.ResourceType,
    sortOrder: row.SortOrder,
    createdDate: row.CreatedDate
  };
  if (row.ResourceType === 'link') {
    return { ...base, externalUrl: row.ExternalUrl };
  }
  const fileUrl = row.StoredFileName ? sasForMarketingFile(row.StoredFileName) : null;
  return {
    ...base,
    fileId: row.FileId,
    fileName: row.FileUploadFileName,
    mimeType: row.FileMimeType,
    fileSize: row.FileSizeBytes,
    fileUrl
  };
}

async function verifyVendor(pool, vendorId) {
  const r = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT VendorId, VendorName
      FROM oe.Vendors
      WHERE VendorId = @vid
    `);
  return r.recordset[0] || null;
}

async function listVendorFolders(pool, vendorId, tenantId) {
  const result = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT FolderId, VendorId, OwnerTenantId, Name, Description, SortOrder, IsActive, CreatedDate, ModifiedDate
      FROM oe.VendorMarketingFolders
      WHERE VendorId = @vid AND IsActive = 1
      ORDER BY SortOrder ASC, CreatedDate ASC
    `);
  return result.recordset || [];
}

async function verifyVendorFolderOwned(pool, vendorId, tenantId, folderId) {
  const r = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('fid', sql.UniqueIdentifier, folderId)
    .query(`
      SELECT FolderId, VendorId, OwnerTenantId, Name, Description, SortOrder, IsActive
      FROM oe.VendorMarketingFolders
      WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
    `);
  return r.recordset[0] || null;
}

async function listVendorResourcesInFolder(pool, vendorId, tenantId, folderId) {
  const result = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('fid', sql.UniqueIdentifier, folderId)
    .query(`
      SELECT
        r.ResourceId,
        r.FolderId,
        r.VendorId,
        r.OwnerTenantId,
        r.Title,
        r.Description,
        r.ResourceType,
        r.FileId,
        r.ExternalUrl,
        r.SortOrder,
        r.IsActive,
        r.CreatedDate,
        fu.FileName AS FileUploadFileName,
        fu.StoredFileName,
        fu.MimeType AS FileMimeType,
        fu.FileSize AS FileSizeBytes
      FROM oe.VendorMarketingResources r
      LEFT JOIN oe.FileUploads fu ON r.FileId = fu.FileId
      WHERE r.FolderId = @fid AND r.VendorId = @vid AND r.IsActive = 1
      ORDER BY r.SortOrder ASC, r.CreatedDate ASC
    `);
  return result.recordset || [];
}

async function getVendorLibraryTree(pool, vendorId, tenantId) {
  const folders = await listVendorFolders(pool, vendorId, tenantId);
  const out = [];
  for (const f of folders) {
    const rows = await listVendorResourcesInFolder(pool, vendorId, tenantId, f.FolderId);
    out.push({
      folderId: f.FolderId,
      name: f.Name,
      description: f.Description,
      sortOrder: f.SortOrder,
      createdDate: f.CreatedDate,
      resources: rows.map(mapVendorResourceRow)
    });
  }
  return out;
}

async function ensureFileUploadRowForVendor(pool, params) {
  const { fileId, fileName, storedFileName, filePath, fileSize, mimeType, tenantId, userId, entityId } = params;
  const check = await pool.request()
    .input('fileId', sql.UniqueIdentifier, fileId)
    .query(`SELECT FileId FROM oe.FileUploads WHERE FileId = @fileId`);
  if (check.recordset.length > 0) return;
  await pool.request()
    .input('fileId', sql.UniqueIdentifier, fileId)
    .input('fileName', sql.NVarChar, fileName)
    .input('storedFileName', sql.NVarChar, storedFileName)
    .input('filePath', sql.NVarChar, filePath || '')
    .input('fileSize', sql.Int, fileSize || 0)
    .input('mimeType', sql.NVarChar, mimeType || 'application/octet-stream')
    .input('uploadType', sql.NVarChar, FILE_UPLOAD_TYPE)
    .input('entityId', sql.NVarChar, String(entityId))
    .input('category', sql.NVarChar, 'marketing-vendor')
    .input('uploadedBy', sql.UniqueIdentifier, optionalUserId(userId))
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('status', sql.NVarChar, 'Active')
    .input('createdDate', sql.DateTime2, new Date())
    .input('modifiedDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.FileUploads (
        FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
        UploadType, EntityId, Category, UploadedBy, TenantId, Status, CreatedDate, ModifiedDate
      ) VALUES (
        @fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
        @uploadType, @entityId, @category, @uploadedBy, @tenantId, @status, @createdDate, @modifiedDate
      )
    `);
}

async function getNextVendorResourceSortOrder(pool, folderId, vendorId, tenantId) {
  const r = await pool.request()
    .input('fid', sql.UniqueIdentifier, folderId)
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ISNULL(MAX(SortOrder), -1) AS mx
      FROM oe.VendorMarketingResources
      WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
    `);
  return (r.recordset[0]?.mx ?? -1) + 1;
}

async function createVendorFolder(pool, vendorId, tenantId, userId, { name, description }) {
  if (!name || !String(name).trim()) throw new Error('Folder name is required');
  const maxSort = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ISNULL(MAX(SortOrder), -1) AS mx
      FROM oe.VendorMarketingFolders
      WHERE VendorId = @vid AND IsActive = 1
    `);
  const nextOrder = (maxSort.recordset[0]?.mx ?? -1) + 1;
  const folderId = uuidv4();
  await pool.request()
    .input('folderId', sql.UniqueIdentifier, folderId)
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
    .input('name', sql.NVarChar(200), String(name).trim())
    .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
    .input('sort', sql.Int, nextOrder)
    .query(`
      INSERT INTO oe.VendorMarketingFolders (
        FolderId, VendorId, OwnerTenantId, Name, Description, SortOrder, IsActive, CreatedBy, CreatedDate
      ) VALUES (
        @folderId, @vid, @tid, @name, @desc, @sort, 1, @uid, SYSUTCDATETIME()
      )
    `);
  return verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
}

async function updateVendorFolder(pool, vendorId, tenantId, userId, folderId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const { name, description } = body;
  const existing = await verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
  if (!existing) return null;
  const hasDesc = Object.prototype.hasOwnProperty.call(body, 'description');
  const req = pool.request();
  req.input('fid', sql.UniqueIdentifier, folderId);
  req.input('vid', sql.UniqueIdentifier, vendorId);
  req.input('tid', sql.UniqueIdentifier, tenantId);
  req.input('uid', sql.UniqueIdentifier, optionalUserId(userId));
  if (name !== undefined) {
    if (!String(name).trim()) throw new Error('Folder name is required');
    req.input('name', sql.NVarChar(200), String(name).trim());
  }
  if (hasDesc) {
    req.input('desc', sql.NVarChar(1000), description ? String(description).trim() : null);
  }
  const sets = [];
  if (name !== undefined) sets.push('Name = @name');
  if (hasDesc) sets.push('Description = @desc');
  if (sets.length === 0) return existing;
  sets.push('ModifiedBy = @uid');
  sets.push('ModifiedDate = SYSUTCDATETIME()');
  await req.query(`
    UPDATE oe.VendorMarketingFolders
    SET ${sets.join(', ')}
    WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
  `);
  return verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
}

async function deleteVendorFolder(pool, vendorId, tenantId, userId, folderId) {
  const existing = await verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
  if (!existing) return false;
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const resRows = await transaction.request()
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT ResourceId, FileId FROM oe.VendorMarketingResources
        WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
      `);
    for (const row of resRows.recordset || []) {
      if (row.FileId) {
        await transaction.request()
          .input('fileId', sql.UniqueIdentifier, row.FileId)
          .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
          .query(`
            UPDATE oe.FileUploads
            SET Status = N'Deleted', ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @uid
            WHERE FileId = @fileId
          `);
      }
    }
    await transaction.request()
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.VendorMarketingResources
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
      `);
    await transaction.request()
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.VendorMarketingFolders
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
      `);
    await transaction.commit();
    return true;
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function reorderVendorFolders(pool, vendorId, tenantId, userId, orderedFolderIds) {
  if (!Array.isArray(orderedFolderIds) || orderedFolderIds.length === 0) {
    throw new Error('orderedFolderIds array required');
  }
  const current = await pool.request()
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT FolderId FROM oe.VendorMarketingFolders
      WHERE VendorId = @vid AND IsActive = 1
    `);
  const currentSet = new Set((current.recordset || []).map((r) => normGuid(r.FolderId)));
  const orderedSet = new Set(orderedFolderIds.map((id) => normGuid(id)));
  if (currentSet.size !== orderedSet.size) {
    throw new Error('orderedFolderIds must include every active folder exactly once');
  }
  for (const id of orderedFolderIds) {
    if (!currentSet.has(normGuid(id))) throw new Error('Invalid folder id in reorder list');
  }
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (let i = 0; i < orderedFolderIds.length; i++) {
      await transaction.request()
        .input('fid', sql.UniqueIdentifier, orderedFolderIds[i])
        .input('vid', sql.UniqueIdentifier, vendorId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('ord', sql.Int, i)
        .query(`
          UPDATE oe.VendorMarketingFolders
          SET SortOrder = @ord, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
          WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
        `);
    }
    await transaction.commit();
    return listVendorFolders(pool, vendorId, tenantId);
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function createVendorResource(pool, vendorId, tenantId, userId, body) {
  const { folderId, title, description, resourceType, externalUrl, fileId, fileName, storedFileName, fileUrl, mimeType, fileSize } = body;

  if (!isUuid(folderId)) throw new Error('Invalid folderId');
  const folder = await verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
  if (!folder) throw new Error('Folder not found');
  if (!title || !String(title).trim()) throw new Error('Title is required');

  const sortOrder = await getNextVendorResourceSortOrder(pool, folderId, vendorId, tenantId);
  const resourceId = uuidv4();

  if (resourceType === 'link') {
    assertHttpUrl(externalUrl);
    await pool.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('title', sql.NVarChar(300), String(title).trim())
      .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
      .input('url', sql.NVarChar(2000), String(externalUrl).trim())
      .input('sort', sql.Int, sortOrder)
      .query(`
        INSERT INTO oe.VendorMarketingResources (
          ResourceId, FolderId, VendorId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @rid, @fid, @vid, @tid, @title, @desc, N'link', NULL, @url, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
    return resourceId;
  }

  if (resourceType === 'file') {
    if (!isUuid(fileId)) throw new Error('Invalid fileId');
    if (!fileName || !storedFileName) throw new Error('fileName and storedFileName are required');
    await ensureFileUploadRowForVendor(pool, {
      fileId,
      fileName,
      storedFileName,
      filePath: fileUrl || '',
      fileSize,
      mimeType,
      tenantId,
      userId,
      entityId: vendorId
    });
    await pool.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('folderId', sql.UniqueIdentifier, folderId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('title', sql.NVarChar(300), String(title).trim())
      .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
      .input('fileId', sql.UniqueIdentifier, fileId)
      .input('sort', sql.Int, sortOrder)
      .query(`
        INSERT INTO oe.VendorMarketingResources (
          ResourceId, FolderId, VendorId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @rid, @folderId, @vid, @tid, @title, @desc, N'file', @fileId, NULL, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
    return resourceId;
  }

  throw new Error('resourceType must be file or link');
}

async function verifyVendorResourceOwned(pool, vendorId, tenantId, resourceId) {
  const r = await pool.request()
    .input('rid', sql.UniqueIdentifier, resourceId)
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT r.ResourceId, r.FolderId, r.Title, r.Description, r.ResourceType, r.FileId, r.ExternalUrl, r.SortOrder
      FROM oe.VendorMarketingResources r
      WHERE r.ResourceId = @rid AND r.VendorId = @vid AND r.IsActive = 1
    `);
  return r.recordset[0] || null;
}

async function updateVendorResource(pool, vendorId, tenantId, userId, resourceId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const { title, description, folderId: newFolderId } = body;
  const existing = await verifyVendorResourceOwned(pool, vendorId, tenantId, resourceId);
  if (!existing) return null;

  const hasTitle = title !== undefined;
  const hasDesc = Object.prototype.hasOwnProperty.call(body, 'description');
  const hasFolder = newFolderId !== undefined;

  if (!hasTitle && !hasDesc && !hasFolder) return existing;

  let nextFolderId = null;
  let nextSortOrder = null;
  if (hasFolder) {
    if (!isUuid(newFolderId)) throw new Error('Invalid folderId');
    if (normGuid(newFolderId) !== normGuid(existing.FolderId)) {
      const folder = await verifyVendorFolderOwned(pool, vendorId, tenantId, newFolderId);
      if (!folder) throw new Error('Folder not found');
      nextFolderId = newFolderId;
      nextSortOrder = await getNextVendorResourceSortOrder(pool, newFolderId, vendorId, tenantId);
    }
  }

  const req = pool.request();
  req.input('rid', sql.UniqueIdentifier, resourceId);
  req.input('vid', sql.UniqueIdentifier, vendorId);
  req.input('tid', sql.UniqueIdentifier, tenantId);
  req.input('uid', sql.UniqueIdentifier, optionalUserId(userId));
  const sets = [];
  if (hasTitle) {
    if (!String(title).trim()) throw new Error('Title is required');
    req.input('title', sql.NVarChar(300), String(title).trim());
    sets.push('Title = @title');
  }
  if (hasDesc) {
    req.input('desc', sql.NVarChar(1000), description ? String(description).trim() : null);
    sets.push('Description = @desc');
  }
  if (nextFolderId != null && nextSortOrder != null) {
    req.input('newFid', sql.UniqueIdentifier, nextFolderId);
    req.input('newSort', sql.Int, nextSortOrder);
    sets.push('FolderId = @newFid');
    sets.push('SortOrder = @newSort');
  }

  if (sets.length === 0) return existing;

  sets.push('ModifiedBy = @uid');
  sets.push('ModifiedDate = SYSUTCDATETIME()');
  await req.query(`
    UPDATE oe.VendorMarketingResources SET ${sets.join(', ')}
    WHERE ResourceId = @rid AND VendorId = @vid AND IsActive = 1
  `);
  return verifyVendorResourceOwned(pool, vendorId, tenantId, resourceId);
}

async function deleteVendorResource(pool, vendorId, tenantId, userId, resourceId) {
  const existing = await verifyVendorResourceOwned(pool, vendorId, tenantId, resourceId);
  if (!existing) return false;
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('vid', sql.UniqueIdentifier, vendorId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.VendorMarketingResources
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE ResourceId = @rid AND VendorId = @vid AND IsActive = 1
      `);
    if (existing.FileId) {
      await transaction.request()
        .input('fileId', sql.UniqueIdentifier, existing.FileId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .query(`
          UPDATE oe.FileUploads
          SET Status = N'Deleted', ModifiedDate = SYSUTCDATETIME(), ModifiedBy = @uid
          WHERE FileId = @fileId
        `);
    }
    await transaction.commit();
    return true;
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function reorderVendorResources(pool, vendorId, tenantId, userId, folderId, orderedResourceIds) {
  if (!isUuid(folderId)) throw new Error('Invalid folderId');
  const folder = await verifyVendorFolderOwned(pool, vendorId, tenantId, folderId);
  if (!folder) throw new Error('Folder not found');
  if (!Array.isArray(orderedResourceIds) || orderedResourceIds.length === 0) {
    throw new Error('orderedResourceIds array required');
  }
  const current = await pool.request()
    .input('fid', sql.UniqueIdentifier, folderId)
    .input('vid', sql.UniqueIdentifier, vendorId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ResourceId FROM oe.VendorMarketingResources
      WHERE FolderId = @fid AND VendorId = @vid AND IsActive = 1
    `);
  const currentSet = new Set((current.recordset || []).map((r) => normGuid(r.ResourceId)));
  const orderedSet = new Set(orderedResourceIds.map((id) => normGuid(id)));
  if (currentSet.size !== orderedSet.size) {
    throw new Error('orderedResourceIds must include every active resource in the folder exactly once');
  }
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (let i = 0; i < orderedResourceIds.length; i++) {
      await transaction.request()
        .input('rid', sql.UniqueIdentifier, orderedResourceIds[i])
        .input('fid', sql.UniqueIdentifier, folderId)
        .input('vid', sql.UniqueIdentifier, vendorId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('ord', sql.Int, i)
        .query(`
          UPDATE oe.VendorMarketingResources
          SET SortOrder = @ord, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
          WHERE ResourceId = @rid AND FolderId = @fid AND VendorId = @vid AND IsActive = 1
        `);
    }
    await transaction.commit();
    return listVendorResourcesInFolder(pool, vendorId, tenantId, folderId);
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function getOrganizationCatalogForCopy(pool, sourceTenantId) {
  const orgQ = await pool.request()
    .input('tid', sql.UniqueIdentifier, sourceTenantId)
    .query(`SELECT Name FROM oe.Tenants WHERE TenantId = @tid`);
  if (!orgQ.recordset[0]) {
    const e = new Error('Source tenant not found');
    e.statusCode = 404;
    throw e;
  }
  const organizationName = orgQ.recordset[0]?.Name || 'Organization';
  const folders = await tenantMk.getLibraryTree(pool, sourceTenantId, { forAgentView: false });
  return { organizationName, folders };
}

async function listTenantsForCopy(pool) {
  const r = await pool.request().query(`
    SELECT TenantId, Name
    FROM oe.Tenants
    WHERE Status = N'Active'
    ORDER BY Name
  `);
  return (r.recordset || []).map((t) => ({ tenantId: t.TenantId, name: t.Name }));
}

async function copyMarketingFileForVendor(transaction, sourceFileId, targetTenantId, vendorId, userId) {
  const fileRowQ = await transaction.request()
    .input('fileId', sql.UniqueIdentifier, sourceFileId)
    .query(`
      SELECT FileId, FileName, StoredFileName, FilePath, FileSize, MimeType
      FROM oe.FileUploads
      WHERE FileId = @fileId AND ISNULL(Status, 'Active') <> 'Deleted'
    `);

  const row = fileRowQ.recordset[0];
  if (!row?.StoredFileName) return null;

  const newStored = await copyDocumentsBlobToNewName(row.StoredFileName);
  const newFileId = uuidv4();

  await transaction.request()
    .input('fileId', sql.UniqueIdentifier, newFileId)
    .input('fileName', sql.NVarChar, row.FileName)
    .input('storedFileName', sql.NVarChar, newStored)
    .input('filePath', sql.NVarChar, row.FilePath || '')
    .input('fileSize', sql.Int, row.FileSize || 0)
    .input('mimeType', sql.NVarChar, row.MimeType || 'application/octet-stream')
    .input('uploadType', sql.NVarChar, FILE_UPLOAD_TYPE)
    .input('entityId', sql.NVarChar, String(vendorId))
    .input('category', sql.NVarChar, 'marketing-vendor')
    .input('uploadedBy', sql.UniqueIdentifier, optionalUserId(userId))
    .input('tenantId', sql.UniqueIdentifier, targetTenantId)
    .input('status', sql.NVarChar, 'Active')
    .input('createdDate', sql.DateTime2, new Date())
    .input('modifiedDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.FileUploads (
        FileId, FileName, StoredFileName, FilePath, FileSize, MimeType,
        UploadType, EntityId, Category, UploadedBy, TenantId, Status, CreatedDate, ModifiedDate
      ) VALUES (
        @fileId, @fileName, @storedFileName, @filePath, @fileSize, @mimeType,
        @uploadType, @entityId, @category, @uploadedBy, @tenantId, @status, @createdDate, @modifiedDate
      )
    `);

  return newFileId;
}

async function copyFoldersFromOrganization(pool, vendorId, targetTenantId, sourceTenantId, userId, folderIds) {
  if (!Array.isArray(folderIds) || folderIds.length === 0) {
    throw new Error('folderIds array required');
  }
  const uniq = [...new Set(folderIds.map((x) => normGuid(x)))];

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (const fid of uniq) {
      const f = await transaction.request()
        .input('fid', sql.UniqueIdentifier, fid)
        .input('sourceTid', sql.UniqueIdentifier, sourceTenantId)
        .query(`
          SELECT FolderId, Name, Description, SortOrder
          FROM oe.TenantMarketingFolders
          WHERE FolderId = @fid AND OwnerTenantId = @sourceTid AND IsActive = 1
        `);
      const src = f.recordset[0];
      if (!src) throw new Error('Folder not found or access denied');

      const newFolderId = uuidv4();
      const sortR = await transaction.request()
        .input('vid', sql.UniqueIdentifier, vendorId)
        .input('tid', sql.UniqueIdentifier, targetTenantId)
        .query(`
          SELECT ISNULL(MAX(SortOrder), -1) AS mx FROM oe.VendorMarketingFolders
          WHERE VendorId = @vid AND IsActive = 1
        `);
      const nextFolderOrder = (sortR.recordset[0]?.mx ?? -1) + 1;

      await transaction.request()
        .input('folderId', sql.UniqueIdentifier, newFolderId)
        .input('vid', sql.UniqueIdentifier, vendorId)
        .input('tid', sql.UniqueIdentifier, targetTenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('name', sql.NVarChar(200), src.Name)
        .input('desc', sql.NVarChar(1000), src.Description || null)
        .input('sort', sql.Int, nextFolderOrder)
        .query(`
          INSERT INTO oe.VendorMarketingFolders (
            FolderId, VendorId, OwnerTenantId, Name, Description, SortOrder, IsActive, CreatedBy, CreatedDate
          ) VALUES (
            @folderId, @vid, @tid, @name, @desc, @sort, 1, @uid, SYSUTCDATETIME()
          )
        `);

      const resources = await tenantMk.listResourcesInFolder(pool, sourceTenantId, fid);
      let sort = 0;
      for (const res of resources) {
        const rid = uuidv4();
        if (res.ResourceType === 'link') {
          await transaction.request()
            .input('rid', sql.UniqueIdentifier, rid)
            .input('nfid', sql.UniqueIdentifier, newFolderId)
            .input('vid', sql.UniqueIdentifier, vendorId)
            .input('tid', sql.UniqueIdentifier, targetTenantId)
            .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
            .input('title', sql.NVarChar(300), res.Title)
            .input('desc', sql.NVarChar(1000), res.Description || null)
            .input('url', sql.NVarChar(2000), res.ExternalUrl)
            .input('sort', sql.Int, sort++)
            .query(`
              INSERT INTO oe.VendorMarketingResources (
                ResourceId, FolderId, VendorId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
              ) VALUES (
                @rid, @nfid, @vid, @tid, @title, @desc, N'link', NULL, @url, @sort, 1, @uid, SYSUTCDATETIME()
              )
            `);
        } else if (res.ResourceType === 'file' && res.FileId) {
          const newFileId = await copyMarketingFileForVendor(transaction, res.FileId, targetTenantId, vendorId, userId);
          if (!newFileId) {
            console.warn(`[vendor-resource-library] Skipping resource "${res.Title}" — source file ${res.FileId} missing or deleted`);
            continue;
          }
          await transaction.request()
            .input('rid', sql.UniqueIdentifier, rid)
            .input('nfid', sql.UniqueIdentifier, newFolderId)
            .input('vid', sql.UniqueIdentifier, vendorId)
            .input('tid', sql.UniqueIdentifier, targetTenantId)
            .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
            .input('title', sql.NVarChar(300), res.Title)
            .input('desc', sql.NVarChar(1000), res.Description || null)
            .input('fileId', sql.UniqueIdentifier, newFileId)
            .input('sort', sql.Int, sort++)
            .query(`
              INSERT INTO oe.VendorMarketingResources (
                ResourceId, FolderId, VendorId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
              ) VALUES (
                @rid, @nfid, @vid, @tid, @title, @desc, N'file', @fileId, NULL, @sort, 1, @uid, SYSUTCDATETIME()
              )
            `);
        }
      }
    }

    await transaction.commit();
  } catch (e) {
    await transaction.rollback();
    throw e;
  }

  return getVendorLibraryTree(pool, vendorId, targetTenantId);
}

module.exports = {
  verifyVendor,
  getVendorLibraryTree,
  listVendorFolders,
  verifyVendorFolderOwned,
  createVendorFolder,
  updateVendorFolder,
  deleteVendorFolder,
  reorderVendorFolders,
  createVendorResource,
  verifyVendorResourceOwned,
  updateVendorResource,
  deleteVendorResource,
  reorderVendorResources,
  getOrganizationCatalogForCopy,
  copyFoldersFromOrganization,
  listTenantsForCopy,
  mapVendorResourceRow,
  listVendorResourcesInFolder
};
