// frontend/src/components/groups/__tests__/HiddenProductsSection.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HiddenProductsSection from '../HiddenProductsSection';
import type { HiddenProductWithEnrollments } from '../../../services/group-products.service';

const product = (over: Partial<HiddenProductWithEnrollments> = {}): HiddenProductWithEnrollments => ({
  productId: 'p-1',
  productName: 'Bronze',
  enrollmentCount: 1,
  members: [{ memberId: 'm-1', fullName: 'Jane Doe', enrolledDate: '2026-01-15T00:00:00.000Z' }],
  ...over,
});

describe('HiddenProductsSection', () => {
  it('renders nothing when the products array is empty', () => {
    const { container } = render(<HiddenProductsSection products={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one collapsed row per product with the count', () => {
    render(
      <HiddenProductsSection
        products={[
          product({ productId: 'p-1', productName: 'Bronze', enrollmentCount: 3 }),
          product({ productId: 'p-2', productName: 'Silver', enrollmentCount: 1 }),
        ]}
      />
    );
    expect(screen.getByText('Bronze')).toBeInTheDocument();
    expect(screen.getByText(/3 members enrolled/)).toBeInTheDocument();
    expect(screen.getByText('Silver')).toBeInTheDocument();
    expect(screen.getByText(/1 member enrolled/)).toBeInTheDocument();
  });

  it('expands a row to show member names and enrolled dates', async () => {
    render(
      <HiddenProductsSection
        products={[
          product({
            productName: 'Bronze',
            enrollmentCount: 2,
            members: [
              { memberId: 'm-1', fullName: 'Jane Doe',   enrolledDate: '2026-01-15T00:00:00.000Z' },
              { memberId: 'm-2', fullName: 'John Smith', enrolledDate: '2025-11-02T00:00:00.000Z' },
            ],
          }),
        ]}
      />
    );
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Bronze/ }));
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
  });
});
