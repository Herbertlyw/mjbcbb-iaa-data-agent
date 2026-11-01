-- 虚构游戏 Starlane Drift 的本地合成数据。没有真实用户、渠道账号或生产阈值。
DROP TABLE IF EXISTS daily_installs;
DROP TABLE IF EXISTS daily_ad_revenue;
DROP TABLE IF EXISTS daily_unit_economics;
DROP TABLE IF EXISTS player_device_map;
DROP TABLE IF EXISTS legacy_installs;
DROP TABLE IF EXISTS staging_notes;
DROP TABLE IF EXISTS finance_ledger;

CREATE TABLE daily_installs (
  event_date TEXT NOT NULL,
  product_id TEXT NOT NULL DEFAULT 'starlane_drift',
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  channel TEXT NOT NULL,
  new_users INTEGER
);

CREATE TABLE daily_ad_revenue (
  event_date TEXT NOT NULL,
  product_id TEXT NOT NULL DEFAULT 'starlane_drift',
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  placement TEXT NOT NULL,
  revenue_usd REAL,
  is_predicted INTEGER NOT NULL
);

CREATE TABLE daily_unit_economics (
  event_date TEXT NOT NULL,
  product_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  channel TEXT NOT NULL,
  spend_usd REAL,
  payback_usd REAL,
  is_predicted INTEGER NOT NULL
);

CREATE TABLE player_device_map (
  event_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  device_id TEXT NOT NULL,
  player_id TEXT NOT NULL
);

CREATE TABLE legacy_installs (
  event_date TEXT NOT NULL,
  platform TEXT NOT NULL,
  new_users INTEGER
);

CREATE TABLE staging_notes (
  event_date TEXT NOT NULL,
  note TEXT NOT NULL
);

CREATE TABLE finance_ledger (
  event_date TEXT NOT NULL,
  amount_usd REAL NOT NULL
);

