import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldInspector } from '../FieldInspector';
import type { FieldDef } from '../../../../types/publicFormDefinition';

const baseField: FieldDef = {
  name: 'provider_1',
  type: 'provider_search',
  label: 'Find your provider',
  required: false,
  providerSearchMode: 'individual'
};

describe('FieldInspector — provider_search', () => {
  it('renders the mode picker and emits providerSearchMode on change', () => {
    const onChange = vi.fn();
    render(
      <FieldInspector
        field={baseField}
        nameDuplicate={false}
        multiPage={false}
        pages={[]}
        onChange={onChange}
        onRemove={() => {}}
        onClose={() => {}}
      />
    );
    const select = screen.getByLabelText('Provider search mode') as HTMLSelectElement;
    expect(select.value).toBe('individual');
    fireEvent.change(select, { target: { value: 'organization' } });
    expect(onChange).toHaveBeenCalledWith({ providerSearchMode: 'organization' });
  });
});
