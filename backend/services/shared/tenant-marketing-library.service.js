/**
 * UNIFIED FUNCTION — tenant marketing documents (folders + file/link resources).
 * Used by:
 * - GET/PATCH/DELETE /api/me/tenant-admin/marketing-folders
 * - GET/POST/PATCH/DELETE /api/me/tenant-admin/marketing-resources
 * - GET /api/me/agent/marketing-resources
 *
 * Multi-tenant: callers must use tenantId from requireTenantAccess (req.tenantId), not
 * JWT primary tenant alone. See prompts/backend-system.md (Multi-tenant context).
 */
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../../config/database');
const { generateSASUrl, MARKETING_RESOURCE_SAS_EXPIRES_MINUTES, copyDocumentsBlobToNewName } = require('../../routes/uploads');

const DOCUMENTS_CONTAINER = 'documents';
const FILE_UPLOAD_TYPE = 'marketing-resources';
const DEFAULT_FOLDER_NAMES = [
  'Scripts',
  'Comp Schedules',
  'Promotion Guides',
  'Bundle Guides',
  'Flyers'
];

function isUuid(s) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(s || ''));
}

function normGuid(v) {
  return String(v).replace(/[{}]/g, '').toLowerCase();
}

/**
 * mssql rejects undefined for UniqueIdentifier; API-key auth uses UserId: null.
 * Returns a canonical GUID string or null (never undefined).
 */
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
    console.warn('[tenant-marketing-library] SAS failed:', e.message);
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

async function ensureDefaultFolder(pool, tenantId, userId) {
  const rows = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT FolderId, Name, SortOrder
      FROM oe.TenantMarketingFolders
      WHERE OwnerTenantId = @tid AND IsActive = 1
      ORDER BY SortOrder ASC, CreatedDate ASC
    `);

  const existing = rows.recordset || [];
  // Seed defaults only once for tenants with no folders.
  // Do not continuously "heal" missing names, otherwise delete/rename appears broken.
  if (existing.length > 0) return;

  for (let i = 0; i < DEFAULT_FOLDER_NAMES.length; i++) {
    await pool.request()
      .input('folderId', sql.UniqueIdentifier, uuidv4())
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('name', sql.NVarChar(200), DEFAULT_FOLDER_NAMES[i])
      .input('sort', sql.Int, i)
      .query(`
        INSERT INTO oe.TenantMarketingFolders (
          FolderId, OwnerTenantId, Name, Description, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @folderId, @tid, @name, NULL, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
  }
}

function inferFolderNameForUpload(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.includes('script')) return 'Scripts';
  if (name.includes('comp') || name.includes('commission')) return 'Comp Schedules';
  if (name.includes('promo') || name.includes('promotion')) return 'Promotion Guides';
  if (name.includes('bundle')) return 'Bundle Guides';
  return 'Flyers';
}

function titleFromFileName(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) return 'Uploaded document';
  const withoutExt = raw.replace(/\.[^/.]+$/, '').trim();
  return withoutExt || raw;
}

