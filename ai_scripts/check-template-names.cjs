const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER || 'oe-sql-srvr.database.windows.net',
  database: process.env.DB_NAME || 'open-enroll-dev',
  user: process.env.DB_USER || 'oe-sqladmin',
  password: process.env.DB_PASSWORD || 'PT$r8u7G21@$',
  options: {
    encrypt: true,
    trustServerCertificate: false
  }
};

async function checkTemplateNames() {
  try {
    console.log('🔍 Connecting to database...');
    await sql.connect(config);
    console.log('✅ Connected successfully');
    
    const query = `
      SELECT TOP 20 
        TemplateId, 
        TemplateName,
        LEN(TemplateName) as NameLength,
        RIGHT(TemplateName, 5) as Last5Chars
      FROM oe.EnrollmentLinkTemplates 
      WHERE TemplateName LIKE '%0' OR TemplateName LIKE '%00'
      ORDER BY TemplateName
    `;
    
    console.log('📊 Executing query...');
    const result = await sql.query(query);
    
    console.log('\n📋 Template Names with 0 or 00:');
    console.log('='.repeat(80));
    result.recordset.forEach((row, index) => {
      console.log(`${index + 1}. "${row.TemplateName}" (Length: ${row.NameLength}, Last 5: "${row.Last5Chars}")`);
    });
    
    console.log('\n📊 Total records:', result.recordset.length);
    
    await sql.close();
    console.log('✅ Connection closed');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkTemplateNames();
