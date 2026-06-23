'use strict';

jest.mock('../../config/database', () => {
  const requests = [];
  let idx = 0;
  const makeReq = () => {
    const req = {
      inputs: {},
      input(name, _type, value) {
        this.inputs[name] = value;
        return this;
      },
      async query(sql) {
        requests.push({ sql, inputs: { ...req.inputs } });
        const i = idx++;
        return requests._responses?.[i] ?? { recordset: [] };
      },
    };
    return req;
  };
  return {
    getPool: async () => ({
      request: makeReq,
      _setResponses(responses) {
        requests._responses = responses;
        idx = 0;
      },
    }),
    sql: {
      UniqueIdentifier: 'uid',
      NVarChar: (n) => `nvarchar(${n})`,
      Int: 'int',
      MAX: 'max',
    },
  };
});

const { getPool } = require('../../config/database');
const service = require('../vendorImportFormatPreset.service');

const VENDOR = 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';
const TEMPLATE = '{LastName:Last Name},{FirstName:First Name},{Email:Email}';

describe('vendorImportFormatPreset.service', () => {
  beforeEach(() => {
    service.clearCache();
  });

  test('normalizeSlug sanitizes display names', () => {
    expect(service.normalizeSlug('Align Health SFTP')).toBe('align_health_sftp');
  });

  test('createFormatPreset rejects invalid placeholders', async () => {
    const pool = await getPool();
    pool._setResponses([
      { recordset: [{ ok: 1 }] },
    ]);
    await expect(
      service.createFormatPreset(VENDOR, {
        slug: 'bad',
        label: 'Bad',
        rowTemplate: '{NotARealPlaceholder:X}',
      })
    ).rejects.toThrow(/Invalid placeholders/);
  });

  test('createFormatPreset inserts when table exists', async () => {
    const pool = await getPool();
    pool._setResponses([
      { recordset: [{ ok: 1 }] },
      { recordset: [{ ok: 1 }] },
      { recordset: [{ ok: 1 }] },
      { recordset: [] },
      { recordset: [{ Slug: 'my_format', Label: 'My Format', RowTemplate: TEMPLATE, SortOrder: 100 }] },
    ]);
    const row = await service.createFormatPreset(VENDOR, {
      slug: 'my_format',
      label: 'My Format',
      rowTemplate: TEMPLATE,
    });
    expect(row.slug).toBe('my_format');
    expect(row.label).toBe('My Format');
  });
});
