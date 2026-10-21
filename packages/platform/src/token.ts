import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const SCRYPT_N = 16_384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt:${SCRYPT_N}:8:1:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltPart = parts[4];
  const hashPart = parts[5];
  if (!Number.isInteger(n) || n < 16_384 || n > 65_536) {
    return false;
  }
  if (!Number.isInteger(r) || r !== 8 || !Number.isInteger(p) || p !== 1) {
    return false;
  }
  if (saltPart === undefined || hashPart === undefined) {
    return false;
  }
  const salt = Buffer.from(saltPart, "base64url");
  const expected = Buffer.from(hashPart, "base64url");
  if (salt.length !== 16 || expected.length !== 32) {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}

export function hashRefresh(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newRefreshToken(): string {
  return `rt_${randomBytes(32).toString("base64url")}`;
}

export type AccessClaims = {
  sid: string;
  exp: number;
  iat: number;
};

export function signAccess(secret: string, claims: AccessClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function readAccess(secret: string, token: string, nowMs: number): { ok: true; claims: AccessClaims } | { ok: false; reason: "invalid" | "expired" } {
  if (token.length < 20 || token.length > 4096) {
    return { ok: false, reason: "invalid" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "invalid" };
  }
  const headerPart = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    return { ok: false, reason: "invalid" };
  }
  const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
  const actual = Buffer.from(signaturePart, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "invalid" };
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "令牌解析失败";
    void message;
    return { ok: false, reason: "invalid" };
  }
  if (typeof header !== "object" || header === null || Reflect.get(header, "alg") !== "HS256") {
    return { ok: false, reason: "invalid" };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "invalid" };
  }
  const sid = Reflect.get(payload, "sid");
  const exp = Reflect.get(payload, "exp");
  const iat = Reflect.get(payload, "iat");
  if (typeof sid !== "string" || !/^[a-z0-9-]{8,64}$/.test(sid)) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof exp !== "number" || !Number.isInteger(exp) || typeof iat !== "number" || !Number.isInteger(iat)) {
    return { ok: false, reason: "invalid" };
  }
  if (exp * 1000 <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims: { sid, exp, iat } };
}
