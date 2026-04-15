# 文档导航

这份导航页的目标不是堆文档列表，而是让新接手 `weapp-agent-mcp` 的人或 agent 立刻知道：

- 先看什么
- 遇到问题去哪里查
- 哪些文档是“怎么用”
- 哪些文档是“做什么”
- 哪些文档是“官方底层到底支不支持”

## 推荐阅读顺序

### 1. 仓库总入口

- `README.md`

适合回答：

- 这个仓库是什么
- 怎么构建 / 运行
- 怎么在 MCP 客户端里接入

### 2. agent 使用方式

- `docs/weapp-dev-agent-guide.md`

适合回答：

- agent 应该怎么起手
- 连接失败时怎么恢复
- 日志、`data`、`evaluate`、等待能力怎么用

### 3. agent-first 规划总表

- `docs/roadmap/agent-first-capability-matrix.md`

适合回答：

- 当前已经做了什么
- 现在最该补什么
- 哪些能力先保留
- 哪些边界当前不做

### 4. 规范文档

当前保留的规范文档：

- `docs/specs/stable-selectors.md`

适合回答：

- 业务项目应遵循什么稳定选择器规范
- agent 应优先依赖哪些 selector

### 5. 官方底层能力索引

- `docs/official/wechat-devtools-automator/README.md`

适合回答：

- 某个需求是不是官方 `miniprogram-automator` 就支持
- 当前是“只差 MCP 封装”还是“官方边界受限”

### 6. 历史改动

- `CHANGELOG.md`

适合回答：

- 这个项目近期做过哪些关键增强
- 当前文档和代码为什么是这个形态

## 按问题查资料

### 我第一次接手这个仓库

按这个顺序看：

1. `README.md`
2. `docs/weapp-dev-agent-guide.md`
3. `docs/roadmap/agent-first-capability-matrix.md`

### 我想确认当前能力状态

先看：

- `docs/roadmap/agent-first-capability-matrix.md`
- `CHANGELOG.md`

### 我不确定官方底层有没有这个能力

先看：

- `docs/official/wechat-devtools-automator/README.md`

再按主题进入：

- 连接 / 启动：`automator.txt`
- 小程序全局能力：`miniprogram.txt`
- 页面能力：`page.txt`
- 元素能力：`element.txt`
- 真机自动化：`remote.txt`
- 边界与限制：`faq.txt`

### 我想知道日志为什么为空

先看：

- `docs/weapp-dev-agent-guide.md`
- `CHANGELOG.md`

### 我想知道当前项目为什么这样设计

先看：

- `CHANGELOG.md`
- `docs/roadmap/agent-first-capability-matrix.md`

## 当前文档分层

### A. 使用层

- `README.md`
- `docs/weapp-dev-agent-guide.md`

用途：告诉你怎么接入、怎么起手。

### B. 规划层

- `docs/roadmap/agent-first-capability-matrix.md`

用途：告诉你当前最该做什么，不该优先做什么。

### C. 规范层

- `docs/specs/stable-selectors.md`

用途：告诉你业务页面应如何提供稳定 selector。

### D. 官方对照层

- `docs/official/wechat-devtools-automator/*`

用途：告诉你底层官方 API 原始能力边界。

### E. 变更记录层

- `CHANGELOG.md`

用途：告诉你这个项目近期改了什么，以及为什么改。

## 当前建议

如果后续还要继续补文档，建议保持同样结构：

- 路线图放 `docs/roadmap/`
- 规格文档放 `docs/specs/`
- 使用文档放 `docs/`
- 官方对照文档放 `docs/official/`

这样新 agent 进入项目时，不需要猜“应该先看哪份文档”。
