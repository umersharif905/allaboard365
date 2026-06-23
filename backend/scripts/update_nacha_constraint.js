const { getPool, rawSql: sql } = require('../config/database');

async function updateConstraint() {
  try {
    const pool = await getPool();
    console.log('Connected to DB');

    // 1. Find the constraint name dynamically
    const findConstraintQuery = `
      SELECT name 
      FROM sys.check_constraints 
      WHERE parent_object_id = OBJECT_ID('oe.NACHAPaymentDetails')
      AND parent_column_id = (
          SELECT column_id 
          FROM sys.columns 
          WHERE object_id = OBJECT_ID('oe.NACHAPaymentDetails') 
          AND name = 'RecipientEntityType'
      )
    `;

    const request = pool.request();
    const result = await request.query(findConstraintQuery);
    
    if (result.recordset.length > 0) {
      const constraintName = result.recordset[0].name;
      console.log(`Found existing constraint: ${constraintName}`);
      
      // 2. Drop the existing constraint
      const dropQuery = `ALTER TABLE oe.NACHAPaymentDetails DROP CONSTRAINT ${constraintName}`;
      await request.query(dropQuery);
      console.log(`Dropped constraint: ${constraintName}`);
    } else {
      console.log('No existing constraint found on RecipientEntityType.');
    }

    // 3. Add the new constraint with 'Agency' included
    // Allow: Agent, Agency, Vendor, Tenant, ProductOwner, ProductOverride, Override, System, Unknown
    const addConstraintQuery = `
      ALTER TABLE oe.NACHAPaymentDetails
      ADD CONSTRAINT CK_NACHAPaymentDetails_RecipientEntityType 
      CHECK (RecipientEntityType IN ('Agent', 'Agency', 'Vendor', 'Tenant', 'ProductOwner', 'ProductOverride', 'Override', 'System', 'Unknown'))
    `;
    
    await request.query(addConstraintQuery);
    console.log('Added new constraint CK_NACHAPaymentDetails_RecipientEntityType.');

  } catch (err) {
    console.error('Error updating constraint:', err);
  } finally {
    // We don't need to close the pool explicitly as the script will exit, 
    // but good practice if we were using the pool manager's close.
    process.exit(0);
  }
}

updateConstraint();
