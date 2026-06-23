import type { ModuleStep, TrainingModule } from './trainingTypes';

/** localStorage key: last successful admin "Save Library" fingerprint (same browser only). */
export const TRAINING_LIBRARY_CLIENT_META_KEY = '__oeTrainingLibraryClientMeta_v1';

/**
 * Opt-in noisy console diagnostics (H1/H2 groups). Set localStorage key `__oeTrainingDiag` to `"1"` to enable.
 * Default off so normal use is not spammed.
 */
export const TRAINING_DIAG_CONSOLE_FLAG = '__oeTrainingDiag';

export function isTrainingDiagnosticsConsoleEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(TRAINING_DIAG_CONSOLE_FLAG) === '1';
  } catch {
    return false;
  }
}

export type H1InlinePdfDiagnostic = {
  hypothesis: 'H1';
  stepId: string;
  /** True when the player would render at least one inline PDF iframe for this step. */
  wouldRenderAnyInlinePdf: boolean;
  attachments: Array<{
    id: string;
    title: string;
    attachmentType: string | undefined;
    renderInline: boolean;
    urlTrimmedLength: number;
    wouldRenderInlinePdf: boolean;
    blockers: string[];
  }>;
};

export type H2StaleDataDiagnostic = {
  hypothesis: 'H2';
  /** ISO time when agent page applied library-content from API */
  loadedAtIso: string;
  /** Compact fingerprint of attachment-related fields for all modules (for compare). */
  libraryFingerprint: string;
  lastAdminSave: { savedAtIso: string; fingerprint: string } | null;
  /** Whether agent snapshot matches last recorded admin save in this browser */
  matchVsLastAdminSave: boolean | 'no-admin-marker';
  note: string;
};

/**
 * Stable JSON fingerprint of attachment metadata across the library (order-preserving).
 */
export function buildTrainingLibraryAttachmentFingerprint(modules: TrainingModule[]): string {
  const minimal = modules.map(m => ({
    id: m.id,
    steps: m.moduleSteps.map(s => ({
      id: s.id,
      att: (s.attachments ?? []).map(a => {
        const u = (a.url ?? '').trim();
        return {
          id: a.id,
          type: a.attachmentType,
          renderInline: Boolean(a.renderInline),
          urlLen: u.length,
          /** First segment of URL so different links with same length still diverge in H2 compare */
          urlHead: u.slice(0, 96)
        };
      })
    }))
  }));
  return JSON.stringify(minimal);
}

export function diagnoseH1InlinePdfEligibility(step: ModuleStep | null | undefined): H1InlinePdfDiagnostic | null {
  if (!step) {
    return null;
  }

  const list = step.attachments ?? [];
  const attachments = list.map(a => {
    const urlTrimmedLength = (a.url ?? '').trim().length;
    const blockers: string[] = [];
    if (a.attachmentType !== 'pdf') {
      blockers.push(`attachmentType is "${a.attachmentType ?? 'undefined'}", not "pdf"`);
    }
    if (!a.renderInline) {
      blockers.push('renderInline is not true');
    }
    if (urlTrimmedLength === 0) {
      blockers.push('url is missing or whitespace-only (H1: primary suspect for empty iframe)');
    }
    const wouldRenderInlinePdf = blockers.length === 0;
    return {
      id: a.id,
      title: a.title ?? '',
      attachmentType: a.attachmentType,
      renderInline: Boolean(a.renderInline),
      urlTrimmedLength,
      wouldRenderInlinePdf,
      blockers
    };
  });

  const wouldRenderAnyInlinePdf = attachments.some(a => a.wouldRenderInlinePdf);

  return {
    hypothesis: 'H1',
    stepId: step.id,
    wouldRenderAnyInlinePdf,
    attachments
  };
}

function readLastAdminSaveMeta(): { savedAtIso: string; fingerprint: string } | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(TRAINING_LIBRARY_CLIENT_META_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAtIso?: string; fingerprint?: string };
    if (typeof parsed.savedAtIso === 'string' && typeof parsed.fingerprint === 'string') {
      return { savedAtIso: parsed.savedAtIso, fingerprint: parsed.fingerprint };
    }
  } catch {
    // ignore
  }
  return null;
}

