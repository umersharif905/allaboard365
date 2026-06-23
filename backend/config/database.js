// config/database.js - FIXED VERSION - Replace your current file
const sql = require('mssql');
const path = require('path');

// Only load .env file in development - production and qa use Azure App Service environment variables
// Load .env if NODE_ENV is not set (default to development) or explicitly set to 'development'
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
    // Preserve test/dev listen port: override:true would stomp PORT=3101 from run-tests.sh with PORT=3001 from .env
    const preserveTestPort = process.env.OE_TEST_BACKEND_PORT;
    const preservePort = process.env.PORT;
    require('dotenv').config({
        path: path.join(__dirname, '..', '.env'),
        override: true
    });
    if (preserveTestPort) {
        process.env.OE_TEST_BACKEND_PORT = preserveTestPort;
    }
    if (preservePort) {
        process.env.PORT = preservePort;
    }
}

// Debug: Log database configuration (without password) - SHOW ACTUAL VALUES
console.log('🔍 Database Config Check:', {
    DB_USER: process.env.DB_USER || '❌ Missing',
    DB_PASSWORD: process.env.DB_PASSWORD ? '✅ Set' : '❌ Missing',
    DB_SERVER: process.env.DB_SERVER || '❌ Missing',
    DB_NAME: process.env.DB_NAME || '❌ Missing', // Show actual database name
    NODE_ENV: process.env.NODE_ENV || 'not set'
});

// Database configuration for Azure SQL
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, // pvt-sql-server.database.windows.net
    database: process.env.DB_NAME,
    options: {
        encrypt: true, // Required for Azure SQL
        trustServerCertificate: false,
        enableArithAbort: true,
        connectionTimeout: 30000,
        requestTimeout: 60000, // Increased to 60 seconds for long-running operations
    },
    pool: {
        max: 20, // Maximum connections in pool
        min: 0,  // Minimum connections in pool
        idleTimeoutMillis: 30000, // Close connections after 30 seconds of inactivity
        acquireTimeoutMillis: 60000, // Wait up to 60 seconds for a connection
        createTimeoutMillis: 30000,
        destroyTimeoutMillis: 5000,
        reapIntervalMillis: 1000,
        createRetryIntervalMillis: 200
    }
};

let pool = null;
let isConnecting = false;

/**
 * Gets the singleton connection pool, creating it if it doesn't exist.
 * This is the corrected, robust version.
 */
async function getPool() {
    try {
        // If pool exists and is connected, return it
        if (pool && pool.connected) {
            return pool;
        }

        // If another request is already creating the pool, wait for it
        if (isConnecting) {
            while (isConnecting) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (pool && pool.connected) {
                return pool;
            }
        }

        // Clean up a disconnected pool before recreating
        if (pool && !pool.connected) {
            try {
                await pool.close();
            } catch (closeError) {
                console.log('⚠️ Pool close error (ignoring):', closeError.message);
            }
            pool = null;
        }

        isConnecting = true;
        console.log('🔄 Creating new database connection pool...');
        console.log(`   📊 Connecting to database: ${dbConfig.database} on server: ${dbConfig.server}`);
        pool = new sql.ConnectionPool(dbConfig);
        
        // Handle pool errors to prevent unhandled exceptions
        pool.on('error', (err) => {
            console.error('❌ Database pool error:', err);
            pool = null; // Reset pool on error
            isConnecting = false;
        });

        await pool.connect();
        isConnecting = false;
        console.log('✅ Database pool connected successfully');
        
        return pool;
    } catch (error) {
        isConnecting = false;
        console.error('❌ Failed to create database pool:', error);
        pool = null; // Ensure pool is null on failure
        throw new Error(`Database connection failed: ${error.message}`);
    }
}

/**
 * Execute query with automatic connection management
 * @param {string} query - SQL query string
 * @param {object} inputs - Input parameters
 * @returns {Promise} Query result
 */
async function executeQuery(query, inputs = {}) {
    let request = null;
    try {
        const currentPool = await getPool();
        request = currentPool.request();
        
        // Add input parameters
        Object.keys(inputs).forEach(key => {
            request.input(key, inputs[key]);
        });
        
        const result = await request.query(query);
        return result;
    } catch (error) {
        console.error('❌ Query execution error:', error);
        console.error('📝 Query:', query);
        console.error('📊 Inputs:', inputs);
        throw error;
    }
}

/**
 * Execute stored procedure with parameters
 * @param {string} procedureName - Name of stored procedure
 * @param {object} inputs - Input parameters
 * @returns {Promise} Procedure result
 */
