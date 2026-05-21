import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope. The master key (32 bytes) comes from
 * AI_KEY_ENCRYPTION_KEY in env. Stored ciphertext is base64:
 *   <12-byte iv> | <16-byte authTag> | <ciphertext>
 * encoded together.
 */
export interface CryptoBox {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

function loadKey(envValue: string | undefined): Buffer {
  if (envValue === undefined || envValue === '') {
    throw new Error(
      'AI_KEY_ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(envValue, 'base64');
  if (key.byteLength !== 32) {
    throw new Error(`AI_KEY_ENCRYPTION_KEY must decode to 32 bytes (got ${key.byteLength.toString()})`);
  }
  return key;
}

export function createCryptoBox(envValue: string | undefined): CryptoBox {
  const key = loadKey(envValue);
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, ct]).toString('base64');
    },
    decrypt(ciphertext: string): string {
      const buf = Buffer.from(ciphertext, 'base64');
      if (buf.byteLength < 12 + 16 + 1) throw new Error('ciphertext too short');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ct = buf.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf-8');
    },
  };
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}
