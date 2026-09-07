import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/*
 * Parol hashi — Node-un daxili scrypt-i, əlavə asılılıq yoxdur.
 *
 * bcrypt/argon2 native modul tələb edir; scrypt yaddaş-ağır KDF-dir və
 * standart kitabxanadadır. Layihənin qalanı da eyni üslubdadır (sessiyalar
 * Web Crypto ilə əl ilə yazılıb, asılılıq gətirilməyib).
 *
 * Parametrlər HASH-IN İÇİNDƏ saxlanılır: `scrypt$N$r$p$salt$hash`. Beləcə
 * sabah N artırılsa və ya argon2-yə keçilsə, köhnə hashlar öz parametrləri ilə
 * yoxlanmağa davam edir — heç kim sistemdən kənarda qalmır.
 *
 * N=32768 bu serverdə ~290 ms çəkir (ölçülüb). Giriş üçün yaxşı qiymətdir:
 * insana hiss olunmur, kütləvi sınaq üçün bahadır.
 */
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Parolu yoxlayır. Saxlanmış hash oxunmazsa `false` qaytarır — heç vaxt atmır,
 * çünki giriş yolunda atılan xəta "bu istifadəçi var" siqnalıdır.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    // Saxlanmış parametrlər bu maşında maxmem-dən çoxdursa buraya düşür.
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Parol qaydaları — admin panelində və parol dəyişmə formasında işlənir. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Parol ən azı 10 simvol olmalıdır";
  if (password.length > 200) return "Parol çox uzundur";
  if (!/[^\p{L}\p{N}]/u.test(password) && !/\p{N}/u.test(password)) {
    return "Parolda ən azı bir rəqəm və ya simvol olmalıdır";
  }
  return null;
}
