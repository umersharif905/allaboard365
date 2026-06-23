import { describe, expect, it } from 'vitest';

import {
  buildTrainingLibraryAttachmentFingerprint,
  diagnoseH1InlinePdfEligibility
} from '../trainingPlayerDiagnostics';
import type { ModuleStep, TrainingModule } from '../trainingTypes';

function minimalModule(overrides: Partial<TrainingModule> = {}): TrainingModule {
  return {
    id: 'mod-1',
    title: 'T',
    modulePurpose: '',
    defaultRequired: true,
    moduleSteps: [],
    attachments: [],
    ...overrides
  };
}

describe('trainingPlayerDiagnostics', () => {
  describe('H1 — diagnoseH1InlinePdfEligibility', () => {
    it('returns wouldRenderAnyInlinePdf false when url is empty (hypothesis: missing URL)', () => {
      const step: ModuleStep = {
        id: 's1',
        title: '',
        subtitle: '',
        copy: '',
        attachments: [
          {
            id: 'a1',
            title: 'Guide',
            url: '   ',
            attachmentType: 'pdf',
            renderInline: true
          }
        ]
      };
      const d = diagnoseH1InlinePdfEligibility(step);
      expect(d).not.toBeNull();
      expect(d!.wouldRenderAnyInlinePdf).toBe(false);
      expect(d!.attachments[0].blockers.some(b => b.includes('url'))).toBe(true);
    });

    it('returns wouldRenderAnyInlinePdf true when pdf + renderInline + url (hypothesis satisfied)', () => {
      const step: ModuleStep = {
        id: 's1',
        title: '',
        subtitle: '',
        copy: '',
        attachments: [
          {
            id: 'a1',
            title: 'Guide',
            url: 'https://example.com/doc.pdf',
            attachmentType: 'pdf',
            renderInline: true
          }
        ]
      };
      const d = diagnoseH1InlinePdfEligibility(step);
      expect(d!.wouldRenderAnyInlinePdf).toBe(true);
      expect(d!.attachments[0].blockers).toHaveLength(0);
    });

    it('flags non-pdf type', () => {
      const step: ModuleStep = {
        id: 's1',
        title: '',
        subtitle: '',
        copy: '',
        attachments: [
          {
            id: 'a1',
            title: 'Guide',
            url: 'https://example.com/doc.pdf',
            attachmentType: 'link',
            renderInline: true
          }
        ]
      };
      const d = diagnoseH1InlinePdfEligibility(step);
      expect(d!.wouldRenderAnyInlinePdf).toBe(false);
    });
  });

  describe('H2 — buildTrainingLibraryAttachmentFingerprint', () => {
    it('changes when attachment url length changes (detect stale payloads)', () => {
      const m1 = minimalModule({
        moduleSteps: [
          {
            id: 'st1',
            title: '',
            subtitle: '',
            copy: '',
            attachments: [
              {
                id: 'a1',
                title: 'x',
                url: 'https://a.com/1.pdf',
                attachmentType: 'pdf',
                renderInline: true
              }
            ]
          }
        ]
      });
      const m2 = minimalModule({
        moduleSteps: [
          {
            id: 'st1',
            title: '',
            subtitle: '',
            copy: '',
            attachments: [
              {
                id: 'a1',
                title: 'x',
                url: 'https://a.com/changed-longer-url-2.pdf',
                attachmentType: 'pdf',
                renderInline: true
              }
            ]
          }
        ]
      });
      expect(buildTrainingLibraryAttachmentFingerprint([m1])).not.toBe(
        buildTrainingLibraryAttachmentFingerprint([m2])
      );
    });
  });
});
