# Paseo 企业多人办公版主实施规约

> 文档状态：可执行基线 v1.1（增加分布式 Paseo 管理演进约束）
> 编制日期：2026-09-09
> 目标读者：技术负责人、总集成会话、各并行实现会话、测试与安全审计会话
> Paseo 源码核对基线：`getpaseo/paseo`，commit `fdf3b4b`，`0.8.0-beta.1`
> 本工作目录建立基线：commit `19bd6e59093d5a774b0b3c3fed12bfbf5aad6266`（2026-09-09，后续同步上游时按本文兼容性门禁重新核对）
> 建议放置位置：目标 Paseo 仓库根目录 `ENTERPRISE_IMPLEMENTATION_MASTER.md`

---

## 0. 本文档怎么使用

本文档是后续所有开发会话的统一产品边界、架构合同、分工合同和验收合同。它不是讨论稿。

每个进入专门目录工作的会话，开始编码前必须依次完成：

1. 阅读仓库根目录 `AGENTS.md`。
2. 完整阅读本文档。
3. 阅读本文档为本工作流列出的 Paseo 原始文档和源码。
4. 只领取一个工作流，不跨工作流修改热点文件。
5. 先写一个会失败的行为测试，再完成一段最小实现。
6. 提交前执行本文档规定的定向测试、类型检查、Lint 和格式检查。
7. 按统一交接格式报告改动、证据、风险和待集成项。

指令优先级如下：

1. 用户当轮明确要求；
2. 仓库 `AGENTS.md` 中的工程和安全限制；
3. 本主实施规约；
4. 工作流任务书；
5. 会话自行提出的实现偏好。

遇到冲突时，不得默默选择一种解释。必须停止相关实现，在 `docs/enterprise/decisions/` 新建 ADR 草案并标记 `DECISION_REQUIRED`，交给总集成会话决定。

禁止各会话重新讨论已经确定的基线；只有证据证明当前 Paseo 代码已经发生结构性变化，或现有决定无法满足验收条件时，才能提交变更提案。

---

## 1. 一句话目标

把 Paseo 改造成一个企业多人 AI 办公入口。首期运行在单台 Mac mini、单个 macOS 登录用户和单个 Paseo daemon 上：10 名员工分别通过自己的 Paseo 身份与 AI 对话，AI 可以处理文件、调用接口和操作与该员工绑定的浏览器业务身份；员工之间会话、工作空间、文件、浏览器登录态不可串用；Boss 可以查看全局工作状态，并在获授权和被审计的前提下查看具体内容。核心模型从第一天保留节点归属和可替换控制面接口，使后续可扩展为多台 Mac、多 daemon 的统一管理，而不重写身份、资源和审计体系。

这不是“给员工展示调度系统”。员工面对的产品仍然是聊天：

```text
员工登录 Paseo → 在自己的会话中描述工作 → AI 执行 → 结果回到原会话
```

资源排队、浏览器锁、原生应用槽位、身份路由和审计都属于后台控制层，只在冲突、等待、登录失效或需要人工确认时，以会话状态提示员工。

---

## 2. 已确定且不可自行改动的产品决策

### 2.1 部署基线

- 一台 Mac mini。
- 一个 macOS 登录用户。
- 一个经过企业化改造的 Paseo daemon。
- 多个员工客户端同时连接同一 daemon。
- P0 先交付单节点，但身份、资源、租约、审计和客户端缓存都必须显式保留节点维度；不得把“只有一个 daemon”写成不可替换的业务假设。
- 不为每个员工创建 macOS 系统用户。
- 不为每个员工运行一套 daemon。
- 不使用 Docker 作为本阶段执行环境。
- Codex/Claude 等模型提供方可以使用公司统一管理的执行凭据；模型账号不是员工身份。
- 生产凭据应使用 Provider 允许的企业/API/组织授权方式；不得把个人订阅账号的共享登录当作长期合规方案，上线前由负责人确认许可、计费和并发条款。

### 2.2 身份与资源归属

强制使用以下归属链：

```text
principalId（员工）
  → workspaceId（工作空间）→ nodeId（执行放置；P0 为本机）
  → agentId（Agent session）
  → browserProfileId / appSlotId（业务应用身份）
  → auditEvent（全链路审计）
```

员工身份来自 Paseo 企业认证层。Codex 账号、Claude 账号、macOS 用户、浏览器 Cookie 都不能代替 `principalId`。

### 2.3 可见性

- 员工默认只能列出、读取、修改自己有权限的 Workspace 和 Agent session。
- 员工不能通过猜测 ID、直接 RPC、文件 URL、实时订阅、客户端缓存、终端或 Provider 历史绕过隔离。
- Boss 默认可看全组织的会话目录、负责人、状态、时间、资源占用和异常。
- Boss 查看聊天正文、客户资料或文件内容必须拥有单独的内容权限，每次访问写入审计。
- 平台管理员默认拥有系统配置权，但不因此自动获得聊天正文或客户数据读取权。

### 2.4 浏览器身份

- 每个需要持久登录的业务身份必须绑定独立 `browserProfileId`。
- Profile 粒度不是“一个浏览器窗口”，而是“组织 + 平台 + 店铺/主体 + 操作人”的业务身份。
- 同一个 Profile 同一时刻只允许一个写操作租约；不同 Profile 可以并行。
- Agent 不能自由选择任意 Profile，必须由服务端依据当前 `principalId` 和 `workspaceId` 解析。
- Cookie、LocalStorage、IndexedDB、缓存、Service Worker 和下载目录都必须按 Profile 隔离。

### 2.5 原生应用

复杂办公能力按以下顺序实现：

1. 官方 API；
2. 绑定独立浏览器 Profile 的 Web 版；
3. 原生应用自身支持的多账号或独立数据目录；
4. 同一应用的受控执行槽位，冲突时排队；
5. 确实需要同时运行且要求强隔离时，升级到独立 Mac、虚拟机或独立执行节点。

同一个 macOS 用户下，不能把“不支持多实例/多身份隔离的原生应用”包装成十路稳定并行。此类能力必须明确显示为“排队、需要登录、需要人工确认或不支持并行”。

### 2.6 信任边界

本阶段面向受信任的内部 10 人试点，接受应用层隔离加 Provider 原生沙箱，不宣称达到恶意租户之间的硬隔离。

如果未来直接服务外部商家、互不信任团队或存在高价值凭据，必须升级为至少“每租户独立进程 + 独立系统凭据”，优先使用 VM、独立 macOS 用户或独立节点。不得仅靠本文档的单用户应用层隔离对外承诺强租户安全。

---

## 3. 明确不做什么

以下项目不属于 v1，任何会话不得顺手实现：

- 不开发面向员工的通用工作流编排器或排班系统。
- 不让员工直接管理 daemon、Hub、插件、全局 Provider 或访问控制。
- 不把公司 Codex/Claude 登录凭据复制给员工客户端。
- 不把业务账号密码、Cookie、刷新令牌写进 Agent prompt、聊天记录、审计正文或普通 JSON 配置。
- 不允许员工使用 Provider 的 `full-access`、绕过沙箱或任意扩大可写根目录。
- 不允许 Agent 接受用户传入的任意 `browserProfileId`、`workspaceId` 或文件绝对路径并直接执行。
- 不依赖前端隐藏菜单完成权限控制。
- 不通过复制十份 Paseo daemon 实现逻辑隔离。
- 不在 v1 中承诺任意 macOS 原生应用十开。
- 不破坏 Paseo 的单用户兼容模式和旧客户端解析能力。

---

## 4. 当前 Paseo 与目标之间的真实差距

截至核对基线，Paseo 已有可复用基础，但尚不是企业多用户隔离系统。

| 领域      | 当前可复用能力                                                               | 当前缺口                                                                                               |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 连接身份  | `SessionAdmission` 已包含 `principalId` 与 daemon 级 permissions             | 直连默认映射为全权 `owner`，没有员工凭据、组织和资源范围                                               |
| 权限      | `SessionAuthorization` 和 `operation-permissions.ts` 已按 RPC 做语义权限判断 | 权限是 daemon 级，只判断“能否调用这类操作”，不判断“能否访问这条 Workspace/Agent”                       |
| Workspace | 有稳定 `workspaceId`、注册表和文件持久化                                     | Workspace 没有组织、Owner 和访问范围字段                                                               |
| Agent     | Agent 记录已有可选 `workspaceId`                                             | 历史记录允许无 Workspace；没有持久化的企业归属完整性校验                                               |
| 时间线    | 有实时流、权威分页、断线补齐和本地副本缓存                                   | 初始快照、实时推送、历史分页、缓存都可能携带其他员工数据，必须统一过滤并按 Principal 分区              |
| 文件      | 有 Workspace 文件、上传、下载 Token、预览和观察能力                          | 部分路径以 `cwd` 或绝对路径为入口；下载 Token 与 Principal/Workspace 绑定不足                          |
| 浏览器    | 有 Browser tools、Broker、Electron WebView、CDP 截图和持久化 Profile         | 当前主要使用一个 `persist:paseo-browser`，多个 Tab 共享 Cookie 和 LocalStorage，不满足员工业务身份隔离 |
| Provider  | 可使用本机 Codex/Claude 登录态，Agent 在当前 OS 用户上下文运行               | Provider 历史和文件系统天然共享，不能当成员工身份边界                                                  |
| 审计      | 有运行日志和部分 `activity_log`                                              | 没有面向企业的持久、可检索、不可静默篡改的审计链                                                       |

