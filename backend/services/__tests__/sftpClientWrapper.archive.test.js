'use strict';

const {
  mkdirErrorIsAlreadyExists,
  isRemoteDirectory,
} = require('../sftpClientWrapper');

describe('sftpClientWrapper archive helpers', () => {
  test('mkdirErrorIsAlreadyExists accepts only real duplicate-dir signals', () => {
    expect(mkdirErrorIsAlreadyExists({ message: 'File already exists', code: 11 })).toBe(true);
    expect(mkdirErrorIsAlreadyExists({ message: 'Failure', code: 4 })).toBe(false);
    expect(mkdirErrorIsAlreadyExists({ message: 'Failure (4)', code: 4 })).toBe(false);
  });

  test('isRemoteDirectory detects directory mode', () => {
    expect(isRemoteDirectory({ isDirectory: () => true })).toBe(true);
    expect(isRemoteDirectory({ isDirectory: () => false, mode: 0o100644 })).toBe(false);
    expect(isRemoteDirectory({ mode: 0o040755 })).toBe(true);
  });
});
