import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useColumbusChat } from '../useColumbusChat';

const encoder = new TextEncoder();
const sseLines = (parts: string[]) =>
  encoder.encode(parts.map(p => `data: ${p}\n`).join('') + '\n');

const mockStream = (lines: string[]) => ({
  body: {
    getReader: () => {
      const chunks = [sseLines(lines)];
      return {
        read: vi.fn()
          .mockImplementationOnce(async () => ({ done: false, value: chunks[0] }))
          .mockResolvedValue({ done: true, value: undefined }),
      };
    },
  },
  ok: true,
  status: 200,
});

beforeEach(() => {
  (global.fetch as any) = vi.fn();
});

describe('useColumbusChat', () => {
  it('appends tokens to the assistant message as they stream', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 }); // health check
    (global.fetch as any).mockResolvedValueOnce(mockStream([
      JSON.stringify({ token: 'Hello' }),
      JSON.stringify({ token: ' world' }),
      '[DONE]',
    ]));

    const { result } = renderHook(() => useColumbusChat('jwt-x'));
    await waitFor(() => expect(result.current.isOnline).toBe(true));
    await act(async () => { await result.current.sendMessage('hi'); });
    await waitFor(() => {
      const last = result.current.messages[result.current.messages.length - 1];
      expect(last.role).toBe('assistant');
      expect(last.content).toBe('Hello world');
    });
  });

  it('surfaces an error when fetch returns 401', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 });
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401 });
    const { result } = renderHook(() => useColumbusChat('bad-jwt'));
    await waitFor(() => expect(result.current.isOnline).toBe(true));
    await act(async () => { await result.current.sendMessage('hi'); });
    const last = result.current.messages[result.current.messages.length - 1];
    expect(last.error).toBe(true);
  });

  it('marks isOnline=false when health check fails', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('network'));
    const { result } = renderHook(() => useColumbusChat('jwt'));
    await waitFor(() => expect(result.current.isOnline).toBe(false));
  });
});
