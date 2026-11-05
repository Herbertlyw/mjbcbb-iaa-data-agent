// Adapted from the user-supplied original sql/review.ts, source revision 932371f.
// Not yet an execution authorization boundary: integration must also prove JOIN
// relationships, current contracts, coverage and evidence delivery.
import { parse, type Expression, type SelectQueryNode, type SelectWithUnionQueryNode } from '@clickhouse/parser';

/** Caller-owned facts. Production values must come from authorized contract reads. */
export type ColumnGrant = { name: string; privacy?: 'ordinary' | 'aggregation_only' | 'forbidden' };
export type TableGrant = {
  fqn: string;
  columns: readonly ColumnGrant[];
  partitionColumn?: string;
  scanKind?: 'day' | 'datetime' | 'sentinel' | 'unpartitioned';
  sentinelValue?: string;
  maxScanDays: number;
  requiredFilters?: readonly string[];
};
export type SqlReviewPolicy = {
  tables: readonly TableGrant[];
  /** Unqualified names resolve only inside the host-selected database. */
  defaultDatabase?: string;
  /** Detail rows are permitted only by an explicit host policy and limits. */
  allowDetail?: boolean;
  /** Combinators beyond explicitly listed aggregates are opt-in. */
  allowAggregateIfCombinators?: boolean;
  allowedFunctions: readonly string[];
  aggregateFunctions: readonly string[];
  piiDistinctFunctions?: readonly string[];
  maxRows: number;
  maxSqlBytes?: number;
};
export type SqlReviewDecision =
  | { ok: true; sql: string; tables: string[]; reason: 'approved' }
  | { ok: false; sql: string; reason: string; detail?: string };

type Failure = { reason: string; detail?: string };
const fail = (reason: string, detail?: string): Failure => ({ reason, detail });
// Function names are case-insensitive; physical ClickHouse identifiers are not.
const key = (value: string): string => value.toLowerCase();
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
// Parser 0.3 represents basic CK language operators as Function nodes. Treat
// this grammar family independently of policy-approved scalar functions;
// operands still undergo the same source/privacy checks as function arguments.
const LANGUAGE_OPERATORS = new Set([
  'and', 'or', 'not', 'equals', 'notequals', 'greater', 'greaterorequals',
  'less', 'lessorequals', 'in', 'notin', 'globalin', 'globalnotin', 'plus', 'minus', 'multiply',
  'divide', 'modulo', 'negate', 'isnull', 'isnotnull',
]);
const DANGEROUS_FUNCTIONS = new Set([
  'sleep', 'sleepeachrow', 'url', 's3', 'remote', 'remotesecure',
  'file', 'mysql', 'postgresql', 'executable', 'executablepool',
  'dictget', 'getsetting', 'currentuser',
]);
const PII_DISTINCT_FUNCTIONS = new Set(['countdistinct', 'uniqexact']);

function approvedAggregate(name: string, policy: SqlReviewPolicy): boolean {
  const aggregates = policy.aggregateFunctions.map(key);
  if (aggregates.includes(name)) return true;
  if (!policy.allowAggregateIfCombinators) return false;
  // Only a single -If on an already approved base aggregate. Do not infer
  // arbitrary combinator chains, state/array/map or unknown base capabilities.
  const base = name.endsWith('if') ? name.slice(0, -2) : '';
  return !!base && !/(if|state|merge|array|map|foreach|resample|ordefault|ornull)$/.test(base)
    && aggregates.includes(base);
}

function cheapDepthCheck(sql: string): Failure | null {
  // Deliberately conservative before handing untrusted text to the parser.
  let depth = 0;
  for (const char of sql) {
    if (char === '(' && ++depth > 64) return fail('sql_depth_limit');
    if (char === ')') depth--;
  }
  return null;
}

