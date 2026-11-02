# Lumenfox Data Agent

这是一个可在本地运行的只读数据分析代理。当前在线主链是 TypeScript：Pi SDK 负责工具调用循环，服务端负责权限、契约绑定、SQL 校验、会话资源和任务终态。

演示场景是虚构工作室 **Lumenfox Interactive** 的手游 **Starlane Drift**。表、指标、SQL、账号和数字都是合成的。默认模式不会访问外部模型，也不会连接真实业务库。

## 本地启动

需要 Node.js 22.12 或更新版本。安装依赖时使用 `--ignore-scripts`，并保留 `package-lock.json`。

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm start
```

浏览器打开 `http://127.0.0.1:4317`。页面可以新建会话、提问、追问，并看到运行中、完成、需要澄清、部分完成、失败、已取消和已超时。

配置示例在 [`.env.example`](.env.example)。不要把真实密钥写入仓库。`MODEL_MODE=deterministic` 是确定性演示；`MODEL_MODE=pi` 使用 Pi AgentSession，可选择显式 `faux` 或 `openai-compatible` 本机协议假服务。后者仅允许 `http://127.0.0.1`，需要虚构测试 token；脚本服务不代表真实模型联调。Anthropic 和远程 HTTPS 路径当前禁用，不会自动回退到 faux。

本地文件写到 `.local-runtime/`，该目录已被忽略。合成业务库存 `lumenfox.sqlite`，每次启动重建并以只读方式打开。

有两种本地模式，不要混称：

- `npm start` 是 SQLite 单进程演示。业务查询打在本地 SQLite，状态也在本进程。这不是 ClickHouse 验证。
- `BUSINESS_ENGINE=clickhouse` 时，业务查询打到 `127.0.0.1` 上的隔离 ClickHouse，使用只读账号。表卡在 `knowledge/harborlight/`。MySQL 仍只存任务状态，Redis 仍只做调度。不要把 SQLite 演示说成 ClickHouse 验证。

## 这条主链做什么

一次提问会经过：

1. 确定性演示模式会把用户原话编译成已发布语义文件里的槽位。`MODEL_MODE=pi` 把用户原话和同会话历史送进同一个 Pi AgentSession，不在模型调用前强制套用这层槽位，也不会在缺少密钥时退回演示逻辑。
2. Pi Agent 循环调用 8 个工具：`search_assets`、`read_asset`、`read_assets`、`read_data_contract_view`、`query`、`calculate_session_cells`、`read_session_resource`、`update_analysis`。
3. 搜索返回资产卡片与授权正文的命中片段，稳定续页校验结果哈希；正文只参与当前主体可读资产的检索匹配。`read_assets` 可批量读取各资产的 Unicode 码点分页，逐项检查内容哈希；契约字段可分页并显示已发布新鲜度。查询资源可按行和列分页，资源截断与页面续读分别标记。
4. `query` 在只读连接上解析单条 SELECT，并递归检查 CTE、子查询和联合查询里的表、字段、敏感列、契约版本和封闭日期。JOIN 只支持可核对物理表及登记键和契约粒度；派生表或 CTE 作为连接输入、无法确定粒度及不支持的语法会被拒绝。通配符直接拒绝，不按契约展开。契约粒度不证明物理数据的唯一性；JOIN 查询尚不能交付已验证汇总。单事实表的受限整数及 Decimal `SUM`、非 NULL `COUNT` 和最多三个契约维度的分组可在覆盖完整时交付；逐一检查已出现的维度组合是否覆盖日期，不支持的表达式保守降级。ClickHouse Decimal 在解析 JSON 前设置为字符串，核对物理类型与契约及扫描上限；Decimal 输入精度最多 28 位，未出现的组合不补零。
5. 服务端根据证据决定终态。模型写出的“已完成”不会单独生效。契约声明了粒度时，无记录、值为 NULL、观测零和预测值分开；无记录和 NULL 不会补成零。存在这些缺口或覆盖情况未知时，数据结论是部分完成。覆盖统计目前仅能证明单表、日期上下界及序列维度字面量等值筛选；其他筛选或多表查询标为未知。`update_analysis` 可比较两个本任务计算单元，或两个可唯一定位的 Decimal 汇总输出：要求完整覆盖和相同口径，范围只能差一个维度或两个等长不重叠日期段；差值用定点整数运算，比例保留四位、变化率保留两位，半数远离零，零基准不计算比例和变化率。原有浮点金额仍只是近似值。查询只读已发布的新鲜度快照，不在提问时用最大日期冒充。身份来自服务端标明的 mock 主体，不信任请求正文里的 userId。

