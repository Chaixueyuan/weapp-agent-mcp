# agent 接手指南

目标：让新接手这个仓库的 agent，在最短路径内搞清楚三件事：

1. 这个仓库是什么
2. 先看哪些文档和代码
3. 遇到某类问题时应该去哪里查

## 一句话理解这个仓库

`weapp-dev-mcp` 是一个通过微信开发者工具自动化能力控制小程序页面的 MCP 服务。

对 agent 来说，它不是普通资料库，而是一套可以直接执行页面调试、交互、截图、日志读取和运行时检查的工具链。

## 新 agent 的推荐阅读顺序

### 第 1 步：先看仓库总入口

- `README.md`

目的：

- 确认项目是什么
- 确认本地构建和运行方式
- 确认 MCP 配置方式
- 确认默认 `wsEndpoint`

### 第 2 步：再看 agent 使用手册

- `docs/weapp-dev-agent-guide.md`

目的：

- 知道推荐起手顺序
- 知道哪些工具优先用
- 知道日志、`data`、`evaluate`、等待能力分别怎么用
- 避免上来就盲点页面或盲重试

### 第 3 步：再看能力矩阵

- `docs/roadmap/agent-first-capability-matrix.md`

目的：

- 知道当前 fork 已做到了什么
- 知道下一步优先做什么
- 知道哪些项是保留项或明确边界

### 第 4 步：如需实现新工具，再看规格文档

当前规格文档：

- `docs/specs/mp-health-check.md`
- `docs/specs/mp-recover-connection.md`
- `docs/specs/log-observability.md`
- `docs/specs/stable-selectors.md`

目的：

- 直接按 spec 实现工具或规范
- 避免重复发明字段和状态模型

### 第 5 步：如需查底层官方能力，再看官方文档索引

- `docs/official/wechat-devtools-automator/README.md`

目的：

- 快速确认某个能力是不是官方原生就支持
- 判断当前需求是“只差 MCP 封装”还是“官方本身做不到”

### 第 6 步：最后再读代码

建议顺序：

1. `src/index.ts`
2. `src/prompts.ts`
3. `src/weappClient.ts`
4. `src/tools/application.ts`
5. `src/tools/page.ts`
6. `src/tools/element.ts`

目的：

- 先理解 server instructions 和 prompt 层
- 再理解连接、日志、持久化与 timeout 核心逻辑
- 最后再看工具暴露层

## 遇到问题时怎么查

### 1. 不知道怎么起手用这个 MCP

先看：

- `docs/weapp-dev-agent-guide.md`

重点看：

- 推荐起手顺序
- 推荐与不推荐
- 页面调试 / data 调试 / 日志调试工作流

### 2. 不知道当前优先做什么能力

先看：

- `docs/roadmap/agent-first-capability-matrix.md`

重点看：

- `P0 / P1 / P2 / P3`
- `已完成 / 待做 / 保留 / 不做`

### 3. 想实现 `healthCheck` 或恢复能力

先看：

- `docs/specs/mp-health-check.md`
- `docs/specs/mp-recover-connection.md`
- `docs/specs/log-observability.md`

### 4. 页面定位总是不稳

先看：

- `docs/specs/stable-selectors.md`

重点结论：

- 业务项目要补稳定 `qa-*` selector
- 不要主要依赖文本、样式 class 或层级结构

### 5. 不确定某个能力官方到底支不支持

先看：

- `docs/official/wechat-devtools-automator/README.md`

再按问题进入：

- 连接 / 启动：`automator.txt`
- 小程序全局能力：`miniprogram.txt`
- 页面能力：`page.txt`
- 元素能力：`element.txt`
- 真机能力：`remote.txt`
- 边界 / FAQ：`faq.txt`

### 6. 不知道日志为什么为空

先看：

- `docs/weapp-dev-agent-guide.md`
- `docs/specs/log-observability.md`

再看代码：

- `src/weappClient.ts`
- `src/tools/application.ts`

### 7. 不知道最近这个 fork 改过什么

先看：

- `CHANGELOG.md`

## 当前推荐的认知顺序

对于新 agent，最重要的顺序不是“先读完所有代码”，而是：

1. 先知道怎么用
2. 再知道当前缺什么
3. 再知道官方底层支不支持
4. 最后才深入代码实现

## 当前最重要的结论

如果你要继续推进 agent-first 路线，当前最优先的不是继续堆更多点击能力，而是：

- `mp_healthCheck`
- `mp_recoverConnection`
- 稳定选择器规范
- 日志状态可观测性
- 断言与结构化报告
