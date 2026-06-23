// messageCenter/TemplateProcessor/index.js - VERSION 6 FINAL
// COMPLETE WORKING VERSION WITH ERROR HANDLING
const sql = require('mssql');

// Database config
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true,
        enableArithAbort: true,
        trustServerCertificate: false
    }
};

// Standard variable mappings
const VARIABLE_MAPPINGS = {
    // From Users table via JOIN
    'member.FirstName': 'FirstName',
    'member.LastName': 'LastName', 
    'member.Email': 'Email',
    'member.Phone': 'Phone',
    
    // From Members table
    'member.Address': 'Address',
    'member.City': 'City',
    'member.State': 'State',
    'member.ZipCode': 'Zip',
    'member.DateOfBirth': 'DateOfBirth',
    'member.MemberNumber': 'MemberNumber',
    'member.EffectiveDate': 'HireDate',
    'member.TerminationDate': 'TerminationDate',
    
    // Computed
    'member.FullName': '_computed_fullname',
    'member.Age': 'Age',
    
    // Tenant variables
    'tenant.Name': 'TenantName',
    'tenant.Phone': 'TenantPhone', 
    'tenant.Email': 'TenantEmail',
    'tenant.Website': 'TenantWebsite',
    
    // System variables
    'system.CurrentDate': '_system_currentdate',
    'system.CurrentYear': '_system_currentyear',
    'system.CurrentMonth': '_system_currentmonth',
    'system.LoginUrl': '_system_loginurl'
};

/**
 * Process scheduled templates every 10 minutes
 */
module.exports = async function (context, myTimer) {
    context.log('TemplateProcessor V6 started');
    
    let pool;
    try {
        pool = await sql.connect(dbConfig);
        context.log('Database connected');
        
        // Get active schedules
        const schedules = await getActiveSchedules(pool, context);
        
        if (schedules.length === 0) {
            context.log('No scheduled messages to process');
            return;
        }
        
        context.log(`Processing ${schedules.length} scheduled messages`);
        
        // Process each schedule with individual error handling
        for (const schedule of schedules) {
            try {
                await processSchedule(pool, schedule, context);
            } catch (scheduleError) {
                // Log error but continue with other schedules
                context.log.error(`Failed to process schedule ${schedule.ScheduleName}:`, scheduleError.message);
            }
        }
        
    } catch (error) {
        context.log.error('TemplateProcessor error:', error);
    } finally {
        if (pool) {
            try {
                await pool.close();
                context.log('Database connection closed');
            } catch (closeError) {
                context.log.error('Error closing database connection:', closeError);
            }
        }
    }
};

async function getActiveSchedules(pool, context) {
    try {
        const result = await pool.request()
            .query(`
                SELECT 
                    sm.ScheduleId,
                    sm.TenantId,
                    sm.ScheduleName,
                    sm.TemplateId,
                    sm.MessageType,
                    sm.RecurrencePattern,
                    sm.RecurrenceTime,
                    sm.LastRunDate,
                    mt.TemplateName,
                    mt.Subject,
                    mt.Body
                FROM oe.ScheduledMessages sm
                INNER JOIN oe.MessageTemplates mt ON mt.TemplateId = sm.TemplateId
                WHERE sm.IsActive = 1
                    AND mt.IsActive = 1
                    AND (
                        -- Daily: Not run today yet
                        (sm.RecurrencePattern = 'Daily' 
                         AND (sm.LastRunDate IS NULL OR DATEDIFF(day, sm.LastRunDate, GETDATE()) >= 1)
                         AND CAST(sm.RecurrenceTime AS TIME) <= CAST(GETDATE() AS TIME))
                        OR
                        -- Weekly: Not run this week yet
                        (sm.RecurrencePattern = 'Weekly' 
                         AND (sm.LastRunDate IS NULL OR DATEDIFF(day, sm.LastRunDate, GETDATE()) >= 7)
                         AND CAST(sm.RecurrenceTime AS TIME) <= CAST(GETDATE() AS TIME))
                        OR
                        -- Monthly: Not run this month yet
                        (sm.RecurrencePattern = 'Monthly' 
                         AND (sm.LastRunDate IS NULL 
                              OR MONTH(sm.LastRunDate) != MONTH(GETDATE()) 
                              OR YEAR(sm.LastRunDate) != YEAR(GETDATE()))
                         AND CAST(sm.RecurrenceTime AS TIME) <= CAST(GETDATE() AS TIME))
                    )
            `);
        
        return result.recordset;
    } catch (error) {
        context.log.error('Error getting active schedules:', error);
        return [];
    }
}

