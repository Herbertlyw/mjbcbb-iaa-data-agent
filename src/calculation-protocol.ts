import { Type } from "typebox";
import { Check } from "typebox/value";
import type { SessionResource } from "./types.js";
import type { ToolService } from "./tools.js";
import { resourceHash } from "./resource-graph.js";

const identity = Type.Object({ resource_id: Type.String({ minLength: 1, maxLength: 128 }), execution_id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
const ref = Type.Object({ resource_id: Type.String({ minLength: 1, maxLength: 128 }), execution_id: Type.String({ minLength: 1, maxLength: 128 }), column: Type.String({ minLength: 1, maxLength: 128 }), row: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })), aggregate: Type.Optional(Type.Literal("sum")) }, { additionalProperties: false, oneOf: [{ required: ["row"] }, { required: ["aggregate"] }] });
const columnSource = Type.Object({ resource_id: Type.String({ minLength: 1, maxLength: 128 }), execution_id: Type.String({ minLength: 1, maxLength: 128 }), column: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
const comparison = Type.Union([Type.Literal("eq"), Type.Literal("ne"), Type.Literal("lt"), Type.Literal("le"), Type.Literal("gt"), Type.Literal("ge")]);
const steps = Type.Array(Type.Union([
  Type.Object({ op: Type.Literal("filter"), column: Type.String(), comparison: Type.Union([comparison, Type.Literal("is_null"), Type.Literal("is_not_null")]), value: Type.Optional(Type.Union([Type.String(), Type.Boolean(), Type.Null()])), other_column: Type.Optional(Type.String()) }),
  Type.Object({ op: Type.Literal("compare"), left: Type.String(), right: Type.String(), comparison, as: Type.String() }),
  Type.Object({ op: Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")]), left: Type.String(), right: Type.String(), as: Type.String() }),
  Type.Object({ op: Type.Literal("sort"), keys: Type.Array(Type.Object({ column: Type.String(), direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]), nulls: Type.Union([Type.Literal("first"), Type.Literal("last")]) }), { minItems: 1, maxItems: 8 }) }),
  Type.Object({ op: Type.Literal("group"), by: Type.Array(Type.String(), { maxItems: 8 }), aggregates: Type.Array(Type.Object({ op: Type.Union([Type.Literal("count_all"), Type.Literal("count"), Type.Literal("sum"), Type.Literal("min"), Type.Literal("max")]), column: Type.Optional(Type.String()), as: Type.String() }), { minItems: 1, maxItems: 20 }) }),
]), { minItems: 1, maxItems: 10 });
const ops = ["cells", "add", "subtract", "multiply", "divide", "align", "transform"] as const;
const allFields = ["input", "operations", "left", "right", "numerator", "denominator", "keys", "align_op", "steps"];
const branch = (op: string, fields: string[], optional: string[] = []) => ({ properties: { operation: { const: op }, ...(["add", "subtract", "multiply"].includes(op) ? { left: ref, right: ref } : op === "align" ? { left: columnSource, right: columnSource } : {}) }, required: ["operation", ...fields], not: { anyOf: allFields.filter((field) => !fields.includes(field) && !optional.includes(field)).map((field) => ({ required: [field] })) } });

/** One object root for OpenAI-compatible suppliers; the discriminated branches
 * are mutually exclusive both in the schema and in the runtime validator. */
export const calculationSchema = Type.Object({
  operation: Type.Union(ops.map((op) => Type.Literal(op))),
  input: Type.Optional(identity),
  operations: Type.Optional(Type.Array(Type.Object({ op: Type.Union([Type.Literal("sum"), Type.Literal("count_null"), Type.Literal("count_zero"), Type.Literal("count_rows")]), column: Type.Optional(Type.String()), predicted: Type.Optional(Type.Union([Type.Literal("actual_only"), Type.Literal("predicted_only"), Type.Literal("any")])), as: Type.String() }), { minItems: 1, maxItems: 40 })),
  left: Type.Optional(Type.Union([ref, columnSource])), right: Type.Optional(Type.Union([ref, columnSource])),
  numerator: Type.Optional(ref), denominator: Type.Optional(ref),
  keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 3 })),
  align_op: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("subtract"), Type.Literal("multiply"), Type.Literal("divide")])),
  steps: Type.Optional(steps),
}, { additionalProperties: false, anyOf: [branch("cells", ["input", "operations"]), ...["add", "subtract", "multiply"].map((op) => branch(op, ["left", "right"], ["input"])), branch("divide", ["numerator", "denominator"], ["input"]), branch("align", ["left", "right", "keys", "align_op"]), branch("transform", ["input", "steps"])] });

