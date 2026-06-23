'use strict';

const {
  classifyEmployerGroupRow,
  getEmployerGroupExclusionMessage,
  getGroupMigrationExclusionMessage
} = require('../migration/e123GroupFilters');

describe('classifyEmployerGroupRow', () => {
  test('includes real employer group with members', () => {
    expect(classifyEmployerGroupRow({
      label: 'CPL LLC',
      memberCount: 25,
      bgroup: 1,
      bgrouplistbill: 1
    })).toEqual({ include: true, reason: 'employer_group' });
  });

  test('excludes Copy Over buckets', () => {
    expect(classifyEmployerGroupRow({
      label: 'Ideal Health Copy Over',
      memberCount: 54
    })).toEqual({ include: false, reason: 'copy_over_bucket' });
  });

  test('excludes org placeholders', () => {
    expect(classifyEmployerGroupRow({
      label: 'Sharewell Partners',
      memberCount: 0
    })).toEqual({ include: false, reason: 'org_placeholder' });
  });

  test('excludes zero-member groups', () => {
    expect(classifyEmployerGroupRow({
      label: 'Panel Swap LLC',
      memberCount: 0
    })).toEqual({ include: false, reason: 'zero_members' });
  });

  test('excludes selling agents when bgroup flags are known', () => {
    expect(classifyEmployerGroupRow({
      label: 'Steve Schone',
      memberCount: 5,
      bgroup: 0,
      bgrouplistbill: 0
    })).toEqual({ include: false, reason: 'selling_agent_not_listbill' });
  });

  test('skips bgroup check when flags are null (View Groups CSV only)', () => {
    expect(classifyEmployerGroupRow({
      label: 'CPL LLC',
      memberCount: 10,
      bgroup: null,
      bgrouplistbill: null
    })).toEqual({ include: true, reason: 'employer_group' });
  });
});

describe('exclusion messages', () => {
  test('maps known reasons to user-facing copy', () => {
    expect(getEmployerGroupExclusionMessage('copy_over_bucket')).toMatch(/Copy Over/);
    expect(getGroupMigrationExclusionMessage('agent_unmapped')).toMatch(/Agent not mapped/);
  });
});
