import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const getMock = vi.fn();
const deleteMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
vi.mock('../../../services/api.service', () => ({
  apiService: {
    get: (url: string) => getMock(url),
    post: (url: string, body: unknown) => postMock(url, body),
    patch: (url: string, body: unknown) => patchMock(url, body),
    delete: (url: string) => deleteMock(url)
  }
}));

import { useFormDraft } from '../useFormDraft';

const FORM = 'f1';
const MEMBER = 'm1';
const DRAFT = 'd1';

beforeEach(() => {
  getMock.mockReset();
  deleteMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockResolvedValue({ success: true });
  postMock.mockResolvedValue({ success: true, data: { draftId: DRAFT } });
  patchMock.mockResolvedValue({ success: true });
});

function draftFound() {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/drafts/active')) {
      return Promise.resolve({
        success: true,
        data: {
          draft: {
            draftId: DRAFT,
            payload: { note: 'saved text' },
            updatedDate: '2026-05-29',
            files: [{ DraftFileId: 'fa', FieldName: 'doc', OriginalFileName: 'x.pdf' }]
          }
        }
      });
    }
    return Promise.resolve({ success: true, data: {} });
  });
}

describe('useFormDraft resume/start-over', () => {
  it('holds a found draft as pendingResume without auto-applying it', async () => {
    draftFound();
    const { result } = renderHook(() =>
      useFormDraft({ enabled: true, formTemplateId: FORM, forMemberId: MEMBER })
    );
    await waitFor(() => expect(result.current.pendingResume).not.toBeNull());
    expect(result.current.pendingResume?.draftId).toBe(DRAFT);
    // Not applied yet — the form should not be pre-seeded until the user decides.
    expect(result.current.resumedPayload).toBeNull();
    expect(result.current.stagedFiles).toEqual([]);
  });

  it('Resume applies the saved payload + files and clears the prompt', async () => {
    draftFound();
    const { result } = renderHook(() =>
      useFormDraft({ enabled: true, formTemplateId: FORM, forMemberId: MEMBER })
    );
    await waitFor(() => expect(result.current.pendingResume).not.toBeNull());
    act(() => result.current.resumeDraft());
    expect(result.current.resumedPayload).toEqual({ note: 'saved text' });
    expect(result.current.stagedFiles).toEqual([
      { draftFileId: 'fa', fieldName: 'doc', originalFileName: 'x.pdf' }
    ]);
    expect(result.current.pendingResume).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('Start over deletes the draft and leaves the form blank', async () => {
    draftFound();
    const { result } = renderHook(() =>
      useFormDraft({ enabled: true, formTemplateId: FORM, forMemberId: MEMBER })
    );
    await waitFor(() => expect(result.current.pendingResume).not.toBeNull());
    await act(async () => {
      await result.current.discardDraft();
    });
    expect(deleteMock).toHaveBeenCalledWith(`/api/me/member/forms/drafts/${DRAFT}`);
    expect(result.current.pendingResume).toBeNull();
    expect(result.current.resumedPayload).toBeNull();
    expect(result.current.stagedFiles).toEqual([]);
  });

  it('cancels a pending autosave when the selected member changes (no cross-member draft)', async () => {
    vi.useFakeTimers();
    try {
      getMock.mockResolvedValue({ success: true, data: { draft: null } });
      const { result, rerender } = renderHook(
        ({ forMemberId }) => useFormDraft({ enabled: true, formTemplateId: FORM, forMemberId }),
        { initialProps: { forMemberId: 'mA' } }
      );

      // Member A types something — schedules the 1200ms debounced autosave.
      act(() => result.current.bundle.onValuesChange({ note: 'A typed this' }));

      // Switch to member B before the debounce fires.
      rerender({ forMemberId: 'mB' });

      // Fire any timer that *would* have run.
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      // The stale save for member A must NOT have been POSTed — otherwise A's
      // text would create A's draft and bind draftIdRef, contaminating B.
      expect(postMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no prompt when no draft exists', async () => {
    getMock.mockResolvedValue({ success: true, data: { draft: null } });
    const { result } = renderHook(() =>
      useFormDraft({ enabled: true, formTemplateId: FORM, forMemberId: MEMBER })
    );
    // Give the effect a tick; pendingResume should stay null.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.pendingResume).toBeNull();
  });
});