async function processSchedule(pool, schedule, context) {
    context.log(`Processing schedule: ${schedule.ScheduleName}`);
    
    // Get recipients
    const recipients = await getRecipients(pool, schedule, context);
    
    if (recipients.length === 0) {
        context.log(`No recipients found for schedule ${schedule.ScheduleName}`);
        await updateLastRunDate(pool, schedule.ScheduleId);
        return;
    }
    
    context.log(`Found ${recipients.length} recipients`);
    
    // Get tenant info
    const tenantInfo = await getTenantInfo(pool, schedule.TenantId);
    
    // Process each recipient
    let successCount = 0;
    for (const recipient of recipients) {
        try {
            const message = processTemplate(schedule, recipient, tenantInfo, context);
            
            await queueMessage(pool, {
                TenantId: schedule.TenantId,
                RecipientId: recipient.UserId,  // CHANGED FROM recipient.MemberId
                MessageType: schedule.MessageType,
                RecipientAddress: getRecipientAddress(recipient, schedule.MessageType),
                Subject: message.subject,
                Body: message.body
            });
            
            successCount++;
        } catch (error) {
            context.log.error(`Error processing recipient ${recipient.Email}:`, error.message);
        }
    }
    
    // Update last run date
    await updateLastRunDate(pool, schedule.ScheduleId);
    
    context.log(`Successfully queued ${successCount} messages for ${schedule.ScheduleName}`);
}

async function getRecipients(pool, schedule, context) {
    // Base query with JOIN to get user info
    const baseSelect = `
        m.MemberId,
        u.FirstName,
        u.LastName,
        u.Email,
        u.PhoneNumber as Phone,
        m.Address,
        m.City,
        m.State,
        m.Zip,
        m.DateOfBirth,
        m.HouseholdMemberID as MemberNumber,
        m.GroupId,
        m.HireDate,
        m.TerminationDate,
        DATEDIFF(year, m.DateOfBirth, GETDATE()) as Age
    `;
    
    let query = '';
    const templateName = schedule.TemplateName.toLowerCase();
    
    if (templateName.includes('birthday')) {
        query = `
            SELECT ${baseSelect}
            FROM oe.Members m
            INNER JOIN oe.Users u ON u.UserId = m.UserId
            WHERE m.TenantId = @TenantId
                AND m.Status = 'Active'
                AND m.DateOfBirth IS NOT NULL
                AND MONTH(m.DateOfBirth) = MONTH(GETDATE())
                AND DAY(m.DateOfBirth) = DAY(GETDATE())
        `;
    } else if (templateName.includes('welcome')) {
        // Get new members from last 24 hours
        query = `
            SELECT ${baseSelect},
                m.CreatedDate as EnrollmentDate
            FROM oe.Members m
            INNER JOIN oe.Users u ON u.UserId = m.UserId
            WHERE m.TenantId = @TenantId
                AND m.Status = 'Active'
                AND m.CreatedDate >= DATEADD(day, -1, GETDATE())
        `;
    } else {
        // Default - get all active members (limited to 100)
        query = `
            SELECT TOP 100 ${baseSelect}
            FROM oe.Members m
            INNER JOIN oe.Users u ON u.UserId = m.UserId
            WHERE m.TenantId = @TenantId
                AND m.Status = 'Active'
            ORDER BY m.CreatedDate DESC
        `;
    }
    
    const result = await pool.request()
        .input('TenantId', sql.UniqueIdentifier, schedule.TenantId)
        .query(query);
    
    return result.recordset;
}