结论：本项目不是新增一个登录页，而是给 Paseo 加一条贯穿认证、授权、存储、推送、文件、浏览器和客户端缓存的资源安全边界。

---

## 5. 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│ 员工 Paseo 客户端 / Boss 管理视图                            │
│ 登录凭据只证明 principalId；不持有 Provider 凭据              │
└───────────────────────┬─────────────────────────────────────┘
                        │ TLS / VPN / Paseo 加密 Relay
┌───────────────────────▼─────────────────────────────────────┐
│ 企业化 Paseo daemon（单实例）                                │
│                                                             │
│ IdentityAuthenticator → PrincipalContext                    │
│        │                                                    │
│        ▼                                                    │
│ Operation permission → ResourceAuthorization → Audit        │
│        │                    │                                │
│        ├── Workspace / Agent / Timeline / File              │
│        ├── BrowserProfileRegistry + BrowserLeaseManager     │
│        └── AppSlotManager + ControlledInstaller             │
└────────┬───────────────────────┬────────────────────────────┘
         │                       │
┌────────▼─────────┐   ┌─────────▼────────────────────────────┐
│ Codex / Claude   │   │ macOS 执行面                          │
│ 公司执行凭据     │   │ 隔离浏览器 Profile / 受控原生应用槽位 │
│ 受限 Workspace   │   │ PID、租约、登录态和风险状态           │
└──────────────────┘   └──────────────────────────────────────┘
```

关键原则：

- 认证回答“你是谁”。
- 粗粒度权限回答“你可调用哪类操作”。
- 资源授权回答“你可操作哪一条资源、以何种数据级别操作”。
- 租约回答“现在是否允许你操作这个独占执行面”。
- 审计回答“谁在什么时候以什么权限对什么资源做了什么”。

五者必须独立建模，禁止用一个 `role === "boss"` 分支代替。

---

## 5.1 后续分布式 Paseo 管理架构

### 5.1.1 演进目标

未来增加第二台及更多 Mac 时，不是让员工手工选择十几个 Host，也不是让多个 daemon 共享同一个 `$PASEO_HOME`。目标架构分成中央管理控制面和节点本地数据面：

```text
                         ┌───────────────────────────────┐
员工客户端 / Boss 视图 ──▶│ Enterprise Management Plane   │
                         │ Identity / Grants / Node       │
                         │ Placement / Global Lease       │
                         │ Audit Index / Global Metadata  │
                         └───────────┬───────────────────┘
                                     │ 节点短期票据、策略、心跳、容量
                   ┌─────────────────┼─────────────────┐
                   ▼                 ▼                 ▼
             ┌───────────┐     ┌───────────┐     ┌───────────┐
             │ Node A    │     │ Node B    │     │ Node C    │
             │ Paseo     │     │ Paseo     │     │ Paseo     │
             │ daemon    │     │ daemon    │     │ daemon    │
             │ Mac mini  │     │ Mac mini  │     │ Mac/VM    │
             └───────────┘     └───────────┘     └───────────┘
```

管理控制面负责“谁、可用哪些资源、资源放在哪台节点、全局是否已被占用、节点是否健康”；Paseo daemon 继续负责 Agent 生命周期、本地 Workspace、文件、浏览器和原生应用执行。

员工仍只看聊天，不需要理解节点和放置。节点调度属于后台能力。

### 5.1.2 从 P0 就必须保留的分布式接口

单节点实现不能直接依赖全局变量。必须先定义 Port，并提供本地适配器：

```ts
interface NodeContext {
  nodeId: string;
  paseoServerId: string;
  mode: "standalone" | "managed";
}

interface IdentityResolver {
  resolveCredential(token: string, node: NodeContext): Promise<PrincipalContext | null>;
}

interface PlacementResolver {
  resolveWorkspace(workspaceId: string): Promise<GlobalResourceRef | null>;
}

interface LeaseCoordinator {
  acquire(input: LeaseAcquireInput): Promise<FencedLease>;
  renew(input: LeaseRenewInput): Promise<FencedLease>;
  release(input: LeaseReleaseInput): Promise<void>;
}

interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}

