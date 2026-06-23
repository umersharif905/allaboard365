#!/usr/bin/env node
/**
 * Approve Marie Kamm's agent account: set Status = 'Active' in oe.Agents (and oe.Users if needed).
 * Run from repo root: node ai_scripts/approve-marie-agent.cjs
 * Uses backend .env for DB connection (requires write access).
 */
const path = require('path');
const fs = require('fs');

const backendEnvPath = path.join(__dirname, '..', 'backend', '.env');
if (fs.existsSync(backendEnvPath)) {
  const envContent = fs.readFileSync(backendEnvPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        process.env[key] = val;
      }
    }
  });
}

const sql = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
};

const MARIE_AGENT_ID = '43836E91-2DF5-41F9-A5E3-EFA3D5E584EE';

async function run() {
  try {
    await sql.connect(config);
    const pool = await sql.connect(config);

    // 1) Get current agent and user
    const before = await pool.request()
      .input('AgentId', sql.UniqueIdentifier, MARIE_AGENT_ID)
      .query(`
        SELECT a.AgentId, a.UserId, a.Status AS AgentStatus, a.AgencyId,
               u.Email, u.FirstName, u.LastName, u.Status AS UserStatus
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @AgentId
      `);

    if (before.recordset.length === 0) {
      console.log('Agent not found for AgentId:', MARIE_AGENT_ID);
      await sql.close();
      process.exit(1);
    }

    const row = before.recordset[0];
    const userId = row.UserId;
    console.log('Before:');
    console.log('  Agent:', row.FirstName, row.LastName, row.Email);
    console.log('  Agent Status:', row.AgentStatus);
    console.log('  User Status:', row.UserStatus);
    console.log('');

    // 2) Update oe.Agents SET Status = 'Active'
    const updateAgent = await pool.request()
      .input('AgentId', sql.UniqueIdentifier, MARIE_AGENT_ID)
      .query(`
        UPDATE oe.Agents
        SET Status = 'Active'
        WHERE AgentId = @AgentId
      `);
    console.log('Updated oe.Agents: Status = Active (rows affected:', updateAgent.rowsAffected[0], ')');

    // 3) Update oe.Users SET Status = 'Active' if column exists and is not already Active
    try {
      const updateUser = await pool.request()
        .input('UserId', sql.UniqueIdentifier, userId)
        .query(`
          UPDATE oe.Users
          SET Status = 'Active'
          WHERE UserId = @UserId AND (Status IS NULL OR Status != 'Active')
        `);
      if (updateUser.rowsAffected[0] > 0) {
        console.log('Updated oe.Users: Status = Active (rows affected:', updateUser.rowsAffected[0], ')');
      } else {
        console.log('oe.Users: no change (already Active or no Status column)');
      }
    } catch (e) {
      if (e.message && e.message.includes('Status')) {
        console.log('oe.Users: Status column not found or not updated, skipping');
      } else {
        throw e;
      }
    }

    // 4) Verify
    const after = await pool.request()
      .input('AgentId', sql.UniqueIdentifier, MARIE_AGENT_ID)
      .query(`
        SELECT a.AgentId, a.Status AS AgentStatus, u.Email, u.FirstName, u.LastName
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @AgentId
      `);
    const afterRow = after.recordset[0];
    console.log('');
    console.log('After:');
    console.log('  Agent:', afterRow.FirstName, afterRow.LastName, afterRow.Email);
    console.log('  Agent Status:', afterRow.AgentStatus);
    console.log('');
    console.log('Marie Kamm\'s account is approved (Status = Active). She should now appear as a qualified agent for Alioup.');
    await sql.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
