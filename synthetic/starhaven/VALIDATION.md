# VV Data Agent 数据包验收记录：2026-11-08

范围是本次新增的数据包。没有提交、推送、部署、真实模型调用或公司数据库连接。

## 实际生成并对账的数据

| 档位 | UTC 范围 | 公开表总行数 | Python 检查 |
|---|---|---:|---:|
| tiny | 2026-10-26–2026-11-08 | 13,758 | 317/317 |
| demo | 2026-07-12–2026-11-08 | 459,817 | 317/317 |
| standard | 2025-08-11–2026-11-08 | 1,143,136 | 317/317 |
| tiny 后续一天发布 | 2026-10-26–2026-11-09 | 15,480 | 317/317 |

总行数包含聚合事实、cohort 观察和预测快照，不能称为同等数量的独立玩家或事件。

本版名称为 VV Data Agent；游戏为拼格 GridFit、落块 BlockFall、叠叠乐 StackJoy，game_id 为 gridfit、blockfall、stackjoy。名称与标识变化后重新生成了数据。

standard 的版本为 `sv_7a79c7183054efa7a9c4`，JSONL 合计 586,824,545 字节。配置和生成器指纹均与此记录时的源码一致。相同参数重复生成逐表字节一致；固定起点延长日期后，旧行为观察与旧预测保持稳定。

新标识触发的回归检查曾发现：未来首次出现的分群会给早期日期增加零行。现已从首次观察日起补齐该分群后续日期，旧发布历史保持不变；相关回归及最终 17 项 Python 测试通过。

## 实际数据库验证

官方 macOS 原生 `ClickHouse local version 26.11.1.1612`：

- standard 的 1,143,136 行真实完成建表及 INSERT。
- 23 张表的所有字段类型与契约逐项比较。
- 类型、唯一键、版本、外键、金额、投影守恒、窗口、预测及示例 SQL 共 **204 项通过**。
- 16 类业务 SQL 绑定真实版本和日期后执行，检查返回非空；这不是 16 道自然语言题的模型评测。
- 独立临时 HTTP 服务器实际完成导入 23 表、只读账号拒写、0600 凭据文件及拒绝覆盖同名数据库的验证，随后停止并清理。

二进制 SHA-256：`6e76108fde28857ab72f7b9a09360edafb56f44097ea3985d8261bdcbc358aa7`。该版本是本机实测版本，不代表另一台电脑的 ClickHouse 24.8 已经过同样验证。

## 自动测试与宿主适配

- `python3 -m unittest discover -s synthetic/starhaven/tests -v`：**17 通过**。
- `python3 -m synthetic.starhaven knowledge`：70 个生成文件无漂移。
- `node --import tsx --test tests/starhaven-knowledge.test.ts`：**4 通过**。
- `node --import tsx src/knowledge-doctor.ts knowledge/lumenfox knowledge/harborlight knowledge/starhaven`：三套均通过。
- `npm run typecheck`：退出码 0。
- Black 检查 14 个 Python 文件：无格式差异。
- 应用前已有的 **423 个项目文件**全部 SHA-256 保持一致，暂存区未改变。

Node 检查在当前工作树的独立副本执行，按现有锁文件使用 `npm ci --ignore-scripts` 安装依赖。本机原有 `node_modules` 链接不完整，未改动该链接或依赖声明。Node 26 的 tsx 测试输出带有 `module.register()` 弃用提示，测试本身通过。

## 不包含的验收

本次未运行旧项目全套 `npm test`，未新增 MySQL/Redis/Pi 分进程、浏览器或真实 DeepSeek 验收。默认宿主也不能通用认证本包所有非加性或预测指标。

scale 档提供可配置生成入口，但本轮没有做该档全部数据的性能验收。40 道题是场景与验收要求，不是通过记录。

接收者应先复现数据层结果，再在自己的隔离实例和当前冻结代码上完成宿主集成；不要把本文件的历史记录当作接收机器的新验证。
