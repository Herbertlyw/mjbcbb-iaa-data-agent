import assert from "node:assert/strict";
import test from "node:test";
import { parseDeliveryReview, reviewHasVerifiedReferences } from "../src/delivery-review.js";

const a = "res_aaa";
const b = "res_bbb";
const encode = (items: unknown[]) => `[[review:${JSON.stringify({ items })}]]`;
const item = (requirement: string, status: string, resource_ids: string[]) => ({ requirement, status, resource_ids });

test("覆盖复核解析保持有界，缺项、歧义、伪造或无效来源不能通过", () => {
  for (const requirement of ["各地区销量", "两个日期的活跃人数", "不同渠道的收入与成本"]) {
    const review = parseDeliveryReview(encode([item(requirement, "answered", [a])]));
    assert.equal(reviewHasVerifiedReferences(review, new Set([a]), new Set([a]), new Set()), true);
    assert.equal(reviewHasVerifiedReferences(review, new Set([b]), new Set([a]), new Set()), false);
    assert.equal(reviewHasVerifiedReferences(review, new Set([a]), new Set([b]), new Set()), false);
    for (const status of ["missing", "uncertain"]) assert.equal(reviewHasVerifiedReferences(parseDeliveryReview(encode([item(requirement, status, [])])), new Set([a]), new Set([a]), new Set()), false);
  }
  assert.equal(parseDeliveryReview(encode([])), null);
  assert.equal(parseDeliveryReview(encode([item("范围", "answered", [])])), null);
  assert.equal(parseDeliveryReview(`${encode([item("范围", "answered", [a])])}${encode([item("范围", "answered", [a])])}`), null);
  assert.equal(parseDeliveryReview('[[review:{"items":[],"ignored":true}]]'), null);
});

test("解释未知必须引用本轮选中且已重核的未知结果，可选探索不阻止交付", () => {
  const unknown = parseDeliveryReview(encode([item("零分母时解释", "explained_unknown", [b]), item("额外研究", "optional", [])]));
  assert.equal(reviewHasVerifiedReferences(unknown, new Set([a, b]), new Set([a, b]), new Set([b])), true);
  assert.equal(reviewHasVerifiedReferences(unknown, new Set([a, b]), new Set([a, b]), new Set()), false);
  assert.equal(reviewHasVerifiedReferences(unknown, new Set([a]), new Set([a, b]), new Set([b])), false);
  assert.equal(reviewHasVerifiedReferences(parseDeliveryReview(encode([item("额外研究", "optional", [])])), new Set(), new Set(), new Set()), false);
});
