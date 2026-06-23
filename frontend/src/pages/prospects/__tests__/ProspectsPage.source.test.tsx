/**
 * @vitest-environment jsdom
 */
// ProspectsPage — Source column + Source filter render, and the List/Insights
// tab switch is present. Hooks/contexts are mocked so the page renders in
// isolation.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const useProspectsMock = vi.fn();

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { currentRole: 'Agent' } }),
}));

vi.mock('../../../hooks/useProspects', () => ({
  useProspects: (...args: unknown[]) => useProspectsMock(...args),
  useProspectStats: () => ({ data: undefined, isLoading: false }),
  useProspectTags: () => ({ data: [] }),
  useTenantAgencies: () => ({ data: [] }),
  useTenantAgentsForFilter: () => ({ data: [] }),
}));

vi.mock('../../../hooks/useDownlineAgentsForFilter', () => ({
  useDownlineAgentsForFilter: () => ({ data: [], isLoading: false }),
}));

// Child components we don't exercise here.
vi.mock('../ProspectCreateModal', () => ({ default: () => null }));
vi.mock('../ProspectDetailModal', () => ({ default: () => null }));
vi.mock('../LeadIngestModal', () => ({ default: () => null }));
vi.mock('../ProspectsInsightsTab', () => ({
  default: () => <div data-testid="insights-mock">insights</div>,
}));
vi.mock('../../../components/common/SearchableDropdown', () => ({
  default: () => <div data-testid="searchable-dropdown" />,
}));

import ProspectsPage from '../ProspectsPage';

const prospect = {
  ProspectId: 'p1',
  TenantId: 't1',
  AgentId: 'a1',
  FirstName: 'Jane',
  LastName: 'Doe',
  Email: 'jane@x.com',
  Phone: null,
  Status: 'New' as const,
  ReferralName: null,
  PremiumAmount: null,
  Source: 'MightyWELL Website',
  SuggestedMemberId: null,
  MemberId: null,
  ClosedDate: null,
  CreatedDate: '2026-05-01T00:00:00Z',
  ModifiedDate: '2026-05-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  useProspectsMock.mockReturnValue({
    data: { prospects: [prospect], total: 1, page: 1, pageSize: 25 },
    isLoading: false,
  });
});

describe('ProspectsPage — Source column & filter', () => {
  it('renders a Source column header and the source cell value', () => {
    render(<ProspectsPage />);
    const header = screen.getByRole('columnheader', { name: /Source/i });
    expect(header).toBeInTheDocument();

    const row = screen.getByTestId('prospect-row');
    expect(within(row).getByText('MightyWELL Website')).toBeInTheDocument();
  });

  it('renders the Source filter with the known options', () => {
    render(<ProspectsPage />);
    const select = screen.getByTestId('source-filter') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('MightyWELL Website');
    expect(options).toContain('Manual');
    expect(options).toContain('ApiIngest');
  });

  it('threads the chosen source into the list query', () => {
    render(<ProspectsPage />);
    const select = screen.getByTestId('source-filter');
    fireEvent.change(select, { target: { value: 'Manual' } });
    const lastParams = useProspectsMock.mock.calls.at(-1)?.[0];
    expect(lastParams.source).toBe('Manual');
  });

  it('sorts by source when the Source header is clicked', () => {
    render(<ProspectsPage />);
    fireEvent.click(screen.getByRole('columnheader', { name: /Source/i }));
    const lastParams = useProspectsMock.mock.calls.at(-1)?.[0];
    expect(lastParams.sortBy).toBe('source');
  });

  it('switches to the Insights tab', () => {
    render(<ProspectsPage />);
    expect(screen.queryByTestId('insights-mock')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tab-insights'));
    expect(screen.getByTestId('insights-mock')).toBeInTheDocument();
  });
});
