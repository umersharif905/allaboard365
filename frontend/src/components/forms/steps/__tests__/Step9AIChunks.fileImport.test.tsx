import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Step9AIChunks from '../Step9AIChunks';
import type { ProductFormData } from '../../../../types/sysadmin/addproductswizard.types';

vi.mock('../../../../hooks/useProductChunks', () => ({
  useProductChunks: vi.fn(() => ({ data: [] })),
  useRegenerateAll: vi.fn(() => ({ isPending: false, mutate: vi.fn() })),
}));

vi.mock('../../../../hooks/useProductDocuments', () => ({
  useProductDocuments: vi.fn(() => ({ data: [] })),
  useRegenerateDocument: vi.fn(() => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  })),
}));

const baseFormData = {
  name: 'Test Product',
  aiChunks: [],
} as ProductFormData;

function renderStep9(
  formData: ProductFormData = baseFormData,
  updateFormData = vi.fn()
) {
  return {
    updateFormData,
    ...render(
      <Step9AIChunks
        formData={formData}
        updateFormData={updateFormData}
      />
    ),
  };
}

describe('Step9AIChunks file import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accept attribute includes PDF and document types', () => {
    renderStep9();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.accept).toContain('.pdf');
    expect(input.accept).toContain('.doc');
    expect(input.accept).toContain('.docx');
    expect(input.accept).toContain('.txt');
    expect(input.accept).toContain('.md');
  });

  it('stages PDF into productDocumentFiles instead of reading as text', () => {
    const updateFormData = vi.fn();
    renderStep9(baseFormData, updateFormData);

    const pdf = new File(['%PDF-1.4'], 'plan.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdf] } });

    expect(updateFormData).toHaveBeenCalledWith({
      productDocumentFiles: [{ file: pdf, displayName: 'plan.pdf' }],
    });
    expect(screen.getByText(/plan\.pdf.*staged for AI extraction on save/i)).toBeInTheDocument();
  });

  it('routes .txt files through text import instead of document staging', () => {
    const readAsTextSpy = vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(() => {});

    const updateFormData = vi.fn();
    renderStep9(baseFormData, updateFormData);

    const txt = new File(['Chunk one\n\nChunk two'], 'notes.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [txt] } });

    expect(updateFormData).not.toHaveBeenCalled();
    expect(readAsTextSpy).toHaveBeenCalledWith(txt);
  });
});
