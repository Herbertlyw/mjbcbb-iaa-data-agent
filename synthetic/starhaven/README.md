# VV Data Agent：第二版合成业务数据

本包实现 23 张 ClickHouse 表、309 个字段声明、43 个指标定义，以及从同一设备日过程生成的投放、安装、活跃、玩法、广告、实验和回收数据。业务定义沿用已经确认的第二版设计；产品、对象、参数和数值全部虚构。

不需要模型密钥，不读取公司数据库，不改变 Lumenfox / Harborlight 数据和既有 Pi、worker 或状态协议。VV 页面通过 API 读取绑定发布的场景元数据；生成数据、密码和运行报告放在 Git 忽略的 `.local-runtime/`。

## 先运行

在项目根目录，使用 Python 3.9 或更新版本。生成器只依赖 Python 标准库。

```sh
python3 -m synthetic.starhaven build \
  --profile tiny \
  --as-of 2026-11-08 \
  --output .local-runtime/starhaven-tiny-v1

python3 -m unittest discover -s synthetic/starhaven/tests -v
python3 -m synthetic.starhaven knowledge

node --import tsx --test tests/starhaven-knowledge.test.ts
node --import tsx src/knowledge-doctor.ts knowledge/starhaven
```

`build` 先生成新目录，再生成绑定该版本的 `release-knowledge` 并执行 Python 对账。退出码 0 表示对账通过，2 表示生成成功但质量检查失败，1 表示参数、文件或执行错误。输出目录必须不存在，绝不覆盖旧版本。

## 数据规模

| 档位 | 天数 | 每 App 每日候选首次安装 | 默认最大公开行数 | 用途 |
|---|---:|---:|---:|---|
| tiny | 14 | 4 | 2,000,000 | 快速验收、错误反例 |
| demo | 120 | 8 | 2,000,000 | 日常演示、趋势与实验 |
| standard | 455 | 4 | 2,000,000 | 百万级数据、成熟 ROI360 回测 |
| scale | 455 | 12 | 5,000,000 | 更高密度；本轮未做此档全量性能验收 |

候选安装会受预算和暂停规则影响，因此实际设备数不等于候选数乘日期。公开行数来自不同粒度聚合，也不等于设备数。生成器保留有界的设备日状态与投影，规模上调会增加内存和耗时；行数和私有设备预算会提前阻止继续扩张。

```sh
python3 -m synthetic.starhaven build \
  --profile standard --as-of 2026-11-08 \
  --output .local-runtime/starhaven-standard-v1
```

`--days`、`--installs-per-app-day`、`--seed`、`--row-budget` 可显式覆盖。日期范围为 2020–2099，天数 14–730。`--start-date` 与 `--as-of` 二选一。

## 三款游戏和主体关系

- 拼格 GridFit：拖消，`game_id=gridfit`，包含 endless / level 两种已定义模式。
- 落块 BlockFall：落消，`game_id=blockfall`，包含 level 模式。
- 叠叠乐 StackJoy：`game_id=stackjoy`，玩法 `unconfirmed`；不编造 TPT 玩法或胜负定义。

应用展示名称统一为 **VV Data Agent**。实现目录、命令模块和数据库前缀沿用 `starhaven` 技术命名，不把它显示为应用名。

每款各有 iOS / Android 包体，共 6 App。另有美国、日本、德国，两个虚构付费渠道、自然来源与归因未知分类；2 个账户、12 个计划、12 个广告组、24 个广告、24 个可复用素材。获客渠道与广告变现 network 是不同维度。

## 23 张表

| 类别 | 表 |
|---|---|
| 9 张维度 | `dim_app`、`dim_country`、`dim_ua_channel`、`dim_ad_account`、`dim_campaign`、`dim_ad_group`、`dim_ad`、`dim_creative`、`dim_experiment_arm` |
| 投放与获客 | `fact_delivery_daily`、`fact_acquisition_daily` |
| 产品与玩法 | `fact_activity_daily`、`fact_cohort_quality_daily`、`fact_gameplay_daily` |
| 商业化与回收 | `fact_ad_funnel_daily`、`fact_cohort_revenue_daily` |
| 素材与实验 | `fact_creative_test_snapshot`、`fact_experiment_cohort_daily` |
| 操作与预测 | `fact_ad_operation_event`、`fact_roi_forecast_snapshot`、`fact_roi_forecast_evaluation` |
| 汇率与规则 | `fact_fx_rate_daily`、`config_business_policy_snapshot` |

每张表卡在 `knowledge/starhaven/tables/`，机器契约在 `contracts/`。SQL、表卡和契约由 `catalog.py` 的同一类型定义生成，不分别手工维护。

## 生成原理

`generate.py` 使用 seed、合成设备×App 身份、业务日及行为主题生成可复现的私有设备日过程，再投影为 23 张分析表。私有身份不写入公开数据，也不生成真实玩家记录。

