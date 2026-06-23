'use strict';

const { Client } = require('ssh2');
const path = require('path');

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * ssh2 negotiates host-key algorithms before auth. Legacy servers (e.g. Tall Tree
 * srtSSHServer_11.00) only offer ssh-rsa; without this, connect hangs until timeout.
 */
function ssh2ConnectAlgorithms(host) {
  const legacy =
    process.env.SFTP_LEGACY_SSH === '1'
    || /talltreehealth\.com$/i.test(String(host || ''));
  const serverHostKey = [
    'ssh-rsa',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
  ];
  if (!legacy) {
    return { serverHostKey };
  }
  // srtSSHServer hangs on KEXDH_GEX_REQUEST — use group14*, not group-exchange.
  return {
    kex: [
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
    ],
    cipher: [
      'aes128-ctr',
      'aes192-ctr',
      'aes256-ctr',
      'aes128-gcm@openssh.com',
      'aes256-gcm@openssh.com',
      'aes128-cbc',
      '3des-cbc',
    ],
    serverHostKey,
    hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
  };
}

function buildConnectConfig(opts) {
  const connectOpts = {
    host: opts.host,
    port: opts.port || 22,
    username: opts.username,
    readyTimeout: CONNECT_TIMEOUT_MS,
    algorithms: ssh2ConnectAlgorithms(opts.host),
  };
  if (opts.privateKey) {
    connectOpts.privateKey = opts.privateKey;
    if (opts.passphrase) connectOpts.passphrase = opts.passphrase;
  } else if (opts.password) {
    connectOpts.password = opts.password;
  }
  return connectOpts;
}

/**
 * Open SSH + SFTP channel (native ssh2 — avoids ssh2-sftp-client ready-event hang).
 */
function openSshAndSftp(opts) {
  const sshClient = new Client();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { sshClient.destroy(); } catch (_) { /* ignore */ }
      reject(new Error('SFTP connect timeout (30s)'));
    }, CONNECT_TIMEOUT_MS);

    sshClient.once('ready', () => {
      sshClient.sftp((err, sftp) => {
        clearTimeout(timer);
        if (err) {
          try { sshClient.end(); } catch (_) { /* ignore */ }
          reject(err);
          return;
        }
        resolve({ sshClient, sftp });
      });
    });
    sshClient.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sshClient.connect(buildConnectConfig(opts));
  });
}

function isRemoteDirectory(stats) {
  if (!stats) return false;
  if (typeof stats.isDirectory === 'function') return stats.isDirectory();
  return (stats.mode & 0o170000) === 0o040000;
}

function mkdirErrorIsAlreadyExists(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('already exists') || err.code === 11;
}

function remotePathMissing(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('no such file')
    || msg.includes('enoent')
    || msg.includes('no such directory')
    || err?.code === 2;
}

/**
 * Creates a new SFTP client wrapper instance.
 */
