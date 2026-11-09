import assert from "node:assert/strict";
import test from "node:test";
import { hashVisitorCredential, issueVisitorCredential, readVisitorCookie, validVisitorCsrf, validVisitorOrigin, visitorCookie, visitorOriginSettings } from "../src/visitor-credentials.js";

test("访客凭据和 CSRF 秘密不可由客户端指定或伪造；来源显式失败关闭", () => {
  const a=issueVisitorCredential(), b=issueVisitorCredential();
  assert.notEqual(a.visitorId,b.visitorId); assert.notEqual(a.credential,b.credential);
  assert.notEqual(a.credentialHash,a.credential); assert.equal(hashVisitorCredential(a.credential),a.credentialHash);
  assert.equal(readVisitorCookie(`foo=1; vv_visitor=${a.credential}`),a.credential);
  assert.equal(readVisitorCookie(`vv_visitor=${a.credential}; vv_visitor=${b.credential}`),null);
  assert.equal(readVisitorCookie("vv_visitor=forged"),null);
  assert.equal(validVisitorCsrf(a.credential,a.csrfToken),true);
  assert.equal(validVisitorCsrf(a.credential,b.csrfToken),false);
  const local=visitorOriginSettings("http://127.0.0.1:43210",true);
  assert.equal(validVisitorOrigin(local,"http://127.0.0.1:43210","127.0.0.1:43210"),true);
  for (const origin of [undefined,"null","http://evil.invalid","http://127.0.0.1:43211"]) assert.equal(validVisitorOrigin(local,origin,"127.0.0.1:43210"),false);
  assert.equal(validVisitorOrigin(local,local.origin,"evil.invalid"),false);
  assert.throws(()=>visitorOriginSettings("http://127.0.0.1:43210",false));
  assert.throws(()=>visitorOriginSettings("http://example.invalid",true));
  assert.throws(()=>visitorOriginSettings("https://example.invalid/path",false));
  const cookie=visitorCookie(a.credential,3600,local);assert.match(cookie,/HttpOnly; SameSite=Strict/u);assert.doesNotMatch(cookie,/; Secure/u);
  assert.match(visitorCookie(a.credential,3600,visitorOriginSettings("https://example.invalid",false)),/; Secure/u);
});
