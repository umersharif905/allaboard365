/**
 * @vitest-environment jsdom
 */
// ProspectService — pins the query-string the list endpoint receives and the
// status set shared with the UI.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
const downloadMock = vi.fn();

vi.mock('../api.service', () => ({
  apiService: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    put: (...args: unknown[]) => putMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
    downloadFile: (...args: unknown[]) => downloadMock(...args),
  },
}));

import { PROSPECT_SOURCES, PROSPECT_STATUSES, ProspectService } from '../prospect.service';

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ success: true, data: { prospects: [], total: 0, page: 1, pageSize: 25 } });
});

describe('ProspectService.list', () => {
  it('builds query params from scope + filters', async () => {
    await ProspectService.list({ scope: 'downline', status: 'New', search: 'jane', page: 2, pageSize: 25 });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('scope=downline');
    expect(url).toContain('status=New');
    expect(url).toContain('search=jane');
    expect(url).toContain('page=2');
  });

  it('passes a specific agentId instead of a scope', async () => {
    await ProspectService.list({ agentId: 'agent-123' });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('agentId=agent-123');
    expect(url).not.toContain('scope=');
  });

  it('hits the bare endpoint when no params are given', async () => {
    await ProspectService.list({});
    expect(getMock.mock.calls[0][0]).toBe('/api/prospects');
  });
});

describe('ProspectService.list — source filter/sort', () => {
  it('threads the source filter into the query string', async () => {
    await ProspectService.list({ source: 'MightyWELL Website' });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('source=MightyWELL+Website');
  });

  it('supports sortBy=source', async () => {
    await ProspectService.list({ sortBy: 'source', sortDir: 'asc' });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('sortBy=source');
  });

  it('omits source when not provided', async () => {
    await ProspectService.list({});
    const url = getMock.mock.calls[0][0] as string;
    expect(url).not.toContain('source=');
  });
});

describe('PROSPECT_SOURCES', () => {
  it('includes the known lead sources', () => {
    expect(PROSPECT_SOURCES).toContain('MightyWELL Website');
    expect(PROSPECT_SOURCES).toContain('Manual');
    expect(PROSPECT_SOURCES).toContain('ApiIngest');
    expect(PROSPECT_SOURCES).toContain('Proposal');
    expect(PROSPECT_SOURCES).toContain('Quote');
  });
});

describe('ProspectService.getStats', () => {
  it('GETs /api/prospects/stats with scope params and returns the payload', async () => {
    const payload = {
      bySourceMonth: [{ month: '2026-05', source: 'Manual', count: 3 }],
      bySource: [{ source: 'Manual', count: 3 }],
      byStatus: [{ status: 'New', count: 3 }],
      totals: { total: 3, newThisMonth: 1, sources: 1 },
    };
    getMock.mockResolvedValueOnce({ success: true, data: payload });
    const res = await ProspectService.getStats({ scope: 'downline', agencyId: 'ag-1' });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/prospects/stats');
    expect(url).toContain('scope=downline');
    expect(url).toContain('agencyId=ag-1');
    expect(res).toEqual(payload);
  });

  it('returns a zeroed shape when the API omits data', async () => {
    getMock.mockResolvedValueOnce({ success: true });
    const res = await ProspectService.getStats({});
    expect(res.totals).toEqual({ total: 0, newThisMonth: 0, sources: 0, enrolled: 0 });
    expect(res.bySource).toEqual([]);
  });
});

describe('ProspectService.create', () => {
  it('throws when the API reports failure', async () => {
    postMock.mockResolvedValueOnce({ success: false, message: 'nope' });
    await expect(ProspectService.create({ email: 'x@y.com' })).rejects.toThrow('nope');
  });
});

describe('ProspectService.remove', () => {
  it('DELETEs the prospect and throws on failure', async () => {
    deleteMock.mockResolvedValueOnce({ success: true });
    await ProspectService.remove('p-1');
    expect(deleteMock).toHaveBeenCalledWith('/api/prospects/p-1');

    deleteMock.mockResolvedValueOnce({ success: false, message: 'denied' });
    await expect(ProspectService.remove('p-1')).rejects.toThrow('denied');
  });
});

describe('ProspectService.downloadReport', () => {
  it('downloads CSV with filter params in the URL', async () => {
    downloadMock.mockResolvedValueOnce(undefined);
    await ProspectService.downloadReport({ scope: 'agency', status: 'Closed' });
    const [url, filename] = downloadMock.mock.calls[0];
    expect(url).toContain('/api/prospects/report');
    expect(url).toContain('scope=agency');
    expect(url).toContain('status=Closed');
    expect(filename).toMatch(/prospects-report-.*\.csv/);
  });
});

