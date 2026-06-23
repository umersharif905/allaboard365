'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const { parseAgentTreeUpload } = require('./e123AgentTree/agentTreeParser');
const { computeExcludedAgentIds, computeDownlineCounts } = require('./e123AgentTree/agentTreeFilters');

async function getLatestAgentTreeExport(instanceId) {
  if (!instanceId) return null;
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT TOP 1 ExportId, InstanceId, RootBrokerId, RootLabel, SourceFormat,
             FileName, NodeCount, CreatedUtc
      FROM oe.MigrationE123AgentTreeExport
      WHERE InstanceId = @instanceId
      ORDER BY CreatedUtc DESC
    `);
  return result.recordset?.[0] || null;
}

async function loadExcludedAgentIds(exportId, pool = null, orgBrokerId = null) {
  const db = pool || await getPool();
  const result = await db.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);
  return computeExcludedAgentIds(result.recordset || [], { orgBrokerId });
}

async function countImportableNodes(exportId, pool = null, { parentAgentId = null, orgBrokerId = null } = {}) {
  const db = pool || await getPool();
  const result = await db.request()
    .input('exportId', sql.UniqueIdentifier, exportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);
  const rows = result.recordset || [];
  const excluded = computeExcludedAgentIds(rows, { orgBrokerId });
  const importable = rows.filter((row) => !excluded.has(Number(row.AgentId)));
  if (parentAgentId != null) {
    const parentId = Number(parentAgentId);
    return importable.filter((row) => Number(row.ParentAgentId) === parentId).length;
  }
  return importable.length;
}

async function getAgentTreeStatus(instanceId) {
  if (!instanceId) {
    return {
      configured: false,
      instanceId: null,
      latestExport: null,
      nodeCount: 0
    };
  }

  const latestExport = await getLatestAgentTreeExport(instanceId);
  if (!latestExport) {
    return {
      configured: false,
      instanceId,
      latestExport: null,
      nodeCount: 0
    };
  }

  const pool = await getPool();
  const nodeCount = await countImportableNodes(latestExport.ExportId, pool, {
    orgBrokerId: latestExport.RootBrokerId
  });

  return {
    configured: true,
    instanceId,
    latestExport: {
      exportId: latestExport.ExportId,
      instanceId: latestExport.InstanceId,
      rootBrokerId: latestExport.RootBrokerId,
      rootLabel: latestExport.RootLabel,
      sourceFormat: latestExport.SourceFormat,
      fileName: latestExport.FileName,
      nodeCount: latestExport.NodeCount,
      createdUtc: latestExport.CreatedUtc
    },
    nodeCount
  };
}

async function loadExportContext(instanceId) {
  const latest = await getLatestAgentTreeExport(instanceId);
  if (!latest) return null;
  return {
    exportId: latest.ExportId,
    instanceId: latest.InstanceId,
    rootBrokerId: latest.RootBrokerId,
    rootLabel: latest.RootLabel
  };
}

function mapNodeRow(row, labelById = new Map()) {
  const agentId = Number(row.AgentId);
  const parentAgentId = row.ParentAgentId != null ? Number(row.ParentAgentId) : null;
  return {
    agentId,
    parentAgentId,
    label: row.Label || labelById.get(agentId) || `Broker ${agentId}`,
    parentLabel: parentAgentId != null ? (labelById.get(parentAgentId) || null) : null,
    depth: Number(row.Depth) || 0,
    sortOrder: Number(row.SortOrder) || 0,
    childCount: Number(row.ChildCount) || 0,
    isGroup: row.IsGroup == null ? null : !!row.IsGroup,
    hasChildren: (Number(row.ChildCount) || 0) > 0
  };
}

async function listAgentTreeChildren(instanceId, parentAgentId = null) {
  const ctx = await loadExportContext(instanceId);
  if (!ctx) return { nodes: [], rootBrokerId: null, rootLabel: null };

  const pool = await getPool();
  const effectiveParent = parentAgentId != null ? Number(parentAgentId) : ctx.rootBrokerId;
  const result = await pool.request()
    .input('exportId', sql.UniqueIdentifier, ctx.exportId)
    .input('parentAgentId', sql.Int, effectiveParent)
    .query(`
      SELECT AgentId, ParentAgentId, Label, Depth, SortOrder, ChildCount, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
        AND (
          (@parentAgentId IS NULL AND Depth = 1)
          OR ParentAgentId = @parentAgentId
        )
      ORDER BY SortOrder, Label, AgentId
    `);

  const labelResult = await pool.request()
    .input('exportId', sql.UniqueIdentifier, ctx.exportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);
  const labelById = new Map((labelResult.recordset || []).map((row) => [Number(row.AgentId), row.Label]));
  const excluded = await loadExcludedAgentIds(ctx.exportId, pool, ctx.rootBrokerId);
  const importableRows = (labelResult.recordset || []).filter((row) => !excluded.has(Number(row.AgentId)));
  const { directCounts, totalCounts } = computeDownlineCounts(importableRows);

  const nodes = (result.recordset || [])
    .map((row) => {
      const node = mapNodeRow(row, labelById);
      node.childCount = directCounts.get(node.agentId) || 0;
      node.totalDownlineCount = totalCounts.get(node.agentId) || 0;
      node.hasChildren = node.childCount > 0;
      return node;
    })
    .filter((node) => !excluded.has(node.agentId));

  return {
    rootBrokerId: ctx.rootBrokerId,
    rootLabel: ctx.rootLabel,
    parentAgentId: effectiveParent,
    nodes
  };
}

async function searchAgentTreeNodes(instanceId, { search = '', limit = 100, topLevelOnly = false } = {}) {
  const ctx = await loadExportContext(instanceId);
  if (!ctx) {
    return { agents: [], totalCount: 0, source: 'agent_tree', topLevelOnly: !!topLevelOnly };
  }

  const trimmed = String(search || '').trim();
  const pool = await getPool();
  const request = pool.request()
    .input('exportId', sql.UniqueIdentifier, ctx.exportId)
    .input('limit', sql.Int, Math.min(Math.max(Number(limit) || 100, 1), 500));

  let whereSql = 'n.ExportId = @exportId';
  if (topLevelOnly) {
    whereSql += ' AND n.ParentAgentId = @rootBrokerId';
    request.input('rootBrokerId', sql.Int, ctx.rootBrokerId);
  }
  if (trimmed) {
    request.input('search', sql.NVarChar, `%${trimmed}%`);
    request.input('searchExact', sql.NVarChar, trimmed);
    whereSql += ` AND (
      n.Label LIKE @search
      OR CAST(n.AgentId AS NVARCHAR(20)) LIKE @search
      OR CAST(n.AgentId AS NVARCHAR(20)) = @searchExact
    )`;
  }

  const result = await request.query(`
    SELECT TOP (@limit)
      n.AgentId,
      n.ParentAgentId,
      n.Label,
      n.Depth,
      n.SortOrder,
      n.ChildCount,
      n.IsGroup,
      p.Label AS ParentLabel
    FROM oe.MigrationE123AgentNode n
    LEFT JOIN oe.MigrationE123AgentNode p
      ON p.ExportId = n.ExportId AND p.AgentId = n.ParentAgentId
    WHERE ${whereSql}
    ORDER BY n.Depth, n.SortOrder, n.Label, n.AgentId
  `);

  const excluded = await loadExcludedAgentIds(ctx.exportId, pool, ctx.rootBrokerId);
  const allNodesResult = await pool.request()
    .input('exportId', sql.UniqueIdentifier, ctx.exportId)
    .query(`
      SELECT AgentId, ParentAgentId, Label, IsGroup
      FROM oe.MigrationE123AgentNode
      WHERE ExportId = @exportId
    `);
  const importableRows = (allNodesResult.recordset || []).filter((row) => !excluded.has(Number(row.AgentId)));
  const { directCounts, totalCounts } = computeDownlineCounts(importableRows);

  const agents = (result.recordset || [])
    .filter((row) => !excluded.has(Number(row.AgentId)))
    .map((row) => ({
      rootBrokerId: Number(row.AgentId),
      rootAgentLabel: row.Label,
      label: row.Label,
      parentLabel: row.ParentLabel || null,
      parentBrokerId: row.ParentAgentId != null ? Number(row.ParentAgentId) : null,
      includeDownline: true,
      depth: Number(row.Depth) || 0,
      childCount: directCounts.get(Number(row.AgentId)) || 0,
      totalDownlineCount: totalCounts.get(Number(row.AgentId)) || 0
    }));

  const totalCount = topLevelOnly
    ? await countImportableNodes(ctx.exportId, pool, { parentAgentId: ctx.rootBrokerId, orgBrokerId: ctx.rootBrokerId })
    : await countImportableNodes(ctx.exportId, pool, { orgBrokerId: ctx.rootBrokerId });

  return {
    agents,
    totalCount,
    source: 'agent_tree',
    topLevelOnly: !!topLevelOnly
  };
}

async function importAgentTreeFromUpload({ file, instanceId, uploadedBy = null }) {
  if (!instanceId) {
    const err = new Error('Migration instance is required to import an agent tree');
    err.code = 'E123_AGENT_TREE_NO_INSTANCE';
    throw err;
  }
  if (!file?.buffer?.length) {
    const err = new Error('Agent tree file is required');
    err.code = 'E123_AGENT_TREE_NO_FILE';
    throw err;
  }

  const parsed = parseAgentTreeUpload({
    buffer: file.buffer,
    originalname: file.originalname
  });

  const exportId = uuidv4();
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    await transaction.request()
      .input('instanceId', sql.UniqueIdentifier, instanceId)
      .query(`
        DELETE FROM oe.MigrationE123AgentTreeExport
        WHERE InstanceId = @instanceId
      `);

    await transaction.request()
      .input('exportId', sql.UniqueIdentifier, exportId)
      .input('instanceId', sql.UniqueIdentifier, instanceId)
      .input('rootBrokerId', sql.Int, parsed.rootBrokerId)
      .input('rootLabel', sql.NVarChar, parsed.rootLabel || null)
      .input('sourceFormat', sql.NVarChar, parsed.sourceFormat || null)
      .input('fileName', sql.NVarChar, parsed.fileName || file.originalname || null)
      .input('nodeCount', sql.Int, parsed.nodes.length)
      .input('uploadedBy', sql.UniqueIdentifier, uploadedBy || null)
      .query(`
        INSERT INTO oe.MigrationE123AgentTreeExport
          (ExportId, InstanceId, RootBrokerId, RootLabel, SourceFormat, FileName, NodeCount, UploadedBy)
        VALUES
          (@exportId, @instanceId, @rootBrokerId, @rootLabel, @sourceFormat, @fileName, @nodeCount, @uploadedBy)
      `);

    for (const node of parsed.nodes) {
      await transaction.request()
        .input('nodeId', sql.UniqueIdentifier, uuidv4())
        .input('exportId', sql.UniqueIdentifier, exportId)
        .input('instanceId', sql.UniqueIdentifier, instanceId)
        .input('rootBrokerId', sql.Int, parsed.rootBrokerId)
        .input('agentId', sql.Int, node.agentId)
        .input('parentAgentId', sql.Int, node.parentAgentId ?? null)
        .input('label', sql.NVarChar, node.label || null)
        .input('depth', sql.Int, node.depth ?? 0)
        .input('sortOrder', sql.Int, node.sortOrder ?? 0)
        .input('childCount', sql.Int, node.childCount ?? 0)
        .input('isGroup', sql.Bit, node.isGroup == null ? null : (node.isGroup ? 1 : 0))
        .query(`
          INSERT INTO oe.MigrationE123AgentNode
            (NodeId, ExportId, InstanceId, RootBrokerId, AgentId, ParentAgentId, Label, Depth, SortOrder, ChildCount, IsGroup)
          VALUES
            (@nodeId, @exportId, @instanceId, @rootBrokerId, @agentId, @parentAgentId, @label, @depth, @sortOrder, @childCount, @isGroup)
        `);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }

  return {
    exportId,
    instanceId,
    rootBrokerId: parsed.rootBrokerId,
    rootLabel: parsed.rootLabel,
    sourceFormat: parsed.sourceFormat,
    fileName: parsed.fileName || file.originalname || null,
    nodeCount: parsed.nodes.length
  };
}

module.exports = {
  getAgentTreeStatus,
  getLatestAgentTreeExport,
  listAgentTreeChildren,
  searchAgentTreeNodes,
  importAgentTreeFromUpload
};
