import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api.service', () => ({ apiService: { get: vi.fn() } }));
import { apiService } from '../api.service';
import { searchPublicProviders, findCoLocatedProviders } from '../npiPublicSearch.service';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('searchPublicProviders', () => {
  it('builds the public NPI search URL with all params', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, widened: false, data: [] });
    await searchPublicProviders({ formId: 'form-1', mode: 'individual', lastName: 'Smith', zip: '06770' });
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/public/npi/search?form=form-1&mode=individual&lastName=Smith&zip=06770'
    );
  });

  it('omits empty optional params', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, widened: false, data: [] });
    await searchPublicProviders({ formId: 'f', mode: 'organization', organizationName: 'Hosp', zip: '06770' });
    const url = mockedGet.mock.calls[0][0] as string;
    expect(url).toContain('organizationName=Hosp');
    expect(url).not.toContain('lastName=');
  });
});

describe('findCoLocatedProviders', () => {
  it('builds the co-located URL with form, address1 and zip', async () => {
    mockedGet.mockResolvedValue({ success: true, count: 0, data: [] });
    await findCoLocatedProviders({ formId: 'form-1', address1: '1 Prestige Dr', zip: '06770' });
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/public/npi/co-located?form=form-1&address1=1+Prestige+Dr&zip=06770'
    );
  });
});
