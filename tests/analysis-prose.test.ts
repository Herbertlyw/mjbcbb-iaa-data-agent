import assert from "node:assert/strict";
import test from "node:test";
import { displayModelProse } from "../src/analysis-prose.js";

test("正文移除传输标记，保留数字、未知原因和普通文本", () => {
  assert.equal(displayModelProse('[[partial]] 收入 1.146593；分母为零，无法计算。 [[result:res_a]] [[compare:res_a.x,res_b.y]] [[review:{"items":[]}]]'), "收入 1.146593；分母为零，无法计算。");
  assert.equal(displayModelProse("[[result:res_a]]"), "");
  assert.equal(displayModelProse("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "HTML 转义由页面呈现边界统一处理");
});
