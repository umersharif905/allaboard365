/**
 * @vitest-environment jsdom
 */
// ProspectsInsightsTab — renders the recharts dashboard from a mocked stats
// payload and falls back to an empty-state card when there's no data.

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProspectStats } from '../../../services/prospect.service';

// Stub the stats hook so we control the payload directly.
const useProspectStatsMock = vi.fn();
vi.mock('../../../hooks/useProspects', () => ({
  useProspectStats: (...args: unknown[]) => useProspectStatsMock(...args),
}));

// The controls row pulls the source list via a real useQuery; stub the service
// call so the query resolves to an empty list without hitting the network.
vi.mock('../../../services/prospect.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/prospect.service')>();
  return { ...actual, listProspectSources: vi.fn().mockResolvedValue([]) };
});

// Render helper that provides a QueryClient for the source-list query.
const renderTab = (ui: React.ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

// recharts renders to <canvas>/SVG with layout math that jsdom can't size.
// Replace the pieces we use with simple test-id markers so we can assert the
// charts mounted without depending on real rendering.
vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="responsive-container">{children}</div>
    ),
    BarChart: Passthrough,
    Bar: () => <div data-testid="bar" />,
    PieChart: Passthrough,
    Pie: ({ children }: { children?: React.ReactNode }) => <div data-testid="pie">{children}</div>,
    Cell: () => <div data-testid="cell" />,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

import ProspectsInsightsTab from '../ProspectsInsightsTab';

const sampleStats: ProspectStats = {
  bySourceMonth: [
    { month: '2026-04', source: 'Manual', count: 2 },
    { month: '2026-04', source: 'MightyWELL Website', count: 1 },
    { month: '2026-05', source: 'Manual', count: 4 },
  ],
  bySource: [
    { source: 'Manual', count: 6, enrolled: 2 },
    { source: 'MightyWELL Website', count: 1, enrolled: 1 },
  ],
  byStatus: [
    { status: 'New', count: 5 },
    { status: 'Contacted', count: 2 },
  ],
  totals: { total: 7, newThisMonth: 4, sources: 2, enrolled: 3 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProspectsInsightsTab', () => {
  it('renders metric cards and all three charts from the stats payload', () => {
    useProspectStatsMock.mockReturnValue({ data: sampleStats, isLoading: false });
    renderTab(<ProspectsInsightsTab scope={{ scope: 'downline' }} />);

    expect(screen.getByTestId('insights-tab')).toBeInTheDocument();
    // metric values
    expect(screen.getByText('7')).toBeInTheDocument(); // total
    expect(screen.getByText('Total leads')).toBeInTheDocument();
    expect(screen.getByText('New this month')).toBeInTheDocument();
    expect(screen.getByText('Enrollments')).toBeInTheDocument();
    expect(screen.getByText('Sources')).toBeInTheDocument();

    // three chart cards mounted
    expect(screen.getByTestId('chart-by-month')).toBeInTheDocument();
    expect(screen.getByTestId('chart-by-source')).toBeInTheDocument();
    expect(screen.getByTestId('chart-by-status')).toBeInTheDocument();

    // responsive containers wrap each chart
    expect(screen.getAllByTestId('responsive-container').length).toBe(3);
  });

  it('shows the empty-state card when there is no data', () => {
    useProspectStatsMock.mockReturnValue({
      data: { bySourceMonth: [], bySource: [], byStatus: [], totals: { total: 0, newThisMonth: 0, sources: 0, enrolled: 0 } },
      isLoading: false,
    });
    renderTab(<ProspectsInsightsTab scope={{}} />);

    expect(screen.getByTestId('insights-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('insights-tab')).not.toBeInTheDocument();
    expect(screen.getByText('No insights yet')).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    useProspectStatsMock.mockReturnValue({ data: undefined, isLoading: true });
    renderTab(<ProspectsInsightsTab scope={{}} />);
    expect(screen.getByTestId('insights-loading')).toBeInTheDocument();
  });
});
