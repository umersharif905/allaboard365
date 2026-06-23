jest.mock('../../config/database', () => ({ getPool: jest.fn() }));
const { getPool } = require('../../config/database');
const service = require('../employeeFacingDoc.service');

function makePool(recordsets) {
  let call = 0;
  return {
    request: () => ({
      input: function() { return this; },
      query: async () => ({ recordset: recordsets[call++] || [] })
    })
  };
}

describe('getApplicableEmployeeDocsForGroup', () => {
  beforeEach(() => getPool.mockReset());

  it('returns employee docs whose primary product is in the group', async () => {
    getPool.mockResolvedValue(makePool([
      // 1st query — group products
      [{ ProductId: 'p1' }, { ProductId: 'p2' }],
      // 2nd query — employee docs for tenant + their primary products
      [
        { ProposalDocumentId: 'd1', Name: 'Gold', PrimaryProductId: 'p1', ProductName: 'Gold Plan' },
        { ProposalDocumentId: 'd2', Name: 'HSA',  PrimaryProductId: 'p3', ProductName: 'HSA Plan' },
      ]
    ]));

    const result = await service.getApplicableEmployeeDocsForGroup('g1', 't1');
    expect(result).toEqual([
      { proposalDocumentId: 'd1', name: 'Gold', productId: 'p1', productName: 'Gold Plan' }
    ]);
  });

  it('returns [] when group has no products', async () => {
    getPool.mockResolvedValue(makePool([[], []]));
    const result = await service.getApplicableEmployeeDocsForGroup('g1', 't1');
    expect(result).toEqual([]);
  });
});

describe('generateEmployeeFacingPDF', () => {
  beforeEach(() => getPool.mockReset());

  it('throws 404-style error when doc is not Employee category', async () => {
    getPool.mockResolvedValue(makePool([
      [{ Category: 'Business' }]
    ]));
    await expect(service.generateEmployeeFacingPDF('g1', 'd1', 'u1'))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws 409 when doc primary product is no longer on the group', async () => {
    getPool.mockResolvedValue(makePool([
      [{ Category: 'Employee', ProposalDocumentId: 'd1', IsActive: true }],
      [{ ProductId: 'pX' }],
      [], // no match in group products
    ]));
    await expect(service.generateEmployeeFacingPDF('g1', 'd1', 'u1'))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
