#!/usr/bin/env node
'use strict';

/**
 * Execute a sql-changes/*.sql migration against the configured DB (backend/.env →
 * prod RW). The migration files default to `DECLARE @DryRun BIT = 1;` (preview +
 * rollback). Without --apply this runs them as-is (dry run). With --apply the
 * runner flips that single line to `= 0` so the real change commits.
 *
 * Usage:
 *   node scripts/apply-sql-change.cjs ../sql-changes/<file>.sql            # dry run
 *   node scripts/apply-sql-change.cjs ../sql-changes/<file>.sql --apply    # commit
 */

const fs = require('fs');
const path = require('path');
const mssql = require('mssql');

const ENV_PATH = path.join(__dirname, '../.env');
// Parse .env WITHOUT mutating process.env so we can pick the DB explicitly and
// avoid config/database.js's `override:true` (which pins DB_NAME from .env).
const ENV = require('dotenv').parse(fs.readFileSync(ENV_PATH, 'utf8'));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function buildPool(dbName) {
  const config = {
    user: ENV.DB_USER,
    password: ENV.DB_PASSWORD,
    server: ENV.DB_SERVER,
    database: dbName,
    options: { encrypt: true, trustServerCertificate: false, requestTimeout: 60000 }
  };
  return mssql.connect(config);
}

async function main() {
  const fileArg = process.argv[2];
  const apply = process.argv.includes('--apply');
  // Target DB defaults to whatever .env points at; --db lets us force prod
  // regardless of how .env is currently set (e.g. when it's on testing).
  const dbName = arg('--db') || ENV.DB_NAME;
  if (!fileArg) {
    console.error('Usage: node scripts/apply-sql-change.cjs <path-to-sql> [--db <database>] [--apply]');
    process.exit(1);
  }
  const filePath = path.resolve(process.cwd(), fileArg);
  let sqlText = fs.readFileSync(filePath, 'utf8');

  if (apply) {
    const before = sqlText;
    sqlText = sqlText.replace(/DECLARE\s+@DryRun\s+BIT\s*=\s*1\s*;/i, 'DECLARE @DryRun BIT = 0;');
    if (sqlText === before) {
      console.error('❌ --apply given but could not find `DECLARE @DryRun BIT = 1;` to flip. Aborting.');
      process.exit(1);
    }
    console.log('⚠️  APPLY MODE: @DryRun set to 0 — changes WILL commit.');
  } else {
    console.log('🔎 DRY RUN: executing migration as-is (@DryRun = 1).');
  }

  console.log(`📄 ${filePath}`);
  console.log(`🎯 target DB: ${ENV.DB_SERVER} / ${dbName}\n`);
  const pool = await buildPool(dbName);
  const result = await pool.request().batch(sqlText);

  const sets = result.recordsets || [];
  if (!sets.length) {
    console.log('(no result sets)');
  } else {
    sets.forEach((rs, i) => {
      console.log(`--- result set ${i + 1} (${rs.length} row(s)) ---`);
      console.log(JSON.stringify(rs, null, 2));
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('apply-sql-change failed:', e.message || e); process.exit(1); });
