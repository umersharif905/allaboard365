import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SignInToSaveModal } from '../SignInToSaveModal';
import { authService } from '../../../services/auth.service';

vi.mock('../../../services/auth.service', () => ({
  authService: {
    requestLoginOtpPortal: vi.fn(),
    verifyLoginOtpPortal: vi.fn(),
    login: vi.fn()
  }
}));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const req = authService.requestLoginOtpPortal as ReturnType<typeof vi.fn>;
const verify = authService.verifyLoginOtpPortal as ReturnType<typeof vi.fn>;

describe('SignInToSaveModal — multi-account (needsAccountChoice)', () => {
  it('shows an account picker instead of dead-ending when one email maps to several portals', async () => {
    req.mockResolvedValueOnce({
      success: true,
      codeSent: false,
      needsAccountChoice: true,
      accountChoices: [
        { userId: 'u-agent', label: 'Alex Agent (Agent)' },
        { userId: 'u-member', label: 'Alex Agent (Member)' }
      ]
    });

    render(
      <SignInToSaveModal open onClose={() => {}} onAuthenticated={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText(/Email or phone/i), {
      target: { value: 'alex@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Email\/text me a code/i }));

    // The picker appears — the previous behaviour threw the message as an error.
    expect(await screen.findByText(/Choose yours to continue/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Alex Agent \(Member\)/i })).toBeInTheDocument();

    // Choosing an account re-requests the OTP scoped to that userId.
    req.mockResolvedValueOnce({ success: true, codeSent: true, challengeId: 'ch-1', maskedDestination: 'a***@example.com' });
    fireEvent.click(screen.getByRole('button', { name: /Alex Agent \(Member\)/i }));

    await waitFor(() => {
      expect(req).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: 'u-member', channel: 'auto' })
      );
    });
    // Now on the code-entry step.
    expect(await screen.findByText(/sent a 6-digit code/i)).toBeInTheDocument();
  });

  it('still verifies the code after an account is chosen', async () => {
    req.mockResolvedValueOnce({ success: true, codeSent: true, challengeId: 'ch-9' });
    const onAuth = vi.fn().mockResolvedValue(undefined);
    verify.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r' });

    render(<SignInToSaveModal open onClose={() => {}} onAuthenticated={onAuth} />);
    fireEvent.change(screen.getByLabelText(/Email or phone/i), { target: { value: 'x@y.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Email\/text me a code/i }));

    const codeInput = await screen.findByLabelText(/Enter the 6-digit code/i);
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & save/i }));

    await waitFor(() => expect(onAuth).toHaveBeenCalledWith('a', 'r'));
  });
});
