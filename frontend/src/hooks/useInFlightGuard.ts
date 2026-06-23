// Synchronous in-flight guard for click handlers.
// Closes the gap that React useState(loading) leaves open: a double-click
// fired within the same React tick would otherwise both see loading=false
// before the first re-render commits.

import { useCallback, useRef, useState } from 'react';

export function useInFlightGuard() {
  const inFlight = useRef(false);
  const [isPending, setIsPending] = useState(false);

  const guard = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined; // duplicate — silently ignore
    inFlight.current = true;
    setIsPending(true);
    try {
      return await fn();
    } finally {
      inFlight.current = false;
      setIsPending(false);
    }
  }, []);

  return { guard, isPending };
}
