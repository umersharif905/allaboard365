// AES-128-GCM payload encryption for public form PHI (key from env; use Azure Key Vault in production).
const crypto = require('crypto');

const ALGO = 'aes-128-gcm';

function getKeyBuffer() {
    const b64 = process.env.PUBLIC_FORMS_ENCRYPTION_KEY_B64;
    if (!b64 || !String(b64).trim()) {
        throw new Error('PUBLIC_FORMS_ENCRYPTION_KEY_B64 must be set (base64-encoded 16 bytes for AES-128-GCM)');
    }
    const buf = Buffer.from(String(b64).trim(), 'base64');
    if (buf.length !== 16) {
        throw new Error('PUBLIC_FORMS_ENCRYPTION_KEY_B64 must decode to exactly 16 bytes');
    }
    return buf;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer, keyId: string }}
 */
function encryptPayloadObject(payload) {
    const key = getKeyBuffer();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        ciphertext: enc,
        iv,
        authTag,
        keyId: process.env.PUBLIC_FORMS_KEY_ID_LABEL || 'env:aes128gcm:v1'
    };
}

/**
 * @param {Buffer} ciphertext
 * @param {Buffer} iv
 * @param {Buffer} authTag
 * @returns {Record<string, unknown>}
 */
function decryptPayloadObject(ciphertext, iv, authTag) {
    const key = getKeyBuffer();
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
}

module.exports = {
    encryptPayloadObject,
    decryptPayloadObject
};
