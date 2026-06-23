const fs = require('fs');
const path = require('path');

describe('agent GET /:groupId — settings columns in SELECT', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'groups.js'),
    'utf8'
  );

  // Settings consumed by GroupSettingsTab.tsx (currentSettings prop) and
  // GroupMembersTab.tsx must round-trip through this endpoint when an Agent
  // views the group; otherwise the UI silently falls back to defaults.
  const requiredColumns = [
    'AllowMidMonthEffective',
    'AllowPlanModifications',
    'MinimumHirePeriod',
    'EarliestEffectiveDate',
    'SetupStatus',
  ];

  it.each(requiredColumns)('SELECT references g.%s', (col) => {
    expect(source).toMatch(new RegExp(`g\\.${col}\\b`));
  });
});
