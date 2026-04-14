# agent-first 能力矩阵

目标：记录当前 `weapp-dev-mcp` fork 面向 agent 主开发 / 主调试 / 主测试的能力状态。当前主计划已收口，本文件只保留状态表和边界结论。

## 状态定义

- `已完成`：当前 fork 已具备，或已在文档 / 测试项目中验证通过
- `保留`：方向成立，但不进入当前批次
- `不做`：当前官方能力受限、范围外，或用户已明确不纳入计划

## 当前总览

| 主题 | 状态 | 优先级 | 说明 |
| --- | --- | --- | --- |
| 连接建立与自动拉起 | 已完成 | P0 基线 | 已支持 `mp_ensureConnection`、自动连接、自动拉起 |
| 日志跨进程持久化与过滤 | 已完成 | P0 基线 | 已支持重连后日志恢复、过滤与简单去重 |
| 页面等待能力 | 已完成 | P0 基线 | 已支持 `page_waitRoute`、`page_waitElementGone` |
| 真实交互增强 | 已完成 | P0 基线 | 已支持 `element_touch`、`element_swipe` |
| `mp_healthCheck` | 已完成 | P0 基线 | 已支持连接、页面、日志状态聚合自检 |
| `mp_recoverConnection` | 已完成 | P0 基线 | 已支持显式恢复流程与恢复前后摘要 |
| 稳定选择器规范 | 已完成 | P0 基线 | 已产出 `qa-*` 规范，并在本机测试小程序完成最小落地验证 |
| `mp_getLogs` 状态增强 | 已完成 | P0 基线 | 已显式返回 `listenerAttached`、`lastLogAt`、`sessionId` 等状态 |
| 断言型工具 | 已完成 | P1 基线 | 已支持 route / visible / text / count / data 结构化断言 |
| 页面结构快照 | 已完成 | P1 基线 | 已支持 `page_snapshot` 聚合 route、query、指定 data 与元素摘要 |
| `mp_runScenario` | 已完成 | P2 基线 | 已支持最小步骤编排：navigate、tap、input、waitRoute、expect、snapshot、getLogs、screenshot |
| 回归测试报告产物 | 已完成 | P2 基线 | 已支持最小 markdown 报告输出，并可带截图路径 |
| 专用测试小程序 | 已完成 | P2 基线 | 当前本机测试小程序已覆盖导航、输入、日志、截图等链路 |
| 编译 / 加载状态读取 | 保留 | P1 | 需要额外接 DevTools CLI / IDE 状态通道 |
| 业务项目 debug / test 入口 | 不做 | 范围外 | 当前用户已明确不纳入本批计划 |
| 系统原生授权弹窗直接自动化 | 不做 | 边界 | 官方能力有限，优先使用 `mockWxMethod` 等绕开 |

## 当前结论

- MCP 侧 agent-first 主计划已完成。
- 业务项目 debug / test 入口不再作为当前任务推进。
- 编译 / 加载状态读取保持保留项，等有明确 DevTools 状态通道后再评估。
- 后续如果继续扩展，应优先基于真实使用痛点补工具，而不是继续堆点击型原子能力。
