import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSessionReplayUrl = vi.fn();

vi.mock('posthog-js', () => ({
  default: {
    init: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    get_session_replay_url: (...args: unknown[]) => getSessionReplayUrl(...args),
  },
}));

describe('getPostHogSessionReplayUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    getSessionReplayUrl.mockReset();
    // initPostHog() bails without an API key (analytics disabled), so set one
    // before each dynamic import so init actually wires up the mocked SDK.
    vi.stubEnv('VITE_POSTHOG_API_KEY', 'phc_test_key');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns undefined before PostHog is initialized', async () => {
    const { getPostHogSessionReplayUrl } = await import('../posthog');
    expect(getPostHogSessionReplayUrl()).toBeUndefined();
    expect(getSessionReplayUrl).not.toHaveBeenCalled();
  });

  it('returns replay URL after init when SDK provides one', async () => {
    getSessionReplayUrl.mockReturnValue('https://us.posthog.com/replay/abc');
    const mod = await import('../posthog');
    mod.initPostHog();
    expect(mod.getPostHogSessionReplayUrl()).toBe('https://us.posthog.com/replay/abc');
    expect(getSessionReplayUrl).toHaveBeenCalledWith({
      withTimestamp: true,
      timestampLookBack: 30,
    });
  });

  it('returns undefined when SDK throws', async () => {
    getSessionReplayUrl.mockImplementation(() => {
      throw new Error('recording off');
    });
    const mod = await import('../posthog');
    mod.initPostHog();
    expect(mod.getPostHogSessionReplayUrl()).toBeUndefined();
  });

  it('returns undefined for non-http URLs', async () => {
    getSessionReplayUrl.mockReturnValue('not-a-url');
    const mod = await import('../posthog');
    mod.initPostHog();
    expect(mod.getPostHogSessionReplayUrl()).toBeUndefined();
  });
});