async function executeProcedure(procedureName, inputs = {}) {
    let request = null;
    try {
        const currentPool = await getPool();
        request = currentPool.request();
        
        // Add input parameters
        Object.keys(inputs).forEach(key => {
            request.input(key, inputs[key]);
        });
        
        const result = await request.execute(procedureName);
        return result;
    } catch (error) {
        console.error('❌ Procedure execution error:', error);
        console.error('📝 Procedure:', procedureName);
        console.error('📊 Inputs:', inputs);
        throw error;
    }
}

/**
 * Test database connection
 * @returns {Promise<boolean>} Connection status
 */
async function testConnection() {
    try {
        console.log('🔍 Testing database connection...');
        const result = await executeQuery('SELECT 1 as test, GETDATE() as timestamp');
        console.log('✅ Database connection test successful');
        return true;
    } catch (error) {
        console.error('❌ Database connection test failed:', error);
        return false;
    }
}

/**
 * Test database connection
 * @returns {Promise<boolean>} Connection status
 */
async function testDatabase() {
    try {
        await testConnection();
        return true;
    } catch (error) {
        console.error("Database test failed:", error.message);
        return false;
    }
}

/**
 * Close database connection pool
 */
async function closePool() {
    try {
        if (pool && !isConnecting) {
            await pool.close();
            console.log('✅ Database pool closed');
            pool = null;
        }
    } catch (error) {
        console.error('❌ Error closing database pool:', error);
    }
}

/**
 * Get database connection info (for debugging)
 */
function getConnectionInfo() {
    return {
        server: process.env.DB_SERVER,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        poolConnected: pool ? pool.connected : false,
        poolSize: pool ? pool.size : 0,
        poolAvailable: pool ? pool.available : 0,
        poolPending: pool ? pool.pending : 0,
        poolBorrowed: pool ? pool.borrowed : 0,
        isConnecting: isConnecting
    };
}

/**
 * Common SQL data types for parameter binding
 */
const SqlTypes = {
    UniqueIdentifier: sql.UniqueIdentifier,
    NVarChar: sql.NVarChar,
    VarChar: sql.VarChar,
    Char: sql.Char,
    VarBinary: sql.VarBinary,
    Int: sql.Int,
    BigInt: sql.BigInt,
    Bit: sql.Bit,
    Time: sql.Time,
    DateTime2: sql.DateTime2,
    Date: sql.Date,
    Decimal: sql.Decimal,
    Float: sql.Float,
    Text: sql.Text,
    NText: sql.NText
};

/**
 * Utility function to sanitize SQL inputs
 * @param {*} value - Input value to sanitize
 * @returns {*} Sanitized value
 */
function sanitizeInput(value) {
    if (typeof value === 'string') {
        // Remove potential SQL injection characters
        return value.replace(/['"\\;]/g, '');
    }
    return value;
}

/**
 * Build WHERE clause with tenant isolation
 * @param {string} userTenantId - User's tenant ID
 * @param {string[]} userRoles - User's roles array
 * @param {string} tableAlias - Table alias for the query
 * @returns {string} WHERE clause
 */
function buildTenantWhereClause(userTenantId, userRoles, tableAlias = '') {
    const alias = tableAlias ? `${tableAlias}.` : '';
    
    // SysAdmin can see everything
    if (Array.isArray(userRoles) && userRoles.includes('SysAdmin')) {
        return '1=1';
    }
    
    // All other users are restricted to their tenant
    return `${alias}TenantId = '${userTenantId}'`;
}

// Export all functions and types
module.exports = {
    getPool,
    executeQuery,
    executeProcedure,
    testConnection,
    testDatabase,
    closePool,
    getConnectionInfo,
    sanitizeInput,
    buildTenantWhereClause,
    sql: SqlTypes,
    rawSql: sql // For when you need the raw mssql module
};

// Graceful shutdown — do not use process.on('exit', closePool): exit listeners must be synchronous,
// and closePool is async (pool.close() returns a Promise), which can cause unreliable teardown.
let shutdownInProgress = false;
async function shutdownDbPool(signal) {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    try {
        console.log(`\n${signal}: closing database pool...`);
        await closePool();
    } catch (e) {
        console.error('Database pool shutdown error:', e.message);
    } finally {
        process.exit(0);
    }
}
process.on('SIGINT', () => shutdownDbPool('SIGINT'));
process.on('SIGTERM', () => shutdownDbPool('SIGTERM'));