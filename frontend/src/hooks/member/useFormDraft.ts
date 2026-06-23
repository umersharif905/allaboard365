import { useCallback, useEffect, useRef, useState } from 'react';
import { apiService } from '../../services/api.service';

export type StagedFile = { draftFileId: string; fieldName: string; originalFileName: string };

type Resp<T> = { success: boolean; data?: T; message?: string };

type ActiveDraft = {
  draftId: string;
  payload: Record<string, unknown>;
  updatedDate?: string;
  files: Array<{ DraftFileId: string; FieldName: string; OriginalFileName: string }>;
};

/**
 * Signed-in draft autosave for a public form. Loads any existing draft for
 * (form, for-member), debounces value autosaves, stages/removes files, and
 * promotes the draft on submit. All calls are best-effort and member-scoped by
 * the backend. Disabled (no-op) when `enabled` is false.
 */
export function useFormDraft({
  enabled,
  formTemplateId,
  forMemberId
}: {
  enabled: boolean;
  formTemplateId?: string;
  forMemberId: string | null;
}) {
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [resumedPayload, setResumedPayload] = useState<Record<string, unknown> | null>(null);
  // A saved draft was found on load and is awaiting the member's Resume / Start
  // over choice. Held here (not applied) so stale abandoned data doesn't load
  // silently when they return for a different request.
  const [pendingResume, setPendingResume] = useState<{
    draftId: string;
    payload: Record<string, unknown>;
    files: StagedFile[];
    updatedDate?: string;
  } | null>(null);
  const draftIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest payload seen, so flush() can persist even if the debounce hasn't fired.
  const latestPayload = useRef<Record<string, unknown>>({});
  // In-flight first-time create, so concurrent callers (post-sign-in seed +
  // first autosave, or a file staged before any text edit) share ONE POST
  // instead of racing two INSERTs into the (owner, form, member) unique index.
  const creatingRef = useRef<Promise<string | null> | null>(null);

  // Reload the active draft whenever the form or selected member changes. A
  // found draft is held in `pendingResume` (not applied) until the member picks
  // Resume or Start over.
  useEffect(() => {
    // Cancel any pending autosave from the PREVIOUS member before resetting the
    // draft id. Otherwise the stale debounced save lands after the switch,
    // re-creates the old member's draft, and points draftIdRef at it — so the
    // newly selected member's edits then PATCH the wrong person's draft (a PHI
    // cross-binding). Switching people must abandon the prior pending save.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    creatingRef.current = null;
    latestPayload.current = {};
    draftIdRef.current = null;
    setStagedFiles([]);
    setResumedPayload(null);
    setPendingResume(null);
    if (!enabled || !formTemplateId || !forMemberId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<Resp<{ draft: ActiveDraft | null }>>(
          `/api/me/member/forms/drafts/active?formTemplateId=${encodeURIComponent(
            formTemplateId
          )}&forMemberId=${encodeURIComponent(forMemberId)}`
        );
        if (cancelled || !res.success || !res.data?.draft) return;
        const d = res.data.draft;
        setPendingResume({
          draftId: d.draftId,
          payload: d.payload || {},
          updatedDate: d.updatedDate,
          files: (d.files || []).map((f) => ({
            draftFileId: f.DraftFileId,
            fieldName: f.FieldName,
            originalFileName: f.OriginalFileName
          }))
        });
      } catch {
        /* best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, formTemplateId, forMemberId]);

  /** Apply the pending draft into the form (member chose "Resume"). */
  const resumeDraft = useCallback(() => {
    if (!pendingResume) return;
    draftIdRef.current = pendingResume.draftId;
    setResumedPayload(pendingResume.payload);
    setStagedFiles(pendingResume.files);
    setPendingResume(null);
  }, [pendingResume]);

  /**
   * Discard the pending draft and start fresh (member chose "Start over").
   * Deletes the server draft + its staged files so abandoned data doesn't
   * linger; the form stays blank (autofill only) and a new draft is lazily
   * created on the next edit.
   */
  const discardDraft = useCallback(async () => {
    const id = pendingResume?.draftId;
    setPendingResume(null);
    setResumedPayload(null);
    setStagedFiles([]);
    draftIdRef.current = null;
    latestPayload.current = {};
    if (id) {
      try {
        await apiService.delete(`/api/me/member/forms/drafts/${id}`);
      } catch {
        /* best-effort — a stale row will simply be overwritten on next save */
      }
    }
  }, [pendingResume]);

  const ensureDraft = useCallback(
    async (payload: Record<string, unknown>) => {
      if (draftIdRef.current) return draftIdRef.current;
      // Coalesce concurrent first-time creates onto a single POST.
      if (creatingRef.current) return creatingRef.current;
      const p = (async () => {
        const res = await apiService.post<Resp<{ draftId: string }>>(
          '/api/me/member/forms/drafts',
          { formTemplateId, forMemberId, payload: payload || {} }
        );
        draftIdRef.current = res?.data?.draftId ?? null;
        return draftIdRef.current;
      })();
      creatingRef.current = p;
      try {
        return await p;
      } finally {
        creatingRef.current = null;
      }
    },
    [formTemplateId, forMemberId]
  );

  const onValuesChange = useCallback(
    (payload: Record<string, unknown>) => {
      latestPayload.current = payload;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const id = await ensureDraft(payload);
          if (id) await apiService.patch(`/api/me/member/forms/drafts/${id}`, { payload });
        } catch {
          /* best-effort */
        }
      }, 1200);
    },
    [ensureDraft]
  );

  /**
   * Force an immediate save of the latest values (used by "Leave & save" so it
   * actually persists rather than relying on the pending debounce). Throws on
   * failure so the caller can surface it instead of silently navigating away.
   */
  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const payload = latestPayload.current;
    const id = await ensureDraft(payload);
    if (!id) throw new Error('Could not save your progress. Please try again.');
    await apiService.patch(`/api/me/member/forms/drafts/${id}`, { payload });
  }, [ensureDraft]);

  /**
   * Persist an explicit payload immediately (used right after a mid-form sign-in
   * to save the values the visitor typed while anonymous). Best-effort.
   */
  const saveValues = useCallback(
    async (payload: Record<string, unknown>) => {
      latestPayload.current = payload;
      const id = await ensureDraft(payload);
      if (id) await apiService.patch(`/api/me/member/forms/drafts/${id}`, { payload });
    },
    [ensureDraft]
  );

  const stageFile = useCallback(
    async (fieldName: string, file: File) => {
      const id = await ensureDraft({});
      if (!id) return;
      const fd = new FormData();
      fd.append('fieldName', fieldName);
      fd.append('file', file, file.name);
      const res = await apiService.post<Resp<StagedFile>>(
        `/api/me/member/forms/drafts/${id}/files`,
        fd
      );
      if (res?.success && res.data) {
        const data = res.data;
        setStagedFiles((prev) => [
          ...prev,
          { draftFileId: data.draftFileId, fieldName, originalFileName: data.originalFileName }
        ]);
      }
    },
    [ensureDraft]
  );

  const removeStagedFile = useCallback(async (draftFileId: string) => {
    const id = draftIdRef.current;
    if (!id) return;
    await apiService.delete(`/api/me/member/forms/drafts/${id}/files/${draftFileId}`);
    setStagedFiles((prev) => prev.filter((s) => s.draftFileId !== draftFileId));
  }, []);

  const submit = useCallback(
    async (payload: Record<string, unknown>) => {
      if (saveTimer.current) clearTimeout(saveTimer.current); // cancel any pending autosave
      const id = await ensureDraft(payload);
      if (!id) throw new Error('Could not save the form. Please try again.');
      await apiService.patch(`/api/me/member/forms/drafts/${id}`, { payload }); // flush latest values
      const res = await apiService.post<Resp<unknown>>(
        `/api/me/member/forms/drafts/${id}/submit`,
        {}
      );
      if (!res?.success) throw new Error(res?.message || 'Submission failed');
      draftIdRef.current = null;
    },
    [ensureDraft]
  );

  return {
    stagedFiles,
    resumedPayload,
    pendingResume,
    resumeDraft,
    discardDraft,
    flush,
    saveValues,
    bundle: { onValuesChange, stagedFiles, stageFile, removeStagedFile, submit }
  };
}
