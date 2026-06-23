// backend/scripts/create-vendor-user.js
// Script to create a vendor user account
const bcrypt = require('bcryptjs');
const sql = require('mssql');
const { getPool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const UserRolesService = require('../services/shared/user-roles.service');

async function createVendorUser() {
  try {
    const pool = await getPool();
    const email = 'vendor@allaboard365.com';
    const password = 'testpass';
    const firstName = 'Vendor';
    const lastName = 'Admin';
    
    console.log('🔍 Checking if user already exists...');
    
    // Check if user already exists
    const checkUserRequest = pool.request();
    checkUserRequest.input('email', sql.NVarChar, email.toLowerCase());
    const userCheck = await checkUserRequest.query(`
      SELECT UserId, VendorId
      FROM oe.Users
      WHERE LOWER(Email) = @email
    `);
    
    if (userCheck.recordset.length > 0) {
      const existingUser = userCheck.recordset[0];
      console.log('⚠️  User already exists:', existingUser.UserId);
      
      // Check if user has VendorId
      if (!existingUser.VendorId) {
        console.log('📝 User exists but has no VendorId. Need to link to a vendor.');
        console.log('   Please manually link this user to a vendor using:');
        console.log(`   UPDATE oe.Users SET VendorId = '<vendor-id>' WHERE UserId = '${existingUser.UserId}'`);
      } else {
        console.log('✅ User already linked to vendor:', existingUser.VendorId);
      }
      
      // Check if user has VendorAdmin role
      const roles = await UserRolesService.getUserRoleNames(existingUser.UserId);
      if (roles.includes('VendorAdmin')) {
        console.log('✅ User already has VendorAdmin role');
      } else {
        console.log('📝 Assigning VendorAdmin role...');
        await UserRolesService.assignRoleToUser(existingUser.UserId, 'VendorAdmin', existingUser.UserId);
        console.log('✅ VendorAdmin role assigned');
      }
      
      return;
    }
    
    console.log('🔍 Finding or creating a vendor...');
    
    // Get first available vendor or create a test vendor
    const vendorRequest = pool.request();
    const vendorResult = await vendorRequest.query(`
      SELECT TOP 1 VendorId, VendorName
      FROM oe.Vendors
      ORDER BY CreatedDate
    `);
    
    let vendorId;
    if (vendorResult.recordset.length > 0) {
      vendorId = vendorResult.recordset[0].VendorId;
      console.log(`✅ Using existing vendor: ${vendorResult.recordset[0].VendorName} (${vendorId})`);
    } else {
      // Create a test vendor
      vendorId = uuidv4();
      const createVendorRequest = pool.request();
      createVendorRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
      createVendorRequest.input('vendorName', sql.NVarChar, 'Test Vendor');
      createVendorRequest.input('email', sql.NVarChar, email);
      
      await createVendorRequest.query(`
        INSERT INTO oe.Vendors (
          VendorId,
          VendorName,
          Email,
          CreatedDate,
          ModifiedDate
        ) VALUES (
          @vendorId,
          @vendorName,
          @email,
          GETDATE(),
          GETDATE()
        )
      `);
      console.log(`✅ Created test vendor: Test Vendor (${vendorId})`);
    }
    
    // Get a tenant ID (required for users)
    const tenantRequest = pool.request();
    const tenantResult = await tenantRequest.query(`
      SELECT TOP 1 TenantId
      FROM oe.Tenants
      ORDER BY CreatedDate
    `);
    
    if (tenantResult.recordset.length === 0) {
      throw new Error('No tenants found in database. Please create a tenant first.');
    }
    
    const tenantId = tenantResult.recordset[0].TenantId;
    console.log(`✅ Using tenant: ${tenantId}`);
    
    // Hash password
    console.log('🔐 Hashing password...');
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    
    // Create user
    const userId = uuidv4();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    
    try {
      const insertRequest = transaction.request();
      insertRequest.input('userId', sql.UniqueIdentifier, userId);
      insertRequest.input('firstName', sql.NVarChar(100), firstName);
      insertRequest.input('lastName', sql.NVarChar(100), lastName);
      insertRequest.input('email', sql.NVarChar(255), email.toLowerCase());
      insertRequest.input('passwordHash', sql.NVarChar(255), passwordHash);
      insertRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
      insertRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      insertRequest.input('status', sql.NVarChar(20), 'Active');
      
      await insertRequest.query(`
        INSERT INTO oe.Users (
          UserId,
          FirstName,
          LastName,
          Email,
          PasswordHash,
          VendorId,
          TenantId,
          Status,
          CreatedDate,
          ModifiedDate
        ) VALUES (
          @userId,
          @firstName,
          @lastName,
          @email,
          @passwordHash,
          @vendorId,
          @tenantId,
          @status,
          GETDATE(),
          GETDATE()
        )
      `);
      
      // Assign VendorAdmin role (outside transaction to avoid timeout)
      await transaction.commit();
      
      console.log('📝 Assigning VendorAdmin role...');
      await UserRolesService.assignRoleToUser(userId, 'VendorAdmin', userId);
      
      console.log('✅ Vendor user created successfully!');
      console.log('');
      console.log('📋 User Details:');
      console.log(`   Email: ${email}`);
      console.log(`   Password: ${password}`);
      console.log(`   UserId: ${userId}`);
      console.log(`   VendorId: ${vendorId}`);
      console.log(`   Role: VendorAdmin`);
      console.log('');
      console.log('✅ You can now login with:');
      console.log(`   Email: ${email}`);
      console.log(`   Password: ${password}`);
      
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error creating vendor user:', error);
    process.exit(1);
  } finally {
    // Close the pool
    const pool = await getPool();
    await pool.close();
    process.exit(0);
  }
}

// Run the script
createVendorUser();

