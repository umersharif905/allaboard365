import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldPalette } from '../FieldPalette';

describe('FieldPalette', () => {
  it('renders a Provider search tile that fires onAdd', () => {
    const onAdd = vi.fn();
    render(<FieldPalette onAdd={onAdd} onAddMember={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Add Provider search'));
    expect(onAdd).toHaveBeenCalledWith('provider_search');
  });

  it('renders pre-keyed Member info tiles that fire onAddMember with the canonical key', () => {
    const onAddMember = vi.fn();
    render(<FieldPalette onAdd={vi.fn()} onAddMember={onAddMember} />);
    fireEvent.click(screen.getByTitle(/Add Date of birth/i));
    expect(onAddMember).toHaveBeenCalledWith(
      expect.objectContaining({ field: expect.objectContaining({ name: 'dateOfBirth', type: 'date' }) })
    );
  });
});
