import assert from "node:assert/strict";
import test from "node:test";
import { webAsset } from "../src/web-assets.js";

test("页面模块按显式白名单发布，不暴露源码、密钥或任意路径", () => {
  for (const path of ["/assets/app.js", "/assets/view.js", "/assets/stream.js", "/assets/examples.js", "/assets/history.js"]) {
    assert.match(webAsset(path)!.contentType, /text\/javascript/);
    assert.ok(webAsset(path)!.body.length > 0);
  }
  assert.match(webAsset("/assets/styles.css")!.contentType, /text\/css/);
  assert.match(webAsset("/")!.body.toString(), /type="module"/);
  for (const path of [
    "/assets/../config.ts",
    "/src/config.ts",
    "/.env",
    "/assets/.local-runtime/deepseek-api-key",
    "/assets/app.js/extra",
  ])
    assert.equal(webAsset(path), undefined);
});
