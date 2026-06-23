// frontend/src/components/groups/__tests__/DeleteProductConfirmModal.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DeleteProductConfirmModal from '../DeleteProductConfirmModal';

describe('DeleteProductConfirmModal', () => {
  it('shows no-enrollment copy when count is 0', () => {
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByRole('heading', {
        name: (name) => /remove/i.test(name) && /bronze plan/i.test(name) && /from this group/i.test(name),
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/will no longer appear in enrollment links/i)).toBeInTheDocument();
    expect(screen.queryByText(/currently enrolled/i)).not.toBeInTheDocument();
  });

  it('shows enrollment-impact copy when count > 0', () => {
    render(
      <DeleteProductConfirmModal
        productName="Silver Plan"
        enrollmentCount={3}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByText(/3 members are currently enrolled/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/their enrollments will continue unchanged/i)
    ).toBeInTheDocument();
  });

  it('uses singular "member" when count is 1', () => {
    render(
      <DeleteProductConfirmModal
        productName="Silver Plan"
        enrollmentCount={1}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/1 member is currently enrolled/i)).toBeInTheDocument();
  });

  it('calls onConfirm when Remove is clicked', async () => {
    const onConfirm = vi.fn();
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={0}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state when isLoading is true', () => {
    render(
      <DeleteProductConfirmModal
        productName="Bronze Plan"
        enrollmentCount={null}
        isLoading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Checking enrollments/i)).toBeInTheDocument();
  });
});