ClickHouse 结果按行和字节上限流式读取：预览缩短不会截断已保存结果；超过保存上限时标记截断，观察到的行数只是下界。SQL 中的 `LIMIT` 也不视为完整总体。单元计算可使用完整资源，Decimal 明细在物理类型及契约可核验时按字符串精确求和；全 NULL 和无行求和不是零，未知预测状态不伪装为实际值。

四则运算可引用本任务受支持的聚合单元或已验证计算结果，并可继续引用先前四则结果；交付时递归核对资源、权限、契约、新鲜度、覆盖和结果。当前仅接受相同指标与口径、相同范围或单个维度/等长非重叠日期范围的组合；除法保留 18 位小数，半数远离零，除零返回不可计算。引用分组时须显式指定每组；自动分组对齐及通用筛选、排序、分组变换尚未实现。模型未调用 `update_analysis` 时，服务端可从本任务可核验资源生成部分完成结果，仍不会采信自由文本作为已验证事实。

知识在 [`knowledge/lumenfox/`](knowledge/lumenfox/)，区分资产目录、表契约、指标口径、分析 SOP、示例 SQL 和权限政策。`registry.json` 里的 `registry_revision` 和各资产 `revision` 是修订标识。

## 明确还是模拟的部分

本地实现有可替换的 `StateStore`，默认是单机 SQLite。这不是分布式生产方案：

- 保证限于同一台机器上的一个状态库。领取使用 `BEGIN IMMEDIATE` 和递增围栏号；心跳只续当前围栏的租约。
- 进程重启后，租约过期且尚未终态的任务可以被新执行者回收。旧围栏不能再写事件或终态。
- SQLite 演示没有多机共识。MySQL 模式的终态由事务和围栏保证只有一个；outbox 到 Redis 是至少一次投递。worker 在写完终态前崩溃时，合成查询可能再执行一次，这不是整个外部副作用的 exactly-once。
- SQLite 状态模式的新鲜度仍发布到本机文件。MySQL 状态模式由独立探测进程先登记批次，再把整批结果和发布指针写入 MySQL 事务；查询和交付只读取 MySQL 发布版本，数据库不可用、版本缺失或契约/目标清单不匹配时失败关闭，不回退旧文件。`/api/health` 的 `freshness_status` 区分已发布、未发布、清单变化和不可用；已发布不代表每张表都是 fresh。旧文件不会自动迁移，需要对隔离库重新探测。
- MySQL freshness 通过数据库分配的批次序号决定先后，较早开始的批次不能覆盖较晚批次。已发布版本及未完成批次保留供排查，本构建不自动删除历史。最终终态事务锁住发布指针并核对可交付证据版本，与发布事务排序；版本已变时任务失败且不保存旧结论。当前探测只核对日期是否存在；NULL、真实零和预测状态由后续查询覆盖检查区分，日期存在不证明指标完整。过期判断默认采用当前时间及知识包/契约时区，`SIMULATED_TODAY` 只用于注入合成测试日期。默认目标仍是固定合成日期；可选的 `knowledge/harborlight/freshness-targets-rolling.example.json` 使用契约时区、延迟和窗口计算周期。跨日时旧版本清单不再匹配，须重新探测；固定历史数据没有覆盖新周期会标为不新鲜。终态事务尚未原子复核跨午夜有效期、契约文件变更或主体权限变更。
- 业务库可以是本地只读 SQLite 演示或隔离的本地 ClickHouse 合成库；MySQL 只存任务状态，Redis 只负责唤醒。
- 确定性模型走 Pi SDK 的 faux provider，不发网络请求。`MODEL_MODE=pi` 的真实模型路径仍未联调。
- 独立 API 的请求、取消和串行 SSE 轮询、outbox dispatcher、worker 领取、快照与进度事件、续租及终态使用 Promise 消息桥接。领域工具的会话读取、契约绑定、资源读写、工具预算和修订预留，以及模型派发和结算也使用异步桥；确定性演示的 agent 事件和快照同样等待异步写入。模型请求须在预留成功后派发，结算完成后才向 Pi 交付终止事件；工具预算结果未知时当前执行者停止继续派发。Pi 内部 agent 监听器按顺序等待：原生 JSONL 完成对应消息后捕获快照，落库失败即失权并中止；续租不重入。MySQL 初始化使用异步桥，兼容同步状态桥改为按需创建、异步关闭。直接调用兼容任务管理接口和本进程订阅等路径仍可能触发同步等待；不能当作全链路异步或高可用保证。异步状态请求超时、桥进程退出或关闭时，其写入结果可能未知，不能据此假定回滚或盲目重试。MySQL 租约领取、续租和保护性写入使用数据库时间，SQLite 演示使用本机时间。
- 知识正文读取字节预算目前只保存在执行进程内，进程重启后不会保留，不能作为跨恢复的权威配额；工具调用预算和模型预算另行持久化。JOIN 仅审查登记键及契约粒度，尚未验证物理维表键唯一性；JOIN 查询结果不得当作已证明的汇总结论。
- 客户端断开只停止事件流。用 `after` 序号可以有序续读已经落库的事件。取消必须调用取消接口。

