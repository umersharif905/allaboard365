import { renderHook, act } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useInFlightGuard } from '../useInFlightGuard';

describe('useInFlightGuard', () => {
  test('rejects synchronous duplicate invocations (the useState gap)', async () => {
    let runCount = 0;
    const { result } = renderHook(() => useInFlightGuard());

    const run = async () => {
      await result.current.guard(async () => {
        runCount++;
        await new Promise(r => setTimeout(r, 10));
      });
    };

    // Fire 5 in the same synchronous tick
    await act(async () => {
      await Promise.all([run(), run(), run(), run(), run()]);
    });

    expect(runCount).toBe(1);
  });

  test('allows next invocation after completion', async () => {
    let runCount = 0;
    const { result } = renderHook(() => useInFlightGuard());

    await act(async () => {
      await result.current.guard(async () => { runCount++; });
    });
    await act(async () => {
      await result.current.guard(async () => { runCount++; });
    });

    expect(runCount).toBe(2);
  });

  test('clears the flag even if the wrapped fn throws', async () => {
    const { result } = renderHook(() => useInFlightGuard());

    await act(async () => {
      await expect(
        result.current.guard(async () => { throw new Error('boom'); })
      ).rejects.toThrow('boom');
    });

    // Next call should proceed
    let ran = false;
    await act(async () => {
      await result.current.guard(async () => { ran = true; });
    });
    expect(ran).toBe(true);
  });
});
