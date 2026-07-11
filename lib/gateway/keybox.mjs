// Provider API keys at rest: AES-256-GCM with a key derived from the
// KEY_ENCRYPTION_KEY env secret (design §5). Ciphertext format (base64):
// iv(12) || authTag(16) || data. Decrypt fails CLOSED — returns null on any
// wrong-key/tamper/format error so a bad key can never leak plaintext bytes.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function derive(kek) {
    // ponytail: bare SHA-256 of a high-entropy env secret — fine for a single
    // purpose. If this KEK ever secures a SECOND thing, switch to HKDF with a
    // distinct info label per purpose instead of reusing this digest.
    return createHash('sha256').update(kek, 'utf8').digest(); // 32 bytes
}

export function encryptSecret(plaintext, kek = process.env.KEY_ENCRYPTION_KEY) {
    if (!plaintext || !kek) throw new Error('encryptSecret: plaintext and KEY_ENCRYPTION_KEY are required');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derive(kek), iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decryptSecret(ciphertext, kek = process.env.KEY_ENCRYPTION_KEY) {
    try {
        if (!ciphertext || !kek) return null;
        const buf = Buffer.from(ciphertext, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', derive(kek), buf.subarray(0, 12));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

// What the console shows instead of the key.
export function keyLast4(key) {
    return typeof key === 'string' && key.length > 4 ? key.slice(-4) : '***';
}
