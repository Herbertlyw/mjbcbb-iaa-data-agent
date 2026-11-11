/** Transport markers select evidence; they are not part of the answer. The
 * remaining prose is still model-authored and must never be labelled verified. */
export function displayModelProse(text: string): string {
  return text
    .replace(/\[\[(?:result|compare):[^\]\n]*\]\]/gu, "")
    .replace(/\[\[(?:partial|failed|clarify)\]\]/gu, "")
    .replace(/\[\[review:\{[^\n]*\}\]\]/gu, "")
    .trim();
}
