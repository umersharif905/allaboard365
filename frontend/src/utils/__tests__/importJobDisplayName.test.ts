import { describe, expect, it } from 'vitest';
import { importJobDisplayName } from '../importJobDisplayName';

describe('importJobDisplayName', () => {
  it('prefers jobName', () => {
    expect(importJobDisplayName({
      jobName: 'MPowering · /MBP',
      tenantName: 'ShareWELL Health',
      subFolderPath: '/MBP',
      connectionName: 'Sharewell SFTP',
    })).toBe('MPowering · /MBP');
  });

  it('falls back to tenant and folder without guids', () => {
    expect(importJobDisplayName({
      jobName: '',
      tenantName: 'Align Health',
      subFolderPath: '/ALIGN',
      connectionName: 'Sharewell production SFTP',
    })).toBe('Align Health · /ALIGN');
  });
});
