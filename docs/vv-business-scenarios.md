# VV Data Agent 业务体验

本批把既有 23 表数据包接到可执行的业务场景和页面入口，不增加业务表，不重造已有数值，不改变 Pi 八工具、权限、预算、SQL 与证据架构。六类共 18 个场景、22 条参考 SQL；每个场景均有明确日期、口径、限制及独立离线预期。

## 场景覆盖

| 类别 | 场景 ID | 用户能检查什么 | 必须保留的边界 |
|---|---|---|---|
| 获客 | acquisition-daily | 拼格 iOS 每日首装设备、安装事件、重装、晚到 | 重装和晚到是子集，不额外加进总事件 |
| 获客 | acquisition-channel | 分获客渠道的折后消耗、AF 注册和 CPI | 比率从分子分母总和重算，分母不是设备首装 |
| 获客 | acquisition-followup | 同会话沿用日期，只看日本 | 当前轮重新查询并产生独立资源 |
| 计划 | plan-efficiency | 计划消耗、注册、曝光、点击、CTR 与 CPI | NULL 计划单列，维表名称须有来源 |
| 计划 | plan-app-names | 三款游戏六个包体的名称与成本 JOIN | 版本键、App 键均不可省略 |
| 素材 | creative-efficiency | 落块 Android 素材消耗、注册和 CPI | 按素材汇总广告贡献，不按广告数冒充素材数 |
| 素材 | creative-readiness | 叠叠乐素材未分配、未测、待观察、可判定状态 | 同素材跨媒体不折叠成虚构状态，出坡分母只用可观测素材 |
| 收入 | revenue-daily | 落块 iOS 每日 SDK 广告收入、展示、DAU、ARPDAU | IAA 与 IAP 分开，DAU 跨日相加是设备日 |
| 收入 | revenue-network | 变现 network／格式的 eCPM 与加载展示漏斗 | 分母用各自对应已结束请求，不把获客媒体当变现网络 |
| 收入 | revenue-source | 同 cohort 窗口的 SDK／AF 回收对照 | 两来源不相加，差额不自动解释为丢数 |
| 收入 | revenue-clarify | 模糊收入问题先澄清 | 不需要业务查询，不编造范围和数字 |
| 活跃 | activity-anchor | 单一锚点的 DAU、7／30 日观察窗口 | 不跨锚点累加；短发布不声称有完整 30 日历史 |
| 留存 | retention-d1、retention-d7 | 固定安装 cohort 的 RR1、RR7 | 单一日龄；同 cohort 分子分母重算，不能平均分群留存率 |
| 价值 | ltv7 | SDK 七日回收／D0 首装设备基数 | D0 基数只取一次，核对七个日龄齐全且基数稳定 |
| 价值 | roi3、roi7 | 同 cohort 成本与 SDK 累计回收 | 日龄 0–N−1；按渠道全集匹配，缺侧、零分母未知 |
| 价值 | roi-immature | 最新 cohort 的实际 ROI30 是否成熟 | 不用预测或零填补未来；当前只有 D0 时结果未知 |

## 唯一维护来源

`synthetic/starhaven/business.py` 维护问题、日期推导、SQL 和适用边界。页面目录与模型可读业务 SOP 从这里生成，避免页面日期、SQL 和文档各自漂移。

普通业务周取发布截止日前的七天，避开 AF 的最后一天报告延迟。RR／LTV／ROI 使用固定安装 cohort，RR7 的观察日为 cohort+7，LTV7／ROI7 为 cohort 到 cohort+6。所有日期使用发布的 UTC 日，不读取电脑当前日期。默认 tiny 的具体日期仅属于该发布，不写成实时数据。

`business_gold.py` 是离线验证层：读取已对账的公开 JSONL，用 Python Decimal 独立筛选、汇总与计算，不调用模型，不连接数据库，不使用 private-gold 的业务答案。数据库查询通过另一实现执行，再比较实际行与预期。模型、在线检索及页面 API 都拿不到 expected_rows 或 expected_business。

已存在的 `metrics.json` 仍是 43 项指标公式的维护来源；本批提供其实际分析步骤，不增加一套相互矛盾的业务定义。表卡、契约和原始数据不因页面改动而升级为更宽的权限。

## 复用已有数据

