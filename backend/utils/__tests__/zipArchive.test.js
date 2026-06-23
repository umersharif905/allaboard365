'use strict';

const { isArchiverAvailable, createZipArchive } = require('../zipArchive');

describe('zipArchive', () => {
  test('createZipArchive returns an archive with append and finalize', () => {
    if (!isArchiverAvailable()) {
      console.warn('archiver not installed — skipping');
      return;
    }
    const archive = createZipArchive({ zlib: { level: 9 } });
    expect(archive).toBeTruthy();
    expect(typeof archive.append).toBe('function');
    expect(typeof archive.finalize).toBe('function');
  });

  test('can build a minimal zip buffer', async () => {
    if (!isArchiverAvailable()) return;
    const buf = await new Promise((resolve, reject) => {
      const archive = createZipArchive({ zlib: { level: 9 } });
      const chunks = [];
      archive.on('data', (c) => chunks.push(c));
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.append('hello', { name: 'test.txt' });
      archive.finalize();
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf[0]).toBe(0x50); // PK zip header
  });
});