async function importLegacyUploads(pool, tenantId, userId) {
  const folderRows = await listFolders(pool, tenantId);
  if (!folderRows.length) return;
  const folderByName = new Map(
    folderRows.map((f) => [String(f.Name || '').trim().toLowerCase(), f])
  );

  // Exclude file uploads that already belong to an agency-scoped marketing resource.
  // Agency copy/upload reuses UploadType='marketing-resources' + TenantId so SAS auth
  // and tenant scoping still work, which would otherwise cause the legacy importer to
  // pull agency files into the tenant (organization) library as duplicates.
  const legacy = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uploadType', sql.NVarChar(100), FILE_UPLOAD_TYPE)
    .query(`
      SELECT fu.FileId, fu.FileName, fu.StoredFileName
      FROM oe.FileUploads fu
      LEFT JOIN oe.TenantMarketingResources r
        ON r.FileId = fu.FileId
        AND r.OwnerTenantId = @tid
        AND r.IsActive = 1
      WHERE fu.TenantId = @tid
        AND fu.UploadType = @uploadType
        AND ISNULL(fu.Status, 'Active') <> 'Deleted'
        AND ISNULL(fu.Category, '') <> 'marketing-agency'
        AND r.ResourceId IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM oe.AgencyMarketingResources ar
          WHERE ar.FileId = fu.FileId
            AND ar.OwnerTenantId = @tid
            AND ar.IsActive = 1
        )
      ORDER BY fu.CreatedDate ASC
    `);

  const missingUploads = legacy.recordset || [];
  if (!missingUploads.length) return;

  for (const file of missingUploads) {
    const preferredFolder = inferFolderNameForUpload(file.FileName);
    const folder =
      folderByName.get(preferredFolder.toLowerCase()) ||
      folderRows[folderRows.length - 1] ||
      folderRows[0];
    const nextSortOrder = await getNextResourceSortOrder(pool, folder.FolderId, tenantId);
    await pool.request()
      .input('rid', sql.UniqueIdentifier, uuidv4())
      .input('fid', sql.UniqueIdentifier, folder.FolderId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('title', sql.NVarChar(300), titleFromFileName(file.FileName))
      .input('fileId', sql.UniqueIdentifier, file.FileId)
      .input('sort', sql.Int, nextSortOrder)
      .query(`
        INSERT INTO oe.TenantMarketingResources (
          ResourceId, FolderId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @rid, @fid, @tid, @title, NULL, N'file', @fileId, NULL, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
  }
}

async function listFolders(pool, tenantId, options = {}) {
  const excludeHiddenFromAgents = options.excludeHiddenFromAgents === true;
  const hideClause = excludeHiddenFromAgents ? ' AND HideFromAgents = 0' : '';
  const result = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT FolderId, OwnerTenantId, Name, Description, SortOrder, IsActive, HideFromAgents, CreatedDate, ModifiedDate
      FROM oe.TenantMarketingFolders
      WHERE OwnerTenantId = @tid AND IsActive = 1${hideClause}
      ORDER BY SortOrder ASC, CreatedDate ASC
    `);
  return result.recordset || [];
}

async function verifyFolderOwned(pool, tenantId, folderId) {
  const r = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('fid', sql.UniqueIdentifier, folderId)
    .query(`
      SELECT FolderId, OwnerTenantId, Name, Description, SortOrder, IsActive, HideFromAgents
      FROM oe.TenantMarketingFolders
      WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
    `);
  return r.recordset[0] || null;
}

async function listResourcesInFolder(pool, tenantId, folderId) {
  const result = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('fid', sql.UniqueIdentifier, folderId)
    .query(`
      SELECT
        r.ResourceId,
        r.FolderId,
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
      FROM oe.TenantMarketingResources r
      LEFT JOIN oe.FileUploads fu ON r.FileId = fu.FileId
      WHERE r.FolderId = @fid AND r.OwnerTenantId = @tid AND r.IsActive = 1
      ORDER BY r.SortOrder ASC, r.CreatedDate ASC
    `);
  return result.recordset || [];
}

async function mapResourceRow(row) {
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

async function getLibraryTree(pool, tenantId, options = {}) {
  const forAgentView = options.forAgentView === true;
  await ensureDefaultFolder(pool, tenantId, null);
  await importLegacyUploads(pool, tenantId, null);
  const folders = await listFolders(pool, tenantId, { excludeHiddenFromAgents: forAgentView });
  const out = [];
  for (const f of folders) {
    const rows = await listResourcesInFolder(pool, tenantId, f.FolderId);
    const resources = await Promise.all(rows.map((row) => mapResourceRow(row)));
    const node = {
      folderId: f.FolderId,
      name: f.Name,
      description: f.Description,
      sortOrder: f.SortOrder,
      createdDate: f.CreatedDate,
      resources
    };
    if (!forAgentView) {
      node.hideFromAgents = Boolean(f.HideFromAgents);
    }
    out.push(node);
  }
  return out;
}

async function createFolder(pool, tenantId, userId, { name, description, hideFromAgents }) {
  if (!name || !String(name).trim()) {
    throw new Error('Folder name is required');
  }
  const maxSort = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ISNULL(MAX(SortOrder), -1) AS mx
      FROM oe.TenantMarketingFolders
      WHERE OwnerTenantId = @tid AND IsActive = 1
    `);
  const nextOrder = (maxSort.recordset[0]?.mx ?? -1) + 1;
  const folderId = uuidv4();
  const hide = hideFromAgents === true;
  await pool.request()
    .input('folderId', sql.UniqueIdentifier, folderId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
    .input('name', sql.NVarChar(200), String(name).trim())
    .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
    .input('sort', sql.Int, nextOrder)
    .input('hideAgents', sql.Bit, hide ? 1 : 0)
    .query(`
      INSERT INTO oe.TenantMarketingFolders (
        FolderId, OwnerTenantId, Name, Description, SortOrder, IsActive, HideFromAgents, CreatedBy, CreatedDate
      ) VALUES (
        @folderId, @tid, @name, @desc, @sort, 1, @hideAgents, @uid, SYSUTCDATETIME()
      )
    `);
  return await verifyFolderOwned(pool, tenantId, folderId);
}

async function updateFolder(pool, tenantId, userId, folderId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const { name, description, hideFromAgents } = body;
  const existing = await verifyFolderOwned(pool, tenantId, folderId);
  if (!existing) return null;
  const hasDesc = Object.prototype.hasOwnProperty.call(body, 'description');
  const req = pool.request();
  req.input('fid', sql.UniqueIdentifier, folderId);
  req.input('tid', sql.UniqueIdentifier, tenantId);
  req.input('uid', sql.UniqueIdentifier, optionalUserId(userId));
  if (name !== undefined) {
    if (!String(name).trim()) throw new Error('Folder name is required');
    req.input('name', sql.NVarChar(200), String(name).trim());
  }
  if (hasDesc) {
    req.input('desc', sql.NVarChar(1000), description ? String(description).trim() : null);
  }
  if (hideFromAgents !== undefined) {
    req.input('hideAgents', sql.Bit, hideFromAgents === true ? 1 : 0);
  }
  let sets = [];
  if (name !== undefined) sets.push('Name = @name');
  if (hasDesc) sets.push('Description = @desc');
  if (hideFromAgents !== undefined) sets.push('HideFromAgents = @hideAgents');
  if (sets.length === 0) return existing;
  sets.push('ModifiedBy = @uid');
  sets.push('ModifiedDate = SYSUTCDATETIME()');
  await req.query(`
    UPDATE oe.TenantMarketingFolders
    SET ${sets.join(', ')}
    WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
  `);
  return await verifyFolderOwned(pool, tenantId, folderId);
}

async function deleteFolder(pool, tenantId, userId, folderId) {
  const existing = await verifyFolderOwned(pool, tenantId, folderId);
  if (!existing) return false;
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request()
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.TenantMarketingResources
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
      `);
    await transaction.request()
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.TenantMarketingFolders
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
      `);
    await transaction.commit();
    return true;
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function reorderFolders(pool, tenantId, userId, orderedFolderIds) {
  if (!Array.isArray(orderedFolderIds) || orderedFolderIds.length === 0) {
    throw new Error('orderedFolderIds array required');
  }
  const current = await pool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT FolderId
      FROM oe.TenantMarketingFolders
      WHERE OwnerTenantId = @tid AND IsActive = 1
    `);
  const currentSet = new Set((current.recordset || []).map((r) => normGuid(r.FolderId)));
  const orderedSet = new Set(orderedFolderIds.map((id) => normGuid(id)));
  if (currentSet.size !== orderedSet.size) {
    throw new Error('orderedFolderIds must include every active folder exactly once');
  }
  for (const id of orderedFolderIds) {
    if (!currentSet.has(normGuid(id))) {
      throw new Error('Invalid folder id in reorder list');
    }
  }
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (let i = 0; i < orderedFolderIds.length; i++) {
      await transaction.request()
        .input('fid', sql.UniqueIdentifier, orderedFolderIds[i])
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('ord', sql.Int, i)
        .query(`
          UPDATE oe.TenantMarketingFolders
          SET SortOrder = @ord, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
          WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
        `);
    }
    await transaction.commit();
    return listFolders(pool, tenantId);
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function ensureFileUploadRow(pool, {
  fileId,
  fileName,
  storedFileName,
  filePath,
  fileSize,
  mimeType,
  tenantId,
  userId
}) {
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
    .input('entityId', sql.NVarChar, String(tenantId))
    .input('category', sql.NVarChar, 'marketing')
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

async function getNextResourceSortOrder(pool, folderId, tenantId) {
  const r = await pool.request()
    .input('fid', sql.UniqueIdentifier, folderId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ISNULL(MAX(SortOrder), -1) AS mx
      FROM oe.TenantMarketingResources
      WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
    `);
  return (r.recordset[0]?.mx ?? -1) + 1;
}

async function createResource(pool, tenantId, userId, body) {
  const {
    folderId,
    title,
    description,
    resourceType,
    externalUrl,
    fileId,
    fileName,
    storedFileName,
    fileUrl,
    mimeType,
    fileSize
  } = body;

  if (!isUuid(folderId)) throw new Error('Invalid folderId');
  const folder = await verifyFolderOwned(pool, tenantId, folderId);
  if (!folder) throw new Error('Folder not found');

  if (!title || !String(title).trim()) throw new Error('Title is required');

  const sortOrder = await getNextResourceSortOrder(pool, folderId, tenantId);
  const resourceId = uuidv4();

  if (resourceType === 'link') {
    assertHttpUrl(externalUrl);
    await pool.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('fid', sql.UniqueIdentifier, folderId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('title', sql.NVarChar(300), String(title).trim())
      .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
      .input('url', sql.NVarChar(2000), String(externalUrl).trim())
      .input('sort', sql.Int, sortOrder)
      .query(`
        INSERT INTO oe.TenantMarketingResources (
          ResourceId, FolderId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @rid, @fid, @tid, @title, @desc, N'link', NULL, @url, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
    return resourceId;
  }

  if (resourceType === 'file') {
    if (!isUuid(fileId)) throw new Error('Invalid fileId');
    if (!fileName || !storedFileName) throw new Error('fileName and storedFileName are required');
    await ensureFileUploadRow(pool, {
      fileId,
      fileName,
      storedFileName,
      filePath: fileUrl || '',
      fileSize,
      mimeType,
      tenantId,
      userId
    });
    await pool.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('folderId', sql.UniqueIdentifier, folderId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .input('title', sql.NVarChar(300), String(title).trim())
      .input('desc', sql.NVarChar(1000), description ? String(description).trim() : null)
      .input('fileId', sql.UniqueIdentifier, fileId)
      .input('sort', sql.Int, sortOrder)
      .query(`
        INSERT INTO oe.TenantMarketingResources (
          ResourceId, FolderId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
        ) VALUES (
          @rid, @folderId, @tid, @title, @desc, N'file', @fileId, NULL, @sort, 1, @uid, SYSUTCDATETIME()
        )
      `);
    return resourceId;
  }

  throw new Error('resourceType must be file or link');
}

async function verifyResourceOwned(pool, tenantId, resourceId) {
  const r = await pool.request()
    .input('rid', sql.UniqueIdentifier, resourceId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT r.ResourceId, r.FolderId, r.Title, r.Description, r.ResourceType, r.FileId, r.ExternalUrl, r.SortOrder
      FROM oe.TenantMarketingResources r
      WHERE r.ResourceId = @rid AND r.OwnerTenantId = @tid AND r.IsActive = 1
    `);
  return r.recordset[0] || null;
}

async function updateResource(pool, tenantId, userId, resourceId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const { title, description, folderId: newFolderId } = body;
  const existing = await verifyResourceOwned(pool, tenantId, resourceId);
  if (!existing) return null;

  const hasTitle = title !== undefined;
  // Rely on whether the client included `description` in JSON (see marketing-resources route: pass raw req.body).
  const hasDesc = Object.prototype.hasOwnProperty.call(body, 'description');
  const hasFolder = newFolderId !== undefined;

  if (!hasTitle && !hasDesc && !hasFolder) return existing;

  let nextFolderId = null;
  let nextSortOrder = null;
  if (hasFolder) {
    if (!isUuid(newFolderId)) throw new Error('Invalid folderId');
    if (normGuid(newFolderId) !== normGuid(existing.FolderId)) {
      const folder = await verifyFolderOwned(pool, tenantId, newFolderId);
      if (!folder) throw new Error('Folder not found');
      nextFolderId = newFolderId;
      nextSortOrder = await getNextResourceSortOrder(pool, newFolderId, tenantId);
    }
  }

  const req = pool.request();
  req.input('rid', sql.UniqueIdentifier, resourceId);
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
    UPDATE oe.TenantMarketingResources SET ${sets.join(', ')}
    WHERE ResourceId = @rid AND OwnerTenantId = @tid AND IsActive = 1
  `);
  return await verifyResourceOwned(pool, tenantId, resourceId);
}

async function deleteResource(pool, tenantId, userId, resourceId) {
  const existing = await verifyResourceOwned(pool, tenantId, resourceId);
  if (!existing) return false;
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    await transaction.request()
      .input('rid', sql.UniqueIdentifier, resourceId)
      .input('tid', sql.UniqueIdentifier, tenantId)
      .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
      .query(`
        UPDATE oe.TenantMarketingResources
        SET IsActive = 0, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
        WHERE ResourceId = @rid AND OwnerTenantId = @tid AND IsActive = 1
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

async function reorderResources(pool, tenantId, userId, folderId, orderedResourceIds) {
  if (!isUuid(folderId)) throw new Error('Invalid folderId');
  const folder = await verifyFolderOwned(pool, tenantId, folderId);
  if (!folder) throw new Error('Folder not found');
  if (!Array.isArray(orderedResourceIds) || orderedResourceIds.length === 0) {
    throw new Error('orderedResourceIds array required');
  }
  const current = await pool.request()
    .input('fid', sql.UniqueIdentifier, folderId)
    .input('tid', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT ResourceId FROM oe.TenantMarketingResources
      WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
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
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('ord', sql.Int, i)
        .query(`
          UPDATE oe.TenantMarketingResources
          SET SortOrder = @ord, ModifiedBy = @uid, ModifiedDate = SYSUTCDATETIME()
          WHERE ResourceId = @rid AND FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
        `);
    }
    await transaction.commit();
    return listResourcesInFolder(pool, tenantId, folderId);
  } catch (e) {
    await transaction.rollback();
    throw e;
  }
}

async function resolveAgentTenantId(pool, user) {
  let tenantId = user.TenantId;
  if (tenantId) return tenantId;
  const uid = optionalUserId(user.UserId);
  if (!uid) return null;
  const r = await pool.request()
    .input('userId', sql.UniqueIdentifier, uid)
    .query(`SELECT TOP 1 TenantId FROM oe.Agents WHERE UserId = @userId`);
  return r.recordset[0]?.TenantId || null;
}

/**
 * Sysadmin: copy a single marketing file row from source tenant to target tenant.
 * Duplicates the blob and inserts a new oe.FileUploads row owned by target tenant.
 * Returns the new FileId.
 */
async function copyMarketingFileBetweenTenants(transaction, sourceFileId, sourceTenantId, targetTenantId, userId) {
  const fileRowQ = await transaction.request()
    .input('fileId', sql.UniqueIdentifier, sourceFileId)
    .input('tid', sql.UniqueIdentifier, sourceTenantId)
    .query(`
      SELECT FileId, FileName, StoredFileName, FilePath, FileSize, MimeType
      FROM oe.FileUploads
      WHERE FileId = @fileId AND TenantId = @tid AND ISNULL(Status, 'Active') <> 'Deleted'
    `);

  const row = fileRowQ.recordset[0];
  if (!row?.StoredFileName) throw new Error('Source file not found');

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
    .input('entityId', sql.NVarChar, String(targetTenantId))
    .input('category', sql.NVarChar, 'marketing')
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

/**
 * Sysadmin: copy whole marketing folders (and their resources) from source tenant
 * to target tenant. Creates independent rows on the target — new FolderId/ResourceId,
 * and for file resources new FileUploads + new blobs. No live cross-tenant linkage.
 * Returns the target tenant's library tree (admin view).
 */
async function copyFoldersBetweenTenants(pool, { sourceTenantId, targetTenantId, folderIds, userId }) {
  if (!isUuid(sourceTenantId)) throw new Error('Invalid sourceTenantId');
  if (!isUuid(targetTenantId)) throw new Error('Invalid targetTenantId');
  if (normGuid(sourceTenantId) === normGuid(targetTenantId)) {
    throw new Error('Source and target tenants must differ');
  }
  if (!Array.isArray(folderIds) || folderIds.length === 0) {
    throw new Error('folderIds array required');
  }

  const tenantsQ = await pool.request()
    .input('s', sql.UniqueIdentifier, sourceTenantId)
    .input('t', sql.UniqueIdentifier, targetTenantId)
    .query(`
      SELECT TenantId FROM oe.Tenants WHERE TenantId IN (@s, @t)
    `);
  const tenantSet = new Set((tenantsQ.recordset || []).map((r) => normGuid(r.TenantId)));
  if (!tenantSet.has(normGuid(sourceTenantId))) throw new Error('Source tenant not found');
  if (!tenantSet.has(normGuid(targetTenantId))) throw new Error('Target tenant not found');

  const uniq = [...new Set(folderIds.map((x) => normGuid(x)))];

  const transaction = pool.transaction();
  await transaction.begin();
  try {
    for (const fid of uniq) {
      const f = await transaction.request()
        .input('fid', sql.UniqueIdentifier, fid)
        .input('tid', sql.UniqueIdentifier, sourceTenantId)
        .query(`
          SELECT FolderId, Name, Description, SortOrder, HideFromAgents
          FROM oe.TenantMarketingFolders
          WHERE FolderId = @fid AND OwnerTenantId = @tid AND IsActive = 1
        `);
      const src = f.recordset[0];
      if (!src) throw new Error('Folder not found in source tenant');

      const sortR = await transaction.request()
        .input('tid', sql.UniqueIdentifier, targetTenantId)
        .query(`
          SELECT ISNULL(MAX(SortOrder), -1) AS mx
          FROM oe.TenantMarketingFolders
          WHERE OwnerTenantId = @tid AND IsActive = 1
        `);
      const nextFolderOrder = (sortR.recordset[0]?.mx ?? -1) + 1;
      const newFolderId = uuidv4();

      await transaction.request()
        .input('folderId', sql.UniqueIdentifier, newFolderId)
        .input('tid', sql.UniqueIdentifier, targetTenantId)
        .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
        .input('name', sql.NVarChar(200), src.Name)
        .input('desc', sql.NVarChar(1000), src.Description || null)
        .input('sort', sql.Int, nextFolderOrder)
        .input('hideAgents', sql.Bit, src.HideFromAgents ? 1 : 0)
        .query(`
          INSERT INTO oe.TenantMarketingFolders (
            FolderId, OwnerTenantId, Name, Description, SortOrder, IsActive, HideFromAgents, CreatedBy, CreatedDate
          ) VALUES (
            @folderId, @tid, @name, @desc, @sort, 1, @hideAgents, @uid, SYSUTCDATETIME()
          )
        `);

      const resources = await listResourcesInFolder(pool, sourceTenantId, fid);
      let sort = 0;
      for (const res of resources) {
        const rid = uuidv4();
        if (res.ResourceType === 'link') {
          await transaction.request()
            .input('rid', sql.UniqueIdentifier, rid)
            .input('nfid', sql.UniqueIdentifier, newFolderId)
            .input('tid', sql.UniqueIdentifier, targetTenantId)
            .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
            .input('title', sql.NVarChar(300), res.Title)
            .input('desc', sql.NVarChar(1000), res.Description || null)
            .input('url', sql.NVarChar(2000), res.ExternalUrl)
            .input('sort', sql.Int, sort++)
            .query(`
              INSERT INTO oe.TenantMarketingResources (
                ResourceId, FolderId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
              ) VALUES (
                @rid, @nfid, @tid, @title, @desc, N'link', NULL, @url, @sort, 1, @uid, SYSUTCDATETIME()
              )
            `);
        } else if (res.ResourceType === 'file' && res.FileId) {
          const newFileId = await copyMarketingFileBetweenTenants(
            transaction,
            res.FileId,
            sourceTenantId,
            targetTenantId,
            userId
          );
          await transaction.request()
            .input('rid', sql.UniqueIdentifier, rid)
            .input('nfid', sql.UniqueIdentifier, newFolderId)
            .input('tid', sql.UniqueIdentifier, targetTenantId)
            .input('uid', sql.UniqueIdentifier, optionalUserId(userId))
            .input('title', sql.NVarChar(300), res.Title)
            .input('desc', sql.NVarChar(1000), res.Description || null)
            .input('fileId', sql.UniqueIdentifier, newFileId)
            .input('sort', sql.Int, sort++)
            .query(`
              INSERT INTO oe.TenantMarketingResources (
                ResourceId, FolderId, OwnerTenantId, Title, Description, ResourceType, FileId, ExternalUrl, SortOrder, IsActive, CreatedBy, CreatedDate
              ) VALUES (
                @rid, @nfid, @tid, @title, @desc, N'file', @fileId, NULL, @sort, 1, @uid, SYSUTCDATETIME()
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

  return getLibraryTree(pool, targetTenantId, { forAgentView: false });
}

module.exports = {
  ensureDefaultFolder,
  listFolders,
  verifyFolderOwned,
  listResourcesInFolder,
  getLibraryTree,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders,
  createResource,
  verifyResourceOwned,
  updateResource,
  deleteResource,
  reorderResources,
  mapResourceRow,
  resolveAgentTenantId,
  copyFoldersBetweenTenants,
  DOCUMENTS_CONTAINER,
  FILE_UPLOAD_TYPE
};
