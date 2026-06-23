#!/usr/bin/env node
/**
 * Cancel a DIME recurring payment schedule by group and schedule ID.
 * Usage: node cancel-dime-schedule.js <groupId> <scheduleId>
 * Example: node cancel-dime-schedule.js 27335A80-6CB1-441E-AFE9-AE6C8B73745C 25
 */

const path = require('path');
const fs = require('fs');

// Load local.settings.json into process.env (same as Azure Functions)
const settingsPath = path.join(__dirname, 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (settings.Values) {
    Object.keys(settings.Values).forEach((k) => {
      process.env[k] = settings.Values[k];
    });
  }
}

const getPool = require('./shared/db').getPool;
const DimeService = require('./shared/dimeService');
const sql = require('mssql');

async function main() {
  const groupId = process.argv[2];
  const scheduleId = process.argv[3];

  if (!groupId || !scheduleId) {
    console.error('Usage: node cancel-dime-schedule.js <groupId> <scheduleId>');
    console.error('Example: node cancel-dime-schedule.js 27335A80-6CB1-441E-AFE9-AE6C8B73745C 25');
    process.exit(1);
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query('SELECT TenantId, Name AS GroupName FROM oe.Groups WHERE GroupId = @groupId');

  if (!result.recordset || result.recordset.length === 0) {
    console.error('Group not found:', groupId);
    process.exit(1);
  }

  const tenantId = result.recordset[0].TenantId;
  const groupName = result.recordset[0].GroupName;
  console.log('Cancelling DIME schedule', scheduleId, 'for group', groupName, '(' + groupId + ')');

  const cancelResult = await DimeService.cancelRecurringPayment(String(scheduleId), tenantId);
  console.log('Result:', cancelResult.message, cancelResult.wasAlreadyCanceled ? '(already canceled)' : '');
  await pool.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
