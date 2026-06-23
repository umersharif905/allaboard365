'use strict';

/**
 * archiver v7: default export is callable — archiver('zip', opts)
 * archiver v8: ESM named exports — new ZipArchive(opts)
 */
let archiverModule;
try {
  archiverModule = require('archiver');
} catch {
  archiverModule = null;
}

function isArchiverAvailable() {
  return !!createZipArchive();
}

function createZipArchive(options = { zlib: { level: 9 } }) {
  if (!archiverModule) return null;
  if (typeof archiverModule === 'function') {
    return archiverModule('zip', options);
  }
  if (typeof archiverModule.ZipArchive === 'function') {
    return new archiverModule.ZipArchive(options);
  }
  return null;
}

module.exports = {
  isArchiverAvailable,
  createZipArchive,
};