interface GlobalResourceRef {
  organizationId: string;
  nodeId: string;
  resourceKind: "workspace" | "agent" | "browser_profile" | "app_slot";
  localResourceId: string;
}
```

P0 使用 `LocalIdentityResolver`、`LocalPlacementResolver`、`LocalLeaseCoordinator` 和 `LocalAuditSink`。P2 替换成受认证的远程适配器，业务模块不改授权语义。

所有中央索引使用 `(nodeId, localResourceId)`，不能假设不同 daemon 生成的本地 ID 永不冲突，也不能从 ID 或路径推导节点。

### 5.1.3 节点身份与注册

管理面使用独立 `nodeId`，Paseo 现有 `serverId` 仍表示 daemon 实例：

- `nodeId`：企业管理面的持久节点身份，例如 `nod_<16 hex>`。
- `paseoServerId`：Paseo 已有 daemon 身份，用于协议、Host 和客户端缓存。

首次注册流程：

1. 管理员创建一次性、短时效 Enrollment Token；
2. 节点生成自己的密钥对，不上传私钥；
3. 管理面签发节点关系凭据并绑定 `nodeId + paseoServerId + organizationId`；
4. 节点通过 mTLS 或等价签名通道建立出站连接；
5. 节点上报版本、Capability、OS、资源容量和脱敏执行能力；
6. 管理员批准后节点进入 `active`，可随时 `draining`、`disabled` 或 `revoked`。

节点凭据支持轮换和吊销。复制 `$PASEO_HOME` 到另一台机器不能克隆出第二个合法节点；检测到相同节点身份并发连接时必须隔离并报警。

### 5.1.4 客户端连接与票据

默认采用“控制面认证、节点直连数据面”：

1. 员工向管理面登录一次；
2. 管理面根据 Workspace/Profile/容量选择节点；
3. 管理面签发短期、节点绑定的 Session Ticket；
4. 客户端通过 Paseo Relay、VPN 或直连到目标 daemon；
5. daemon 验证签名、`aud=nodeId`、Principal、Grant version、到期时间和吊销 epoch；
6. 原始聊天和文件默认不经过中央控制面。

Session Ticket 不能跨节点复用。管理面只保存全局元数据和审计索引；Boss 打开正文时，由管理面签发一次性内容票据，再从目标节点按需读取并审计。

如果未来必须使用 WebSocket 代理，也要保持相同 Ticket 和资源授权合同，不能因为流量经过网关就跳过 daemon 本地授权。

### 5.1.5 放置和会话黏性

分布式放置遵守以下顺序：

1. 已有 Workspace 固定到其 `nodeId`。
2. 已有 Agent session 固定到 Workspace 节点。
3. 需要 Browser Profile/AppSlot 的任务优先放到该资源的 `homeNodeId`。
4. 新任务才按 OS、应用、Profile、Provider、CPU、内存和并发槽选择节点。
5. 节点进入 `draining` 后不接收新任务，已有任务结束或显式迁移。

不实现“运行中 Agent 无感热迁移”。Provider 执行可能已产生外部副作用，跨节点自动重放会重复发消息、改价或提交表单。节点故障时状态标记为 `outcome_unknown`，由员工/Boss 检查后决定是否继续。

Workspace 迁移是显式运维操作：停止 Agent → 校验无租约 → 复制允许的数据 → 在目标节点重新注册 → 验证 → 切换 Placement。Browser Cookie/Profile 默认不跨节点复制，目标节点优先重新登录，避免设备指纹变化和凭据扩散。

### 5.1.6 跨节点业务身份锁与防脑裂

本地 `browserProfileId` 只标识一台节点上的 Profile。分布式锁必须绑定全局 `businessIdentityId`，例如某平台某店铺的业务账号：

```ts
interface FencedLease extends ResourceLease {
  organizationId: string;
  businessIdentityId: string;
  nodeId: string;
  fencingToken: number; // 由管理面单调递增
  leaseRevision: string;
}
```

要求：

- 控制面用强一致存储或单事务保证同一 `businessIdentityId` 同时只有一个写租约。
- 每次 Browser/App 写动作前，节点验证租约未过期且 `fencingToken` 仍是本节点最新值。
- 网络分区时，节点只能执行到当前租约到期；无法续租后停止新的外部写动作。
- 新节点获得更高 `fencingToken` 后，旧节点即使恢复网络也不能继续写。
- 不能只依赖“谁最后发心跳”或本机内存锁解决跨节点互斥。

同一店铺在多节点建立多个 Profile 时，Profile 各自保存登录态，但共享同一个 `businessIdentityId` 全局写锁。是否允许并发只读由具体平台风险策略决定。

### 5.1.7 数据所有权和审计汇聚

每个 daemon 保持自己的 `$PASEO_HOME`，禁止多节点通过 NFS/同步盘共享文件注册表、SQLite、Socket、PID 或 Browser Profile 目录。

中央控制面保存：

- Node/Capability/版本/容量；
- Principal、Grant 和吊销版本；
- 全局资源引用与 Placement；
- 会话状态摘要和脱敏结果摘要；
- 全局业务身份租约；
- 审计索引和完整性锚点。

节点本地保存：

- 原始 Timeline 和 Provider session 映射；
- Workspace 文件；
- Browser Cookie/Profile；
- 原生应用本地状态；
- 详细本地审计 Journal。

审计事件增加 `nodeId`、`nodeEventSeq` 和全局唯一 `eventId`。节点断网时有界缓存，恢复后幂等补传；管理面按 `eventId` 去重并检测 sequence gap。Boss 全局视图的摘要可以汇聚，正文不能默认批量复制到控制面。

### 5.1.8 故障语义

| 故障             | 默认行为                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| 管理面短时不可用 | 已有本地纯文件任务可在有效 Ticket/Grant 内继续；新的登录、放置和全局租约失败关闭 |
| 全局租约无法续期 | 当前步骤结束后停止新的 Browser/App 写动作，显示等待管理面恢复                    |
| 节点失联         | 标记 Node offline；不自动把可能已执行的动作在其他节点重放                        |
| 节点恢复         | 先刷新 Grant、Placement 和最高 fencing token，再恢复可写状态                     |
| 审计补传缺口     | 节点进入 degraded；高风险动作和 Boss 正文查看失败关闭                            |
| 版本不兼容       | Node 保持 registered 但不接新任务，提示升级；不走无权限降级路径                  |
| 重复节点身份     | 隔离两个连接，要求管理员确认，不以“最新连接获胜”静默处理                         |

### 5.1.9 与 Paseo 现有能力的边界

- Relay 解决网络连通和端到端加密，不负责节点注册、放置和全局租约。
- Hub 解决外部触发、Workflow 和 `hub.execute`；当前 `hub.execute` 是 daemon-wide，不能直接当成员工/租户隔离或多节点控制面。
- App 的多 Host 能让一个客户端连接多 daemon，但不是组织级 Node Registry、统一授权、容量调度和 Boss 全局视图。
- 分布式管理可以复用 Paseo Hub 的“主动出站关系、独立节点凭据、权限吊销”模式，但必须使用新的企业资源范围和节点管理协议，不能扩大 `hub.execute` 含义。

### 5.1.10 分布式安全底线

- 中央管理面被攻破不能直接获得所有节点的 Provider 明文凭据和 Browser Cookie。
- 单个节点被攻破不能伪装成其他节点，也不能修改其他节点的 Placement/租约。
- Boss 全局视图不批量预取原始聊天。
- 节点之间不直接互信；所有跨节点指令由管理面签名、限定目标节点、资源、动作和到期时间。
- 分布式不会提升单节点内部隔离强度；外部商家仍需独立 VM/节点边界。

---

## 6. 统一术语与 ID 规范

沿用 Paseo 官方术语：Project、Workspace、Agent session、Daemon、Provider、Terminal。不要在 UI 中把 Agent session 改叫 Job/Task/Run。

企业扩展使用以下名称：

| 名称                 | 含义                          | 规范                                     |
| -------------------- | ----------------------------- | ---------------------------------------- |
| `organizationId`     | 企业/组织边界                 | `org_<16 hex>`，不可从名称推导           |
| `principalId`        | 当前经过认证的人或服务身份    | `usr_<16 hex>` / `svc_<16 hex>`          |
| `ownerPrincipalId`   | 资源的业务 Owner              | 持久字段，不使用邮箱/姓名                |
| `actorPrincipalId`   | 审计事件实际操作者            | 来自 Session，不接受客户端覆盖           |
| `nodeId`             | 企业管理面的持久执行节点身份  | `nod_<16 hex>`，与 Paseo `serverId` 分开 |
| `businessIdentityId` | 跨节点唯一的店铺/业务账号身份 | `bid_<16 hex>`，全局租约键               |
| `browserProfileId`   | 浏览器持久业务身份            | `brp_<16 hex>`，不可解析含义             |
| `appSlotId`          | 原生应用执行槽位              | `aps_<16 hex>`                           |
| `leaseId`            | 一次独占资源租约              | `lea_<uuid>`                             |
| `credentialRef`      | macOS Keychain/密钥服务引用   | 只存引用，不存秘密值                     |

Paseo 现有 `agent-owner.ts` 中的 Owner 表示 daemon/Hub 执行归属，不能复用为员工 Owner。员工资源归属必须明确命名为 `ownerPrincipalId`。

---

## 7. 认证设计

### 7.1 v1 试点采用个人访问令牌

为了复用 Paseo 已有 HTTP Bearer 和 WebSocket `paseo.bearer.<token>` 传输，v1 使用管理员签发的个人访问令牌：

```text
pso_u_<credentialId>.<至少 32 字节随机熵的 base64url secret>
```

要求：

- `credentialId` 只用于 O(1) 定位哈希记录，不是秘密，也不授予权限；禁止遍历所有 bcrypt Hash 试配 Token。
- 服务端只持久化 credential ID、secret 的 bcrypt 哈希、`principalId`、`organizationId`、状态、创建时间、到期时间和最后使用时间。
- bcrypt cost 不低于 Paseo 当前 daemon password 的 12。
- 明文令牌只在创建时显示一次。
- 支持吊销、轮换、过期和“注销当前所有会话”。
- 认证日志不能打印 Authorization 或 WebSocket subprotocol；保留 Paseo 已有日志脱敏并补测试。
- 原有 daemon password 保留为本机 break-glass Owner 通道，不能发给员工。
- 未配置企业模式时，保持 Paseo 原有单用户行为。

### 7.2 认证端口

新建可替换接口：

```ts
interface PrincipalAuthenticator {
  authenticateBearer(token: string, context: ConnectionContext): Promise<PrincipalContext | null>;
}

interface PrincipalContext {
  principalId: string;
  organizationId: string;
  principalType: "human" | "service" | "break_glass_owner";
  grants: ResourceGrant[];
  credentialId: string;
}
```

`PrincipalContext` 由 WebSocket/HTTP 入口构造，传入 Session；客户端提交的任何同名字段都必须忽略。

### 7.3 后续 SSO

OIDC/飞书企业身份属于 v2。接入时只新增 `PrincipalAuthenticator` 适配器，不重写资源授权。验证 `iss`、`aud`、`exp`、`nbf`、`kid`、签名和组织映射；失败时默认拒绝。SSO 不是 v1 交付的阻塞项。

---

## 8. 授权模型

### 8.1 两层授权

所有请求和所有出站数据都必须经过两层检查：

1. 保留现有 `DaemonPermission` / `operation-permissions.ts`，判断操作类别。
2. 新增 `ResourceAuthorization`，判断具体组织、Workspace、Agent、文件、Browser Profile 和内容级别。

不能只在请求入口检查。列表、首屏快照、实时事件、Tombstone、订阅恢复和异步回调也必须经过同一资源判断。

### 8.2 Grant 结构

角色只是企业身份系统的权限预设，daemon 不写 `if (role === "boss")`。身份解析器输出如下 Grant：

```ts
type EnterpriseAction =
  | "workspace.metadata.read"
  | "workspace.content.read"
  | "workspace.write"
  | "workspace.manage"
  | "browser.use"
  | "browser.profile.manage"
  | "app.use"
  | "audit.read"
  | "identity.manage";

type ResourceSelector =
  | { kind: "self" }
  | { kind: "organization"; organizationId: string }
  | { kind: "workspace"; workspaceIds: string[] };

