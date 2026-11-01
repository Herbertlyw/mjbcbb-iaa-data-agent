# 周度示例 SQL

下面是写法示例，不是授权，服务端也不会因为读过这段文字就执行它。

```sql
SELECT event_date, platform, country_code, channel, new_users
FROM daily_installs
WHERE event_date >= '2026-10-06'
  AND event_date <= '2026-10-12'
  AND platform = 'ios'
  AND country_code = 'US'
```

真正执行时仍要先读取当前契约，并由服务端重新校验表、字段、日期范围和敏感字段。