describe('ProspectService quotes + comms + keys', () => {
  it('createQuote posts to /api/quotes', async () => {
    postMock.mockResolvedValueOnce({ success: true, data: { quoteId: 'q1', prospectId: 'p1' } });
    const res = await ProspectService.createQuote({ lineItems: [{ premium: 100 }] });
    expect(postMock.mock.calls[0][0]).toBe('/api/quotes');
    expect(res.quoteId).toBe('q1');
  });

  it('sendCommunication posts to the prospect communications endpoint', async () => {
    postMock.mockResolvedValueOnce({ success: true, data: { messageId: 'm1' } });
    await ProspectService.sendCommunication('p1', { channel: 'email', body: 'hi' });
    expect(postMock.mock.calls[0][0]).toBe('/api/prospects/p1/communications');
  });

  it('createApiKey returns the one-time secret', async () => {
    postMock.mockResolvedValueOnce({ success: true, data: { apiKeyId: 'k1', name: 'x', partialKey: 'abcd', key: 'sk_live_xxx', scope: 'lead-ingest' } });
    const res = await ProspectService.createApiKey();
    expect(res.key).toBe('sk_live_xxx');
  });
});

describe('status set', () => {
  it('matches the backend lifecycle', () => {
    expect(PROSPECT_STATUSES).toEqual(['New', 'Contacted', 'Proposal Sent', 'Closed', 'Lost']);
  });
});

describe('ProspectService.list — phase 2 params', () => {
  it('passes sortBy, sortDir, tags, and followUp to the query', async () => {
    await ProspectService.list({ sortBy: 'name', sortDir: 'asc', tags: 'tag1,tag2', followUp: 'overdue' });
    const url = getMock.mock.calls[0][0] as string;
    expect(url).toContain('sortBy=name');
    expect(url).toContain('sortDir=asc');
    expect(url).toContain('tags=tag1%2Ctag2');
    expect(url).toContain('followUp=overdue');
  });

  it('omits phase 2 params when not provided', async () => {
    await ProspectService.list({});
    const url = getMock.mock.calls[0][0] as string;
    expect(url).not.toContain('sortBy');
    expect(url).not.toContain('tags');
    expect(url).not.toContain('followUp');
  });
});

describe('ProspectService tag methods', () => {
  it('listTags GETs /api/prospect-tags', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [] });
    const res = await ProspectService.listTags();
    expect(getMock.mock.calls[0][0]).toBe('/api/prospect-tags');
    expect(res).toEqual([]);
  });

  it('createTag POSTs and returns the new tag', async () => {
    const tag = { ProspectTagId: 't1', AgencyId: null, Name: 'Hot', Color: 'red', CreatedDate: '2024-01-01' };
    postMock.mockResolvedValueOnce({ success: true, data: tag });
    const res = await ProspectService.createTag({ name: 'Hot', color: 'red' });
    expect(postMock.mock.calls[0][0]).toBe('/api/prospect-tags');
    expect(res.ProspectTagId).toBe('t1');
  });

  it('createTag throws on failure', async () => {
    postMock.mockResolvedValueOnce({ success: false, message: 'bad color' });
    await expect(ProspectService.createTag({ name: 'X', color: 'neon' })).rejects.toThrow('bad color');
  });

  it('deleteTag DELETEs the tag', async () => {
    deleteMock.mockResolvedValueOnce({ success: true });
    await ProspectService.deleteTag('t1');
    expect(deleteMock.mock.calls[0][0]).toBe('/api/prospect-tags/t1');
  });

  it('assignTag POSTs to /api/prospects/:id/tags', async () => {
    const detail = { prospect: { ProspectId: 'p1' }, products: [], member: null };
    postMock.mockResolvedValueOnce({ success: true, data: detail });
    await ProspectService.assignTag('p1', 't1');
    expect(postMock.mock.calls[0][0]).toBe('/api/prospects/p1/tags');
    expect(postMock.mock.calls[0][1]).toEqual({ tagId: 't1' });
  });

  it('removeTag DELETEs /api/prospects/:id/tags/:tagId', async () => {
    const detail = { prospect: { ProspectId: 'p1' }, products: [], member: null };
    deleteMock.mockResolvedValueOnce({ success: true, data: detail });
    await ProspectService.removeTag('p1', 't1');
    expect(deleteMock.mock.calls[0][0]).toBe('/api/prospects/p1/tags/t1');
  });
});

describe('ProspectService.reassign', () => {
  it('POSTs to /api/prospects/:id/reassign with agentId', async () => {
    const detail = { prospect: { ProspectId: 'p1' }, products: [], member: null };
    postMock.mockResolvedValueOnce({ success: true, data: detail });
    await ProspectService.reassign('p1', 'agent-99');
    expect(postMock.mock.calls[0][0]).toBe('/api/prospects/p1/reassign');
    expect(postMock.mock.calls[0][1]).toEqual({ agentId: 'agent-99' });
  });

  it('throws on failure', async () => {
    postMock.mockResolvedValueOnce({ success: false, message: 'not allowed' });
    await expect(ProspectService.reassign('p1', 'a1')).rejects.toThrow('not allowed');
  });
});

describe('ProspectService.downloadReport — phase 2 params', () => {
  it('passes sortBy, tags, followUp to report URL', async () => {
    downloadMock.mockResolvedValueOnce(undefined);
    await ProspectService.downloadReport({ sortBy: 'premium', sortDir: 'desc', tags: 'x,y', followUp: 'any' });
    const [url] = downloadMock.mock.calls[0];
    expect(url).toContain('sortBy=premium');
    expect(url).toContain('sortDir=desc');
    expect(url).toContain('followUp=any');
  });
});
