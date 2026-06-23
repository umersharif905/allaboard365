import { describe, it, expect } from 'vitest';
import {
  pickReturnPathFromRouterState,
  resolvePostLoginPath,
  getSafeInternalReturnPath,
} from '../postLoginRedirect';

describe('postLoginRedirect', () => {
  describe('pickReturnPathFromRouterState', () => {
    it('reads pathname from React Router shape { from: Location }', () => {
      const state = {
        from: {
          pathname: '/member/payments',
          search: '?invoice=test-123',
          hash: '',
        },
      };
      expect(pickReturnPathFromRouterState(state)).toBe('/member/payments?invoice=test-123');
    });

    it('still supports flat location-shaped state (backward compat)', () => {
      const state = {
        pathname: '/agent/clients',
        search: '?tab=open',
        hash: '#x',
      };
      expect(pickReturnPathFromRouterState(state)).toBe('/agent/clients?tab=open#x');
    });

    it('returns null for missing pathname', () => {
      expect(pickReturnPathFromRouterState({ from: {} })).toBeNull();
      expect(pickReturnPathFromRouterState(null)).toBeNull();
    });

    it('rejects login as return target', () => {
      expect(
        pickReturnPathFromRouterState({
          from: { pathname: '/login', search: '', hash: '' },
        }),
      ).toBeNull();
    });
  });

  describe('resolvePostLoginPath', () => {
    it('prefers query param over router state', () => {
      const sp = new URLSearchParams('returnUrl=/from-query');
      const out = resolvePostLoginPath({
        searchParams: sp,
        routerState: {
          from: { pathname: '/from-state', search: '', hash: '' },
        },
        roleDefault: '/member/dashboard',
      });
      expect(out).toBe('/from-query');
    });

    it('uses nested from when no query return', () => {
      const sp = new URLSearchParams();
      const out = resolvePostLoginPath({
        searchParams: sp,
        routerState: {
          from: { pathname: '/member/payments', search: '?invoice=a', hash: '' },
        },
        roleDefault: '/member/dashboard',
      });
      expect(out).toBe('/member/payments?invoice=a');
    });
  });

  describe('getSafeInternalReturnPath', () => {
    it('allows normal internal paths', () => {
      expect(getSafeInternalReturnPath('/member/foo')).toBe('/member/foo');
    });
  });
});
