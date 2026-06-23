const fs = require('fs');
const path = require('path');
const sql = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'mssql'));
require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'dotenv'))
  .config({ path: path.resolve(__dirname, '..', 'backend', '.env') });

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--email') out.email = argv[++i];
    else if (a === '--outdir') out.outdir = argv[++i];
  }
  return out;
}

function escStr(v) {
  return String(v).replace(/'/g, "''");
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `CAST('${v.toISOString()}' AS datetime2)`;
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;

  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return `CAST('${escStr(s)}' AS datetime2)`;
  return `N'${escStr(s)}'`;
}

async function getColumns(pool, schema, table) {
  const res = await pool.request()
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table)
    .query(`
      SELECT c.name AS ColumnName,
             c.column_id AS ColumnId,
             c.is_identity AS IsIdentity
      FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = @schema AND t.name = @table
      ORDER BY c.column_id;
    `);
  return res.recordset;
}

function renderDelete(schema, table, whereSql) {
  return `DELETE FROM ${schema}.${table}\nWHERE ${whereSql};\nGO\n`;
}

function renderInsert(schema, table, cols, rows) {
  if (!rows.length) return `-- No rows to restore for ${schema}.${table}\nGO\n`;

  const colList = cols.map(c => `[${c}]`).join(', ');
  const values = rows.map(r => `(${cols.map(c => sqlLiteral(r[c])).join(', ')})`).join(',\n');
  return `INSERT INTO ${schema}.${table} (${colList})\nVALUES\n${values};\nGO\n`;
}

async function main() {
  const { email, outdir = '.' } = parseArgs(process.argv);
  if (!email) {
    console.error('Missing required --email argument');
    process.exit(1);
  }

  const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
  };

  let pool;
  try {
    pool = await sql.connect(config);

    const agentRes = await pool.request()
      .input('email', sql.NVarChar(255), email)
      .query(`
        SELECT TOP 1 a.AgentId, a.TenantId, a.Status, u.Email
        FROM oe.Users u
        JOIN oe.Agents a ON a.UserId = u.UserId
        WHERE LOWER(u.Email) = LOWER(@email);
      `);

    if (!agentRes.recordset.length) {
      throw new Error(`No agent found for email: ${email}`);
    }

    const ctx = agentRes.recordset[0];
    const agentId = ctx.AgentId;
    const packageId = 'pkg-mw-001';

    const tableDefs = [
      {
        schema: 'oe', table: 'TrainingCompletions',
        where: `AgentId = '${escStr(agentId)}'`
      },
      {
        schema: 'oe', table: 'AgentTrainingLibraryModuleCompletions',
        where: `AgentId = '${escStr(agentId)}'`
      },
      {
        schema: 'oe', table: 'AgentTrainingLibraryQuizCompletions',
        where: `AgentId = '${escStr(agentId)}'`
      },
      {
        schema: 'oe', table: 'AgentTrainingPackageCertificateAwards',
        where: `AgentId = '${escStr(agentId)}'`
      }
    ];

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeEmail = email.replace(/[^a-zA-Z0-9]/g, '_');
    const outPath = path.resolve(outdir, `undo_${safeEmail}_${stamp}.sql`);

    let sqlOut = '';
    sqlOut += `-- Undo script generated ${new Date().toISOString()}\n`;
    sqlOut += `-- DB: ${process.env.DB_NAME} @ ${process.env.DB_SERVER}\n`;
    sqlOut += `-- Target email: ${email}\n`;
    sqlOut += `-- AgentId: ${agentId}\n`;
    sqlOut += `SET NOCOUNT ON;\nGO\n`;

    for (const t of tableDefs) {
      const colsMeta = await getColumns(pool, t.schema, t.table);
      const cols = colsMeta.map(c => c.ColumnName);
      const hasIdentity = colsMeta.some(c => c.IsIdentity);

      const rowRes = await pool.request().query(
        `SELECT * FROM ${t.schema}.${t.table} WHERE ${t.where};`
      );
      const rows = rowRes.recordset;

      sqlOut += `\n-- Restore ${t.schema}.${t.table} (${rows.length} row(s))\n`;
      sqlOut += renderDelete(t.schema, t.table, t.where);
      if (hasIdentity) {
        sqlOut += `SET IDENTITY_INSERT ${t.schema}.${t.table} ON;\nGO\n`;
      }
      sqlOut += renderInsert(t.schema, t.table, cols, rows);
      if (hasIdentity) {
        sqlOut += `SET IDENTITY_INSERT ${t.schema}.${t.table} OFF;\nGO\n`;
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, sqlOut, 'utf8');

    console.log(JSON.stringify({
      message: 'Undo SQL generated',
      output: outPath,
      email,
      agentId,
      db: process.env.DB_NAME,
      server: process.env.DB_SERVER
    }, null, 2));
  } finally {
    if (pool) await pool.close();
  }
}

main().catch(err => {
  console.error('UNDO_GEN_ERROR:', err.message);
  process.exit(1);
});