-- 美国 iOS：10-07 是真实零，10-09 新增缺失。
INSERT INTO daily_installs (event_date, platform, country_code, channel, new_users) VALUES
  ('2026-10-06', 'ios', 'US', 'nebula_ads', 120),
  ('2026-10-07', 'ios', 'US', 'nebula_ads', 0),
  ('2026-10-08', 'ios', 'US', 'nebula_ads', 95),
  ('2026-10-09', 'ios', 'US', 'nebula_ads', NULL),
  ('2026-10-10', 'ios', 'US', 'nebula_ads', 110),
  ('2026-10-11', 'ios', 'US', 'nebula_ads', 80),
  ('2026-10-12', 'ios', 'US', 'nebula_ads', 75),
  ('2026-10-06', 'android', 'US', 'nebula_ads', 200),
  ('2026-10-07', 'android', 'US', 'nebula_ads', 40),
  ('2026-10-08', 'android', 'US', 'nebula_ads', 0),
  ('2026-10-09', 'android', 'US', 'nebula_ads', 180),
  ('2026-10-10', 'android', 'US', 'nebula_ads', NULL),
  ('2026-10-11', 'android', 'US', 'nebula_ads', 150),
  ('2026-10-12', 'android', 'US', 'nebula_ads', 160),
  ('2026-10-06', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-07', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-08', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-09', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-10', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-11', 'ios', 'JP', 'nebula_ads', 10),
  ('2026-10-12', 'ios', 'JP', 'nebula_ads', 10);

-- 美国 iOS：10-07 实际为零，10-08 缺失，10-10 与 10-11 是预测。
INSERT INTO daily_ad_revenue (event_date, platform, country_code, placement, revenue_usd, is_predicted) VALUES
  ('2026-10-06', 'ios', 'US', 'rewarded', 12.5, 0),
  ('2026-10-07', 'ios', 'US', 'rewarded', 0, 0),
  ('2026-10-08', 'ios', 'US', 'rewarded', NULL, 0),
  ('2026-10-09', 'ios', 'US', 'rewarded', 15, 0),
  ('2026-10-10', 'ios', 'US', 'rewarded', 14, 1),
  ('2026-10-11', 'ios', 'US', 'rewarded', 13.5, 1),
  ('2026-10-12', 'ios', 'US', 'rewarded', 16, 0),
  ('2026-10-06', 'android', 'US', 'rewarded', 20, 0),
  ('2026-10-07', 'android', 'US', 'rewarded', 0, 0),
  ('2026-10-08', 'android', 'US', 'rewarded', 5, 0),
  ('2026-10-09', 'android', 'US', 'rewarded', NULL, 0),
  ('2026-10-10', 'android', 'US', 'rewarded', 9, 1),
  ('2026-10-11', 'android', 'US', 'rewarded', 8, 1),
  ('2026-10-12', 'android', 'US', 'rewarded', 22, 0),
  ('2026-10-06', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-07', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-08', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-09', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-10', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-11', 'ios', 'JP', 'rewarded', 3, 0),
  ('2026-10-12', 'ios', 'JP', 'rewarded', 3, 0);

INSERT INTO player_device_map (event_date, platform, country_code, device_id, player_id) VALUES
  ('2026-10-06', 'ios', 'US', 'sim-device-001', 'sim-player-001'),
  ('2026-10-07', 'ios', 'US', 'sim-device-002', 'sim-player-002'),
  ('2026-10-08', 'android', 'US', 'sim-device-003', 'sim-player-003');

INSERT INTO legacy_installs (event_date, platform, new_users) VALUES
  ('2025-01-01', 'ios', 999);

INSERT INTO staging_notes (event_date, note) VALUES
  ('2026-10-06', '合成草稿，没有契约');

INSERT INTO finance_ledger (event_date, amount_usd) VALUES
  ('2026-10-06', 999.5);

-- 上一等长窗口，只用于环比。不落在 2026-10-06 至 2026-10-12，因此不改变该周合计。
INSERT INTO daily_installs (event_date, product_id, platform, country_code, channel, new_users) VALUES
  ('2026-09-29', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-09-30', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-10-01', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-10-02', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-10-03', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-10-04', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20),
  ('2026-10-05', 'starlane_drift', 'ios', 'US', 'nebula_ads', 20);

-- 第二件虚构产品，放在德国，避免混入美国或日本的既有合计。
INSERT INTO daily_installs (event_date, product_id, platform, country_code, channel, new_users) VALUES
  ('2026-10-06', 'ember_kites', 'ios', 'DE', 'nebula_ads', 8),
  ('2026-10-07', 'ember_kites', 'ios', 'DE', 'nebula_ads', 0);

-- 投放成本与回收。预测行不进入实际 ROI。10-07 成本是真实零，10-08 成本缺失。
INSERT INTO daily_unit_economics (
  event_date, product_id, platform, country_code, channel, spend_usd, payback_usd, is_predicted
) VALUES
  ('2026-10-06', 'starlane_drift', 'ios', 'US', 'nebula_ads', 10, 20, 0),
  ('2026-10-07', 'starlane_drift', 'ios', 'US', 'nebula_ads', 0, 0, 0),
  ('2026-10-08', 'starlane_drift', 'ios', 'US', 'nebula_ads', NULL, NULL, 0),
  ('2026-10-09', 'starlane_drift', 'ios', 'US', 'nebula_ads', 10, 5, 0),
  ('2026-10-10', 'starlane_drift', 'ios', 'US', 'nebula_ads', 10, 30, 1),
  ('2026-10-11', 'starlane_drift', 'ios', 'US', 'nebula_ads', 8, 16, 0),
  ('2026-10-12', 'starlane_drift', 'ios', 'US', 'nebula_ads', 12, 6, 0),
  ('2026-10-06', 'starlane_drift', 'ios', 'US', 'comet_network', 5, 5, 0);
