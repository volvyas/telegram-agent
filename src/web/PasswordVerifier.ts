import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
const MAX_HASH_LENGTH = 512;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;

export class PasswordVerifier {
  public static async hash(password: string): Promise<string> {
    validatePassword(password);
    const salt = randomBytes(16);
    const derived = await derive(password, salt, KEY_BYTES);
    return `$scrypt$v=1$N=${String(SCRYPT_N)},r=${String(SCRYPT_R)},p=${String(SCRYPT_P)}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  public async verify(password: string, encoded: string): Promise<boolean> {
    if (encoded.length > MAX_HASH_LENGTH) return false;
    const parsed = parseHash(encoded);
    if (parsed === undefined) return false;
    try {
      const derived = await derive(password, parsed.salt, parsed.key.length, parsed.n, parsed.r, parsed.p);
      return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
    } catch { return false; }
  }
}

function derive(password: string, salt: Buffer, length: number, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, length, { N: n, r, p, maxmem: 32 * 1024 * 1024 }, (error, result) => error === null ? resolve(result) : reject(error)));
}

function parseHash(encoded: string): { salt: Buffer; key: Buffer; n: number; r: number; p: number } | undefined {
  const match = /^\$scrypt\$v=1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{43,128})$/u.exec(encoded);
  if (match === null) return undefined;
  const n = Number(match[1]); const r = Number(match[2]); const p = Number(match[3]);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return undefined;
  const salt = Buffer.from(match[4] as string, "base64url"); const key = Buffer.from(match[5] as string, "base64url");
  return salt.length === 16 && key.length === KEY_BYTES ? { salt, key, n, r, p } : undefined;
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length < 1 || password.length > 1_024) throw new TypeError("Password is invalid");
}