async function getTenantInfo(pool, tenantId) {
    try {
        const result = await pool.request()
            .input('TenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT 
                    Name as TenantName,
                    ContactPhone as TenantPhone,
                    ContactEmail as TenantEmail,
                    Website as TenantWebsite
                FROM oe.Tenants
                WHERE TenantId = @TenantId
            `);
        
        return result.recordset[0] || {};
    } catch (error) {
        console.error('Error getting tenant info:', error);
        return {};
    }
}

function processTemplate(schedule, recipient, tenantInfo, context) {
    try {
        const data = {
            // Direct fields from query
            ...recipient,
            
            // Computed variables
            _computed_fullname: `${recipient.FirstName || ''} ${recipient.LastName || ''}`.trim(),
            
            // System variables
            _system_currentdate: new Date().toLocaleDateString(),
            _system_currentyear: new Date().getFullYear(),
            _system_currentmonth: new Date().toLocaleDateString('en-US', { month: 'long' }),
            _system_loginurl: 'https://app.allaboard365.com/login',
            
            // Tenant info
            ...tenantInfo
        };
        
        // Process subject and body
        let subject = schedule.Subject || 'Notification';
        subject = replaceVariables(subject, data);
        
        let body = schedule.Body || '';
        body = replaceVariables(body, data);
        
        return { subject, body };
    } catch (error) {
        context.log.error('Template processing error:', error);
        return {
            subject: schedule.Subject || 'Notification',
            body: schedule.Body || ''
        };
    }
}

function replaceVariables(template, data) {
    if (!template) return '';
    
    let processed = template;
    
    // Find all {[variable]} patterns
    const variablePattern = /\{\[([^\]]+)\]\}/g;
    const matches = template.matchAll(variablePattern);
    
    for (const match of matches) {
        const fullMatch = match[0];
        const variableName = match[1];
        
        // Get field name from mapping
        const fieldName = VARIABLE_MAPPINGS[variableName];
        
        if (fieldName && data[fieldName] !== undefined) {
            let value = data[fieldName];
            
            // Format dates
            if (value instanceof Date) {
                value = value.toLocaleDateString();
            } else if (fieldName.includes('Date') && value) {
                try {
                    value = new Date(value).toLocaleDateString();
                } catch (e) {
                    // Keep original if date parsing fails
                }
            }
            
            processed = processed.replace(fullMatch, value || '');
        }
    }
    
    return processed;
}

function getRecipientAddress(recipient, messageType) {
    if (messageType === 'Email') {
        return recipient.Email;
    } else if (messageType === 'SMS') {
        return recipient.Phone;
    }
    return recipient.Email;
}

async function queueMessage(pool, message) {
    await pool.request()
        .input('TenantId', sql.UniqueIdentifier, message.TenantId)
        .input('RecipientId', sql.UniqueIdentifier, message.RecipientId)
        .input('MessageType', sql.NVarChar(20), message.MessageType)
        .input('RecipientAddress', sql.NVarChar(200), message.RecipientAddress)
        .input('Subject', sql.NVarChar(500), message.Subject)
        .input('Body', sql.NVarChar(sql.MAX), message.Body)
        .query(`
            INSERT INTO oe.MessageQueue (
                MessageId,
                TenantId,
                RecipientId,
                MessageType,
                RecipientAddress,
                Subject,
                Body,
                Status,
                RetryCount,
                CreatedDate
            ) VALUES (
                NEWID(),
                @TenantId,
                @RecipientId,
                @MessageType,
                @RecipientAddress,
                @Subject,
                @Body,
                'Pending',
                0,
                GETDATE()
            )
        `);
}

async function updateLastRunDate(pool, scheduleId) {
    await pool.request()
        .input('ScheduleId', sql.UniqueIdentifier, scheduleId)
        .query(`
            UPDATE oe.ScheduledMessages
            SET LastRunDate = GETDATE(),
                ModifiedDate = GETDATE()
            WHERE ScheduleId = @ScheduleId
        `);
}