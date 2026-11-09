# VV Data Agent 复合键 JOIN 适配

本补丁基于已应用第二版数据包 `6baa19ecbab1b41833090a2a76c79c51c33351d05145385f79a41f443409c647` 和接收机 13 路径适配 `676eb4c87a71e18b3b6f4659035d20ab4fa4f0d626c0959f6bd41f2deb132450` 的工作树。接收机转来的 13 个文件在同步时逐一匹配 after SHA-256。

## 原因与修复

实际失败的 SQL 同时包含 `f.dataset_version=d.dataset_version` 和 `f.app_id=d.app_id`。问题包括三层：

1. 生成契约的 grain 含版本键，但 series.dimensions 漏了该键，违反宿主用于证明的完整物理粒度要求。现统一补齐，涉及的序列契约和登记版本递增为 v2。日期 must_filter 仍只有 Date 列。
2. 直接 GROUP BY 折叠了国家、渠道和广告等完整事实键，旧路径只在受限预聚合 CTE 中允许这种证明。现在原生审查通过后的直接分组也可捕获完整键，并使用现有有界聚合回执检查唯一性和维表重复。没有证明的缺日及未出现分组仍为未知。
3. 本机 ClickHouse 26.11 的合法 EXPLAIN 含空白分隔行，旧判定误以为计划无效。现在允许计划中夹带空白，但空计划、全空白、错误列/类型和截断仍拒绝，正式 SQL 不会继续执行。

新表 UInt64 也已补齐。捕获值以精确整数字符串及 BigInt 检查位宽和符号，拒绝 unsafe Number、负 UInt64、越界和 SUM 溢出。只有数据库计数回执时，不把 UInt64/Int64 的潜在溢出 SUM 认证为精确值；其他有界整数和 Decimal 聚合也检查累加器上界。

## 实际本地验证

验证使用自己创建的 ClickHouse 26.11.1.1612 回环 HTTP 服务、23 张 tiny 合成表和真实宿主领域工具。控制状态为临时 SQLite，没有 MySQL/Redis/Pi/model/browser。

接收机的原始 SELECT、ON、日期与 GROUP BY 保持相同形状，只将 dataset_version 替换为本次测试发布。原始成本 JOIN 已依次完成契约绑定、EXPLAIN、正式查询、证据回读和正式交付。独立读取生成数据后用 Decimal 求得的六组金额与宿主逐项一致：

| App | 折后成本 USD |
|---|---:|
| blockfall_android | 15.250428 |
| blockfall_ios | 19.300204 |
| gridfit_android | 17.594751 |
| gridfit_ios | 17.365794 |
| stackjoy_android | 19.596562 |
| stackjoy_ios | 15.977107 |

正式结果保留拼格、落块、叠叠乐名称和 USD 单位。终态为 partial，原因是 `coverage_unknown` 和 `model_completion_was_not_authoritative`；没有 `join_key_mismatch` 或 `query_expression_semantics_unverified`。这里的 partial 不否定已核验金额，也不证明整个经营总体完整。

自动回归包括契约一致性、原始 SQL、缺少登记键、OR 绕过、错误关联、UInt64 精度/边界/溢出、重复事实行、缺日、EXPLAIN 空白/截断、只读配置和旧知识包流程。Python 测试另覆盖新知识绑定保留旧目录、拒绝覆盖和拒绝绑定对账失败数据。

本机未复跑接收机的 338 项完整测试，也未把原生 26.11 的结果写成 ClickHouse 24.8 验证。真实模型请求为 0，没有提交、推送或部署。

## 接收与重新绑定

先按增量清单校验 before/after SHA，保留现有未提交修改。不得把上一份“新增 92 路径”补丁重新覆盖到已经应用的目录。

在项目根运行：

```sh
python3 -m synthetic.starhaven knowledge
python3 -m unittest discover -s synthetic/starhaven/tests -v
node --import tsx --import ./tests/test-clock.mjs --test tests/vv-join-contract.test.ts tests/clickhouse-explain.test.ts tests/clickhouse-locked-profile.test.ts tests/starhaven-knowledge.test.ts
npm run typecheck
```

复用已有 tiny 数据时，创建新知识目录：

```sh
python3 -m synthetic.starhaven bind-knowledge \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --output .local-runtime/vv-knowledge-contract-v2
```

dataset 改为接收机真实的生成目录；output 必须全新。该步骤不会修改 JSONL、数据版本、旧 release-knowledge 或数据库。API、worker、freshness 的 KNOWLEDGE_DIR 同时切到新 output；若显式设置 FRESHNESS_TARGETS_PATH，也切到新 output 下的 freshness-targets.json。使用原有只读账号并保留 CLICKHOUSE_LOCKED_READONLY=true，重新发布 MySQL 权威 freshness，再验证原 SQL。

有原生二进制时可显式运行：

```sh
python3 -m synthetic.starhaven.tests.native_join \
  --binary /absolute/path/to/clickhouse \
  --report .local-runtime/vv-native-join-report.json
```

该工具独占其临时服务器和数据，结束后清理自身资源。接收机应在自己的 24.8 隔离栈上补跑 API/MySQL/outbox/Redis/worker/Pi 协议验证，保持相同 SQL 和独立金额预期。完整回归需在最终代码冻结后运行，不能把测试期间继续修改的结果报告为最终冻结全套。

预测快照仍未发布为在线认证目标，未因这次 JOIN 适配而开放。UInt64 聚合回执限制、未知覆盖和跨查询非原子观察也继续保留；不得通过去除这些限制获得 completed。