function scanHazards(root: unknown): Failure | null {
  const pending: unknown[] = [root];
  let seen = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++seen > 20_000) return fail('ast_node_limit');
    if (Array.isArray(item)) { pending.push(...item); continue; }
    const value = record(item);
    if (!value) continue;
    if (value.type === 'TableExpression' && value.table_function) {
      return fail('table_function_forbidden', String(record(value.table_function)?.name ?? 'unknown'));
    }
    if (value.type === 'QueryParameter') return fail('query_parameter_unsupported');
    if (value.type === 'Function') {
      const name = key(String(value.name ?? ''));
      if (DANGEROUS_FUNCTIONS.has(name)) return fail('dangerous_function', name);
    }
    if (value.type === 'SelectWithUnionQuery' || value.type === 'SelectIntersectExceptQuery') {
      if (value.out_file || value.outfile_truncate) return fail('outfile_forbidden');
      if (value.settings || value.format) return fail('query_output_options_forbidden');
    }
    if (value.type === 'SelectQuery' && value.settings) return fail('settings_forbidden');
    for (const [name, child] of Object.entries(value)) {
      if (name !== 'location' && name !== 'parent') pending.push(child);
    }
  }
  return null;
}

function dateValue(value: Expression): number | null {
  if (value.type !== 'Literal' || value.value_type !== 'String' || typeof value.value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.value)) return null;
  const stamp = Date.parse(`${value.value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().startsWith(value.value)
    ? stamp / 86_400_000 : null;
}

function datetimeValue(value: Expression): number | null {
  const day = dateValue(value);
  if (day !== null) return day;
  if (value.type !== 'Literal' || value.value_type !== 'String' || typeof value.value !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.value)) return null;
  const stamp = Date.parse(value.value.replace(' ', 'T') + 'Z');
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 19)
    === value.value.replace(' ', 'T') ? stamp / 86_400_000 : null;
}

function conjuncts(where: Expression | undefined): Expression[] {
  const terms: Expression[] = [];
  const flatten = (expr: Expression): void => {
    if (expr.type === 'Function' && key(expr.name) === 'and') expr.arguments.forEach(flatten);
    else terms.push(expr);
  };
  if (where) flatten(where);
  return terms;
}

function namedColumn(expr: Expression, name: string, alias: string, allowUnqualified: boolean): boolean {
  if (expr.type !== 'Identifier') return false;
  const parts = expr.name_parts ?? expr.name.split('.');
  return parts.at(-1) === name && (parts.length === 2 ? parts[0] === alias : allowUnqualified && parts.length === 1);
}

function containsColumn(expr: Expression, name: string, alias: string, allowUnqualified: boolean): boolean {
  return namedColumn(expr, name, alias, allowUnqualified)
    || (expr.type === 'Function' && expr.arguments.some(arg => containsColumn(arg, name, alias, allowUnqualified)));
}

function datetimeProof(where: Expression | undefined, column: string, maxDays: number,
  alias: string, allowUnqualified: boolean): Failure | null {
  if (!where) return fail('missing_datetime_predicate');
  let low: number | null = null;
  let high: number | null = null;
  let relative = false;
  for (const term of conjuncts(where)) {
    if (term.type !== 'Function') continue;
    const name = key(term.name);
    if (name === 'or' && containsColumn(term, column, alias, allowUnqualified)) return fail('unsafe_datetime_or');
    const [left, right] = term.arguments;
    if (!left || !right || !namedColumn(left, column, alias, allowUnqualified)) continue;
    if (!['equals', 'greater', 'greaterorequals', 'less', 'lessorequals'].includes(name)) {
      return fail('datetime_predicate_unsupported');
    }
    if ((name === 'greater' || name === 'greaterorequals') && right.type === 'Function'
        && key(right.name) === 'minus' && right.arguments.length === 2) {
      const [now, interval] = right.arguments;
      if (now?.type === 'Function' && key(now.name) === 'now' && now.arguments.length === 0
          && interval?.type === 'Function' && key(interval.name) === 'tointervalday'
          && interval.arguments.length === 1 && interval.arguments[0]?.type === 'Literal'
          && interval.arguments[0].value_type === 'UInt64') {
        const days = Number(interval.arguments[0].value);
        if (!Number.isSafeInteger(days) || days < 1 || days > maxDays) return fail('scan_limit_exceeded');
        relative = true;
        continue;
      }
    }
    const value = datetimeValue(right);
    if (value === null) return fail('datetime_literal_required');
    if (name === 'equals') { low = Math.max(low ?? value, value); high = Math.min(high ?? value, value); }
    else if (name === 'greater' || name === 'greaterorequals') low = Math.max(low ?? value, value);
    else high = Math.min(high ?? value, value);
  }
  if (relative) return null;
  if (low === null || high === null) return fail('missing_datetime_predicate');
  // Proven empty scan is bounded; the caller must still check every field,
  // other source and publication. Unresolved bounds never reach this point.
  if (high - low > maxDays) return fail('scan_limit_exceeded');
  return null;
}

function sentinelProof(where: Expression | undefined, column: string, value: string,
  alias: string, allowUnqualified: boolean): Failure | null {
  if (!where) return fail('missing_sentinel_predicate');
  let matched = false;
  for (const term of conjuncts(where)) {
    if (term.type !== 'Function') continue;
    if (key(term.name) === 'or' && containsColumn(term, column, alias, allowUnqualified)) return fail('unsafe_sentinel_or');
    const [left, right] = term.arguments;
    if (!left || !right || !namedColumn(left, column, alias, allowUnqualified)) continue;
    if (key(term.name) === 'equals' && right.type === 'Literal'
        && right.value_type === 'String' && right.value === value) matched = true;
  }
  return matched ? null : fail('sentinel_predicate_required');
}

function partitionProof(where: Expression | undefined, partition: string, maxDays: number,
  sourceAlias: string, allowUnqualified: boolean): Failure | null {
  if (!where) return fail('missing_partition_predicate');
  const conjuncts: Expression[] = [];
  const flatten = (expr: Expression): void => {
    if (expr.type === 'Function' && key(expr.name) === 'and') {
      expr.arguments.forEach(flatten);
    } else conjuncts.push(expr);
  };
  flatten(where);
  const isPartition = (expr: Expression): boolean => {
    if (expr.type !== 'Identifier') return false;
    const parts = expr.name_parts ?? expr.name.split('.');
    if (String(parts.at(-1) ?? '') !== partition) return false;
    return parts.length > 1 ? String(parts.at(-2)) === sourceAlias : allowUnqualified;
  };
  const containsPartition = (expr: Expression): boolean => {
    if (isPartition(expr)) return true;
    return expr.type === 'Function' && expr.arguments.some(containsPartition);
  };
  let low: number | null = null;
  let high: number | null = null;
  for (const term of conjuncts) {
    if (term.type !== 'Function') continue;
    const name = key(term.name);
    if (name === 'or' && containsPartition(term)) return fail('unsafe_partition_or');
    const [left, right] = term.arguments;
    if (!left || !right || !isPartition(left)) continue;
    if (name === 'equals') {
      const day = dateValue(right);
      if (day === null) return fail('partition_literal_required');
      low = Math.max(low ?? day, day); high = Math.min(high ?? day, day);
    } else if (['in', 'globalin'].includes(name) && right.type === 'Literal' && right.value_type === 'Tuple'
      && Array.isArray(right.value)) {
      const days = right.value.map(item => dateValue({ type: 'Literal', value_type: item.value_type,
        value: item.value } as Expression));
      if (!days.length || days.some(day => day === null)) return fail('partition_literal_required');
      const values = days as number[];
      low = Math.max(low ?? Math.min(...values), Math.min(...values));
      high = Math.min(high ?? Math.max(...values), Math.max(...values));
    } else if (name === 'greaterorequals' || name === 'greater' || name === 'lessorequals' || name === 'less') {
      const day = dateValue(right);
      if (day === null) return fail('partition_literal_required');
      if (name === 'greaterorequals' || name === 'greater') low = Math.max(low ?? day, day + (name === 'greater' ? 1 : 0));
      else high = Math.min(high ?? day, day - (name === 'less' ? 1 : 0));
    } else if (containsPartition(term)) return fail('partition_predicate_unsupported');
  }
  if (low === null || high === null) return fail('missing_partition_predicate');
  // Contradictory, fully proved bounds are a bounded (empty) scan.
  if (high - low + 1 > maxDays) return fail('scan_limit_exceeded');
  return null;
}

function requiredFilterProof(where: Expression | undefined, columns: readonly string[], alias: string): Failure | null {
  const terms: Expression[] = [];
  const flatten = (term: Expression): void => {
    if (term.type === 'Function' && key(term.name) === 'and') term.arguments.forEach(flatten);
    else terms.push(term);
  };
  if (where) flatten(where);
  const literal = (term: Expression | undefined): boolean => !!term && term.type === 'Literal'
    && term.value !== null && !['Null', 'Tuple', 'Array'].includes(term.value_type);
  const identifier = (term: Expression | undefined, name: string): boolean => {
    if (term?.type !== 'Identifier') return false;
    const parts = term.name_parts ?? term.name.split('.');
    return parts.at(-1) === name && (parts.length === 1 || (parts.length === 2 && parts[0] === alias));
  };
  for (const column of columns) {
    const proved = terms.some(term => {
      if (term.type !== 'Function' || term.arguments.length !== 2) return false;
      const [left, right] = term.arguments;
      const operator = key(term.name);
      if (['equals', 'greater', 'greaterorequals', 'less', 'lessorequals'].includes(operator)) {
        return (identifier(left, column) && literal(right)) || (literal(left) && identifier(right, column));
      }
      return ['in', 'globalin'].includes(operator) && identifier(left, column) && right.type === 'Literal'
        && right.value_type === 'Tuple' && Array.isArray(right.value) && right.value.length > 0
        && right.value.every(item => item.value !== null && !['Null', 'Tuple', 'Array'].includes(item.value_type));
    });
    if (!proved) return fail('required_filter_missing', column);
  }
  return null;
}

// Only policy lineage lives here. CK EXPLAIN PLAN owns SQL semantics (types,
// grouping, window/aggregate legality and JOIN strategy). The function
// capability allowlist stays while the database account has broad privileges.
// A derived source exposes only projections already checked in its own scope.
type Source = { names: string[]; columns: readonly ColumnGrant[]; grant?: TableGrant; requiresAggregation?: boolean };
type Projections = { columns: ColumnGrant[]; failure?: Failure; requiresAggregation?: boolean };

function reviewQuery(query: SelectWithUnionQueryNode, policy: SqlReviewPolicy,
  used: Set<string>, inheritedCtes = new Map<string, Projections>(), depth = 0, finalOutput = false): Projections {
  if (depth > 64) return { columns: [], failure: fail('sql_depth_limit') };
  if (query.selects.length > 8) return { columns: [], failure: fail('union_branch_limit') };
  let columns: ColumnGrant[] = [];
  let requiresAggregation = false;
  for (const branch of query.selects) {
    if (branch.type !== 'SelectQuery') return { columns: [], failure: fail('nested_set_operation_unsupported') };
    const reviewed = reviewSelect(branch, policy, used, inheritedCtes, depth + 1, finalOutput);
    if (reviewed.failure) return reviewed;
    // All branch expressions were authorized independently. Sensitive raw
    // projections never enter a derived source, even under a different alias.
    if (!columns.length) columns = reviewed.columns;
    requiresAggregation ||= reviewed.requiresAggregation ?? false;
  }
  return { columns, requiresAggregation };
}

function reviewSelect(query: SelectQueryNode, policy: SqlReviewPolicy, used: Set<string>,
  inheritedCtes: Map<string, Projections>, depth: number, finalOutput: boolean): Projections {
  const deny = (failure: Failure): Projections => ({ columns: [], failure });
  if (query.recursive_with) return deny(fail('cte_lineage_unsupported'));
  const ctes = new Map(inheritedCtes);
  for (const item of query.with ?? []) {
    if (item.type !== 'WithElement' || item.aliases || item.subquery.query.type !== 'SelectWithUnionQuery') {
      return deny(fail('cte_lineage_unsupported'));
    }
    if (ctes.has(item.name)) return deny(fail('cte_shadowing_unsupported'));
    const reviewed = reviewQuery(item.subquery.query, policy, used, ctes, depth + 1);
    if (reviewed.failure) return reviewed;
    ctes.set(item.name, reviewed);
  }
  const elements = query.from?.children ?? [];
  const sources: Source[] = [];
  const predicate = query.prewhere && query.where
    ? { type: 'Function', name: 'and', arguments: [query.prewhere, query.where] } as Expression
    : query.where ?? query.prewhere;
  for (const element of elements) {
    const expression = element.table_expression;
    // ARRAY JOIN changes identifier bindings; do not guess its lineage.
    if (!expression || element.array_join) return deny(fail('source_capability_unsupported'));
    const table = expression.database_and_table_name;
    let source: Source;
    if (expression.subquery) {
      if (expression.subquery.query.type !== 'SelectWithUnionQuery') return deny(fail('derived_source_unresolved'));
      const reviewed = reviewQuery(expression.subquery.query, policy, used, ctes, depth + 1);
      if (reviewed.failure) return reviewed;
      source = { names: expression.subquery.alias ? [expression.subquery.alias] : [],
        columns: reviewed.columns, requiresAggregation: reviewed.requiresAggregation };
    } else if (table && !table.database && ctes.has(String(table.name))) {
      const projection = ctes.get(String(table.name))!;
      source = { names: [String(table.alias ?? table.name)], columns: projection.columns,
        requiresAggregation: projection.requiresAggregation };
    } else if (table && (table.database || policy.defaultDatabase)) {
      const fqn = `${table.database ?? policy.defaultDatabase}.${table.name}`;
      const grant = policy.tables.find(item => item.fqn === fqn);
      if (!grant) return deny(fail('table_not_authorized', fqn));
      const alias = String(table.alias ?? table.name);
      const kind = grant.scanKind ?? 'day';
      const proof = kind === 'unpartitioned' ? null
        : kind === 'datetime' ? datetimeProof(predicate, grant.partitionColumn!, grant.maxScanDays, alias, elements.length === 1)
        : kind === 'sentinel' ? sentinelProof(predicate, grant.partitionColumn!, grant.sentinelValue!, alias, elements.length === 1)
        : partitionProof(predicate, grant.partitionColumn!, grant.maxScanDays, alias, elements.length === 1);
      if (proof) return deny({ ...proof, detail: `${fqn}${proof.detail ? `: ${proof.detail}` : ''}` });
      const required = requiredFilterProof(predicate,
        (grant.requiredFilters ?? []).filter(field => !(kind === 'datetime' && field === grant.partitionColumn)), alias);
      if (required) return deny({ ...required, detail: `${fqn}.${required.detail}` });
      used.add(fqn);
      source = { names: table.alias ? [String(table.alias)] : [String(table.name), fqn],
        columns: grant.columns, grant, requiresAggregation: !policy.allowDetail };
    } else return deny(fail('physical_source_unresolved'));
    if (source.names.some(name => sources.some(previous => previous.names.includes(name)))) {
      return deny(fail('column_source_unresolved', source.names[0]));
    }
    sources.push(source);
  }

  const aliases = new Map<string, Expression>();
  for (const expr of query.select) {
    if (!('alias' in expr) || typeof expr.alias !== 'string') continue;
    if (aliases.has(expr.alias)) return deny(fail('duplicate_output_alias'));
    const collides = sources.some(source => source.columns.some(column => column.name === expr.alias));
    // Prevent alias substitution from changing the meaning of scan/PII proofs.
    const identity = expr.type === 'Identifier' && (expr.name_parts ?? expr.name.split('.')).at(-1) === expr.alias;
    if (collides && !identity) {
      const protectedName = sources.some(source => source.grant && (source.grant.partitionColumn === expr.alias
        || source.grant.requiredFilters?.includes(String(expr.alias))
        || source.columns.some(column => column.name === expr.alias && column.privacy && column.privacy !== 'ordinary')));
      const unqualified = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(unqualified);
        const node = record(value);
        if (!node) return false;
        if (node.type === 'Identifier') return node.name === expr.alias;
        return Object.entries(node).some(([field, child]) => !['location', 'parent', 'alias', 'from', 'with', 'order_by'].includes(field) && unqualified(child));
      };
      if (protectedName || unqualified({ ...query, select: query.select.filter(item => item !== expr) })) {
        return deny(fail('column_alias_collision', expr.alias));
      }
    }
    aliases.set(expr.alias, expr);
  }
  const piiDistinct = new Set((policy.piiDistinctFunctions ?? []).map(key));
  const check = (value: unknown, insideDistinct = false, resolving = new Set<string>()): Failure | null => {
    if (Array.isArray(value)) {
      for (const child of value) { const failure = check(child, insideDistinct, resolving); if (failure) return failure; }
      return null;
    }
    const node = record(value);
    if (!node) return null;
    if (node.type === 'Literal') return null;
    if (node.type === 'Identifier') {
      const expr = node as unknown as Expression & { name: string; name_parts?: string[] };
      const parts = expr.name_parts ?? expr.name.split('.');
      const name = parts.at(-1)!;
      const qualifier = parts.slice(0, -1).join('.');
      const candidates = sources.filter(source => (!qualifier || source.names.includes(qualifier))
        && source.columns.some(column => column.name === name));
      if (parts.length === 1 && aliases.has(name) && !candidates.length) {
        if (resolving.has(name)) return fail('column_source_unresolved', expr.name);
        return check(aliases.get(name), insideDistinct, new Set([...resolving, name]));
      }
      if (qualifier && !sources.some(source => source.names.includes(qualifier))) return fail('column_source_unresolved', expr.name);
      if (!candidates.length) return fail('column_not_authorized', expr.name);
      // USING/merged columns may have multiple origins. Every origin must pass.
      for (const source of candidates) {
        const privacy = source.columns.find(column => column.name === name)!.privacy;
        if (privacy === 'forbidden' || (privacy === 'aggregation_only' && !insideDistinct)) {
          return fail('pii_output_forbidden', expr.name);
        }
      }
      return null;
    }
    if (node.type === 'Asterisk' || node.type === 'QualifiedAsterisk' || String(node.type).startsWith('Columns')) return fail('wildcard_forbidden');
    if (node.type === 'Subquery') {
      const subquery = node.query;
      if (record(subquery)?.type !== 'SelectWithUnionQuery') return fail('derived_source_unresolved');
      return reviewQuery(subquery as SelectWithUnionQueryNode, policy, used, ctes, depth + 1).failure ?? null;
    }
    if (node.type === 'Function') {
      if (node.is_lambda_function) return fail('expression_capability_unsupported', 'lambda');
      const args = node.arguments as Expression[];
      const name = key(String(node.name));
      if (!LANGUAGE_OPERATORS.has(name) && !policy.allowedFunctions.some(allowed => key(allowed) === name)
          && !approvedAggregate(name, policy)) return fail('function_not_allowed', name);
      const safePii = piiDistinct.has(name) && args.length === 1 && args[0]?.type === 'Identifier';
      for (const arg of args) {
        if (name === 'count' && arg.type === 'Asterisk' && !arg.transformers?.length) continue;
        const failure = check(arg, safePii, resolving); if (failure) return failure;
      }
      // Parameters and window PARTITION/ORDER/frame expressions never inherit
      // the sensitive distinct-count exception.
      for (const [field, child] of Object.entries(node)) {
        if (!['arguments', 'alias', 'name', 'type', 'location', 'parent'].includes(field)) {
          const failure = check(child, false, resolving); if (failure) return failure;
        }
      }
      return null;
    }
    for (const [field, child] of Object.entries(node)) {
      if (!['alias', 'location', 'parent'].includes(field)) {
        const failure = check(child, false, resolving); if (failure) return failure;
      }
    }
    return null;
  };
  // Traverse every expression-bearing clause (including JOIN ON/USING,
  // HAVING, QUALIFY, named windows and ORDER BY fill expressions).
  for (const element of elements) {
    const failure = check(element.table_join); if (failure) return deny(failure);
    for (const [field, child] of Object.entries(element.table_expression!)) {
      if (!['database_and_table_name', 'subquery', 'type'].includes(field)) {
        const failure = check(child); if (failure) return deny(failure);
      }
    }
  }
  for (const [field, child] of Object.entries(query)) {
    if (['with', 'from', 'location', 'parent'].includes(field)) continue;
    if (field === 'order_by' && query.order_by_all) continue; // Parser's synthetic ALL identifier.
    const failure = check(child); if (failure) return deny(failure);
  }
  // LIMIT semantics belong to CK PLAN; its expressions were checked above.
  // Actual result rows/bytes remain bounded by the native driver and host.
  // Ordinary intermediate projections are needed for mapping/IN/CTE inputs.
  // Carry their output boundary to the final query so wrappers cannot authorize
  // detail exports. Every scope still proves permissions, PII and scan filters.
  const containsAggregate = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsAggregate);
    const node = record(value);
    if (!node) return false;
    if (node.type === 'Subquery') return false; // A scalar subquery is not an outer aggregation.
    if (node.type === 'Function' && !node.is_window_function
        && approvedAggregate(key(String(node.name)), policy)) return true;
    return Object.entries(node).some(([field, child]) => !['location', 'parent'].includes(field) && containsAggregate(child));
  };
  const requiresAggregation = sources.some(source => source.requiresAggregation)
    && !containsAggregate(query.select) && !query.group_by?.length;
  if (finalOutput && requiresAggregation) {
    if (!query.distinct) return deny(fail('detail_output_unsupported'));
    if (!query.limit) return deny(fail('distinct_limit_required'));
  }
  return { requiresAggregation: requiresAggregation && !(query.distinct && query.limit),
    columns: query.select.map(expr => ({ name: 'alias' in expr && typeof expr.alias === 'string' ? expr.alias
    : expr.type === 'Identifier' ? String((expr.name_parts ?? expr.name.split('.')).at(-1)) : '' })) };
}

function parseReadOnlySql(sql: string, maxBytes: number): { query: SelectWithUnionQueryNode } | { failure: Failure } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) return { failure: fail('invalid_policy_configuration') };
  if (Buffer.byteLength(sql, 'utf8') > maxBytes) return { failure: fail('sql_size_limit') };
  if (!sql.trim()) return { failure: fail('empty_sql') };
  const depth = cheapDepthCheck(sql);
  if (depth) return { failure: depth };
  let statements: { type: string }[];
  try { statements = parse(sql, { locations: false }); }
  catch { return { failure: fail('sql_parse_failed') }; }
  if (statements.length !== 1) return { failure: fail('multiple_statements_forbidden') };
  const statement = statements[0];
  if (!statement || statement.type !== 'SelectWithUnionQuery') return { failure: fail('statement_not_read_only') };
  const hazard = scanHazards(statement);
  return hazard ? { failure: hazard } : { query: statement as SelectWithUnionQueryNode };
}

/** Finds candidate physical identities for loading policy, never grants permission to execute. */
export function inspectSqlSources(sql: string, maxBytes = 64 * 1024):
  { ok: true; tables: string[] } | { ok: false; reason: string; detail?: string } {
  const parsed = parseReadOnlySql(sql, maxBytes);
  if ('failure' in parsed) return { ok: false, ...parsed.failure };
  const tables = new Set<string>();
  const pending: unknown[] = [parsed.query];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = record(value);
    if (!node) continue;
    if (node.type === 'TableExpression') {
      const table = record(node.database_and_table_name);
      if (table && typeof table.database === 'string' && typeof table.name === 'string') tables.add(`${table.database}.${table.name}`);
    }
    for (const [name, child] of Object.entries(node)) if (name !== 'location' && name !== 'parent') pending.push(child);
  }
  return tables.size ? { ok: true, tables: [...tables] } : { ok: false, reason: 'physical_source_required' };
}

/** Offline policy proof only; no database access and no SQL rewriting. */
export function reviewSql(sql: string, policy: SqlReviewPolicy): SqlReviewDecision {
  const deny = (failure: Failure): SqlReviewDecision => ({ ok: false, sql, ...failure });
  if (!Number.isSafeInteger(policy.maxRows) || policy.maxRows < 1
      || (policy.defaultDatabase !== undefined && !/^[A-Za-z_][\w]*$/.test(policy.defaultDatabase))
      || !policy.tables.length || policy.tables.some(table =>
        !/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/.test(table.fqn)
        || !(['day', 'datetime', 'sentinel', 'unpartitioned'].includes(table.scanKind ?? 'day'))
        || ((table.scanKind ?? 'day') !== 'unpartitioned'
          && !table.columns.some(column => column.name === table.partitionColumn))
        || (table.scanKind === 'sentinel' && (typeof table.sentinelValue !== 'string' || !table.sentinelValue))
        || (table.scanKind !== 'sentinel' && table.sentinelValue !== undefined)
        || (table.requiredFilters ?? []).some(field => !table.columns.some(column => column.name === field))
        || !Number.isSafeInteger(table.maxScanDays) || table.maxScanDays < 1)
      || policy.aggregateFunctions.some(name => !policy.allowedFunctions.map(key).includes(key(name)))
      || (policy.piiDistinctFunctions ?? []).some(name => !PII_DISTINCT_FUNCTIONS.has(key(name))
        || !policy.aggregateFunctions.map(key).includes(key(name)))) {
    return deny(fail('invalid_policy_configuration'));
  }
  const parsed = parseReadOnlySql(sql, policy.maxSqlBytes ?? 64 * 1024);
  if ('failure' in parsed) return deny(parsed.failure);
  const used = new Set<string>();
  const failure = reviewQuery(parsed.query, policy, used, undefined, 0, true).failure
    ?? (!used.size ? fail('physical_source_required') : undefined);
  return failure ? deny(failure) : { ok: true, sql, tables: [...used], reason: 'approved' };
}
