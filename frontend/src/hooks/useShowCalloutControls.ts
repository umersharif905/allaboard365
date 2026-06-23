import { useSearchParams } from 'react-router-dom';

/**
 * Enables Columbus training callout dev/replay UI when the URL includes
 * `?show-callout-controls=1` (e.g. `/agent/training?show-callout-controls=1`).
 */
export function useShowCalloutControls(): boolean {
  const [searchParams] = useSearchParams();

  return searchParams.get('show-callout-controls') === '1';
}
