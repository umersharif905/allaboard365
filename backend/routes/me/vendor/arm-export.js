// ============================================================================
// ARM VENDOR EXPORT API ENDPOINT
// ============================================================================
// This endpoint generates ARM vendor export files for weekly data transmission
// Accessible to SysAdmin and TenantAdmin for generating weekly exports
// ============================================================================

const express = require('express');
const router = express.Router();
const { getPool } = require('../../../config/database');
const sql = require('mssql');
const { authorize } = require('../../../middleware/auth');
const csv = require('csv-stringify/sync'); // You may need to install: npm install csv-stringify

// ============================================================================
// GET /api/me/vendor/arm-export
// ============================================================================
// Generate ARM export CSV file
// Query parameters:
//   - enrollmentDateStart: Start date for enrollment filter (YYYY-MM-DD)
//   - terminationDateStart: Start date for termination filter (YYYY-MM-DD)
//   - format: 'csv' or 'json' (default: 'csv')
// ============================================================================
router.get('/', authorize(['SysAdmin', 'TenantAdmin']), async (req, res) => {
    try {
        const pool = await getPool();
        const {
            enrollmentDateStart,
            terminationDateStart,
            format = 'csv'
        } = req.query;

        // Parse dates or use defaults (last 7 days)
        let enrollmentStart = enrollmentDateStart 
            ? new Date(enrollmentDateStart) 
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        
        let terminationStart = terminationDateStart 
            ? new Date(terminationDateStart) 
            : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Call stored procedure
        const request = pool.request();
        request.input('enrollmentDateStart', sql.Date, enrollmentStart);
        request.input('terminationDateStart', sql.Date, terminationStart);
        request.input('outputFormat', sql.VarChar(10), format.toLowerCase());

        const result = await request.execute('oe.sp_ARM_WeeklyExport');

        if (!result.recordset || result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No data found for the specified date range',
                data: []
            });
        }

        const data = result.recordset;

        if (format.toLowerCase() === 'json') {
            // Return JSON format
            res.json({
                success: true,
                message: 'ARM export data retrieved successfully',
                count: data.length,
                data: data,
                exportDate: new Date().toISOString(),
                dateRange: {
                    enrollmentDateStart: enrollmentStart.toISOString().split('T')[0],
                    terminationDateStart: terminationStart.toISOString().split('T')[0]
                }
            });
        } else {
            // Return CSV format
            // Define CSV headers matching ARM format
            const headers = [
                'Group Number', 'Location Number', 'Employee Or Dependent',
                'Employee SSN', 'Dependent SSN', 'Restrict SSN', 'Alternate ID',
                'Restricted Employee', 'Last Name', 'First Name', 'Middle Initial',
                'Name Suffix', 'Gender', 'Employee Date Of Birth', 'Dependent Date Of Birth',
                'Age Independent', 'Date Of Hire', 'Enrollment Date', 'Termination Date',
                'Eligibility Change Effective Date', '1st Address Line', '2nd Address Line',
                'International Address Flag', 'City', 'State', 'Zip Code', 'Country',
                'Country Code', 'Language', 'Home Phone', 'Work Phone', 'Cell Phone',
                'Fax Number', 'Email', 'Retiree', 'Disability Employee', 'COBRA Employee',
                'Dependent Life Coverage', 'Marriage Status', 'Marriage Date',
                'Relationship Code', 'Domestic Partner', 'Medical Eligibility', 'Medical COB',
                'Dental Eligibility', 'Dental COB', 'Vision Eligibility', 'Vision COB',
                'Drug Eligibility', 'Drug COB', 'Miscellaneous Eligibility', 'Miscellaneous COB',
                'Life Eligibility', 'Life COB', 'LTD Eligibility', 'STD Eligibility',
                'Life Volume', 'Supplemental Life Volume', 'A D & D Volume',
                'Supplemental A D & A Volume', 'Salary', 'Spouse Life',
                'Dependent Life Coverage', 'STD Volume', 'LTD Volume',
                'Miscellaneous Volume1', 'Miscellaneous Volume2', 'Miscellaneous Volume3',
                'Miscellaneous Volume4', 'Miscellaneous Volume5', 'Student Status',
                'Student Thru Date', 'New York Region', 'PHI Authorization',
                'EFT Account Type', 'EFT Account Effective Date', 'EFT Account Termination Date',
                'EFT Routing Number', 'EFT Account Number'
            ];

            // Convert data to CSV
            const csvData = csv.stringify(data, {
                header: true,
                columns: headers,
                quoted: true,
                quoted_empty: true
            });

            // Set response headers for CSV download
            const filename = `ARM_Export_${new Date().toISOString().split('T')[0]}.csv`;
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(csvData);
        }

    } catch (error) {
        console.error('❌ Error generating ARM export:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate ARM export',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ============================================================================
// POST /api/me/vendor/arm-export/schedule
// ============================================================================
// Schedule a weekly ARM export (for future implementation with job scheduler)
// ============================================================================
router.post('/schedule', authorize(['SysAdmin']), async (req, res) => {
    try {
        // TODO: Implement job scheduling (e.g., using node-cron or Azure Functions)
        // This would schedule weekly exports and send them to ARM
        
        res.json({
            success: true,
            message: 'ARM export scheduling not yet implemented',
            note: 'Use GET /api/me/vendor/arm-export to generate exports manually'
        });
    } catch (error) {
        console.error('❌ Error scheduling ARM export:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to schedule ARM export',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

module.exports = router;
