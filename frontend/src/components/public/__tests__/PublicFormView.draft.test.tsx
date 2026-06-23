import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { PublicFormView } from '../PublicFormView';
import type { FormDefinition } from '../../../types/publicFormDefinition';

afterEach(cleanup);

const def: FormDefinition = {
  version: 1,
  title: 'Test form',
  fields: [
    { name: 'note', type: 'text', label: 'A note', required: false },
    { name: 'doc', type: 'file', label: 'A document', required: false }
  ]
};

function makeDraft(overrides = {}) {
  return {
    onValuesChange: vi.fn(),
    stagedFiles: [],
    stageFile: vi.fn(),
    removeStagedFile: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('PublicFormView — draft mode', () => {
  it('calls onValuesChange when a field is edited', () => {
    const draft = makeDraft();
    render(<PublicFormView definition={def} pageTitle="t" formId="f1" draft={draft} />);
    fireEvent.change(screen.getByLabelText(/A note/i), { target: { value: 'hello' } });
    expect(draft.onValuesChange).toHaveBeenCalled();
  });

  it('stages a selected file instead of holding it in memory', () => {
    const draft = makeDraft();
    render(<PublicFormView definition={def} pageTitle="t" formId="f1" draft={draft} />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'notes.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(draft.stageFile).toHaveBeenCalledWith('doc', file);
  });

  it('renders staged files with a remove action', () => {
    const draft = makeDraft({
      stagedFiles: [{ draftFileId: 'fa', fieldName: 'doc', originalFileName: 'records.pdf' }]
    });
    const { container } = render(
      <PublicFormView definition={def} pageTitle="t" formId="f1" draft={draft} />
    );
    expect(screen.getByText('records.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('draft-remove-file'));
    expect(draft.removeStagedFile).toHaveBeenCalledWith('fa');
    expect(container).toBeTruthy();
  });

  it('submits via draft.submit (promote) instead of the anonymous endpoint', async () => {
    const textOnly: FormDefinition = {
      version: 1,
      title: 'Test',
      fields: [{ name: 'note', type: 'text', label: 'A note', required: false }]
    };
    const draft = makeDraft();
    const { container } = render(
      <PublicFormView definition={textOnly} pageTitle="t" formId="f1" draft={draft} onSubmitSuccess={vi.fn()} />
    );
    const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    fireEvent.click(submitBtn);
    await waitFor(() => expect(draft.submit).toHaveBeenCalled());
  });
});
