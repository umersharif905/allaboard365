import { describe, expect, it } from 'vitest';
import {
  computeAiPreviewIncludedFee,
  computeAiPreviewMemberTotal,
  resolveAiFeePreviewSettings,
  resolveAiPreviewBandAmounts,
} from '../productAiFeePreview';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';

const baseForm = {
  includeProcessingFee: false,
  roundUpProcessingFee: true,
  processingFeePercentage: null,
} as unknown as ProductFormData;

describe('productAiFeePreview', () => {
  it('resolveAiFeePreviewSettings prefers patch fee fields', () => {
    const settings = resolveAiFeePreviewSettings(baseForm, {
      includeProcessingFee: true,
      processingFeePercentage: 3.5,
      roundUpProcessingFee: true,
    } as never);
    expect(settings.includeProcessingFee).toBe(true);
    expect(settings.processingFeePercentage).toBe(3.5);
    expect(settings.fromPatch).toBe(true);
  });

  it('computeAiPreviewMemberTotal round-up matches wizard whole-dollar MSRP', () => {
    const total = computeAiPreviewMemberTotal(135.75, {
      includeProcessingFee: true,
      roundUpProcessingFee: true,
      processingFeePercentage: 3.5,
      fromPatch: true,
    });
    expect(total!.processingFee).toBe(5.25);
    expect(total!.memberTotal).toBe(141);
  });

  it('computeAiPreviewIncludedFee round-up bumps fee so base+fee is whole dollar', () => {
    const settings = {
      includeProcessingFee: true,
      roundUpProcessingFee: true,
      processingFeePercentage: 3.5,
      fromPatch: true,
    };
    const low = computeAiPreviewIncludedFee(100, 0, 0, 4.75, settings);
    const high = computeAiPreviewIncludedFee(200, 0, 0, 4.75, settings);
    expect(low).toBe(4);
    expect(high).toBe(7);
    expect(low).not.toBe(high);
  });

  it('resolveAiPreviewBandAmounts yields whole-dollar MSRP when round-up on', () => {
    const settings = {
      includeProcessingFee: true,
      roundUpProcessingFee: true,
      processingFeePercentage: 3,
      fromPatch: false,
    };
    const { msrp } = resolveAiPreviewBandAmounts(
      { netRate: 253.6, overrideRate: 60, commission: 60.5, msrpRate: 374.1 },
      settings,
      null,
      false
    );
    expect(msrp % 1).toBe(0);
  });

  it('resolveAiPreviewBandAmounts uses hand-entered fee only in manual mode', () => {
    const settings = {
      includeProcessingFee: true,
      roundUpProcessingFee: false,
      processingFeePercentage: 3.5,
      fromPatch: true,
    };
    const auto = resolveAiPreviewBandAmounts(
      { netRate: 100, overrideRate: 0, commission: 0, includedProcessingFee: 9.99, msrpRate: 100 },
      settings,
      null,
      false
    );
    expect(auto.includedFee).toBe(3.5);
    expect(auto.msrp).toBe(103.5);

    const manual = resolveAiPreviewBandAmounts(
      { netRate: 100, overrideRate: 0, commission: 0, includedProcessingFee: 6.25, msrpRate: 106.25 },
      settings,
      null,
      true
    );
    expect(manual.includedFee).toBe(6.25);
    expect(manual.msrp).toBe(106.25);
  });
});