interface ResourceGrant {
  action: EnterpriseAction;
  selector: ResourceSelector;
}
```

不要在第一阶段向现有 `DAEMON_PERMISSIONS` 枚举直接加入上述字符串。旧客户端可能无法解析未知枚举值。企业 Grant 使用独立、可选、Capability-gated 的协议字段或 RPC。

### 8.3 权限预设

| 能力                            |             员工 |           Boss |             平台管理员 |
| ------------------------------- | ---------------: | -------------: | ---------------------: |
| 查看 Workspace/Agent 元数据     |             自己 |         全组织 |             仅运维所需 |
| 查看聊天正文/客户内容           |             自己 | 需显式内容授权 |                 默认否 |
| 创建、发送、取消 Agent          |             自己 |   可选代办授权 |                 默认否 |
| 管理自己的 Browser Profile 绑定 | 使用，不可改绑定 |     可查看状态 | 可管理绑定，不可读秘密 |
| daemon/插件/Provider 全局配置   |               否 |             否 |                     是 |
| 查看审计                        |       自己的摘要 |         全组织 |               系统审计 |
| 管理身份和 Grant                |               否 |             否 |                     是 |

### 8.4 `ResourceAuthorization` 必须提供的最小接口

```ts
interface ResourceAuthorization {
  filterWorkspaces(
    ctx: PrincipalContext,
    rows: PersistedWorkspaceRecord[],
  ): PersistedWorkspaceRecord[];
  assertWorkspace(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    workspaceId: string,
  ): Promise<AuthorizedWorkspace>;
  assertAgent(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    agentId: string,
  ): Promise<AuthorizedAgent>;
  assertBrowserProfile(
    ctx: PrincipalContext,
    action: EnterpriseAction,
    browserProfileId: string,
  ): Promise<AuthorizedBrowserProfile>;
  resolveWorkspacePath(
    ctx: PrincipalContext,
    workspaceId: string,
    requestedPath: string,
  ): Promise<string>;
  canEmit(ctx: PrincipalContext, event: SessionOutboundMessage): Promise<boolean>;
}
```

禁止在 `session.ts` 各分支散落 Owner 判断。`session.ts` 只调用统一服务；业务模块得到的应是已经授权的资源对象，而不是未经验证的 ID。

### 8.5 必须覆盖的入口清单

实施会话必须建立一张可机读或可测试的资源入口清单，至少包含：

- Project/Workspace list、get、create、rename、pin、label、archive、restore、remove；
- Agent list、get、create、resume、import、fork、send、steer、cancel、archive、delete；
- Timeline tail、before/after 分页、prompt list、replacement、live `agent_stream`；
- Agent 状态、注意力、权限请求、子 Agent、搜索和历史；
- Terminal create/list/subscribe/input/kill/capture；
- 文件浏览、预览、写入、创建、重命名、复制、删除、上传、下载；
- Git 状态、Diff、提交、推送、拉取、切分支、Forge 搜索；
- Workspace scripts、setup、service proxy；
- Browser tools、浏览器列表、新建 Tab、操作、截图、文件上传；
- Schedule、Heartbeat、Push token 和通知路由；
- Provider 最近 Session、Provider usage、Provider diagnostics；
- Desktop 打开文件、打开编辑器、插件与 daemon 配置。

任何入口无法可靠解析到 Workspace/Organization 时，企业员工模式下默认拒绝，不得退回 daemon 全局权限。

---

## 9. 数据模型与持久化

### 9.1 Workspace 是主要授权边界

在 `PersistedWorkspaceRecordSchema` 增加兼容性可选字段：

```ts
organizationId: z.string().optional(),
nodeId: z.string().optional(),
ownerPrincipalId: z.string().optional(),
createdByPrincipalId: z.string().optional(),
```

规则：

- 新企业 Workspace 上述字段必须写入。
- P0 的 `nodeId` 写当前本地节点；不得用常量散落在业务代码中，由 `NodeContext` 统一提供。
- `ownerPrincipalId` 一经创建不可由普通员工修改。
- 相同 `cwd` 不允许属于两个不同 Owner；这是 v1 的硬约束。
- 员工新建 Workspace 的 `cwd` 必须位于其 `assignedRoot` 内。
- Project 列表只展示含有可访问 Workspace 的 Project；Project 操作同样受范围控制。

### 9.2 Agent 继承 Workspace 归属

Agent 的授权来源是其 `workspaceId` 对应的 Workspace。企业模式下新 Agent 必须有 `workspaceId`。

Agent 记录可增加以下可选完整性字段：

```ts
organizationId?: string;
nodeId?: string;
ownerPrincipalId?: string;
createdByPrincipalId?: string;
```

这些字段是防孤儿和一致性校验副本，不能单独扩大权限。每次读取 Agent 时：

1. 解析 Agent 的 `workspaceId`；
2. 读取 Workspace；
3. 以 Workspace Owner 做授权；
4. 校验 Agent 副本与 Workspace 一致；
5. 不一致或 Workspace 缺失时进入隔离区，仅平台管理员可修复，并写审计。

### 9.3 旧数据策略

旧 Workspace/Agent 没有企业字段时不得自动归给第一个登录员工。

- 企业模式首次启用前生成迁移报告。
- 管理员显式把每个旧 Workspace 指派给 Owner，或标记为 `legacy_owner_only`。
- 未指派记录仅 break-glass Owner 可见。
- 迁移只补字段，不重写 ID、路径、Provider sessionId 或历史。
- 不建立破坏性通用 Migration 框架；遵循 Paseo 当前 Zod + 可选字段 + 原子文件写入方式。

### 9.4 企业扩展存储

建议在 `$PASEO_HOME/enterprise/` 下保存：

```text
enterprise/
  node-identity.json        # nodeId 与 paseoServerId 绑定，无私钥明文
  organizations.json
  principals.json
  credentials.json          # 只有哈希和元数据
  grants.json
  browser-profiles.json     # 无 Cookie、无密码
  app-slots.json
  audit/
    2026-09-09.jsonl
```

要求：

- JSON 注册表使用 Paseo 的原子写入工具。
- 文件权限为当前 OS 用户可读写，敏感文件启动时检查权限。
- 租约的实时状态以内存为准，可选写恢复 Journal；daemon 重启后不得把旧租约直接当作有效。
- Cookie/LocalStorage 仍由隔离的 Electron/Chromium Profile 保存。
- 密码、Token、验证码只进入 macOS Keychain 或外部 Secret Manager；JSON 只保存 `credentialRef`。

---

## 10. WebSocket、实时流和客户端缓存隔离

这是最高风险工作流之一。

### 10.1 Session 必须持有完整 Principal

把 `principalId`、`organizationId` 和 Grants 从 `SessionAdmission` 传入 `SessionOptions`。当前 Session 只有 `clientId` 和粗粒度 permissions，不足以做资源授权。

Paseo 当前恢复连接 Key 已包含 `principalId`，保留该设计。企业 Token 变化、Principal 变化或 Grant 版本变化时，不得恢复到旧 Principal 的 Session。

### 10.2 出站过滤

以下数据都必须按 Principal 过滤：

- 初始 Agent/Workspace/Project 快照；
- `fetch_*` 响应；
- `agent_stream`、`agent_update`、状态和权限请求；
- Workspace mutation、archive、remove 和 Tombstone；
- Timeline replacement、gap recovery、tail 和向前/向后分页；
- Terminal、Git、脚本、服务和浏览器事件；
- 通知和 `activity_log`。

订阅成功不代表永久授权。Grant 被撤销后，要取消对应订阅、清理 Session 中的资源状态并向客户端发送“授权范围已刷新”，不能继续推送已打开页面的数据。

### 10.3 客户端缓存分区

Paseo 当前客户端副本主要按 Host/Server 维持。企业版必须把以下持久缓存键至少改为：

```text
(organizationId, nodeId, paseoServerId, principalId, workspaceId/agentId, dataKind)
```

必须覆盖 Timeline、Workspace/Agent 列表、草稿、附件、审阅状态、Tab、最近访问和下载记录。切换员工身份或退出登录时：

- 停止网络与订阅；
- 释放当前 Principal 的运行时 Store；
- 不把旧 Principal 的缓存绘制到新会话；
- 如果产品要求“退出即清除”，删除该 Principal 的本地缓存；否则保持加密分区但绝不跨 Principal 读取。

验收必须包含“员工 A 登录并浏览 → 退出 → 同一设备登录员工 B → 离线打开”的测试。

---

## 11. 文件系统和 Provider 执行边界

### 11.1 每个员工的根目录

建议路径：

```text
$PASEO_HOME/enterprise/workspaces/<organizationId>/<principalId>/<workspaceId>/
```

也可以绑定现有目录，但必须显式登记 `assignedRoot`。路径验证必须：

- 使用 `realpath`/规范化后的路径比较；
- 阻止 `..`、符号链接、大小写和挂载点逃逸；
- 从 `workspaceId` 解析允许根，不能相信请求携带的 `cwd`；
- 对不存在的新路径验证其最近存在父目录；
- 文件上传和浏览器文件选择也执行同一检查。

### 11.2 同 cwd 风险

Paseo 部分 Directory-backed surface 和状态缓存按 `(serverId, cwd)` 建模。v1 不允许两个不同 Owner 使用相同 `cwd`。共享资料通过显式只读副本、受控 API 或独立共享资源 Grant 提供，不能让不同 Owner 注册同一个可写目录。

### 11.3 Codex/Claude 执行策略

公司统一 Codex/Claude 登录只是 Provider 凭据。每个员工 Agent 启动时，服务端强制注入受限配置，客户端不能覆盖：

```yaml
codex:
  sandbox_mode: workspace-write
  approval_policy: never
  sandbox_workspace_write:
    writable_roots: [<authorized-workspace-root>]
    network_access: false # 有明确业务需要时按能力白名单开启
```

Claude 等 Provider 使用其原生等价限制，并设置 `failIfUnavailable: true`；沙箱不可用时不能自动退化到无限制模式。

员工角色默认禁止：

- 任意 Terminal 创建、输入和订阅；
- `open_in_editor`；
- Provider 最近全局 Session 浏览/导入；
- 自定义 MCP Server、Provider options 或系统级工具权限；
- 修改 `paseo.json` 中可执行脚本，除非 Workspace 被显式授予开发权限。

受信任的开发岗位可通过单独 Grant 放开，但仍需 Workspace 范围和审计。

### 11.4 Provider 历史

Codex 历史位于 `~/.codex/sessions/...`，Claude 历史位于 `~/.claude/projects/...`，它们在同一 macOS 用户下天然共享。企业员工不能直接扫描这些目录。

只允许通过已经绑定到其 Workspace 的 Paseo Agent 读取 Provider 历史。`fetch_recent_provider_sessions` 在员工模式下默认关闭；恢复操作必须先证明 Provider handle 已绑定到当前可访问 Agent。

---

## 12. 浏览器业务身份隔离

### 12.1 当前实现必须改动的原因

当前 Paseo Desktop 使用固定 `persist:paseo-browser`，官方 Browser Profile Harness 也验证多个 Tab 共享 Cookie/LocalStorage。这个行为对单用户方便，对多员工是 P0 级串号风险。

### 12.2 BrowserProfile 数据结构

```ts
interface BrowserProfileRecord {
  browserProfileId: string;
  organizationId: string;
  homeNodeId: string;
  businessIdentityId: string;
  ownerPrincipalId: string;
  platform: "douyin" | "pinduoduo" | "taobao" | "feishu_web" | "generic";
  businessAccountKey: string; // 脱敏后的店铺/主体内部键
  label: string;
  partitionKey: string;
  downloadRoot: string;
  credentialRef?: string;
  expectedIdentity?: {
    hostnames: string[];
    accountLabelHash?: string;
  };
  status: "ready" | "login_required" | "mfa_required" | "risk_control" | "disabled";
  createdAt: string;
  updatedAt: string;
}
```

Profile 唯一键建议为：

```text
(organizationId, platform, businessAccountKey, ownerPrincipalId)
```

`label` 可读，不能作为安全键。`businessAccountKey` 不存完整店铺敏感信息。

### 12.3 路由规则

浏览器工具调用必须经过：

```text
Agent → workspaceId → ownerPrincipalId → BrowserProfileBinding
      → acquire lease → server adds browserProfileId
      → Broker routes to registered browser host
      → Desktop main selects isolated partition
