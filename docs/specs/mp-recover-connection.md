# `mp_recoverConnection` 规格说明

目标：把连接异常后的恢复流程，从“人工经验”和“agent 临场猜测”，变成一个显式、可重复、可观察的工具。

## 为什么需要它

当前连接问题通常不是单一故障，而是几种状态混在一起：

- DevTools 没在线
- `ws://localhost:9420` 不可达
- automator 会话断开
- 日志监听没有重新绑定
- 项目路径没有选中或已经漂移

如果没有专门的恢复工具，agent 往往会：

- 盲目重复 `mp_ensureConnection`
- 在同样参数下重试很多次
- 误把“日志为空”当成“页面没有输出”
- 恢复后也不知道到底有没有恢复成功

`mp_recoverConnection` 的目的，就是收敛一条标准恢复流程，并在结尾直接返回恢复后的健康状态。

## 适用场景

- `mp_healthCheck` 返回 `needsRecovery=true`
- 页面操作连续失败，怀疑当前连接已失效
- `mp_getLogs` 长时间为空，且怀疑监听异常
- 更换项目或重新打开 DevTools 后，想恢复会话

## 工具目标

工具应该尽量完成以下事情：

1. 判断当前问题属于哪一层
2. 必要时重连当前 automator 会话
3. 必要时重新绑定日志监听
4. 必要时重新选择 / 连接目标项目
5. 输出恢复后的健康状态，而不是只返回“已执行恢复”

## 建议输入

```json
{
  "reconnect": true,
  "rebindLogs": true,
  "ensureProject": true,
  "projectSelection": "auto",
  "wsEndpoint": "ws://localhost:9420"
}
```

### 字段说明

- `reconnect`
  - 是否允许主动重建 automator 会话
  - 默认 `true`
- `rebindLogs`
  - 是否尝试重绑日志监听
  - 默认 `true`
- `ensureProject`
  - 是否在恢复时确认目标项目
  - 默认 `true`
- `projectSelection`
  - 项目选择策略
  - 建议支持：`auto`、`last-used`、明确路径
- `wsEndpoint`
  - 指定恢复时使用的端点
  - 默认取当前配置值

## 建议输出

```json
{
  "ok": true,
  "recovered": true,
  "actions": [
    "reconnected automator",
    "rebound console listener",
    "reused persisted project path"
  ],
  "before": {
    "automatorConnected": false,
    "listenerAttached": false,
    "projectPath": null
  },
  "after": {
    "automatorConnected": true,
    "listenerAttached": true,
    "projectPath": "/Users/liting/Desktop/微信小程序动效",
    "currentRoute": "pages/index/index"
  },
  "health": {
    "ok": true,
    "summary": "connected",
    "needsRecovery": false
  },
  "warnings": [],
  "errors": []
}
```

## 返回字段定义

- `ok`
  - 本次恢复流程是否成功完成
- `recovered`
  - 是否真正从异常状态恢复到可用状态
- `actions`
  - 本次实际执行过的恢复动作列表
- `before`
  - 恢复前关键状态摘要
- `after`
  - 恢复后关键状态摘要
- `health`
  - 恢复后再次执行的健康检查摘要
- `warnings`
  - 恢复过程中的非致命问题
- `errors`
  - 恢复失败原因

## 建议恢复顺序

### 1. 先拿当前状态

恢复动作前，应先收集最小状态：

- DevTools 是否在线
- `wsEndpoint` 是否可达
- automator 是否已连接
- 当前项目路径是否存在
- 日志监听是否已绑定

### 2. 再决定是否重连

如果出现以下情况，可执行重连：

- `automatorConnected=false`
- 当前 session 明显失效
- 当前页面信息无法获取且连接异常明确

### 3. 再决定是否重绑日志

如果出现以下情况，可执行日志重绑：

- `listenerAttached=false`
- 会话恢复后日志状态未恢复
- 近期多次操作后日志仍持续为空

### 4. 必要时重新确认项目

如果出现以下情况，应重新确认项目：

- 当前项目路径为空
- 恢复后项目不是预期项目
- DevTools 重启后丢失项目选择状态

### 5. 最后必须返回健康状态

恢复工具不应只告诉 agent “做了什么”，更要告诉 agent：

- 现在能不能继续做自动化
- 当前项目是不是对的
- 当前页面和日志状态是不是健康

## 与其他工具的关系

- `mp_ensureConnection`
  - 更偏向连接建立 / 确保连接存在
- `mp_healthCheck`
  - 更偏向无副作用判断状态
- `mp_recoverConnection`
  - 更偏向带标准动作的恢复

建议工作流：

1. `mp_ensureConnection`
2. `mp_healthCheck`
3. 若 `needsRecovery=true`，调用 `mp_recoverConnection`
4. 恢复后再次 `mp_healthCheck`

## 错误分层建议

### 可恢复错误

- automator session missing
- console listener missing
- persisted project missing but projects available

### 不可直接恢复错误

- DevTools offline
- `wsEndpoint` 不可达且无法自动拉起
- 指定项目不存在
- 用户登录态失效导致 IDE 无法正常进入项目

对于不可直接恢复错误，应在 `errors` 中给出明确原因，而不是继续重试。

## 第一版实现建议

第一版建议只覆盖最常见的三类恢复动作：

1. reconnect session
2. rebind log listener
3. ensure target project

不要一开始把所有特殊分支都塞进去。

## 后续演进方向

后续可增加：

- 更细的失败原因分类
- 最近一次恢复时间与恢复耗时
- 恢复步骤开关化
- 恢复动作与 `mp_healthCheck` 的统一状态模型
