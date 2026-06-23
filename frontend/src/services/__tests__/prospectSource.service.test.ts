/**
 * @vitest-environment jsdom
 */
// Tests for prospect source service functions.
// The service uses apiService (named export from ./api.service), not apiClient.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../api.service', () => ({
  apiService: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}));

import {
  listProspectSources,
  createProspectSource,
  updateProspectSource,
  archiveProspectSource,
} from '../prospect.service';

describe('prospect source service', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('listProspectSources returns data.data', async () => {
    getMock.mockResolvedValue({ success: true, data: [{ sourceId: '1', name: 'FB' }] });
    const res = await listProspectSources();
    expect(res).toEqual([{ sourceId: '1', name: 'FB' }]);
    expect(getMock).toHaveBeenCalledWith('/api/prospect-sources');
  });

  it('listProspectSources returns empty array when data is absent', async () => {
    getMock.mockResolvedValue({ success: true });
    const res = await listProspectSources();
    expect(res).toEqual([]);
  });

  it('createProspectSource posts body and returns data.data', async () => {
    postMock.mockResolvedValue({ success: true, data: { sourceId: '2', link: 'x', name: 'FB', tag: null, type: 'landing', linkCode: null, apiKey: null } });
    const res = await createProspectSource({ name: 'FB', type: 'landing' });
    expect(postMock).toHaveBeenCalledWith('/api/prospect-sources', { name: 'FB', type: 'landing' });
    expect((res as any).sourceId).toBe('2');
  });

  it('createProspectSource throws when API reports failure', async () => {
    postMock.mockResolvedValue({ success: false, message: 'name taken' });
    await expect(createProspectSource({ name: 'X', type: 'website' })).rejects.toThrow('name taken');
  });

  it('updateProspectSource PATCHes the source', async () => {
    patchMock.mockResolvedValue({ success: true });
    await updateProspectSource('src-1', { name: 'Renamed' });
    expect(patchMock).toHaveBeenCalledWith('/api/prospect-sources/src-1', { name: 'Renamed' });
  });

  it('updateProspectSource throws on failure', async () => {
    patchMock.mockResolvedValue({ success: false, message: 'not found' });
    await expect(updateProspectSource('src-1', { name: 'X' })).rejects.toThrow('not found');
  });

  it('archiveProspectSource DELETEs the source', async () => {
    deleteMock.mockResolvedValue({ success: true });
    await archiveProspectSource('src-2');
    expect(deleteMock).toHaveBeenCalledWith('/api/prospect-sources/src-2');
  });

  it('archiveProspectSource throws on failure', async () => {
    deleteMock.mockResolvedValue({ success: false, message: 'denied' });
    await expect(archiveProspectSource('src-2')).rejects.toThrow('denied');
  });
});
