'use strict';

const { buildCatalogStatus } = require('../e123ProductCatalog.service');

describe('e123ProductCatalog.service', () => {
  test('buildCatalogStatus marks missing products as legacy', () => {
    expect(buildCatalogStatus(null).catalogStatusLabel).toBe('Legacy (not in agent catalog)');
  });

  test('buildCatalogStatus marks active catalog products', () => {
    const status = buildCatalogStatus({
      label: 'Essential (Sharewell)',
      active: true,
      category: 'Individual Product',
      underwriter: 'Sharewell'
    });
    expect(status.inAgentCatalog).toBe(true);
    expect(status.catalogActive).toBe(true);
    expect(status.catalogStatusLabel).toContain('Active');
  });
});
