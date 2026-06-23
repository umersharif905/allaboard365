const { dedupePriorProviders } = require('../priorProviderService');

describe('dedupePriorProviders', () => {
  it('dedups by NPI (case-insensitive), keeping the first (most recent) row', () => {
    const rows = [
      { ProviderName: 'Dr A', NPI: '1234567890', City: 'Austin', State: 'TX', CreatedDate: '2026-05-02' },
      { ProviderName: 'Dr A (old addr)', NPI: '1234567890', City: 'Dallas', State: 'TX', CreatedDate: '2026-01-01' }
    ];
    const out = dedupePriorProviders(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ npi: '1234567890', name: 'Dr A', city: 'Austin' });
  });

  it('dedups NPI-less rows by name|city|state', () => {
    const rows = [
      { ProviderName: 'Clinic X', City: 'Reno', State: 'NV', CreatedDate: '2026-05-01' },
      { ProviderName: 'clinic x', City: 'reno', State: 'nv', CreatedDate: '2026-04-01' },
      { ProviderName: 'Clinic Y', City: 'Reno', State: 'NV', CreatedDate: '2026-03-01' }
    ];
    const out = dedupePriorProviders(rows);
    expect(out.map((p) => p.name)).toEqual(['Clinic X', 'Clinic Y']);
  });

  it('shapes rows for the provider field (zipCode -> zip, role, lastUsedDate)', () => {
    const out = dedupePriorProviders([
      {
        ProviderName: 'Dr B', NPI: '999', TaxId: 'T', Fax: 'F', Phone: 'P',
        Address1: 'A1', Address2: 'A2', City: 'C', State: 'S', ZipCode: '00001',
        ProviderType: 'individual', ProviderRole: 'Surgeon', CreatedDate: '2026-05-05'
      }
    ]);
    expect(out[0]).toEqual({
      npi: '999', name: 'Dr B', providerType: 'individual', taxId: 'T', address1: 'A1', address2: 'A2',
      city: 'C', state: 'S', zip: '00001', phone: 'P', fax: 'F', role: 'Surgeon', lastUsedDate: '2026-05-05'
    });
  });

  it('handles empty/undefined input', () => {
    expect(dedupePriorProviders([])).toEqual([]);
    expect(dedupePriorProviders(undefined)).toEqual([]);
  });
});
