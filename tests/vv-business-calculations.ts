// Scripted tool references are derived from current query replies, never fixture IDs.
export interface BusinessInput {
  resource_id: string;
  execution_id: string;
  rows: Array<Record<string, unknown>>;
}

export interface BusinessCalculation {
  metric: string;
  row: number;
  factor: number;
  params: Record<string, unknown>;
}

/** Build bounded mathematical checks; business certification stays with the host. */
export function businessCalculations(recipe: string, inputs: BusinessInput[], prepared: BusinessInput[] = []): BusinessCalculation[] {
  const output: BusinessCalculation[] = [];
  const ref = (input: BusinessInput, column: string, row: number | null) => ({
    resource_id: input.resource_id, execution_id: input.execution_id, column,
    ...(row === null ? { aggregate: "sum" } : { row }),
  });
  const divide = (metric: string, input: BusinessInput, numerator: string, denominator: string, row: number, factor = 1) => {
    output.push({ metric, row, factor, params: { operation: "divide",
      numerator: ref(input, numerator, row), denominator: ref(input, denominator, row) } });
  };
  const first = inputs[0];
  if (!first) return output;
  for (let row = 0; row < first.rows.length; row++) {
    if (["cpi", "plan_efficiency", "creative_efficiency"].includes(recipe))
      divide("af_cpi_usd", first, "total_discounted_cost_usd", "total_af_registers", row);
    if (recipe === "plan_efficiency") divide("ctr_pct", first, "total_clicks", "total_impressions", row, 100);
    if (recipe === "arpdau") divide("arpdau_usd", first, "total_ad_revenue_usd", "total_active_devices", row);
    if (recipe === "ad_funnel") {
      divide("ecpm_usd", first, "total_revenue_usd", "total_impressions", row, 1000);
      divide("load_success_pct", first, "total_successful_load_attempts", "total_completed_load_attempts", row, 100);
      divide("load_completion_pct", first, "total_completed_load_attempts", "total_load_attempts", row, 100);
      divide("show_success_pct", first, "total_successful_show_requests", "total_completed_show_requests", row, 100);
    }
  }
  if (recipe === "retention" && prepared[0]) output.push({ metric: "rr_pct", row: 0, factor: 100,
    params: { operation: "divide", numerator: ref(prepared[0], "retained_total", 0), denominator: ref(prepared[0], "base_once", 0) } });
  if (recipe === "ltv7" && prepared[0] && prepared[1]) output.push({ metric: "ltv7_usd_per_device", row: 0, factor: 1,
    params: { operation: "divide", numerator: ref(prepared[1], "revenue_total", 0), denominator: ref(prepared[0], "base_once", 0) } });
  if (recipe === "roi" && inputs[1]) {
    for (let row = 0; row < first.rows.length; row++) {
      const other = inputs[1].rows.findIndex(item => item.ua_channel_id === first.rows[row]!.ua_channel_id);
      if (other < 0) continue;
      output.push({ metric: "roi_pct", row, factor: 100, params: { operation: "divide",
        numerator: ref(inputs[1], "total_revenue_usd", other), denominator: ref(first, "total_discounted_cost_usd", row) } });
    }
  }
  return output;
}

/** Reduce only the selected observation slice, keeping D0 separate from its window. */
export function businessPreparations(recipe: string, inputs: BusinessInput[]): Array<Record<string, unknown>> {
  const group = (input: BusinessInput, fields: Array<[string, string]>) => ({ operation: "transform",
    input: { resource_id: input.resource_id, execution_id: input.execution_id },
    steps: [{ op: "group", by: [], aggregates: fields.map(([column, as]) => ({ op: "sum", column, as })) }] });
  if (recipe === "retention" && inputs[0])
    return [group(inputs[0], [["retained_devices", "retained_total"], ["cohort_size_devices", "base_once"]])];
  if (recipe === "ltv7" && inputs[0] && inputs[1])
    return [group(inputs[0], [["cohort_size_devices", "base_once"]]), group(inputs[1], [["ad_revenue_usd", "revenue_total"]])];
  return [];
}
