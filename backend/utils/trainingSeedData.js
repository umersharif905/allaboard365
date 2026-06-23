const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTrainingSeedDataFromFrontendMock() {
  const mockPath = path.resolve(
    __dirname,
    '../../frontend/src/components/tenant-admin/training/trainingMockData.ts'
  );

  const source = fs.readFileSync(mockPath, 'utf8');

  // Remove TS-only syntax so we can safely evaluate the data constants.
  let js = source
    .replace(/^import\s+type\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];\s*$/m, '')
    .replace(/export const createTrainingId[\s\S]*?;\s*\n\s*/m, '')
    .replace(/export const INITIAL_MODULE_LIBRARY:\s*TrainingModule\[\]\s*=\s*/, 'const INITIAL_MODULE_LIBRARY = ')
    .replace(/export const INITIAL_PACKAGES:\s*TrainingPackage\[\]\s*=\s*/, 'const INITIAL_PACKAGES = ');

  js += '\nmodule.exports = { INITIAL_MODULE_LIBRARY, INITIAL_PACKAGES };';

  const sandbox = { module: { exports: {} }, exports: {} };
  const script = new vm.Script(js, { filename: 'trainingMockData.seed.eval.js' });
  script.runInNewContext(sandbox);

  const { INITIAL_MODULE_LIBRARY, INITIAL_PACKAGES } = sandbox.module.exports || {};

  if (!Array.isArray(INITIAL_MODULE_LIBRARY) || !Array.isArray(INITIAL_PACKAGES)) {
    throw new Error('Training seed data could not be parsed from frontend mock file.');
  }

  return {
    moduleLibrary: INITIAL_MODULE_LIBRARY,
    packages: INITIAL_PACKAGES
  };
}

module.exports = {
  loadTrainingSeedDataFromFrontendMock
};