```sh
python3 -m synthetic.starhaven knowledge --write
python3 -m synthetic.starhaven knowledge
python3 -m synthetic.starhaven bind-knowledge \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --output .local-runtime/vv-business-knowledge-v1
python3 -m synthetic.starhaven business-check \
  --dataset .local-runtime/starhaven-tiny-v1 \
  --report .local-runtime/vv-business-gold-v1.json
```

dataset 替换为已有真实生成目录；两个输出必须全新。不要把旧目录覆盖成新发布，不需要重新生成或灌入百万行。`bind-knowledge` 不改原 JSONL、数据版本或旧知识；`business-check` 不改变数据或知识目录，不覆盖已有报告。

API、worker、freshness 指向同一个新 `KNOWLEDGE_DIR`，`FRESHNESS_TARGETS_PATH` 指向该目录的 freshness-targets.json。保留已验证的只读账号和 `CLICKHOUSE_LOCKED_READONLY=true`，重新发布权威 freshness。数据包元数据和页面目录不是 freshness 证明。

静态 knowledge/starhaven 仍是未绑定模板。未找到发布目录、日期非法、重复问题或 release.json 不匹配时，页面不展示带虚构日期的旧问题，明确显示未绑定或配置不一致。

## 页面

当前发布范围、版本和成熟度提醒出现在工作台顶部。六类按钮切换问题，先展示范围、完整问题和口径说明，点击“填入这个问题”后才进入输入框；不会自动发送。可以修改文字后用 Ctrl／⌘+Enter 发送。问题模板不影响自由输入、既有历史、SSE 或取消。

长历史在会话侧栏内部滚动。数学结果保留数值、单位、NULL、零分母和未认证提示，长资源身份与公式收进“计算公式与来源”，便于先读结果再核对依据。移动端分类换行，横向表格在自身区域滚动。

## 验证方式与认证边界

```sh
python3 -m unittest discover -s synthetic/starhaven/tests -v
node --import tsx --import ./tests/test-clock.mjs --test \
  tests/vv-demo.test.ts tests/demo-clock.test.ts \
  tests/starhaven-knowledge.test.ts tests/web-assets.test.ts tests/web-stream.test.ts
node --import tsx src/knowledge-doctor.ts knowledge/lumenfox knowledge/harborlight knowledge/starhaven
npm run typecheck
```

有本机原生二进制时：

```sh
python3 -m synthetic.starhaven.tests.native_business \
  --binary /absolute/path/to/clickhouse \
  --report .local-runtime/vv-business-native.json
```

该显式工具创建自己的随机回环 ClickHouse、23 张 tiny 表、一次性只读账号、API、SQLite 状态和本机脚本 HTTP 模型。逐条检查 22 条原 SQL、保存资源、执行号与独立预期；通过现有计算工具保存并递归复核 51 个算术资源。留存先 group 固定日龄的两个字段，LTV 先将 D0 与七日收入分开 group，再做除法，保留中间来源。脚本还通过真实 Pi 和 API 运行 18 个场景；日本追问沿用同一会话。结束后只清理自己创建的服务与数据。

`--browser` 在自动检查通过后打印本轮地址和 stop-browser 路径，保留栈供人工操作。完成后创建该空 stop-browser 文件，工具会正常关闭自己的服务。测试模型严格按场景配方行动，不读取 gold；其他自由提问只返回澄清，不代表通用语言理解。

不同层面的通过不能混用：

- 离线预期验证的是公式、范围和数据口径；不能替代数据库执行。
- SQL 和计算资源数值一致，证明本次捕获结果及数学运算；不自动认证任意业务语义或完整总体。
- 宿主对重复 cohort 基数、窗口去重、跨来源和覆盖未知仍保留现有规则。某些结果是数学观察，某些任务为 partial，completed 也不表示模型的自由解释逐句获认证。
- 本机验证版本是原生 ClickHouse 26.11、SQLite 控制状态；接收机仍应验证其 ClickHouse 24.8、MySQL／Redis／独立 worker、页面与恢复。
- 本批没有真实模型请求；不据脚本配方推断 DeepSeek 自主检索、规划或泛化已通过。后续真实模型只接收自然业务问题，不注入 SQL、固定工具顺序或 gold。

## 公开体验前

这批完成业务场景包和演示入口。生产认证、陌生访客隔离、总费用与访问限额、可观测性及部署运维仍属于公开上线验收范围；本批未部署，也未将公司网关或密钥放进项目。