function create() {
  let sshClient = null;
  let sftp = null;

  async function connect(opts) {
    await disconnect();
    const opened = await openSshAndSftp(opts);
    sshClient = opened.sshClient;
    sftp = opened.sftp;
  }

  async function listCsvFiles(remotePath) {
    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          const msg = (err.message || '').toLowerCase();
          if (
            msg.includes('no such file')
            || msg.includes('enoent')
            || msg.includes('no such directory')
            || (err.code && String(err.code) === '2')
          ) {
            resolve([]);
            return;
          }
          reject(err);
          return;
        }
        resolve((list || [])
          .filter((f) => f.longname && f.longname.startsWith('-') && f.filename.toLowerCase().endsWith('.csv'))
          .map((f) => ({
            name: f.filename,
            remotePath: remotePath.replace(/\/$/, '') + '/' + f.filename,
            size: f.attrs.size,
            modifyTime: f.attrs.mtime ? new Date(f.attrs.mtime * 1000) : null,
          })));
      });
    });
  }

  async function downloadFile(remotePath) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  function statRemote(remotePath) {
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => (err ? reject(err) : resolve(stats)));
    });
  }

  async function mkdirOne(remotePath) {
    try {
      const stats = await statRemote(remotePath);
      if (!isRemoteDirectory(stats)) {
        throw new Error(`${remotePath} exists but is not a directory`);
      }
      return;
    } catch (err) {
      if (!remotePathMissing(err)) throw err;
    }

    const verifyDir = async () => {
      const stats = await statRemote(remotePath);
      if (!isRemoteDirectory(stats)) {
        throw new Error(`${remotePath} exists but is not a directory`);
      }
    };

    await new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (!err) {
          verifyDir().then(resolve).catch(reject);
          return;
        }
        if (mkdirErrorIsAlreadyExists(err)) {
          verifyDir().then(resolve).catch(reject);
          return;
        }
        sftp.mkdir(remotePath, { mode: 0o755 }, (err2) => {
          if (!err2) {
            verifyDir().then(resolve).catch(reject);
            return;
          }
          if (mkdirErrorIsAlreadyExists(err2)) {
            verifyDir().then(resolve).catch(reject);
            return;
          }
          reject(err2);
        });
      });
    });
  }

  /** Create each path segment (SFTP has no mkdir -p). */
  async function ensureDirectory(remotePath) {
    const normalized = String(remotePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || normalized === '/') return;
    const parts = normalized.split('/').filter(Boolean);
    let built = '';
    for (const part of parts) {
      built += `/${part}`;
      await mkdirOne(built);
    }
  }

  function renameRemote(sourcePath, destPath) {
    return new Promise((resolve, reject) => {
      sftp.rename(sourcePath, destPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  function copyRemoteFile(sourcePath, destPath) {
    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(sourcePath);
      const writeStream = sftp.createWriteStream(destPath);
      let finished = false;
      const fail = (err) => {
        if (finished) return;
        finished = true;
        readStream.destroy();
        writeStream.destroy();
        reject(err);
      };
      readStream.on('error', fail);
      writeStream.on('error', fail);
      writeStream.on('close', () => {
        if (finished) return;
        finished = true;
        resolve();
      });
      readStream.pipe(writeStream);
    });
  }

  function unlinkRemote(remotePath) {
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function archiveFile(sourcePath, archiveDir) {
    const dir = String(archiveDir || '').replace(/\/+$/, '');
    if (!dir) throw new Error('Archive directory is required');

    await ensureDirectory(dir);

    const fileName = path.posix.basename(sourcePath);
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15);
    const ext = path.posix.extname(fileName);
    const base = path.posix.basename(fileName, ext);
    const archivedName = ext ? `${base}_${ts}${ext}` : `${base}_${ts}`;
    const destPath = `${dir}/${archivedName}`;

    try {
      await renameRemote(sourcePath, destPath);
    } catch (renameErr) {
      try {
        await copyRemoteFile(sourcePath, destPath);
        await unlinkRemote(sourcePath);
      } catch (copyErr) {
        const renameDetail = renameErr.message || renameErr.code || String(renameErr);
        const copyDetail = copyErr.message || copyErr.code || String(copyErr);
        throw new Error(
          `rename ${sourcePath} → ${destPath} failed (${renameDetail}); copy+delete failed (${copyDetail})`,
        );
      }
    }
    return destPath;
  }

  async function uploadFile(localPath, remotePath) {
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function remoteExists(remotePath) {
    return new Promise((resolve) => {
      sftp.stat(remotePath, (err) => resolve(!err));
    });
  }

  async function disconnect() {
    if (sftp) {
      try {
        sftp.end();
      } catch (_) { /* ignore */ }
      sftp = null;
    }
    if (sshClient) {
      try {
        sshClient.end();
      } catch (_) { /* ignore */ }
      sshClient = null;
    }
  }

  async function testConnect(opts) {
    const start = Date.now();
    try {
      await connect(opts);
      const latencyMs = Date.now() - start;
      return { success: true, latencyMs };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      await disconnect();
    }
  }

  return {
    connect,
    listCsvFiles,
    downloadFile,
    uploadFile,
    remoteExists,
    statRemote,
    ensureDirectory,
    archiveFile,
    disconnect,
    testConnect,
  };
}

module.exports = {
  create,
  ssh2ConnectAlgorithms,
  mkdirErrorIsAlreadyExists,
  isRemoteDirectory,
};
