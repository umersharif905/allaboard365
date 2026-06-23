import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Clean up the DOM between tests so queries don't leak between suites.
afterEach(() => {
  cleanup();
});