MySQL 分进程模式需要先配置本机隔离 MySQL、Redis 和 ClickHouse，并准备合成数据与只读账号；按照 `.env.example` 为各进程设置相同的本机配置后，先运行 `npm run start:freshness`，再分别运行 `npm run start:api`、`npm run start:dispatcher` 和 `npm run start:worker`。首次使用 MySQL 需要允许初始化状态表与 freshness 表。当前没有负责创建及清理整套隔离容器的一键启动命令，停止服务和清理测试实例时应只处理自己创建的资源。

要试用滚动示例，所有进程需一致设置 `KNOWLEDGE_DIR=knowledge/harborlight` 和 `FRESHNESS_TARGETS_PATH=knowledge/harborlight/freshness-targets-rolling.example.json`，然后重新运行 freshness 探测。固定合成仓库可在测试中设置 `SIMULATED_TODAY=2026-10-29`；不设置则使用当前日期，不会把旧数据冒充当前数据。

也可用 `npm run seed:clickhouse` 在**本轮新建、回环端口的隔离 ClickHouse** 内建立新的滚动合成库。先通过环境变量提供 `CLICKHOUSE_URL`、`SYNTHETIC_DATABASE`、`SYNTHETIC_ADMIN_USER`、`SYNTHETIC_ADMIN_PASSWORD`、`SYNTHETIC_READER_USER`、`SYNTHETIC_READER_PASSWORD`；数据库和只读账号名须以 `synthetic_` 开头，口令使用本轮临时生成的字母数字。该命令只创建新数据库及只读账号，不清空或覆盖已有数据库；失败时保留部分初始化结果供检查。接着将应用的 ClickHouse 库名、只读账号与口令指向新库，再启动 freshness、API、dispatcher 和 worker。生成器默认按洛杉矶当前日平移完整合成样本，保留 NULL、真实零和预测；`SIMULATED_TODAY` 可固定测试日期。滚动窗口的示例延迟是合成规则，并非实时业务数据。

仓库里的 `showoff/`、`data_agent_plan/`、`da_assets/` 和 `bugfix_doc/` 是历史公开材料。它们帮助理解边界；和当前 TypeScript 主链冲突时，以这里的运行代码和测试为准。

## 历史公开材料

本仓库同时保留从私有工程中按白名单导出的公开材料，包含架构设计、方法论文档、可编辑架构图和问题修复复盘。

所有组织、产品、内部平台、域名、包名、地址和提交标识均已替换；生产 SQL、表卡、metadata、原始数据、历史数据文件、凭证与内部接口不在仓库中。

### 目录

- [`showoff/`](showoff/)：面向读者的架构与能力说明。
- [`data_agent_plan/架构/`](data_agent_plan/%E6%9E%B6%E6%9E%84/)：在线与离线架构设计。
- [`da_assets/`](da_assets/)：可复用的方法论与操作规范。
- [`bugfix_doc/`](bugfix_doc/)：重大问题、修复与验证复盘。

### 图的更新

图以 `.excalidraw` 为可编辑源；修改源文件后运行：

```bash
npm install
ruby scripts/重新导出架构图.rb
ruby scripts/校验公开快照.rb
```

图像只应由当前已脱敏源重新导出，不应复用私有工程中的旧 PNG。导出图依赖 `sharp`，这一步不能使用 `--ignore-scripts`。数据分析代理本身不需要这些安装脚本。
