# `mp_healthCheck` 规格说明

目标：让 agent 在开始调试、测试或恢复动作之前，一次性拿到当前自动化环境的健康状态，而不是依赖临时试错。

## 为什么需要它

当前 agent 虽然可以通过 `mp_ensureConnection`、`mp_currentPage`、`mp_getLogs` 等工具逐步拼出环境状态，但缺点也很明显：

- 起手成本高，需要多次调用才能判断是否可用
- 容易漏掉日志监听、项目路径、连接模式等隐含状态
- 当连接异常时，agent 容易盲重试，而不是先判断问题属于哪一层

`mp_healthCheck` 的价值，是把这些零散判断收敛成一次显式自检。

## 适用场景

- 新 agent / 新会话刚进入项目
- 刚执行完 `mp_ensureConnection`
- 页面操作连续失败后，想区分“页面问题”还是“连接问题”
- 执行恢复流程后，想确认当前是否真正恢复

## 返回目标

工具应该尽量回答以下问题：

1. DevTools 当前是否在线
2. `ws://localhost:9420` 是否可连
3. 当前是否已连上 automator
4. 当前项目路径是什么
5. 当前页面路由是什么
6. 当前连接是否处于需要恢复的状态
7. 日志监听是否已绑定
8. 最近一次日志时间是什么时候
9. 当前连接模式、`projectPath`、`wsEndpoint` 分别是什么

## 建议输入

```json
{
  "includePage": true,
  "includeLogs": true,
  "attemptReconnect": false
}
```

### 字段说明

- `includePage`
  - 是否读取当前页面状态
  - 默认 `true`
- `includeLogs`
  - 是否附带日志状态信息
  - 默认 `true`
- `attemptReconnect`
  - 是否在检测到明显断链时尝试做一次轻量恢复
  - 默认 `false`
  - 只有明确需要时才开启，避免把“自检”做成“副作用恢复”

## 建议输出

```json
{
  "ok": true,
  "summary": "connected",
  "devtoolsOnline": true,
  "wsReachable": true,
  "automatorConnected": true,
  "needsRecovery": false,
  "connectionMode": "existing-session",
  "projectPath": "/Users/liting/Desktop/微信小程序动效",
  "wsEndpoint": "ws://localhost:9420",
  "currentRoute": "pages/lab/lab",
  "listenerAttached": true,
  "lastLogAt": 1770000000000,
  "logStoreMode": "persisted",
  "sessionId": "auto-generated-or-manager-session-id",
  "checkedAt": 1770000001234,
  "warnings": [],
  "errors": []
}
```

## 字段定义

- `ok`
  - 整体是否可继续执行自动化流程
- `summary`
  - 给 agent 的简短状态摘要
  - 建议枚举：`connected`、`degraded`、`disconnected`、`needs-reconnect`
- `devtoolsOnline`
  - 微信开发者工具是否在线
- `wsReachable`
  - `wsEndpoint` 是否可达
- `automatorConnected`
  - 当前 automator 会话是否已经建立
- `needsRecovery`
  - 当前是否建议调用恢复工具
- `connectionMode`
  - 当前连接模式，例如：`existing-session`、`auto-launch`、`reconnected`
- `projectPath`
  - 当前生效项目路径
- `wsEndpoint`
  - 当前生效 WebSocket 端点
- `currentRoute`
  - 当前页面路由
- `listenerAttached`
  - 日志监听是否处于已绑定状态
- `lastLogAt`
  - 最近一次日志时间戳
- `logStoreMode`
  - 日志存储模式，例如 `memory` 或 `persisted`
- `sessionId`
  - 当前会话标识，便于排查跨会话问题
- `checkedAt`
  - 本次健康检查时间
- `warnings`
  - 警告列表
- `errors`
  - 错误列表

## 建议判定逻辑

### 1. `ok = true`

满足以下条件时：

- DevTools 在线
- `wsEndpoint` 可达
- automator 已连接
- 当前项目路径可确认
- 若要求读取页面，则当前 route 可正常获取
- 若要求读取日志，则监听状态可确认

### 2. `ok = false` 但仍可继续观察

例如：

- 已连接，但 `listenerAttached=false`
- 已连接，但当前 route 获取失败
- 已连接，但项目路径不明确

此时：

- `summary` 应为 `degraded`
- `needsRecovery` 可以为 `true`
- `warnings` 中应明确指出退化原因

### 3. `ok = false` 且应优先恢复

例如：

- `wsReachable=false`
- `automatorConnected=false`
- DevTools 未在线

此时：

- `summary` 应为 `disconnected` 或 `needs-reconnect`
- `needsRecovery=true`
- `errors` 中应给出可直接执行的恢复提示

## 与现有工具的关系

- `mp_ensureConnection`
  - 负责“建立连接 / 保证连接存在”
- `mp_healthCheck`
  - 负责“告诉 agent 当前是不是健康”
- `mp_recoverConnection`
  - 负责“按标准流程恢复异常状态”

三者关系建议如下：

1. 新会话先 `mp_ensureConnection`
2. 再 `mp_healthCheck`
3. 若 `needsRecovery=true`，调用 `mp_recoverConnection`
4. 恢复后再次 `mp_healthCheck`

## 错误与警告建议

### `warnings` 示例

```json
[
  "listener not attached",
  "current route unavailable",
  "project path inferred from persisted state"
]
```

### `errors` 示例

```json
[
  "devtools offline",
  "ws endpoint unreachable",
  "automator session missing"
]
```

## 实现建议

### 优先级

第一批建议只做只读型健康检查，不带恢复副作用。

### 数据来源建议

- 连接状态：`WeappAutomatorManager` 当前连接与 endpoint 状态
- 项目路径：当前连接状态或持久化状态
- 页面路由：当前页面信息
- 日志状态：当前日志监听绑定信息与持久化日志状态
- 会话标识：manager 内部 session 标识或衍生唯一值

### 第一版可接受范围

第一版不要求完美覆盖所有异常，只要先稳定回答下面几个核心问题就足够：

- 能不能继续自动化
- 要不要恢复
- 当前项目是不是目标项目
- 当前页面是不是 agent 预期页面
- 日志监听是不是健康

## 后续演进方向

`mp_healthCheck` 稳定后，可以把以下信息逐步并入：

- 最近一次恢复时间
- 最近一次连接错误摘要
- 最近一次页面切换时间
- 最近一次 screenshot / data 读取成功时间
- 保留中的编译 / 加载状态摘要
