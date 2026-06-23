require('dotenv').config();
const { getPool, sql } = require('../config/database');

async function run() {
  try {
    const pool = await getPool();
    console.log('Connected to DB');
    
    // Check if column exists
    const check = await pool.request().query(`
      SELECT * FROM sys.columns 
      WHERE object_id = OBJECT_ID('oe.NACHAPaymentDetails') 
      AND name = 'ACHAccountId'
    `);
    
    if (check.recordset.length > 0) {
      console.log('Column ACHAccountId already exists.');
      return;
    }

    console.log('Adding column...');
    await pool.request().query(`
      ALTER TABLE oe.NACHAPaymentDetails
      ADD ACHAccountId uniqueidentifier NULL
    `);
    console.log('Column added successfully.');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit();
  }
}

run();