同一笔广告收入进入活跃汇总、广告漏斗、SDK 回收及相应日龄的 cohort 质量表；同一笔成本进入美元、原币、素材窗口及预测当时成本。不是每张表各自随机造数后再修总额。

模拟中包含预算下调、暂停和恢复、变现网络收入变化、不同实验组行为差异及获客后留存变化。隐藏驱动位于生成器配置，不注册到在线知识，也不把“预设原因”当作模型诊断证据。

所有业务日为 UTC。内部金额使用整数微美元/微原币，导出 Decimal 字符串；不经过浮点。XCU 是虚构货币，`source_currency_per_usd` 表示 1 USD 兑换的原币数，美元为原币除以该数。

## 必须保留的口径

- `unique_install_events` 含重装；重装、晚到、无归因是其子集，不额外加进总量。首次安装设备、行为 D0、AF 报表注册、媒体注册不强制相等。
- DAU 跨日相加是设备日。7/30 日活跃在单一锚点精确去重，不能跨锚点相加。身份仅在设备×App 范围内，不声称跨 App 玩家去重。
- 留存和实验观察保存日龄 0–30；cohort 基数跨观察日重复，不能随日龄相加。RR7 是第 7 日，累计 ROI7 是日龄 0–6。
- SDK 与 AF 是不同收入来源，不相加为总收入。AF 有报告延迟；稀疏回收表的缺行不自动等于零。设备 LTV 表内窗口上限为 31 日，更长回收使用分来源回收表。
- load / ready / show 是不同事件分母；玩法未定义的胜负、分数为 NULL。NULL、真实零、未成熟、缺行、不适用分别保留。
- 素材存在已投放、已分配但尚未投放、未分配三种情况；测试/出坡状态从投放和窗口推导，不独立随机生成。
- product 实验以 first_open 入组，monetization 以 first_ad_show 入组；触发日可能晚于安装日。不同实验可重叠，不把组基数累加为全部用户。
- 预测只用截止点之前收入，保存不可变 prediction_id 和模型版本。未成熟目标不计算真实误差；成本回刷标为 input_revised，与模型错误分开。

43 项公式、单位、分母和限制见 `knowledge/starhaven/assets/metrics.md`；16 类通用参数化 SQL 见 `assets/sql.md`。新业务场景在 `assets/business.md`：18 个问题、22 条参考 SQL，与绑定发布的页面示例同源。`cases.json` 是原有 40 道设计题及验收要求，不是 40 道已经通过的模型评测。

复用已有数据验证业务预期：

```sh
python3 -m synthetic.starhaven business-check \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --report .local-runtime/vv-business-gold-v1.json
```

报告必须是新路径。独立预期只留在离线验收层，不注册到模型知识，不通过页面 API 返回。详细指标、完整计算步骤、页面及数据库验收见 `docs/vv-business-scenarios.md`。

## 对账与故障注入

```sh
python3 -m synthetic.starhaven reconcile \
  --dataset .local-runtime/starhaven-tiny-v1

python3 -m synthetic.starhaven build \
  --profile tiny --scenario missing_day \
  --output .local-runtime/starhaven-missing-v1
```

`null_cost`、`missing_day`、`duplicate_dimension` 应对账失败。`late_cost` 是有说明的有效回刷，应通过对账，并让受影响预测复验停止记作模型误差。

检查包括唯一粒度、23 表字段、文件哈希、NULL 状态、层级和国家外键、逐行换汇、成本守恒、安装子集、独立设备日累计、广告收入多投影守恒、7/30 日精确去重、实验基数及锚点、预测输入截止和成熟收入。

离线 `private-gold.json` 是生成过程的核对计数，不是标准答案 API；manifest 中的哈希不是防管理员篡改的签名。它们都不注册到在线知识。

## 真正放进 ClickHouse 检查

提供自己的 ClickHouse 二进制绝对路径：

```sh
python3 -m synthetic.starhaven verify-clickhouse \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --binary /absolute/path/to/clickhouse
```

命令创建新的临时 `clickhouse-local` 数据目录，实际运行 23 张表 DDL、灌数、类型检查、跨表 SQL 和 16 类示例查询。结束后删除该临时数据库。报告及实际 SQL 保存在数据目录。不会连接现有服务器。

本机验证使用官方 macOS 原生 26.11.1.1612 二进制。它不等同于另一台电脑现有 24.8 容器的版本验证，也不等同于 API/worker/MySQL/Redis/Pi 端到端验收。

另可验证本机 HTTP 导入和只读账号：

```sh
python3 -m synthetic.starhaven.tests.native_loader \
  --binary /absolute/path/to/clickhouse
```

这个显式测试只启动自己创建的回环服务器，验证导入 23 表、只读账号拒写、已有数据库拒绝覆盖和凭据权限，结束后停止自己的进程并删除自己的文件。

## 导入明确属于本次测试的隔离实例

