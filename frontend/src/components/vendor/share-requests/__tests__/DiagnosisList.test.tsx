import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DiagnosisList from '../DiagnosisList';
import { srDiagnosesService } from '../../../../services/sr-diagnoses.service';

vi.mock('../../../../services/sr-diagnoses.service', () => ({
  srDiagnosesService: { list: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

beforeEach(() => { vi.clearAllMocks(); });

describe('DiagnosisList', () => {
  it('renders existing diagnoses', async () => {
    (srDiagnosesService.list as any).mockResolvedValue([
      { DiagnosisId: 'd1', ICD10Code: 'M17.11', Description: 'OA right knee', IsPrimary: true, SortOrder: 0, CreatedDate: '2026-06-01' },
    ]);
    render(<DiagnosisList shareRequestId="sr-1" />);
    expect(await screen.findByText('M17.11')).toBeInTheDocument();
    expect(screen.getByText('OA right knee')).toBeInTheDocument();
  });
  it('adds a diagnosis and reloads', async () => {
    (srDiagnosesService.list as any).mockResolvedValue([]);
    (srDiagnosesService.add as any).mockResolvedValue({ diagnosisId: 'd2', icd10Code: 'E11.9' });
    render(<DiagnosisList shareRequestId="sr-1" />);
    await screen.findByText(/No diagnoses/i);
    fireEvent.click(screen.getByRole('button', { name: /Add diagnosis/i }));
    fireEvent.change(screen.getByPlaceholderText(/ICD-10/i), { target: { value: 'E11.9' } });
    fireEvent.change(screen.getByPlaceholderText(/Description/i), { target: { value: 'Type 2 diabetes' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() => expect(srDiagnosesService.add).toHaveBeenCalledWith('sr-1', expect.objectContaining({ icd10Code: 'E11.9', description: 'Type 2 diabetes' })));
  });
});
