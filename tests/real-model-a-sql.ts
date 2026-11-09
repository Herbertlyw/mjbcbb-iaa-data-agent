// Synthetic SQL copied verbatim from the latest real DeepSeek A acceptance trace.
export const REAL_A_PAYMENT_SQL =
  "SELECT event_date, title_id, platform, country_code, channel_id, amount_usd, cost_usd FROM fact_fox_daily_payment WHERE event_date IN (toDate('2026-10-08')) AND country_code = 'US' AND platform = 'ios' AND channel_id = 'mist_ads' AND title_id = 'paper_lantern'";

export const REAL_A_SPEND_SQL =
  "SELECT event_date, title_id, platform, country_code, channel_id, spend_usd, payback_usd, is_predicted FROM fact_fox_daily_spend WHERE event_date IN (toDate('2026-10-08')) AND country_code = 'US' AND platform = 'ios' AND channel_id = 'mist_ads' AND title_id = 'paper_lantern'";