type Lookup = (id: string) => Promise<{ ok: true; resource: SessionResource } | { ok: false; code: string }>;
type Legacy = Parameters<ToolService["calculateSessionCells"]>[1];

/** Validate and resolve execution identities before translating into the
 * existing governed calculation implementation. No model-supplied value or
 * identifier is promoted into an authority receipt. */
export async function normalizeCalculation(value: unknown, lookup: Lookup): Promise<{ ok: true; input: Legacy; hashes: Record<string, string> } | { ok: false; code: string }> {
  if (!Check(calculationSchema, value)) return { ok: false, code: "invalid_calculation_shape" };
  const raw = value as Record<string, unknown>;
  const checked = new Map<string, SessionResource>();
  const hashes: Record<string, string> = Object.create(null) as Record<string, string>;
  let lookupError = "resource_execution_mismatch";
  const resolve = async (v: unknown): Promise<SessionResource | null> => {
    const identityValue = v as { resource_id: string; execution_id: string };
    const prior = checked.get(identityValue.resource_id);
    const found = prior ? { ok: true as const, resource: prior } : await lookup(identityValue.resource_id);
    if (!found.ok) { lookupError = found.code; return null; }
    if (!found.resource.execution_id || found.resource.execution_id !== identityValue.execution_id) { lookupError = "resource_execution_mismatch"; return null; }
    checked.set(identityValue.resource_id, found.resource); hashes[identityValue.resource_id] = resourceHash(found.resource); return found.resource;
  };
  if (raw.operation === "cells" || raw.operation === "transform") {
    const resource = await resolve(raw.input); if (!resource) return { ok: false, code: lookupError };
    return raw.operation === "cells"
      ? { ok: true, hashes, input: { resource_id: resource.resource_id, operations: raw.operations as NonNullable<Legacy["operations"]> } }
      : { ok: true, hashes, input: { transform: { resource_id: resource.resource_id, steps: raw.steps as NonNullable<Legacy["transform"]>["steps"] } } };
  }
  const left = (raw.operation === "divide" ? raw.numerator : raw.left) as Record<string, unknown>;
  const right = (raw.operation === "divide" ? raw.denominator : raw.right) as Record<string, unknown>;
  // A redundant top-level input is meaningful only when it identifies both
  // operands exactly. Never let a conflicting hint select or authorize data.
  if (raw.input !== undefined) {
    const hint = raw.input as Record<string, unknown>;
    if ([left, right].some((operand) => operand.resource_id !== hint.resource_id || operand.execution_id !== hint.execution_id)) return { ok: false, code: "resource_execution_mismatch" };
  }
  const a = await resolve(left); if (!a) return { ok: false, code: lookupError };
  const b = await resolve(right); if (!b) return { ok: false, code: lookupError };
  if (raw.operation === "align") return { ok: true, hashes, input: { align: { op: raw.align_op as NonNullable<Legacy["align"]>["op"], keys: raw.keys as string[], left: { resource_id: a.resource_id, cell: String(left.column) }, right: { resource_id: b.resource_id, cell: String(right.column) } } } };
  const convert = (v: Record<string, unknown>, source: SessionResource) => {
    const scalar = source.kind === "calculation" || source.kind === "arithmetic";
    if (scalar && v.row !== 0 && v.aggregate !== "sum") return null;
    // Arithmetic responses expose their scalar as result.value, while the
    // unified one-row result view calls the same cell "result". Accept that
    // unambiguous response name only for arithmetic resources.
    const cell = source.kind === "arithmetic" && v.column === "value" ? "result" : String(v.column);
    return { resource_id: source.resource_id, execution_id: String(v.execution_id), cell, ...(scalar ? {} : v.row !== undefined ? { row: Number(v.row) } : { aggregate: "sum" as const }) };
  };
  const l = convert(left, a), r = convert(right, b);
  if (!l || !r) return { ok: false, code: "invalid_calculation_shape" };
  return { ok: true, hashes, input: { arithmetic: { op: raw.operation as "add" | "subtract" | "multiply" | "divide", left: l, right: r } } };
}
