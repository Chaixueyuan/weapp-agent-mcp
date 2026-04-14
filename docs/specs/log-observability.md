# 日志可观测性规格说明

目标：让 agent 能明确区分“页面没有日志输出”和“日志监听链路异常”，并基于结构化状态决定下一步是继续调试、重新触发动作，还是先恢复连接。

## 为什么需要它

日志对 agent 很重要，但日志本身不是唯一真相源。

如果日志能力没有结构化状态，agent 很容易误判：

- `count=0` 就以为页面没有执行到
- 看见空日志就开始盲重试
- 不知道当前监听是否已挂上
- 不知道日志是内存态还是持久化态
- 不知道日志是不是来自当前会话

所以 `mp_getLogs` 除了返回日志内容，还应该返回“日志链路当前是否健康”的状态信息。

## 目标问题

日志相关工具应该尽量回答这些问题：

1. 当前日志监听是否已绑定
2. 最近一次日志是什么时候到达的
3. 当前日志存储模式是什么
4. 当前日志是否与本次会话相关
5. 当前为空日志，是“真的没有日志”还是“监听链路异常”

## 建议状态字段

建议在 `mp_getLogs` 或相关健康检查结果中加入以下字段：

- `listenerAttached`
- `lastLogAt`
- `logStoreMode`
- `sessionId`
- `logCount`
- `recentTypes`
- `sourceProjectPath`

## 字段定义

### `listenerAttached`

- 类型：`boolean`
- 含义：当前控制台 / 异常监听是否已绑定
- 用途：区分“没有日志”与“根本没在听”

### `lastLogAt`

- 类型：`number | null`
- 含义：最近一次日志写入时间戳
- 用途：判断日志链路是否新鲜

### `logStoreMode`

- 类型：`string`
- 建议枚举：`memory`、`persisted`
- 含义：当前日志来源于进程内存还是持久化状态
- 用途：帮助 agent 理解跨进程场景下日志为何仍然存在

### `sessionId`

- 类型：`string | null`
- 含义：当前日志所属的会话标识
- 用途：区分是否为当前连接上下文产生的日志

### `logCount`

- 类型：`number`
- 含义：当前匹配条件下返回的日志条数
- 用途：比只看数组长度更显式

### `recentTypes`

- 类型：`string[]`
- 含义：最近一批日志中出现过的类型，如 `log`、`error`、`warn`
- 用途：帮助 agent 快速判断日志性质

### `sourceProjectPath`

- 类型：`string | null`
- 含义：这批日志关联的项目路径
- 用途：排查切项目后日志混淆问题

## 建议输出示例

```json
{
  "ok": true,
  "logCount": 3,
  "listenerAttached": true,
  "lastLogAt": 1770000000000,
  "logStoreMode": "persisted",
  "sessionId": "session-abc",
  "sourceProjectPath": "/Users/liting/Desktop/微信小程序动效",
  "recentTypes": ["log", "warn"],
  "logs": [
    {
      "type": "log",
      "message": "[mcp-test] lab:count 1",
      "timestamp": 1770000000000
    }
  ],
  "warnings": [],
  "errors": []
}
```

## 状态判断建议

### 情况 1：监听健康，但当前没有日志

条件示例：

- `listenerAttached=true`
- `lastLogAt` 存在或近期更新过
- `logCount=0`

建议解释：

- 当前过滤条件下没有匹配日志
- 或页面动作尚未触发日志输出

此时 agent 应优先：

1. 确认动作是否真实发生
2. 核对 route、元素状态或截图
3. 再决定是否重现动作

### 情况 2：监听异常

条件示例：

- `listenerAttached=false`
- `logCount=0`

建议解释：

- 当前不能把“没有日志”当成“页面没有输出”
- 应优先恢复监听链路

此时 agent 应优先：

1. 调用 `mp_healthCheck`
2. 必要时调用 `mp_recoverConnection`

### 情况 3：日志存在，但不是当前会话

条件示例：

- `sessionId` 与当前会话不一致
- `lastLogAt` 很旧

建议解释：

- 可能拿到的是历史持久化日志
- 不应直接把它当成当前动作的结果

此时 agent 应结合：

- 当前 route
- 最近动作时间
- 过滤条件 `since`

再做判断。

## 与 `mp_getLogs` 的关系

当前 `mp_getLogs` 已具备：

- 跨进程日志持久化
- 重连后重新绑定日志监听
- 简单去重
- 按 `type`、`contains`、`since`、`limit` 过滤

下一步建议补的是“状态信息显式返回”，而不是继续只堆过滤参数。

## 推荐判断顺序

建议 agent 在日志调试时使用如下顺序：

1. 先确认动作已真实发生
   - 看 route
   - 看元素状态
   - 看截图
2. 再取日志
3. 若日志为空，先看：
   - `listenerAttached`
   - `lastLogAt`
   - `sessionId`
4. 若状态异常，再走恢复流程

## 第一版实现建议

第一版建议先补以下四个字段：

- `listenerAttached`
- `lastLogAt`
- `logStoreMode`
- `sessionId`

这是当前最直接能提升 agent 自诊断能力的最小集合。

## 后续演进方向

后续可继续补：

- `lastExceptionAt`
- `lastListenerBindAt`
- `listenerSource`
- `dedupDroppedCount`
- `persistedLogFile` 或状态来源摘要

但这些都可以在第一版之后再做。
