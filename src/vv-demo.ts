// Read a bounded question catalog; its dates describe configuration, never freshness.
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isCalendarDate } from "./config.js";

export interface VvQuestion {
  id: string;
  category: string;
  label: string;
  text: string;
  scope: string;
  note: string;
}

export interface VvDemo {
  scenario: "VV Data Agent";
  title: "VV Data Agent";
  placeholder: string;
  categories: Array<{ id: string; label: string }>;
  questions: VvQuestion[];
  release: { dataset_version: string; start_date: string; as_of: string; timezone: "UTC" } | null;
  release_state: "bound" | "unbound" | "invalid";
}

/** Load display-only metadata, omitting every unrecognised field and answer. */
export async function loadVvDemo(knowledgeDir: string): Promise<VvDemo> {
  const fallback: VvDemo = {
    scenario: "VV Data Agent", title: "VV Data Agent",
    placeholder: "询问拼格 GridFit、落块 BlockFall 或叠叠乐 StackJoy 的合成数据",
    categories: [], questions: [], release: null, release_state: "unbound",
  };
  try {
    const root = await realpath(knowledgeDir);
    const read = async (name: string): Promise<unknown> => {
      const file = path.join(root, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128_000 || await realpath(file) !== file)
        throw new Error("vv_catalog_file_invalid");
      return JSON.parse(await readFile(file, "utf8")) as unknown;
    };
    const catalog = object(await read("demo-catalog.json"));
    if (catalog?.schema_version !== 1 || catalog.application !== "VV Data Agent")
      return { ...fallback, release_state: "invalid" };
    if (catalog.release === null) return fallback;
    const release = object(catalog.release);
    const declared = object(await read("release.json"));
    if (!release || !declared || release.timezone !== "UTC" ||
        typeof release.dataset_version !== "string" || !/^sv_[a-f0-9]{20}$/u.test(release.dataset_version) ||
        typeof release.start_date !== "string" || typeof release.as_of !== "string" ||
        !isCalendarDate(release.start_date) || !isCalendarDate(release.as_of) || release.start_date > release.as_of ||
        ["dataset_version", "start_date", "as_of"].some(key => release[key] !== declared[key]))
      return { ...fallback, release_state: "invalid" };
    if (!Array.isArray(catalog.categories) || catalog.categories.length > 8 ||
        !Array.isArray(catalog.questions) || catalog.questions.length > 40)
      return { ...fallback, release_state: "invalid" };
    const categories: VvDemo["categories"] = [];
    for (const value of catalog.categories) {
      const category = object(value);
      if (!category || !identifier(category.id) || !text(category.label, 30) ||
          categories.some(item => item.id === category.id))
        return { ...fallback, release_state: "invalid" };
      categories.push({ id: category.id, label: category.label });
    }
    const questions: VvQuestion[] = [];
    for (const value of catalog.questions) {
      const question = object(value);
      if (!question || !identifier(question.id) || !identifier(question.category) ||
          !categories.some(item => item.id === question.category) || questions.some(item => item.id === question.id) ||
          !text(question.label, 40) || !text(question.text, 2000) || !text(question.scope, 200) || !text(question.note, 500))
        return { ...fallback, release_state: "invalid" };
      questions.push({ id: question.id, category: question.category, label: question.label,
        text: question.text, scope: question.scope, note: question.note });
    }
    return { ...fallback, categories, questions, release_state: "bound", release: {
      dataset_version: release.dataset_version, start_date: release.start_date, as_of: release.as_of, timezone: "UTC",
    } };
  } catch (error) {
    return { ...fallback, release_state: object(error)?.code === "ENOENT" ? "unbound" : "invalid" };
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
