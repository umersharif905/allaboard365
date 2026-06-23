import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GroupBadge, PendingMigrationBadge } from '../GroupBadge';

describe('GroupBadge', () => {
  it('renders nothing for Standard group type', () => {
    const { container } = render(<GroupBadge type="Standard" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "List Bill" text for ListBill group type', () => {
    render(<GroupBadge type="ListBill" />);
    expect(screen.getByText('List Bill')).toBeInTheDocument();
  });

  it('applies the prominent green background class for ListBill badge', () => {
    render(<GroupBadge type="ListBill" />);
    const badge = screen.getByText('List Bill');
    expect(badge).toHaveClass('bg-green-100');
  });

  it('applies the green-800 text class for ListBill badge', () => {
    render(<GroupBadge type="ListBill" />);
    const badge = screen.getByText('List Bill');
    expect(badge).toHaveClass('text-green-800');
  });

  it('uses small padding by default', () => {
    render(<GroupBadge type="ListBill" />);
    const badge = screen.getByText('List Bill');
    expect(badge).toHaveClass('px-2.5');
    expect(badge).toHaveClass('text-xs');
  });

  it('uses larger padding when size="md"', () => {
    render(<GroupBadge type="ListBill" size="md" />);
    const badge = screen.getByText('List Bill');
    expect(badge).toHaveClass('px-3');
    expect(badge).toHaveClass('text-sm');
  });
});

describe('PendingMigrationBadge', () => {
  it('renders pending migration label', () => {
    render(<PendingMigrationBadge isE123Migrated pendingMemberCount={3} />);
    expect(screen.getByText('Pending migration')).toBeInTheDocument();
  });
});
