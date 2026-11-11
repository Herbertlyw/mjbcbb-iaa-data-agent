/** Model-authored coverage review. It is a bounded aid to identify omissions,
 * not an authorization receipt or proof of natural-language understanding. */
export interface DeliveryReview {
  items: Array<{ requirement: string; status: "answered" | "explained_unknown" | "missing" | "uncertain" | "optional"; resource_ids: string[] }>;
}

export function parseDeliveryReview(text: string): DeliveryReview | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 32_000) return null;
  const matches = [...text.matchAll(/\[\[review:(\{[^\n]*\})\]\]/gu)];
  if (matches.length !== 1 || (text.match(/\[\[review:/gu)?.length ?? 0) !== 1) return null;
  try {
    const parsed: unknown = JSON.parse(matches[0]![1]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => key !== "items")) return null;
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 32) return null;
    for (const value of items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some((key) => !["requirement", "status", "resource_ids"].includes(key)) || typeof item.requirement !== "string" || !item.requirement.trim() || item.requirement.length > 500 || !["answered", "explained_unknown", "missing", "uncertain", "optional"].includes(String(item.status)) || !Array.isArray(item.resource_ids) || item.resource_ids.length > 16 || item.resource_ids.some((id) => typeof id !== "string" || !/^res_[A-Za-z0-9-]{1,128}$/u.test(id))) return null;
      if (["answered", "explained_unknown"].includes(String(item.status)) && item.resource_ids.length === 0) return null;
    }
    return { items } as DeliveryReview;
  } catch { return null; }
}

/** References are checked again after normal delivery validation. The host
 * verifies evidence identities and unknown-result reasons; the model's mapping
 * of user wording to requirements remains explicitly unverified. */
export function reviewHasVerifiedReferences(review: DeliveryReview | null, selected: ReadonlySet<string>, verified: ReadonlySet<string>, explainedUnknown: ReadonlySet<string>): boolean {
  if (!review || !review.items.some((item) => item.status !== "optional")) return false;
  return review.items.every((item) => {
    if (item.status === "optional") return true;
    if (item.status === "missing" || item.status === "uncertain") return false;
    return item.resource_ids.every((id) => selected.has(id) && verified.has(id)) &&
      (item.status !== "explained_unknown" || item.resource_ids.some((id) => explainedUnknown.has(id)));
  });
}
