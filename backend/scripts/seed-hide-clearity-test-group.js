// Seeds (idempotently) a comprehensive test group named "Hide Clearity Test"
// in the agent@allaboard365.com tenant for manual testing of the
// hide → delete UI overhaul.
//
// Re-run this script any time to wipe the test data and re-seed.
//
//   node backend/scripts/seed-hide-clearity-test-group.js

const path = require('path');
const fs = require('fs');
const sql = require('mssql');
const crypto = require('crypto');

const envText = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const env = {};
envText.split('\n').forEach(line => {
  const m = line.match(/^\s*([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});

const config = {
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  server: env.DB_SERVER,
  database: env.DB_NAME,
  options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
};

// Constants from prior probing
const GROUP_NAME = 'Hide Clearity Test';
const TENANT_ID = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';
const AGENT_USER_ID = '2BF5EB13-5EFA-4366-AD90-A8EF05C32600'; // agent@allaboard365.com
const AGENT_ID      = '576BC108-94B0-49B0-8CF5-07F3B3046306'; // oe.Agents row for the agent
const GROUP_ADMIN_USER_ID = 'C6617BD1-B3A0-46A0-9AFE-9BF8B8348E1C'; // groupadmin@allaboard365.com (Thomas Smith)

// Vendor IDs (for SignedASAAgreements VendorId column)
const VENDOR_TALLTREE = 'C34859BA-1B50-4AE8-9A14-2DC7794886A4'; // Tall Tree Administrators (HIPAA BAA)

// ASA documents used by products in this seed
const DOC_HIPAA_BAA = 'E1FE1E27-2369-412A-B060-10BE22243DE7'; // shared by many MW products
// const DOC_ARM_ASA  = 'E897787D-7777-4CAE-98D4-12F926EA360C';

// Curated product set
//
// Each entry will become a GroupProducts row. `hidden` = soft-deleted at seed time.
const PRODUCTS = [
  // --- Active products with HIPAA BAA ASA (will be SIGNED → no banner row) ---
  { id: 'AA7B7E6C-6350-4148-92F2-1908B8AA445E', name: 'MightyWELL CoPay Basic',  hidden: false },
  { id: '6976233B-60F2-4D44-AE9E-A6885FAC1000', name: 'MightyWELL CoPay Gold',   hidden: false },
  { id: '49FC601D-789D-4D93-A9E5-5D3546BB5DF9', name: 'MightyWELL Dental',      hidden: false },

  // --- Active product with ARM ASA (will be UNSIGNED → 1 banner row, GA can sign) ---
  { id: '85352141-57A6-4138-8277-6CEFF35BDF7E', name: 'Copay MEC (arm)',        hidden: false },

  // --- Active products with NO ASA (one with no enrollments, one with one enrollment) ---
  { id: 'C311D191-A013-4908-B2FB-F8D02B3D034C', name: 'Lyric',                  hidden: false }, // 0 enrollments — clean delete test
  { id: 'F165AF93-8268-448D-9DD6-F02FB338EEAE', name: 'Essential (ShareWELL)',  hidden: false }, // 1 enrollment — "1 member is currently enrolled"

  // --- Pre-deleted products (IsHidden = 1) ---
  { id: '467071D2-FF13-4637-A4A3-FCFF7E898D1E', name: 'MightyWELL Copay Silver', hidden: true }, // 2 enrollments → audit section
  { id: 'BA9B249F-22A3-4151-8717-E503BF9FA916', name: 'MightyWELL Vision',       hidden: true }, // 0 enrollments → invisible
];

const newId = () => crypto.randomUUID().toUpperCase();

async function main() {
  console.log('📍', config.server, '/', config.database);
  const pool = await sql.connect(config);

  // ----- 1. Wipe any existing "Hide Clearity Test" groups in this tenant -----
  console.log('\n[1] Removing any existing "Hide Clearity Test" group(s)…');
  const existing = await pool.request()
    .input('name', sql.NVarChar, GROUP_NAME)
    .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
    .query(`SELECT GroupId FROM oe.Groups WHERE Name = @name AND TenantId = @tenantId`);

  for (const row of existing.recordset) {
    const gid = row.GroupId;
    console.log(`  - deleting group ${gid}…`);
    // Cascade delete in dependency order. Capture User IDs first so we can wipe
    // the orphan Users rows after Members is empty.
    const orphanUsers = await pool.request()
      .input('gid', sql.UniqueIdentifier, gid)
      .query(`SELECT DISTINCT m.UserId FROM oe.Members m WHERE m.GroupId = @gid AND m.UserId IS NOT NULL`);

    await pool.request().input('gid', sql.UniqueIdentifier, gid).query(`
      DELETE FROM oe.Enrollments WHERE MemberId IN (SELECT MemberId FROM oe.Members WHERE GroupId = @gid);
      DELETE FROM oe.Members WHERE GroupId = @gid;
      DELETE FROM oe.SignedASAAgreements WHERE GroupId = @gid;
      DELETE FROM oe.GroupAdmins WHERE GroupId = @gid;
      DELETE FROM oe.GroupProducts WHERE GroupId = @gid;
      DELETE FROM oe.EnrollmentLinkTemplates WHERE GroupId = @gid;
      DELETE FROM oe.Groups WHERE GroupId = @gid;
    `);

    // Drop the orphan Users we created for prior test members (only ones we own
    // — identified by the seed email convention)
    for (const u of orphanUsers.recordset) {
      await pool.request()
        .input('uid', sql.UniqueIdentifier, u.UserId)
        .query(`DELETE FROM oe.Users WHERE UserId = @uid AND Email LIKE '%hideclearity@example.com'`);
    }
  }

  // ----- 2. Create the group -----
  console.log('\n[2] Creating new "Hide Clearity Test" group…');
  const groupId = newId();
  await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
    .input('agentId', sql.UniqueIdentifier, AGENT_ID)
    .input('name', sql.NVarChar, GROUP_NAME)
    .input('createdBy', sql.UniqueIdentifier, AGENT_USER_ID)
    .query(`
      INSERT INTO oe.Groups
        (GroupId, TenantId, AgentId, Name, Status, GroupType,
         CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
         MinimumHirePeriod, OnboardingMarkedComplete,
         ShowEmployeePricingOnTiles, ShowContributionStrategy)
      VALUES
        (@groupId, @tenantId, @agentId, @name, 'Active', 'Standard',
         GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy,
         0, 0, 0, 0)
    `);
  console.log('  ✓ GroupId =', groupId);

  // ----- 3. Tie group admin to the group -----
  console.log('\n[3] Linking group admin (groupadmin@allaboard365.com) to the group…');
  await pool.request()
    .input('id', sql.UniqueIdentifier, newId())
    .input('userId', sql.UniqueIdentifier, GROUP_ADMIN_USER_ID)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      INSERT INTO oe.GroupAdmins (GroupAdminId, UserId, GroupId, Status, AssignedDate, CreatedDate, ModifiedDate)
      VALUES (@id, @userId, @groupId, 'Active', GETUTCDATE(), GETUTCDATE(), GETUTCDATE())
    `);

  // ----- 4. Insert GroupProducts rows -----
  console.log(`\n[4] Inserting ${PRODUCTS.length} GroupProducts rows…`);
  for (const p of PRODUCTS) {
    await pool.request()
      .input('id', sql.UniqueIdentifier, newId())
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('productId', sql.UniqueIdentifier, p.id)
      .input('isHidden', sql.Bit, p.hidden ? 1 : 0)
      .input('createdBy', sql.UniqueIdentifier, AGENT_USER_ID)
      .query(`
        INSERT INTO oe.GroupProducts
          (GroupProductId, GroupId, ProductId, IsActive, IsHidden, CustomSettings,
           CreatedDate, ModifiedDate, CreatedBy, ModifiedBy)
        VALUES
          (@id, @groupId, @productId, 1, @isHidden, NULL,
           GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy)
      `);
    console.log(`  ✓ ${p.hidden ? '[HIDDEN]' : '[active]'} ${p.name}`);
  }

  // ----- 5. Insert 4 test User+Member pairs -----
  // Members.UserId is NOT NULL and FirstName/LastName live on oe.Users — so each
  // test member needs a real User row.
  console.log('\n[5] Inserting 4 test User+Member pairs…');
  const members = [
    { firstName: 'Alice',  lastName: 'TestEnrolled',     email: 'alice.hideclearity@example.com'  },
    { firstName: 'Bob',    lastName: 'TestSilverHidden', email: 'bob.hideclearity@example.com'    },
    { firstName: 'Carol',  lastName: 'TestSilverHidden', email: 'carol.hideclearity@example.com'  },
    { firstName: 'Dave',   lastName: 'TestDental',       email: 'dave.hideclearity@example.com'   },
  ];
  for (const m of members) {
    m.UserId = newId();
    m.MemberId = newId();
    // Each test member is their own one-person household. The roster page
    // rolls up premium / household counts by HouseholdId, so leaving it NULL
    // makes every metric show zero even when enrollments exist.
    m.HouseholdId = newId();

    // Wipe any leftover user with the same email (idempotent re-runs)
    await pool.request()
      .input('email', sql.NVarChar, m.email)
      .query(`DELETE FROM oe.Users WHERE Email = @email`);

    await pool.request()
      .input('userId', sql.UniqueIdentifier, m.UserId)
      .input('email', sql.NVarChar, m.email)
      .input('firstName', sql.NVarChar, m.firstName)
      .input('lastName', sql.NVarChar, m.lastName)
      .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        INSERT INTO oe.Users
          (UserId, Email, FirstName, LastName, UserType, Status, TenantId,
           MfaEnabled, CreatedDate, ModifiedDate)
        VALUES
          (@userId, @email, @firstName, @lastName, 'Member', 'Active', @tenantId,
           0, GETUTCDATE(), GETUTCDATE())
      `);

    await pool.request()
      .input('memberId', sql.UniqueIdentifier, m.MemberId)
      .input('userId', sql.UniqueIdentifier, m.UserId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('tenantId', sql.UniqueIdentifier, TENANT_ID)
      .input('householdId', sql.UniqueIdentifier, m.HouseholdId)
      .query(`
        INSERT INTO oe.Members
          (MemberId, UserId, GroupId, HouseholdId,
           Status, EnrollmentType, Tier, TenantId,
           CreatedDate, ModifiedDate, IsTestData, MemberSequence, RelationshipType)
        VALUES
          (@memberId, @userId, @groupId, @householdId,
           'Active', 'Group', 'EE', @tenantId,
           GETUTCDATE(), GETUTCDATE(), 1, 1, 'P')
      `);
    console.log(`  ✓ ${m.firstName} ${m.lastName} → User ${m.UserId.slice(0,8)}, Member ${m.MemberId.slice(0,8)}, HH ${m.HouseholdId.slice(0,8)}`);
  }

  // ----- 6. Insert active enrollments -----
  console.log('\n[6] Inserting enrollments…');
  const enrollments = [
    // Alice → Essential (visible product, 1 enrollment → "1 member is currently enrolled" delete test)
    { member: members[0], productId: 'F165AF93-8268-448D-9DD6-F02FB338EEAE', status: 'Active' },
    // Bob → Copay Silver (HIDDEN product, contributes to audit section)
    { member: members[1], productId: '467071D2-FF13-4637-A4A3-FCFF7E898D1E', status: 'Active' },
    // Carol → Copay Silver (HIDDEN product, contributes to audit section, 2nd member)
    { member: members[2], productId: '467071D2-FF13-4637-A4A3-FCFF7E898D1E', status: 'Active' },
    // Dave → MightyWELL Dental (visible, 1 enrollment → "1 member" delete test variant on an ASA-product)
    { member: members[3], productId: '49FC601D-789D-4D93-A9E5-5D3546BB5DF9', status: 'Active' },
  ];
  for (const e of enrollments) {
    await pool.request()
      .input('id', sql.UniqueIdentifier, newId())
      .input('memberId', sql.UniqueIdentifier, e.member.MemberId)
      .input('productId', sql.UniqueIdentifier, e.productId)
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('householdId', sql.UniqueIdentifier, e.member.HouseholdId)
      .input('agentId', sql.UniqueIdentifier, AGENT_ID)
      .input('status', sql.NVarChar, e.status)
      .input('createdBy', sql.UniqueIdentifier, AGENT_USER_ID)
      .query(`
        INSERT INTO oe.Enrollments
          (EnrollmentId, MemberId, ProductId, AgentId, Status,
           EffectiveDate, PremiumAmount, PaymentFrequency,
           CreatedDate, ModifiedDate, CreatedBy, ModifiedBy,
           GroupID, HouseholdId, EnrollmentType,
           IncludedPaymentProcessingFeeAmount, IncludedSystemFeeAmount)
        VALUES
          (@id, @memberId, @productId, @agentId, @status,
           CAST(GETUTCDATE() AS date), 100.00, 'Monthly',
           GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy,
           @groupId, @householdId, 'Group',
           0, 0)
      `);
    console.log(`  ✓ ${e.member.firstName} → product ${e.productId.slice(0, 8)} (${e.status})`);
  }

  // ----- 7. Pre-sign HIPAA BAA so the banner only shows ARM ASA -----
  console.log('\n[7] Pre-signing HIPAA BAA (Tall Tree) for the group…');
  await pool.request()
    .input('id', sql.UniqueIdentifier, newId())
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('productId', sql.UniqueIdentifier, '49FC601D-789D-4D93-A9E5-5D3546BB5DF9') // signed against MW Dental
    .input('vendorId', sql.UniqueIdentifier, VENDOR_TALLTREE)
    .input('documentId', sql.UniqueIdentifier, DOC_HIPAA_BAA)
    .input('sigData', sql.NVarChar, JSON.stringify({ type: 'typed', name: 'Thomas Smith' }))
    .query(`
      INSERT INTO oe.SignedASAAgreements
        (SignedAgreementId, GroupId, ProductId, VendorId, DocumentId,
         SignatureData, SignedByEmail, SignedByName, SignedDate,
         Status, CreatedDate, ModifiedDate, EmailSendCount)
      VALUES
        (@id, @groupId, @productId, @vendorId, @documentId,
         @sigData, 'groupadmin@allaboard365.com', 'Thomas Smith', GETUTCDATE(),
         'Completed', GETUTCDATE(), GETUTCDATE(), 0)
    `);
  console.log('  ✓ Signed (HIPAA BAA covers ALL products in this group sharing that doc)');

  // ----- 8. Verify final state -----
  console.log('\n[8] Final state ===');

  const final = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT
        gp.IsHidden,
        p.Name AS ProductName,
        ISNULL(p.RequiredASA, '(no ASA)') AS HasASA,
        (
          SELECT COUNT(*) FROM oe.Enrollments e
          INNER JOIN oe.Members m ON m.MemberId = e.MemberId
          WHERE m.GroupId = @groupId AND e.ProductId = gp.ProductId AND e.Status = 'Active'
        ) AS ActiveEnrollments
      FROM oe.GroupProducts gp
      INNER JOIN oe.Products p ON p.ProductId = gp.ProductId
      WHERE gp.GroupId = @groupId
      ORDER BY gp.IsHidden, p.Name
    `);

  console.log('\nGroupProducts rows:');
  console.table(final.recordset.map(r => ({
    Hidden: r.IsHidden ? 'yes' : 'no',
    Product: r.ProductName,
    ASA: r.HasASA === '(no ASA)' ? 'no' : 'yes',
    ActiveEnrollments: r.ActiveEnrollments,
  })));

  console.log(`\n✅ Done. GroupId = ${groupId}`);
  console.log(`Open in browser as agent@allaboard365.com:`);
  console.log(`  http://localhost:5173/agent/groups/${groupId}#products`);
  console.log(`Open as groupadmin@allaboard365.com (Thomas Smith): the same group should appear in their list.`);

  await sql.close();
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
