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

配置示例在 [`.env.example`](.env.example)。不要把真实密钥写入仓库。`MODEL_MODE=deterministic` 使用 Pi SDK 的 faux provider，不需要 `PI_API_KEY`。`MODEL_MODE=pi` 才会走可选的 Anthropic 适配；没有密钥时进程会直接退出，不会假装已经连通。

本地文件写到 `.local-runtime/`，该目录已被忽略。合成业务库存 `lumenfox.sqlite`，每次启动重建并以只读方式打开。

有两种本地模式，不要混称：

- `npm start` 是 SQLite 单进程演示。业务查询打在本地 SQLite，状态也在本进程。这不是 ClickHouse 验证。
- `BUSINESS_ENGINE=clickhouse` 时，业务查询打到 `127.0.0.1` 上的隔离 ClickHouse，使用只读账号。表卡在 `knowledge/harborlight/`。MySQL 仍只存任务状态，Redis 仍只做调度。不要把 SQLite 演示说成 ClickHouse 验证。

## 这条主链做什么

一次提问会经过：

1. 确定性演示模式会把用户原话编译成已发布语义文件里的槽位。`MODEL_MODE=pi` 把用户原话和同会话历史送进同一个 Pi AgentSession，不在模型调用前强制套用这层槽位，也不会在缺少密钥时退回演示逻辑。
2. Pi Agent 循环调用 8 个工具：`search_assets`、`read_asset`、`read_assets`、`read_data_contract_view`、`query`、`calculate_session_cells`、`read_session_resource`、`update_analysis`。
3. 搜索只返回资产卡片。读取正文和查询数据分别再做授权。
4. `query` 在只读连接上解析单条 SELECT，并递归检查 CTE、子查询和联合查询里的表、字段、敏感列、契约版本和封闭日期。通配符直接拒绝，不按契约展开。超时和取消由服务端执行。
5. 服务端根据证据决定终态。模型写出的“已完成”不会单独生效。契约声明了粒度时，无记录、值为 NULL、观测零和预测值分开；无记录和 NULL 不会补成零。存在这些缺口或覆盖情况未知时，数据结论是部分完成。只有真实零、且预期日期都有实际观测时，可以完成。查询只读已发布的新鲜度快照，不在提问时用最大日期冒充。任务领取带单机租约和围栏号；过期执行者不能覆盖新执行者的结果。同一个幂等键如果问题内容不同，会返回冲突而不是静默复用。身份来自服务端标明的 mock 主体，不信任请求正文里的 userId。

知识在 [`knowledge/lumenfox/`](knowledge/lumenfox/)，区分资产目录、表契约、指标口径、分析 SOP、示例 SQL 和权限政策。`registry.json` 里的 `registry_revision` 和各资产 `revision` 是修订标识。

## 明确还是模拟的部分

本地实现有可替换的 `StateStore`，默认是单机 SQLite。这不是分布式生产方案：

- 保证限于同一台机器上的一个状态库。领取使用 `BEGIN IMMEDIATE` 和递增围栏号；心跳只续当前围栏的租约。
- 进程重启后，租约过期且尚未终态的任务可以被新执行者回收。旧围栏不能再写事件或终态。
- SQLite 演示没有多机共识。MySQL 模式的终态由事务和围栏保证只有一个；outbox 到 Redis 是至少一次投递。worker 在写完终态前崩溃时，合成查询可能再执行一次，这不是整个外部副作用的 exactly-once。
- 新鲜度由独立探测进程只读核对合成表的声明周期后原子发布。查询只读已发布版本。远程引擎只标记为未实现，不会去连接。
- 业务库是本地只读 SQLite 合成数据，不是 MaxCompute、ClickHouse 或 MySQL。
- 确定性模型走 Pi SDK 的 faux provider，不发网络请求。`MODEL_MODE=pi` 的真实模型路径仍未联调。
- 客户端断开只停止事件流。用 `after` 序号可以有序续读已经落库的事件。取消必须调用取消接口。

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
