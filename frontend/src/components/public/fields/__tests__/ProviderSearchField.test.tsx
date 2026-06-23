import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProviderSearchField from '../ProviderSearchField';
import type { FieldDef } from '../../../../types/publicFormDefinition';

vi.mock('../../../../services/npiPublicSearch.service', () => ({
  searchPublicProviders: vi.fn(),
  findCoLocatedProviders: vi.fn()
}));
import { searchPublicProviders, findCoLocatedProviders } from '../../../../services/npiPublicSearch.service';
const mockedSearch = searchPublicProviders as unknown as ReturnType<typeof vi.fn>;
const mockedCoLocated = findCoLocatedProviders as unknown as ReturnType<typeof vi.fn>;

const field: FieldDef = {
  name: 'provider_1',
  type: 'provider_search',
  label: 'Find your provider',
  providerSearchMode: 'individual'
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProviderSearchField', () => {
  it('searches and selects a registry provider', async () => {
    mockedSearch.mockResolvedValue({
      success: true, count: 1, widened: false,
      data: [{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD', city: 'Naugatuck', state: 'CT', zip: '06770' }]
    });
    const onChange = vi.fn();
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Provider last name'), { target: { value: 'Smith' } });
    fireEvent.change(screen.getByPlaceholderText('Your ZIP code'), { target: { value: '06770' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(screen.getByText('Jane Smith, MD')).toBeInTheDocument());
    expect(mockedSearch).toHaveBeenCalledWith({
      formId: 'form-1', mode: 'individual', lastName: 'Smith', organizationName: undefined, zip: '06770'
    });

    fireEvent.click(screen.getByText('Jane Smith, MD'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD' })
    );
  });

  it('shows the selected provider with a Change button', () => {
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={field}
        formId="form-1"
        value={{ source: 'registry', npi: '1234567890', name: 'Jane Smith, MD' }}
        onChange={onChange}
      />
    );
    expect(screen.getByText(/Jane Smith, MD/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Change'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('submits a manually entered provider', () => {
    const onChange = vi.fn();
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByText(/Enter it manually/i));
    fireEvent.change(screen.getByPlaceholderText('Provider / facility name'), { target: { value: 'Town Clinic' } });
    fireEvent.click(screen.getByText('Use this provider'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual', name: 'Town Clinic' })
    );
  });

  it('captures the full registry-equivalent detail on manual entry', () => {
    const onChange = vi.fn();
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByText(/Enter it manually/i));
    fireEvent.change(screen.getByPlaceholderText('Provider / facility name'), { target: { value: 'Town Clinic' } });
    fireEvent.change(screen.getByLabelText('Provider type'), { target: { value: 'Hospital' } });
    fireEvent.change(screen.getByPlaceholderText('NPI number (if you have it)'), { target: { value: '1112223330' } });
    fireEvent.change(screen.getByPlaceholderText('Phone'), { target: { value: '203-555-0100' } });
    fireEvent.change(screen.getByPlaceholderText('Fax'), { target: { value: '203-555-0142' } });
    fireEvent.change(screen.getByPlaceholderText('Suite, unit, floor (optional)'), { target: { value: 'Suite 5' } });
    fireEvent.click(screen.getByText('Use this provider'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual',
        name: 'Town Clinic',
        providerType: 'Hospital',
        npi: '1112223330',
        phone: '203-555-0100',
        fax: '203-555-0142',
        address2: 'Suite 5'
      })
    );
  });
});

describe('ProviderSearchField — co-located suggestion', () => {
  const orgField: FieldDef = {
    name: 'hospital_1',
    type: 'provider_search',
    label: 'Find your hospital',
    providerSearchMode: 'organization'
  };
  const linkedDoctor = {
    source: 'registry' as const,
    npi: '1234567890',
    name: 'Jane Smith, MD',
    address1: '1 Prestige Dr',
    zip: '06770'
  };

  it('fetches and shows facilities at the doctor\'s office, and selects on tap', async () => {
    mockedCoLocated.mockResolvedValue({
      success: true,
      count: 1,
      data: [{ source: 'registry', npi: '8000000001', name: 'Co-Located Surgery Center', city: 'Naugatuck', state: 'CT' }]
    });
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={orgField}
        formId="form-1"
        value={undefined}
        onChange={onChange}
        linkedProvider={linkedDoctor}
      />
    );

    await waitFor(() => expect(screen.getByText('Co-Located Surgery Center')).toBeInTheDocument());
    expect(mockedCoLocated).toHaveBeenCalledWith({
      formId: 'form-1', address1: '1 Prestige Dr', zip: '06770'
    });

    fireEvent.click(screen.getByText('Co-Located Surgery Center'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', npi: '8000000001' })
    );
  });

  it('does not fetch a suggestion when there is no linked doctor', () => {
    render(
      <ProviderSearchField field={orgField} formId="form-1" value={undefined} onChange={vi.fn()} />
    );
    expect(mockedCoLocated).not.toHaveBeenCalled();
  });

  it('does not fetch a suggestion for a manually-entered doctor', () => {
    render(
      <ProviderSearchField
        field={orgField}
        formId="form-1"
        value={undefined}
        onChange={vi.fn()}
        linkedProvider={{ source: 'manual', name: 'Some Clinic' }}
      />
    );
    expect(mockedCoLocated).not.toHaveBeenCalled();
  });

  it('shows a departments toggle, parent click selects the umbrella, dept click selects the dept', async () => {
    mockedCoLocated.mockResolvedValue({
      success: true,
      count: 1,
      data: [
        {
          source: 'registry',
          npi: 'parent-npi',
          name: 'Hartford Hospital',
          providerType: 'Hospital',
          city: 'Hartford',
          state: 'CT',
          departments: [
            { npi: 'dept-er', specialty: 'Emergency Medicine', providerType: 'Provider' },
            { npi: 'dept-path', specialty: 'Pathology', providerType: 'Provider' }
          ]
        }
      ]
    });
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={orgField}
        formId="form-1"
        value={undefined}
        onChange={onChange}
        linkedProvider={linkedDoctor}
      />
    );

    await waitFor(() => expect(screen.getByText('2 departments')).toBeInTheDocument());

    // Parent click → umbrella NPI, departments stripped.
    fireEvent.click(screen.getByText('Hartford Hospital'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ npi: 'parent-npi', departments: undefined })
    );
    onChange.mockClear();

    // Toggle expands the list, then a department row selects its specific NPI.
    fireEvent.click(screen.getByText('2 departments'));
    fireEvent.click(screen.getByText(/Emergency Medicine/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        npi: 'dept-er',
        specialty: 'Emergency Medicine',
        departments: undefined
      })
    );
  });
});

describe('ProviderSearchField — Your providers (signed-in)', () => {
  it('shows prior providers and selects one with an NPI as a registry value', () => {
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={field}
        formId="form-1"
        value={undefined}
        onChange={onChange}
        priorProviders={[
          { npi: '5550001111', name: 'Dr Prior', city: 'Reno', state: 'NV', role: 'Primary Provider' }
        ]}
      />
    );
    expect(screen.getByText('Your providers')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Dr Prior'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'registry', npi: '5550001111', name: 'Dr Prior' })
    );
  });

  it('converts an NPI-less prior provider to a manual value', () => {
    const onChange = vi.fn();
    render(
      <ProviderSearchField
        field={field}
        formId="form-1"
        value={undefined}
        onChange={onChange}
        priorProviders={[{ name: 'Town Clinic', city: 'Reno', state: 'NV' }]}
      />
    );
    fireEvent.click(screen.getByText('Town Clinic'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual', name: 'Town Clinic' })
    );
  });

  it('renders no "Your providers" section when none are provided', () => {
    render(<ProviderSearchField field={field} formId="form-1" value={undefined} onChange={vi.fn()} />);
    expect(screen.queryByText('Your providers')).not.toBeInTheDocument();
  });
});
