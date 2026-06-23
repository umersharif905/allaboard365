import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldInspector } from '../FieldInspector';
import type { FieldDef } from '../../../../types/publicFormDefinition';

function renderInspector(field: FieldDef, onChange = vi.fn()) {
  render(
    <FieldInspector
      field={field}
      nameDuplicate={false}
      multiPage={false}
      pages={[]}
      onChange={onChange}
      onRemove={vi.fn()}
      onClose={vi.fn()}
    />
  );
  return onChange;
}

describe('FieldInspector — Autofills from member', () => {
  it('selecting a member concept sets the field key to its canonical key', () => {
    const onChange = renderInspector({ name: 'ay_dob', type: 'date', label: 'Date of birth' });
    const select = screen.getByRole('combobox', { name: /autofills from member/i });
    expect((select as HTMLSelectElement).value).toBe(''); // ay_dob is not canonical
    fireEvent.change(select, { target: { value: 'dateOfBirth' } });
    expect(onChange).toHaveBeenCalledWith({ name: 'dateOfBirth' });
  });

  it('shows the autofill badge when the field key is already canonical', () => {
    renderInspector({ name: 'addressZip', type: 'text', label: 'ZIP code' });
    const select = screen.getByRole('combobox', { name: /autofills from member/i });
    expect((select as HTMLSelectElement).value).toBe('addressZip');
    expect(screen.getByText(/Autofills ZIP code when the member is signed in/i)).toBeInTheDocument();
  });

  it('shows no badge and no selection for a non-member field key', () => {
    renderInspector({ name: 'surg_procedure', type: 'text', label: 'Procedure' });
    const select = screen.getByRole('combobox', { name: /autofills from member/i });
    expect((select as HTMLSelectElement).value).toBe('');
    expect(screen.queryByText(/when the member is signed in/i)).not.toBeInTheDocument();
  });
});
