import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Controlled-mode credential and same-origin primitives. */
export const VISITOR_COOKIE = "vv_visitor";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export function issueVisitorCredential() {
  const credential = randomBytes(32).toString("base64url");
  return { visitorId: `vis_${randomBytes(16).toString("hex")}`, credential, credentialHash: hashVisitorCredential(credential), csrfToken: visitorCsrfToken(credential) };
}

export function hashVisitorCredential(credential: string): string {
  if (!TOKEN.test(credential)) throw new Error("invalid_visitor_credential");
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

export function visitorCsrfToken(credential: string): string {
  if (!TOKEN.test(credential)) throw new Error("invalid_visitor_credential");
  return createHmac("sha256", credential).update("vv-visitor-csrf-v1").digest("base64url");
}

export function readVisitorCookie(header: string | undefined): string | null {
  if (!header || header.length > 4096) return null;
  const values = header.split(";").map(item => item.trim()).filter(item => item.startsWith(`${VISITOR_COOKIE}=`)).map(item => item.slice(VISITOR_COOKIE.length + 1));
  return values.length === 1 && TOKEN.test(values[0]!) ? values[0]! : null;
}

export function validVisitorCsrf(credential: string, supplied: string | undefined): boolean {
  if (!TOKEN.test(credential) || !supplied || !TOKEN.test(supplied)) return false;
  const expected = Buffer.from(visitorCsrfToken(credential)); const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Origin and Host are compared to one fixed deployment setting; forwarded
 * headers are not consulted. HTTP is accepted only for explicit loopback. */
export function visitorOriginSettings(value: string, allowLoopbackHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid_visitor_origin");
  if (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port)) throw new Error("invalid_visitor_origin");
  return url;
}

export function validVisitorOrigin(configured: URL, origin: string | undefined, host: string | undefined): boolean {
  return origin === configured.origin && host === configured.host;
}

export function visitorCookie(credential: string, maxAgeSeconds: number, origin: URL): string {
  if (!TOKEN.test(credential) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 31 * 86400) throw new Error("invalid_visitor_cookie");
  return `${VISITOR_COOKIE}=${credential}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${origin.protocol === "https:" ? "; Secure" : ""}`;
}

/** Only clears this browser's cookie; it does not delete or reassign history. */
export function clearVisitorCookie(origin: URL): string {
  return `${VISITOR_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${origin.protocol === "https:" ? "; Secure" : ""}`;
}
