// frontend/src/components/groups/__tests__/ASARequiredBanner.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ASARequiredBanner, { ASAStatusItem } from '../ASARequiredBanner';

const item = (over: Partial<ASAStatusItem> = {}): ASAStatusItem => ({
  productId: 'p-1',
  productName: 'Bronze',
  documentId: 'doc-1',
  documentName: 'MightyWELL Master ASA',
  documentUrl: 'https://example.com/asa.pdf',
  signed: false,
  ...over,
});

describe('ASARequiredBanner', () => {
  it('renders nothing when there are no unsigned documents', () => {
    const { container } = render(
      <ASARequiredBanner
        asaStatus={[item({ signed: true })]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the status array is empty', () => {
    const { container } = render(
      <ASARequiredBanner asaStatus={[]} canSign={false} onSign={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows one row per unique unsigned document', () => {
    render(
      <ASARequiredBanner
        asaStatus={[
          item({ productId: 'p-1', documentId: 'doc-1', documentName: 'MightyWELL Master ASA' }),
          item({ productId: 'p-2', documentId: 'doc-1', documentName: 'MightyWELL Master ASA' }),
          item({ productId: 'p-3', documentId: 'doc-2', documentName: 'Acme Vendor ASA' }),
        ]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(screen.getAllByText('MightyWELL Master ASA')).toHaveLength(1);
    expect(screen.getByText('Acme Vendor ASA')).toBeInTheDocument();
  });

  it('shows Sign buttons in the canSign variant', () => {
    render(
      <ASARequiredBanner
        asaStatus={[item()]}
        canSign={true}
        onSign={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Sign/ })).toBeInTheDocument();
  });

  it('shows informational text in the read-only variant', () => {
    render(
      <ASARequiredBanner
        asaStatus={[item()]}
        canSign={false}
        onSign={vi.fn()}
      />
    );
    expect(screen.getByText(/Awaiting group admin signature/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign/ })).not.toBeInTheDocument();
  });

  it('invokes onSign with the correct documentId when Sign is clicked', async () => {
    const onSign = vi.fn();
    render(
      <ASARequiredBanner
        asaStatus={[item({ documentId: 'doc-42', documentName: 'Doc 42' })]}
        canSign={true}
        onSign={onSign}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Sign/ }));
    expect(onSign).toHaveBeenCalledWith('doc-42');
  });
});