```

Agent tool schema不得暴露可自由填写的 `browserProfileId`。如果一个员工对同一 Workspace 有多个合法 Profile，用户先在 Paseo UI 选择业务身份并形成受审计的 Workspace binding，之后 Agent 只能使用该绑定。

### 12.4 Electron Profile 实现

把每个 Profile 映射到独立持久分区，例如：

```text
persist:paseo-enterprise-brp_<opaque-id>
```

同时修改：

- Desktop preload 暴露的 Profile 能力；
- WebView attach allowlist，允许且只允许注册表中已授权的分区；
- Browser WebView Registry，使 Browser ID 同时绑定 Workspace、Profile 和 Host；
- Browser automation RPC，增加可选 `browserProfileId`，由 daemon 填入；
- Broker 的 `list_tabs` 和 Host 选择逻辑，按 Workspace + Profile 过滤；
- Popup、新 Tab、下载、文件选择和清理 Profile 的路径；
- Capture Harness，新建“两 Profile Cookie 互不可见、重启后各自保持”的真实 Electron 测试。

旧单用户模式继续使用 `persist:paseo-browser`。企业能力由 Capability Gate 开启，不允许新旧逻辑在功能内部到处分支。

### 12.5 租约和并发

```ts
interface ResourceLease {
  leaseId: string;
  resourceKind: "browser_profile" | "app_slot";
  resourceId: string;
  nodeId: string;
  holderPrincipalId: string;
  holderAgentId: string;
  fencingToken: number;
  mode: "read" | "write";
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}
```

规则：

- 同一 Browser Profile 只允许一个写租约。
- 不同 Profile 可并行，受 Mac 压力上限控制。
- 读取截图也必须有租约，避免截到其他 Agent 正在切换后的敏感页面。
- 租约超时、Agent 结束、WebSocket 断开或 Browser Host 重启时自动释放。
- daemon 重启后所有旧租约失效；重新核对 Browser PID、Profile 和当前页面后才能恢复。
- 等待租约时把 `resource_waiting` 状态发回原 Agent session，不创建独立调度产品。

### 12.6 登录态与风险控制

- 第一次登录建议由员工本人在绑定 Profile 中完成；AI 可以引导，但不得把密码写入对话。
- MFA、扫码、滑块、平台风控一律切换为 `mfa_required` / `risk_control` 并请求员工接管。
- 高风险动作（发布、删除、付款、改价、批量消息）前核对域名、店铺标识和账号标识。
- 当前页面识别不到预期账号时停止，不尝试“猜一个账号继续”。
- Profile 清除、转让和重新绑定必须由平台管理员执行并审计。

### 12.7 与 macOS Harness 的关系

macOS Harness 可以作为执行驱动，但不能作为身份与授权系统。稳定性来自 `Browser Profile + 浏览器进程 PID + CDP Target + 租约` 的联合映射，不来自窗口标题、屏幕坐标或“最近打开的浏览器”。

Browser 场景优先使用 Paseo Browser tools/CDP；只有系统对话框、浏览器外壳或原生应用必须操作时才交给 macOS Harness。daemon 发给 Harness 的不是任意 PID，而是短期执行 Capability：

```ts
interface HarnessCapability {
  leaseId: string;
  actorPrincipalId: string;
  workspaceId: string;
  resourceKind: "browser_profile" | "app_slot";
  resourceId: string;
  allowedBundleId: string;
  allowedPid: number;
  allowedActions: string[];
  expiresAt: string;
}
```

Harness 每次动作前核对租约、PID、Bundle ID 和 CDP/Profile 绑定；PID 退出、浏览器重启或前台窗口不匹配时立即失效并回到 daemon 重新解析。不得允许 Agent 直接调用“点击任意坐标”“控制任意 PID”作为企业能力。

---

## 13. 原生应用槽位与受控安装

### 13.1 AppSlot

```ts
interface AppSlotRecord {
  appSlotId: string;
  organizationId: string;
  nodeId: string;
  businessIdentityId?: string;
  appBundleId: string;
  accountBindingKey: string;
  ownerPrincipalId?: string;
  concurrency: 1;
  credentialRef?: string;
  status: "ready" | "login_required" | "busy" | "disabled";
}
```

同一原生应用如果没有可验证的多账号隔离，必须通过 `AppSlotManager` 串行执行。租约绑定 `principalId + agentId + PID + accountBindingKey`。执行前验证 Bundle ID、PID、窗口和当前账号；验证失败则停止并请求人工处理。

优先把飞书、吉客云等能力实现成 API 或隔离 Web Profile。只有 API/Web 无法满足的功能才进入原生应用槽位。

### 13.2 受控安装器

员工可以在会话里提出“安装某软件”，但 Agent 不得直接下载并执行任意 DMG/PKG。

受控安装流程：

1. 解析软件名和业务需要；
2. 命中管理员 Allowlist；
3. 从固定官方来源下载；
4. 校验哈希、开发者签名、Notarization 和 Bundle ID；
5. 需要提权时转人工批准；
6. 安装后登记 AppSlot 和版本；
7. 写审计并反馈结果。

未命中 Allowlist 时只创建审批请求，不执行安装。

macOS Harness 驱动原生应用时必须消费第 12.7 节的短期 Capability。单个 Harness 运行时可以维护多个受控目标，但不能因为它支持 PID 定向输入就宣称原生应用已经实现十个账号并行；并发能力仍由应用本身的多实例/多账号能力和 AppSlot 租约决定。

---

## 14. Boss 管理视图

Boss 视图是 Paseo 的一个受权限控制的组织视角，不是另起一套调度系统。

v1 最小字段：

- 员工、Workspace、Agent session；
- 当前状态：等待、运行、需要输入、失败、完成；
- Provider/模型、开始时间、最后活动时间、耗时；
- 当前 Browser Profile/App Slot 的脱敏标签和占用状态；
- 失败原因分类和资源压力；
- 审计入口。

打开聊天正文或文件前再次调用服务端授权。每次内容访问记录 `boss.content.viewed`，包括 Actor、目标资源、理由/工单号（如果组织要求）、时间和结果。前端不能预加载 Boss 尚未打开的所有正文。

平台管理员视图与 Boss 视图分开：管理员可以修复身份、绑定和系统配置，但默认只看到脱敏运行信息。

---

## 15. 企业审计

### 15.1 审计事件

```ts
interface AuditEvent {
  eventId: string;
  occurredAt: string;
  organizationId: string;
  nodeId: string;
  nodeEventSeq: number;
  actorPrincipalId: string;
  actorCredentialId?: string;
  sessionId?: string;
  action: string;
  resource: { kind: string; id: string };
  workspaceId?: string;
  agentId?: string;
  outcome: "allowed" | "denied" | "failed";
  reasonCode?: string;
  metadata?: Record<string, string | number | boolean | null>;
  previousHash?: string;
  eventHash?: string;
}
```

最低事件集合：

- Token 创建、使用、吊销、失败登录；
- Grant 变化和管理员操作；
- Workspace/Agent 创建、读取内容、修改、归档、删除；
- 越权拒绝和 IDOR 尝试；
- 文件上传、下载、删除；
- Browser Profile 绑定、租约、登录失效、身份不匹配、高风险动作；
- AppSlot 获取、释放、账号不匹配；
- 安装审批和安装结果；
- Boss 内容查看；
- break-glass Owner 使用。

### 15.2 审计存储规则

- 使用只追加 JSONL，每日轮转。
- 使用 hash chain 检测静默修改；每日首条关联上一日末尾 Hash。
- 不记录 Prompt 正文、Cookie、Token、密码、完整客户数据或截图。
- 审计服务失败时，高风险管理操作和 Boss 内容查看必须失败关闭；普通 Agent 状态事件可进入有界内存缓冲并报警。
- 稳定版将审计副本发送到 Mac 外部存储，避免本机管理员可无痕删除。

---

## 16. 协议兼容规则

严格遵守 Paseo 的协议合同：

- 新字段必须 `.optional()`，并在验证后显式归一化。
- 不把现有 optional 改 required，不删除字段，不收窄类型。
- WebSocket wire schema 不使用 `.transform()`、`.catch()` 或 `.preprocess()`。
- 同 Tag 联合使用 `z.discriminatedUnion()`。
- 新功能通过 `server_info.features` 在一个入口 Gate；不做散落的旧版降级分支。
- 新 RPC 使用点分命名，动词在方向前，例如：

```text
enterprise.identity.get_current.request/response
enterprise.identity.list_principals.request/response
enterprise.access.list_grants.request/response
enterprise.access.update_grants.request/response
enterprise.audit.list_events.request/response
enterprise.browser.list_profiles.request/response
enterprise.browser.bind_profile.request/response
enterprise.resource.acquire_lease.request/response
enterprise.resource.renew_lease.request/response
enterprise.resource.release_lease.request/response
enterprise.node.list_nodes.request/response
enterprise.node.set_drain.request/response
enterprise.placement.resolve_workspace.request/response
```

节点 Enrollment、心跳、Capacity 和审计补传属于 daemon 与管理控制面的独立受认证通道，不复用普通员工 Session RPC。普通客户端只能调用有明确用户授权语义的 Node/Placement 查询，不能注册节点或伪造 Capacity。

建议 Feature Flags：

```text
enterpriseIdentityV1
enterpriseResourceAuthorizationV1
enterpriseBrowserProfilesV1
enterpriseAuditV1
enterpriseDistributedNodeV1
```

兼容 Shim 使用 Paseo 规定的注释：

```ts
// COMPAT(enterpriseIdentityV1): added in vX.Y.Z, remove after YYYY-MM-DD once client and daemon floors are compatible.
```

旧客户端连接企业员工入口时，如果无法理解资源隔离能力，必须提示升级并拒绝进入；不能给旧客户端返回全量数据。旧客户端仍可通过本机 break-glass Owner 的单用户模式连接。

---

## 17. 实现阶段、优先级和时间

### P0：不串数据的内部试点，目标 7–12 个工作日

交付：

- 员工 Token 与 Principal；
- Workspace/Agent Owner；
- 请求、响应、实时流、缓存和文件的资源授权；
- 共享 Codex 凭据下的受限 Workspace；
- 每员工/店铺独立 Browser Profile 和写租约；
- Boss 全局元数据视图；
- 基础审计；
- `NodeContext` 以及 Identity/Placement/Lease/Audit 的本地适配器，所有新资源写入当前 `nodeId`；
- 10 人并发验收。

第 2–3 天可以形成仅供开发验证的原型，但不得给业务使用，因为缓存、文件 Token 和实时订阅通常尚未全部封闭。

### P1：可持续内部生产，目标累计 3–5 周

交付：

- Grant 管理 UI、Token 吊销/轮换；
- Boss 内容授权和审计；
- AppSlot、登录失效恢复、风险状态；
- 受控安装器；
- 压力测试、故障恢复、审计导出、运维手册；
- 上游同步和回滚机制。

### P2：分布式 Paseo 管理，目标 2–3 个真实节点

交付：

- Enterprise Management Plane；
- Node Enrollment、证书/关系凭据轮换、心跳和 Capability Registry；
- 短期 Node-bound Session Ticket；
- Workspace/Profile/AppSlot Placement 和节点 Drain；
- 带 fencing token 的跨节点业务身份租约；
- Boss 全局元数据视图和按需内容访问；
- 审计幂等汇聚、sequence gap 检测；
- 节点离线、控制面离线、脑裂和版本漂移演练。

P2 必须复用 P0 已定义的 Port 和资源语义，不在 daemon 之外另建一套不一致的身份/权限系统。

### P3：外部商家/强隔离

交付前置：

- OIDC/企业 SSO；
- 租户级独立进程、VM 或节点；
- 外部审计存储、密钥轮换、备份与灾备；
- 安全评审与渗透测试。

P3 不允许在单一 macOS 用户的应用层隔离上直接贴“多租户安全”标签。每个外部租户必须绑定明确的隔离域和节点 Placement 策略。

---

## 18. 并行开发组织

建议同时运行 6–8 个 Paseo Worktree/会话。继续增加会话并不会线性提速，反而会在 `messages.ts`、`session.ts`、`daemon-client.ts` 和 App Store 上产生合并冲突。

### W0：合同、协议与 ADR

独占修改：

- `packages/protocol/src/messages.ts`
- `packages/protocol/src/browser-automation/**`
- `docs/enterprise/**`

职责：

- 建立 Feature Flags、企业协议 Schema、兼容测试；
- 固化 Principal/Grant/Owner/Profile/Lease/Audit/Node/GlobalResourceRef 类型；
- 为 Identity、Placement、Lease、Audit 定义 Port 和单节点本地适配器合同；
- 输出接口供其他工作流使用。

不得实现 Session 或 UI 业务逻辑。

### W1：认证与 Session Admission

独占修改：

- `packages/server/src/server/auth.ts`
- `packages/server/src/server/websocket-server.ts`
- `packages/server/src/server/bootstrap.ts` 中认证装配区域
- 新目录 `packages/server/src/server/enterprise/identity/**`

职责：

- Token Registry、哈希、吊销、PrincipalAuthenticator；
- 把 PrincipalContext 安全传到 Session；
- HTTP、WebSocket 和重连身份测试；
- 保持 break-glass 单用户模式。

### W2：资源授权与归属数据

独占修改：

- `packages/server/src/server/authorization/**`
- `packages/server/src/server/workspace-registry.ts`
- `packages/server/src/server/workspace-registry-model.ts`
- `packages/server/src/server/agent/agent-storage.ts`
- 新目录 `packages/server/src/server/enterprise/access/**`

职责：

- ResourceAuthorization；
- Workspace/Agent Owner 字段和旧数据隔离；
- Project/Workspace/Agent 的范围过滤；
- 归属不一致的 fail-closed 行为。

### W3：Session、时间线、订阅和客户端副本

独占修改：

- `packages/server/src/server/session.ts`
- `packages/server/src/server/session/**` 中非其他工作流专属模块
- `packages/client/src/daemon-client.ts`
- `packages/app/src/timeline/**`
- `packages/app/src/contexts/session-context.tsx`
- 企业缓存分区相关 Store

职责：

- 对初始快照、RPC 响应和实时事件统一过滤；
- Grant 撤销后的订阅回收；
- 客户端缓存按 Principal 分区；
- A→退出→B 的无泄漏测试。

`session.ts` 是总热点。其他工作流不得直接改它，只提交需要接入的接口和调用点说明。

### W4：浏览器 Profile 与租约

独占修改：

- `packages/server/src/server/browser-tools/**`
- `packages/desktop/src/features/browser-profile.ts`
- `packages/desktop/src/features/browser-webviews/**`
- `packages/desktop/src/preload.ts` 的浏览器桥接部分
- `packages/app/src/desktop/browser/**`
- 新目录 `packages/server/src/server/enterprise/browser/**`

职责：

- Profile Registry/Binding/Lease；
- Broker 按 Profile 路由和过滤；
- Electron Partition 隔离；
- Cookie、LocalStorage、Popup、下载和重启保持测试。

### W5：文件、Terminal、Provider 策略和 AppSlot

独占修改：

- 文件上传/下载/预览/观察模块；
- Terminal 和 Workspace script 的授权适配；
- Provider 启动配置策略模块；
- 新目录 `packages/server/src/server/enterprise/runtime/**`

职责：

- 路径 Canonicalization 和 symlink escape 防护；
- 下载 Token 绑定 Principal + Workspace + TTL + 一次性策略；
- 员工角色禁用全局 Terminal/Provider history；
- AppSlot 与受控安装器骨架。

### W6：企业 UI

独占修改：

- `packages/app/src/screens/enterprise/**`
- `packages/app/src/components/enterprise/**`
- 身份状态与 Boss 视图专属 Store

职责：

- Token 登录/身份显示/退出；
- 员工资源视图；
- Boss 元数据和授权后的内容查看；
- Browser Profile 状态、等待、MFA、风控提示；
- 平台管理员绑定和 Grant 操作。

不得在前端复制服务端权限逻辑；前端只根据服务端投影渲染。

### W7：审计、对抗测试、压力和发布

独占修改：

- 新目录 `packages/server/src/server/enterprise/audit/**`
- `packages/app/e2e/browser/enterprise-*.spec.ts`
- `packages/desktop/e2e/enterprise-*.spec.ts`
- 企业测试 Fixture、压力脚本和发布清单

职责：

- Audit Sink 与 hash chain；
- IDOR、事件泄漏、缓存泄漏、路径逃逸、Profile 串号测试；
- 10 客户端并发和资源压力；
- QA 证据汇总。

W7 可以要求其他工作流补可测试接口，但不得为了让测试通过而降低验收标准。

### W8：分布式管理控制面（P2 才启动）

独占修改：

- 新的 Enterprise Management Plane 项目或包；
- `packages/server/src/server/enterprise/managed-node/**`；
- Node Enrollment、Ticket、Placement、跨节点 Lease 和审计汇聚客户端；
- `docs/enterprise/distributed/**`。

职责：

- 实现 Node Registry、Capability/Capacity、心跳和 Drain；
- 用远程适配器替换 P0 的 Local Identity/Placement/Lease/Audit；
- 实现 node-bound Session Ticket 和全局资源索引；
- 实现带 fencing token 的业务身份全局锁；
- 汇聚 Boss 元数据和审计，不默认复制原始正文；
- 完成多节点故障、版本漂移和脑裂测试。

W8 不得在 P0/P1 核心授权完成前启动生产实现。W0 应先保留合同，但不要让分布式控制面拖延单机试点。

---

## 19. Worktree、分支和合并顺序

建议分支：

```text
enterprise/integration
enterprise/w0-contracts
enterprise/w1-identity
enterprise/w2-authorization
enterprise/w3-session-sync
enterprise/w4-browser
enterprise/w5-runtime
enterprise/w6-ui
enterprise/w7-audit-qa
enterprise/w8-distributed-control-plane
```

执行规则：

- 每个工作流一个 Paseo Worktree，不在同一工作目录并行编辑。
- Worktree 从冻结的共同基线创建，记录 `git rev-parse HEAD`。
- 工作流之间通过接口合同和 commit 交接，不复制未提交文件。
- 未经总集成会话批准，不修改其他工作流独占路径。
- 发现必须跨域的改动时，先提交最小接口提案，由文件 Owner 合并。
- 不重新运行其他会话已经给出同一 commit 下的绿色测试。

合并顺序：

1. W0 合同和兼容测试；
2. W1 身份、W2 授权骨架；
3. W3 Session/Sync；
4. W4 Browser、W5 Runtime；
5. W6 UI；
6. W7 审计与对抗验收；
7. 总集成会话进行最终回归和发布 Gate。

P2 在 P1 发布基线冻结后，单独启动 W8；W8 先接本地适配器的合同测试，再连接两个以上真实节点，不回头改写员工资源语义。

任何工作流不得自己合并到 `enterprise/integration`。总集成会话审核合同、测试证据和冲突后统一合并。

---

## 20. 每个会话的标准启动提示词

创建并行会话时，把下面模板连同具体 W 编号发给它：

```text
你正在修改 Paseo 企业多人办公版，工作流为 W<编号>。

开始前必须完整阅读：
1. 仓库根目录 AGENTS.md；
2. ENTERPRISE_IMPLEMENTATION_MASTER.md；
3. 主规约在 W<编号> 中指定的源码和 docs。

产品基线不可改：单 Mac mini、单 macOS 用户、单 daemon、多人独立 principal、
Workspace/Agent/Browser Profile 隔离、共享 Provider 执行凭据、Boss 受控可见、全链路审计。
P0 虽是单节点，但所有新资源必须带 NodeContext，Identity/Placement/Lease/Audit 只能依赖可替换 Port，
不得写死单 daemon 假设；W8 才实现远程分布式控制面。

只修改 W<编号> 的独占路径。不要修改 session.ts、messages.ts 或其他热点文件，
除非它们明确归你所有。跨工作流需求写成接口提案交给总集成会话。

采用纵向 TDD：一条失败行为测试 → 最小实现 → 下一条测试。
不得仅做前端过滤；所有资源访问和所有出站数据都必须服务端 fail-closed。
不得输出、记录或持久化 Token、Cookie、密码和客户敏感正文。

完成时按主规约第 21 节交接。没有测试证据不得声称完成。
```

---

## 21. 统一交接格式

每个会话最终输出必须包含：

```markdown
## 工作流

Wn / commit / 基线 commit

## 完成的可观察行为

- 用户或 API 能观察到什么

## 修改文件

- 路径：修改原因

## 合同变化

- 新类型、接口、RPC、Feature Flag

## 测试证据

- 命令
- 完整通过/失败摘要
- 截图或日志路径（脱敏）

## 安全检查

- 认证来源
- 资源授权点
- 出站过滤点
- 日志脱敏

## 待集成调用点

- 由哪个工作流接入什么接口

## 已知风险 / DECISION_REQUIRED

- 不得隐藏未完成项
```

“代码写完”“理论上可用”“类型检查通过”都不能代替行为证据。

---

## 22. 测试规范

遵守 Paseo 当前规则：

- 纵向 TDD，测试用户可观察行为。
- 本地只运行修改相关的单个 Vitest 文件：

```bash
npx vitest run <path-to-test-file> --bail=1
```

- 不在本地运行全仓库测试，不运行全量 Playwright；全量交给 CI。
- 协议或 Client 改动先构建生产包再判断跨包错误：

```bash
npm run build:client
npm run build:server
```

- 每个实现会话完成前至少运行：

```bash
npm run typecheck
npm run lint
npm run format
npm run format:check
```

- UI 可失败操作必须有 Pending、Success、Failure 三态，并测试用户能看到的失败恢复。
- E2E 使用真实 daemon、真实网络和真实浏览器；单元测试使用注入端口和内存适配器，不用 `vi.mock` 掩盖核心行为。
- Provider 真实验证单独归入 `*.real.e2e.test.ts`，不能让缺少 Provider 凭据阻塞普通 CI。
- 禁止任何会话未经用户明确批准重启主 Paseo daemon 的 6767 端口；开发使用 Worktree 自己的 `PASEO_HOME` 和端口。

### 22.1 P0 强制安全用例

以下任一失败，版本不得进入试点：

1. 员工 A 无法列出、读取、更新、归档员工 B 的 Workspace/Agent。
2. A 猜中 B 的 `workspaceId`、`agentId`、`browserId` 仍得到统一的不可枚举拒绝。
3. A 订阅后把资源转给 B，A 立即停止收到后续事件。
4. A 不能通过 Timeline tail/before/after/gap recovery 得到 B 的消息。
5. A 不能通过 Agent search、Provider recent sessions、子 Agent 或 Tombstone 推断 B 的内容。
6. A 的下载 Token 不能下载 B 的文件；过期和使用后的 Token 失效。
7. 路径 `..`、符号链接和不存在子路径都不能逃出 Workspace Root。
8. A 退出后同一客户端登录 B，离线缓存、草稿、附件和 Tab 不显示 A 的内容。
9. 两个 Browser Profile 登录同一测试站的不同账号，Cookie/LocalStorage 互不可见，重启后各自保持。
10. 同一 Profile 两个 Agent 同时写时只有一个获得租约；等待方在原会话显示等待。
11. 不同 Profile 可以并行操作，Browser ID 不串路由。
12. Browser Host/daemon 崩溃重启后旧租约不继续生效。
13. 页面账号与 Profile 预期不一致时停止高风险动作。
14. 员工无法读取 daemon 配置、Grant、插件、Provider 凭据和全局 Terminal。
15. 公司 Codex/Claude Token 不出现在协议响应、Agent Snapshot、日志、审计和客户端缓存。
16. Boss 可看全员元数据；无内容 Grant 时无法读取正文。
17. Boss 有内容 Grant 时可读取正文，且产生审计事件。
18. 平台管理员能管理绑定但默认看不到正文。
19. break-glass Owner 使用一定产生高优先级审计。
20. 10 个模拟员工并发聊天 30 分钟，无跨 Principal 数据，daemon 无失控内存增长。

### 22.2 浏览器真实验证

扩展 Paseo Capture Harness，至少保留并新增：

```bash
npm run build:main --workspace=@getpaseo/desktop
PASEO_CAPTURE_HARNESS_GROUP=enterprise-browser-profiles \
  npm run capture-harness --workspace=@getpaseo/desktop
```

Harness 必须使用真实 Electron session/WebView，不用模拟 Cookie Store。

### 22.3 P2 分布式强制用例

P2 发布前必须在至少两台真实 Mac/Paseo daemon 和一个隔离测试控制面上证明：

1. 相同本地 `workspaceId` 出现在不同 Node 时，中央索引仍按 `(nodeId, localResourceId)` 正确区分。
2. 员工只登录一次，得到的 Node-bound Ticket 不能在另一 Node 使用。
3. Workspace/Agent 会话保持节点黏性，不被负载均衡器随机切换。
4. Node `draining` 后拒绝新放置，已有任务可以完成并可观察。
5. 同一 `businessIdentityId` 在 Node A/B 同时申请写租约时只有一个成功。
6. Node A 断网且租约过期后，Node B 获得更高 fencing token；A 恢复后不能继续写。
7. 管理面不可用时不接受新全局写租约，已有纯本地任务只在有效 Ticket/Grant 内继续。
8. Node 故障后的外部动作标记 `outcome_unknown`，不会在其他 Node 自动重放。
9. Node 审计断网缓存、恢复补传、`eventId` 去重和 sequence gap 报警正确。
10. Boss 能看多 Node 全局元数据，但未授权时不能读取任一 Node 正文。
11. 吊销 Principal/Node 后，各 Node 在规定时间内停止新请求和租约续期。
12. 新旧 daemon 版本并存时按 Capability 放置；不兼容 Node 不接任务且不泄漏全量数据。
13. 复制 `$PASEO_HOME` 制造重复 Node 身份时触发隔离，不静默选一个连接。
14. Browser Profile 迁移不自动复制 Cookie，业务身份全局锁在迁移窗口保持有效。
15. 控制面数据库恢复、节点重连和审计补传后，Placement/Lease 不出现双写。

---

## 23. 性能与容量目标

P0 不是“十个浏览器动作都在同一毫秒执行”，而是十名员工可以同时对话并稳定推进工作。

初始目标：

| 指标                        | P0 目标                             |
| --------------------------- | ----------------------------------- |
| 同时在线员工                | 10                                  |
| 同时活跃 Agent session      | 10，按 Provider/内存压测调整        |
| API/纯文件工作              | 可并行，受全局并发阈值保护          |
| 同一 Browser Profile 写操作 | 1                                   |
| 不同 Browser Profile 并行   | 压测后设上限，建议从 3 开始         |
| 同一无隔离原生 AppSlot      | 1                                   |
| 资源等待反馈                | 2 秒内在原会话可见                  |
| 授权拒绝                    | 不泄漏资源是否存在                  |
| daemon 重启恢复             | 不恢复过期租约，不串 Principal 缓存 |

记录以下数据再扩大并发：daemon RSS、每 Agent 子进程 RSS、Electron Renderer/WebView RSS、CPU、交换内存、文件描述符、Browser 操作 P95、租约等待时间和失败率。

内存压力处理顺序：限制并发 → 回收闲置 Agent/WebView → 限制 Browser Profile 同时激活数 → 扩容机器。不要通过关闭隔离减少进程/Session 来换性能。

---

## 24. 发布、回滚与上游同步

### 24.1 Feature Flag

企业能力默认关闭。启用配置示例：

```json
{
  "features": {
    "enterpriseMultiUser": {
      "enabled": true,
      "organizationId": "org_...",
      "nodeId": "nod_...",
      "managementMode": "standalone",
      "legacyRecords": "owner_only"
    }
  }
}
```

关闭企业能力应恢复原 Paseo 单用户行为，但不能删除企业数据或把企业 Workspace 暴露给普通无密码网络连接。

### 24.2 回滚

- 所有 Schema 新字段保持可选，旧程序可忽略。
- 企业注册表独立存储，不覆盖 Provider Session。
- 发布前备份 `$PASEO_HOME`，记录版本和配置 Hash。
- 回滚时先停止员工入口，再回滚二进制，最后以本机 Owner 验证旧模式。
- 浏览器多 Profile 回滚不能合并 Cookie；保留 Profile 数据，等待新版恢复。
- 分布式回滚先把 Node 设为 `draining`，停止新 Placement/Lease，再回滚节点；不得在有效全局租约期间把同一业务身份切到另一 Node。
- 管理控制面回滚不得回退 fencing token 或 Grant/Revocation 版本；这些计数必须单调前进。

### 24.3 跟随上游

- 维护 `upstream/main`，至少每周同步一次。
- 企业改动优先新增深模块，通过小接口接入，降低对 `session.ts` 和 `messages.ts` 的长期 Fork 成本。
- 每次上游同步重新跑协议兼容、资源入口清单和 P0 安全用例。
- 上游已实现同类能力时，优先迁移到上游抽象并删除重复层，不长期维护两个授权系统。
- 多节点滚动升级先升级控制面兼容层，再逐个 Drain/升级 Node；Placement 只选择声明完整 Capability 的节点。

---

## 25. 总集成会话的 Gate

总集成会话只有在以下条件全部满足时才能宣布阶段完成：

- 需求决定没有被各工作流改写。
- 所有新 RPC 和字段满足双向协议兼容。
- 每个资源入口在清单中有“授权点 + 出站过滤点 + 测试”。
- 没有前端专属安全判断。
- 没有未绑定 Workspace 的新企业 Agent。
- 所有新企业 Workspace/Profile/AppSlot/Audit 都带当前 `nodeId`，没有从路径或 ID 推导 Node。
- Identity、Placement、Lease、Audit 通过 Port 注入；P0 本地适配器没有渗入业务授权判断。
- 没有共享 `persist:paseo-browser` 用于两个员工业务身份。
- 没有员工可访问的全局 Terminal、Provider history 或 daemon 管理入口。
- P0 20 条安全用例全部有证据。
- 真实 Electron Profile 测试通过。
- 10 客户端并发压测达到约定时长，无串数据和失控资源增长。
- `typecheck`、`lint`、`format:check` 通过，CI 全量测试通过。
- QA 表列出 Web、Desktop macOS 以及受影响平台的覆盖范围。
- 审计中不含秘密或客户正文。
- 已生成备份、升级、回滚和紧急吊销操作手册。

P2 还必须满足：Node-bound Ticket、Placement、Drain、fencing token、审计补传和第 22.3 节分布式用例全部有证据；否则只能标记为单节点版本。

---

## 26. 不得由实现会话自行决定的开放项

下面事项如果用户/技术负责人没有补充，按本文默认值推进；需要改变时必须 ADR：

| 事项                       | v1 默认                                                                | 何时需要决定               |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| 身份方式                   | 个人访问令牌                                                           | 引入 OIDC/飞书 SSO 前      |
| Boss 正文权限              | 默认关闭，单独 Grant                                                   | 业务制度要求默认可见时     |
| 员工 Terminal              | 默认关闭                                                               | 明确的开发岗位开放前       |
| Browser 并发上限           | 从 3 个活跃 Profile 压测                                               | 压测后调整                 |
| 原生 App                   | 默认串行 AppSlot                                                       | App 自证支持隔离多实例时   |
| 网络访问                   | Provider 默认关闭，Browser/API 受控开放                                | 具体业务需要直连网络时     |
| P2 控制面形态              | 独立 Enterprise Management Plane；不把 Relay/Hub/多 Host 当成等价实现  | 开始 W8 前确定部署和数据库 |
| 管理面短时故障             | 新登录、Placement 和全局写租约失败关闭；有效 Ticket 内纯本地任务可继续 | SLA/业务连续性评审时       |
| Browser Profile 跨节点迁移 | 默认不复制 Cookie，在目标 Node 重新登录                                | 确有设备迁移需求时安全评审 |
| 外部商家                   | 不接入                                                                 | 独立 VM/节点方案完成后     |

实现会话不得因为“做起来方便”更改默认值。

---

## 27. 新目录启动清单

技术负责人创建专门目录后，按以下顺序启动：

1. Fork/clone Paseo，记录远端、版本和基线 commit。
2. 把本文放到仓库根目录并命名为 `ENTERPRISE_IMPLEMENTATION_MASTER.md`。
3. 在根 `AGENTS.md` 增加下方“企业项目强制入口”，确保新会话不会漏读主规约。
4. 新建 `docs/enterprise/decisions/` 和 `docs/enterprise/workstreams/`。
5. 建立 `enterprise/integration` 分支。
6. 由总集成会话先执行 W0，固化合同、测试 Fixture、`NodeContext` 和四个可替换 Port。
7. W0 合并后，从同一基线创建 W1–W7 Worktree。
8. 每个会话使用第 20 节标准提示词，只领取一个工作流。
9. 每次合并使用第 25 节 Gate，不按“代码量”判断完成。

追加到 `AGENTS.md` 的文字：

```markdown
## Enterprise multi-user project

Before making any change for the enterprise multi-user project, read
`ENTERPRISE_IMPLEMENTATION_MASTER.md` completely. Work only inside the assigned W0–W8
workstream and obey its exclusive file ownership. If a requested change crosses a workstream
boundary or conflicts with the master spec, stop that part, create a `DECISION_REQUIRED` ADR
draft, and hand it to the integration owner. No test evidence means the work is not complete.
```

在启动 W1–W7 前，总集成会话必须先运行并保存：

```bash
git rev-parse HEAD
git status --short
npm ci
npm run typecheck
npm run lint
```

基线本身失败时先记录为独立问题，不把它混进企业改造提交。

---

## 28. 下次最短执行路径

```text
放入主规约
  → W0 冻结协议和接口
  → W1 身份 + W2 资源授权
  → W3 封闭所有数据通道
  → W4 浏览器 Profile
  → W5 文件/Provider/AppSlot
  → W6 企业 UI
  → W7 对抗测试与审计
  → 10 人内部试点
  → W8 多节点控制面
  → 两台以上真实 Node 故障演练
```

如果时间被压缩，不能删减 W3 的实时流/缓存隔离，也不能删减 W4 的 Profile 隔离；同时不能删掉 `nodeId` 和本地 Port 抽象。可以延后的是远程控制面实现、SSO、原生应用多开、受控安装器完善和外部商家能力。

---

## 29. Paseo 基线依据

实施前应重新核对当前源码；本规约基于以下 Paseo 文件和合同：

- `AGENTS.md`
- `docs/architecture.md`
- `docs/data-model.md`
- `docs/permissions.md`
- `docs/protocol-compatibility.md`
- `docs/rpc-namespacing.md`
- `docs/testing.md`
- `docs/qa.md`
- `docs/timeline-sync.md`
- `docs/browser-capture-harness.md`
- `docs/file-observation.md`
- `docs/development.md`
- `docs/glossary.md`
- `public-docs/security.md`
- `public-docs/hub/security.md`
- `packages/server/src/server/websocket-server.ts`
- `packages/server/src/server/session.ts`
- `packages/server/src/server/auth.ts`
- `packages/server/src/server/authorization/**`
- `packages/server/src/server/workspace-registry.ts`
- `packages/server/src/server/agent/agent-storage.ts`
- `packages/server/src/server/browser-tools/**`
- `packages/desktop/src/features/browser-profile.ts`
- `packages/desktop/src/features/browser-webviews/**`
- `packages/app/src/timeline/**`

官方源码：<https://github.com/getpaseo/paseo>

---

## 30. AI 检索信息

- 类型：企业架构决策 + 实施主规约
- 领域：Paseo、多人 AI 办公、macOS、Agent 平台
- 关键词：Paseo 魔改、多员工会话隔离、Workspace Owner、Boss 可见、浏览器 Profile、Cookie 隔离、单 Mac mini、共享 Codex、资源授权、审计、并行 Worktree、分布式 Paseo、Node Registry、Placement、fencing token
- 触发问题：如何让 10 个员工通过同一个 Paseo daemon 与 AI 办公；如何保证聊天、文件和浏览器登录态不串；如何让 Boss 查看全局；如何组织多个 AI 会话并行修改 Paseo；后续如何统一管理多台 Mac 和多个 Paseo daemon
