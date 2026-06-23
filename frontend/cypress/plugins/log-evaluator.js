// Cypress plugin to evaluate backend logs
const fs = require('fs');
const path = require('path');

module.exports = (on, config) => {
  // Task to read backend logs
  on('task', {
    readBackendLogs() {
      const logFile = path.join(__dirname, '../../backend-logs.json');
      try {
        if (fs.existsSync(logFile)) {
          const logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
          return logs;
        }
        return [];
      } catch (error) {
        console.error('Failed to read backend logs:', error);
        return [];
      }
    },

    clearBackendLogs() {
      const logFile = path.join(__dirname, '../../backend-logs.json');
      try {
        if (fs.existsSync(logFile)) {
          fs.writeFileSync(logFile, '[]');
        }
        return null;
      } catch (error) {
        console.error('Failed to clear backend logs:', error);
        return null;
      }
    },

    evaluateBackendLogs() {
      const logFile = path.join(__dirname, '../../backend-logs.json');
      try {
        if (fs.existsSync(logFile)) {
          const logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
          
          const evaluation = {
            totalLogs: logs.length,
            errors: logs.filter(log => log.level === 'ERROR' || log.message.includes('❌')),
            successes: logs.filter(log => log.level === 'SUCCESS' || log.message.includes('✅')),
            warnings: logs.filter(log => log.level === 'WARN' || log.message.includes('⚠️')),
            hasErrors: logs.some(log => log.level === 'ERROR' || log.message.includes('❌')),
            hasSuccesses: logs.some(log => log.level === 'SUCCESS' || log.message.includes('✅')),
            recentLogs: logs.slice(-10) // Last 10 logs
          };
          
          return evaluation;
        }
        return { totalLogs: 0, errors: [], successes: [], warnings: [], hasErrors: false, hasSuccesses: false, recentLogs: [] };
      } catch (error) {
        console.error('Failed to evaluate backend logs:', error);
        return { totalLogs: 0, errors: [], successes: [], warnings: [], hasErrors: false, hasSuccesses: false, recentLogs: [] };
      }
    }
  });
};