先由使用者或另一台 Codex 创建新的隔离 ClickHouse，确认随机回环端口和管理员密码文件。不要填写公司端点或已有的 8123/9000 服务。

```sh
python3 -m synthetic.starhaven load \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --url http://127.0.0.1:本轮新建端口 \
  --admin-password-file .local-runtime/本轮管理员密码文件 \
  --database starhaven_demo_v1 \
  --credentials-out .local-runtime/starhaven-demo-reader.json
```

只接受 `http://127.0.0.1` 和显式端口，不读取 HTTP 代理、不跟随重定向。导入前必须通过对账；`CREATE DATABASE` 不带 `IF NOT EXISTS`，目标已存在就拒绝。只读密码随机生成并仅写入新建的 0600 文件，不打印。

失败可能留下明确属于本次的新库；工具不猜测事务回滚，也不自动删除服务器资源。排查时按本轮数据库名处理，不能批量清理未知库或 Docker 卷。

## 新版本如何持续产生

```sh
python3 -m synthetic.starhaven advance \
  --from .local-runtime/starhaven-tiny-v1 \
  --days 1 \
  --output .local-runtime/starhaven-tiny-v2
```

它固定起点、seed 和生成器版本，重建延长一天的新发布，旧目录保持原样。不是对旧库追加，不是假装实时 CDC。过去已经观测到的行为和旧预测保持稳定，晚到事件按新到达截止可见。新分群从首次观察日起补齐后续日期，不反向向旧发布添加零行。生成器或配置修订后必须显式新建基线，不能冒充连续演进。

## 接入现有 Agent 的范围

已有第二版数据可单独绑定新版契约，不必重新生成或灌数：

```sh
python3 -m synthetic.starhaven bind-knowledge \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --output .local-runtime/vv-knowledge-contract-v2
```

将示例中的 dataset 替换为实际已生成的数据目录，output 必须不存在。命令先对账，再写入新知识目录，保留原数据和旧知识目录；它不会自行发布 fresh。序列契约 v2 将 `dataset_version` 纳入完整物理维度，登记的复合键仍必须全部出现在 JOIN 中。

装载成功后，把 `KNOWLEDGE_DIR` 指向该数据目录的 `release-knowledge`；业务库连接使用本轮只读账号，`BUSINESS_ENGINE=clickhouse`。各进程使用一致的发布目录和数据库。

使用上述单独绑定时，`KNOWLEDGE_DIR` 改为新 output，`FRESHNESS_TARGETS_PATH` 同时指向新 output 下的 `freshness-targets.json`；重新发布权威 freshness 后再启动查询。详细适配与验证范围见 `docs/vv-join-compatibility.md`。

随后由现有 freshness 流程发布 MySQL 权威回执。静态 `knowledge/starhaven` 不声明任何库已 fresh。生成目录中的 `freshness-targets.json` 描述实际日期和维表观察目标；不证明所有分群、cohort 或预测都成熟。

使用本包导出的只读账号时，为 API、worker 和 freshness 进程设置 `CLICKHOUSE_LOCKED_READONLY=true`。账号的服务端配置固定只读、3 秒查询时限、500 万行扫描上限、NULL 关联和十进制输出；宿主在执行前核对这些设置，缺失或不符合当前宿主限制时关闭查询。若将宿主查询时限或扫描上限设得更严格，也需相应收紧账号设置。不要使用此模式连接未经隔离或不可信的服务端。

当前宿主的 `must_filter` 只接受日期分区，所以版本隔离采用“一个新数据库只装载一个不可变发布”，查询示例再显式筛选版本。不要往同一数据库混入多个发布。

宿主暂不能通用解释本包的非加性规则。因此窗口去重、重复基数、预测、原币金额和模式专用分数没有放进可自动认证的 `series.metrics`。这能避免跨窗口、跨币种或跨分数单位错误认证；并不表示这些字段已完成在线自然语言评测。预测快照也暂不发布在线认证目标。

另一台电脑接收后应补同版 Pi/API/worker 与其 ClickHouse 版本的验收。本包没有调用真实模型，也没有用新数据重新认证既有 A–F 题或网页流程。

## 文件职责

- `model-spec.json` / `catalog.py`：23 表字段、粒度、类型及 SQL。
- `settings.json` / `generate.py`：模拟参数、不可变生成及快照。
- `metrics.json` / `queries.py`：43 个定义及 16 类查询模板。
- `business.py` / `business_gold.py`：发布绑定的业务问题与 SQL、独立离线预期；后者不供模型读取。
- `knowledge.py`：72 个生成文件和绑定版本的知识目录。
- `reconcile.py` / `clickhouse.py`：Python 与真实数据库两层对账。
- `load.py`：只向明确指定的本轮回环实例创建新库。
- `tests/`：确定性、时间演进、反例、导入边界和显式原生服务器验收。

不要手工编辑生成的表卡和契约。修改唯一来源后运行 `python3 -m synthetic.starhaven knowledge --write`，再运行检查。