export function diagnoseH2AgentLibraryVsAdminSave(
  modules: TrainingModule[],
  loadedAtIso: string
): H2StaleDataDiagnostic {
  const libraryFingerprint = buildTrainingLibraryAttachmentFingerprint(modules);
  const lastAdminSave = readLastAdminSaveMeta();

  let matchVsLastAdminSave: boolean | 'no-admin-marker' = 'no-admin-marker';
  if (lastAdminSave) {
    matchVsLastAdminSave = lastAdminSave.fingerprint === libraryFingerprint;
  }

  let note: string;
  if (!lastAdminSave) {
    note =
      'No prior admin Save Library marker in this browser. H2 cannot detect stale tabs here; use Save Library after edits, or hard-refresh the agent page.';
  } else if (matchVsLastAdminSave === true) {
    note =
      'Fingerprint matches last admin save in this browser — attachment metadata is consistent with last save (still verify server persistence separately).';
  } else {
    note =
      'Fingerprint differs from last admin save in this browser — agent may be showing older server data, or another tab changed the library (H2: stale data plausible).';
  }

  return {
    hypothesis: 'H2',
    loadedAtIso,
    libraryFingerprint,
    lastAdminSave,
    matchVsLastAdminSave,
    note
  };
}

export function writeAdminSaveClientMeta(modules: TrainingModule[]): { savedAtIso: string; fingerprintLength: number } | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }
  try {
    const payload = {
      savedAtIso: new Date().toISOString(),
      fingerprint: buildTrainingLibraryAttachmentFingerprint(modules)
    };
    window.localStorage.setItem(TRAINING_LIBRARY_CLIENT_META_KEY, JSON.stringify(payload));
    return { savedAtIso: payload.savedAtIso, fingerprintLength: payload.fingerprint.length };
  } catch {
    return null;
  }
}

export function logAdminSaveRecordedToConsole(meta: { savedAtIso: string; fingerprintLength: number } | null): void {
  if (!isTrainingDiagnosticsConsoleEnabled()) {
    return;
  }
   
  console.groupCollapsed('[Training diagnostics] H2 — Admin Save Library recorded (this browser)');
  if (!meta) {
     
    console.log('Could not persist client marker (no localStorage or quota).');
  } else {
     
    console.log('savedAtIso:', meta.savedAtIso);
     
    console.log('fingerprint length:', meta.fingerprintLength);
  }
   
  console.groupEnd();
}

/**
 * Logs H1/H2 diagnostics to the browser devtools console (collapsed groups).
 */
export function logH1ToConsole(diag: H1InlinePdfDiagnostic | null, context?: string): void {
  if (!isTrainingDiagnosticsConsoleEnabled()) {
    return;
  }
   
  console.groupCollapsed(
    `[Training diagnostics] H1 — Inline PDF flags / URL${context ? ` (${context})` : ''}`
  );
  if (!diag) {
     
    console.log('No step — skipped.');
     
    console.groupEnd();
    return;
  }
   
  console.log('wouldRenderAnyInlinePdf:', diag.wouldRenderAnyInlinePdf);
   
  console.table(diag.attachments.map(a => ({
    id: a.id,
    title: a.title,
    type: a.attachmentType,
    renderInline: a.renderInline,
    urlLen: a.urlTrimmedLength,
    inlineOk: a.wouldRenderInlinePdf,
    blockers: a.blockers.join(' | ') || '—'
  })));
   
  console.groupEnd();
}

export function logH2ToConsole(diag: H2StaleDataDiagnostic): void {
  if (!isTrainingDiagnosticsConsoleEnabled()) {
    return;
  }
   
  console.groupCollapsed('[Training diagnostics] H2 — Agent load vs last admin save (this browser)');
   
  console.log('loadedAtIso:', diag.loadedAtIso);
   
  console.log('matchVsLastAdminSave:', diag.matchVsLastAdminSave);
   
  console.log('note:', diag.note);
  if (diag.lastAdminSave) {
     
    console.log('lastAdminSave.savedAtIso:', diag.lastAdminSave.savedAtIso);
  }
   
  console.log('libraryFingerprint (length):', diag.libraryFingerprint.length);
   
  console.groupEnd();
}
