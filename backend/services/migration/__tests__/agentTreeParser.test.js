'use strict';

const { parseAgentTreeUpload, parseAgentId } = require('../e123AgentTree/agentTreeParser');

describe('agentTreeParser', () => {
  test('parseAgentFullCsv builds parent links and depths', () => {
    const csv = [
      'Parent ID,Agent ID,Label,Group',
      ',775982,Sharewell Partners,1',
      '775982,783390,ShareWELL Partners,1',
      '783390,785508,Steve Schone,0'
    ].join('\n');

    const parsed = parseAgentTreeUpload({
      buffer: Buffer.from(csv, 'utf8'),
      originalname: '1552_Agent_Full.csv'
    });

    expect(parsed.sourceFormat).toBe('agent_full_csv');
    expect(parsed.rootBrokerId).toBe(775982);
    expect(parsed.nodes).toHaveLength(3);
    const steve = parsed.nodes.find((n) => n.agentId === 785508);
    expect(steve.parentAgentId).toBe(783390);
    expect(steve.depth).toBe(2);
    expect(steve.childCount).toBe(0);
  });

  test('parseIndentedHtmlTable extracts ids and hierarchy', () => {
    const html = `
      <table>
        <tr><td>Sharewell Partners 775982</td><td></td><td></td></tr>
        <tr><td></td><td>ShareWELL Partners 783390</td><td></td></tr>
        <tr><td></td><td></td><td>Steve Schone 785508</td></tr>
      </table>
    `;

    const parsed = parseAgentTreeUpload({
      buffer: Buffer.from(html, 'utf8'),
      originalname: '1552_AgentTree.xls'
    });

    expect(parsed.sourceFormat).toBe('agent_tree_xls');
    expect(parsed.rootBrokerId).toBe(775982);
    const steve = parsed.nodes.find((n) => n.agentId === 785508);
    expect(steve.parentAgentId).toBe(783390);
    expect(steve.depth).toBe(2);
  });

  test('parseAgentId handles commas and dollar suffix', () => {
    expect(parseAgentId('785508$')).toBe(785508);
    expect(parseAgentId('785,508')).toBe(785508);
  });

  test('parseIndentedHtmlTable excludes PORTALS and VENDORS branches', () => {
    const html = `
      <table>
        <tr><td>Sharewell Partners 775982</td><td></td><td></td></tr>
        <tr><td></td><td>PORTALS 778694</td><td></td></tr>
        <tr><td></td><td></td><td>Member Portal 778699</td></tr>
        <tr><td></td><td>VENDORS 778695</td><td></td></tr>
        <tr><td></td><td></td><td>Merchant Fee 780686</td></tr>
        <tr><td></td><td>ShareWELL Partners 783390</td><td></td></tr>
        <tr><td></td><td></td><td>Steve Schone 785508</td></tr>
      </table>
    `;

    const parsed = parseAgentTreeUpload({
      buffer: Buffer.from(html, 'utf8'),
      originalname: '1552_AgentTree.xls'
    });

    expect(parsed.nodes.map((n) => n.agentId)).toEqual([775982, 783390, 785508]);
    expect(parsed.nodes.find((n) => n.agentId === 778694)).toBeUndefined();
    expect(parsed.nodes.find((n) => n.agentId === 778695)).toBeUndefined();
  });
});
