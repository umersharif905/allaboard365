import { describe, it, expect, vi, beforeEach } from 'vitest';
import { srDiagnosesService } from '../sr-diagnoses.service';
import { apiService } from '../api.service';

vi.mock('../api.service', () => ({
  apiService: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const SR = 'sr-1';
beforeEach(() => { vi.clearAllMocks(); });

describe('srDiagnosesService', () => {
  it('lists diagnoses', async () => {
    (apiService.get as any).mockResolvedValue({ success: true, data: [{ DiagnosisId: 'd1' }] });
    const rows = await srDiagnosesService.list(SR);
    expect(apiService.get).toHaveBeenCalledWith(`/api/me/vendor/share-requests/${SR}/diagnoses`);
    expect(rows).toEqual([{ DiagnosisId: 'd1' }]);
  });
  it('adds a diagnosis', async () => {
    (apiService.post as any).mockResolvedValue({ success: true, data: { diagnosisId: 'd2' } });
    await srDiagnosesService.add(SR, { icd10Code: 'm17.11', description: 'OA knee', isPrimary: true });
    expect(apiService.post).toHaveBeenCalledWith(
      `/api/me/vendor/share-requests/${SR}/diagnoses`,
      { icd10Code: 'm17.11', description: 'OA knee', isPrimary: true }
    );
  });
  it('throws on failure', async () => {
    (apiService.get as any).mockResolvedValue({ success: false, message: 'nope' });
    await expect(srDiagnosesService.list(SR)).rejects.toThrow('nope');
  });
});
