/**
 * Commission Trigger - Azure SQL Trigger Function
 * Monitors oe.Payments table for new payments and creates commissions
 * 
 * This is the entry point for the Azure Function
 */

module.exports = require('../shared/commissionTrigger');

