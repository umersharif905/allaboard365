'use strict';

const { normalizeAgentRecord } = require('../e123Agent.service');

describe('e123Agent normalizeAgentRecord', () => {
  it('reads uppercase E123 v2 API fields', () => {
    const agent = normalizeAgentRecord({
      ID: 785508,
      LABEL: 'Steve Schone',
      FIRSTNAME: 'Steve',
      LASTNAME: 'Schone',
      PARENT: 775982,
      ACTIVE: 1
    }, 785508);

    expect(agent.id).toBe(785508);
    expect(agent.label).toBe('Steve Schone');
    expect(agent.active).toBe(true);
    expect(agent.parent).toBe(775982);
  });

  it('falls back to first/last name when label missing', () => {
    const agent = normalizeAgentRecord({
      ID: 792550,
      FIRSTNAME: 'Scott',
      LASTNAME: 'Whitesides'
    }, 792550);

    expect(agent.label).toBe('Scott Whitesides');
  });
});
