/**
 * @vitest-environment jsdom
 *
 * Tests for the "Filtered group" audience mode on the Message Blast page.
 *
 * Covers:
 *   - Both recipient modes render (Specific people / Filtered group)
 *   - Switching to Filtered group reveals the Audience selector
 *   - Choosing "members in a product / bundle" lists products from audience-options
 *     (with a "(bundle)" tag) and prompts to select one
 *   - Once a product is selected, audience-count is fetched and the resolved
 *     recipient count + opt-out exclusions are shown
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// RichTextEditor pulls in heavy deps — stub it.
vi.mock('../../../components/common/RichTextEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="email-body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('../../../services/api.service', () => ({
  apiService: {
    get: (...a: unknown[]) => getMock(...a),
    post: (...a: unknown[]) => postMock(...a),
  },
}));

import MessageBlastPage from '../MessageBlastPage';

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url.includes('/agents')) {
      return Promise.resolve({ success: true, data: [] });
    }
    if (url.includes('/audience-options')) {
      return Promise.resolve({
        success: true,
        data: {
          products: [
            { id: 'p1', name: 'Dental', isBundle: false },
            { id: 'p2', name: 'Family Bundle', isBundle: true },
          ],
          agencies: [{ id: 'a1', name: 'Acme Agency' }],
        },
      });
    }
    return Promise.resolve({ success: false });
  });
  postMock.mockResolvedValue({
    success: true,
    data: { emailRecipients: 42, smsRecipients: 10, emailOptedOut: 3, smsOptedOut: 1, maxRecipients: 5000 },
  });
});

it('renders both recipient modes', async () => {
  render(<MessageBlastPage />);
  expect(await screen.findByText('Specific people')).toBeInTheDocument();
  expect(screen.getByText('Filtered group')).toBeInTheDocument();
});

it('reveals the Audience selector and product list when switching to Filtered group', async () => {
  const user = userEvent.setup();
  render(<MessageBlastPage />);

  await user.click(await screen.findByText('Filtered group'));

  // Audience dropdown appears
  const select = await screen.findByRole('combobox');
  expect(select).toBeInTheDocument();

  // Choose the product/bundle audience
  await user.selectOptions(select, 'members_by_product');

  // Products from audience-options are listed, bundle is tagged
  expect(await screen.findByText('Dental')).toBeInTheDocument();
  expect(screen.getByText('Family Bundle')).toBeInTheDocument();
  expect(screen.getByText('(bundle)')).toBeInTheDocument();

  // Before any product is selected, it prompts for one and does NOT call count
  expect(screen.getByText(/Select at least one product or bundle/i)).toBeInTheDocument();
  expect(postMock).not.toHaveBeenCalled();
});

it('fetches and displays the resolved recipient count after selecting a product', async () => {
  const user = userEvent.setup();
  render(<MessageBlastPage />);

  await user.click(await screen.findByText('Filtered group'));
  await user.selectOptions(await screen.findByRole('combobox'), 'members_by_product');
  await user.click(await screen.findByText('Dental'));

  // audience-count POST fires with the selected product
  await waitFor(() => {
    expect(postMock).toHaveBeenCalledWith(
      '/api/me/tenant-admin/message-blast/audience-count',
      expect.objectContaining({ audienceType: 'members_by_product', productIds: ['p1'] })
    );
  });

  // Email recipients shown (email is the default channel), plus opt-out note
  expect(await screen.findByText(/42 email recipients/i)).toBeInTheDocument();
  expect(screen.getByText(/Excluded due to marketing opt-out/i)).toBeInTheDocument();
});
