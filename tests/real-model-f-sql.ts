// Synthetic SQL copied verbatim from the real DeepSeek F acceptance trace.
export const REAL_F_JOIN_SQL = `SELECT t.title_name AS title_name,
       countIf(f.new_users IS NULL) AS null_rows,
       countIf(f.new_users = 0) AS zero_rows,
       count() AS row_count,
       SUM(f.new_users) AS new_users_sum
FROM fact_fox_daily_install AS f
INNER JOIN dim_fox_title AS t ON f.title_id = t.title_id
WHERE f.event_date >= toDate('2026-10-06')
  AND f.event_date <= toDate('2026-10-12')
  AND f.country_code = 'JP'
  AND f.platform = 'ios'
  AND f.channel_id = 'mist_ads'
  AND f.title_id = 'paper_lantern'
GROUP BY t.title_name
ORDER BY title_name`;

export const REAL_F_FACT_SQL = `SELECT title_id,
       countIf(new_users IS NULL) AS null_rows,
       countIf(new_users = 0) AS zero_rows,
       count() AS row_count,
       SUM(new_users) AS new_users_sum
FROM fact_fox_daily_install
WHERE event_date >= toDate('2026-10-06')
  AND event_date <= toDate('2026-10-12')
  AND country_code = 'JP'
  AND platform = 'ios'
  AND channel_id = 'mist_ads'
  AND title_id = 'paper_lantern'
GROUP BY title_id`;
