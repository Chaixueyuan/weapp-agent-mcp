# Changelog

本文件记录当前 `weapp-dev-mcp` fork 近期完成的关键改动，重点面向后续交接与维护，而不是面向发布营销文案。

## 2026-04-14

### 概览

当前 fork 已从“能连通基础 automator”推进到“更适合 agent 稳定调试”的状态，重点补的是：
- 连接与自动拉起稳定性
- `data` 读取超时保护
- 日志恢复与过滤
- 页面等待能力
- 真实触摸/滑动交互
- 连接健康检查与标准恢复能力
- 日志状态可观测性增强
- 本地化官方文档与 agent 使用手册
- README 与当前 fork 实际使用方式对齐

---

## 已完成改动

### 1. 恢复 MCP 工具暴露并升级版本

相关提交：
- `45a9177` `fix: restore MCP tool exposure in opencode and bump to 0.2.2`

说明：
- 修复了 MCP 工具暴露问题
- 当前版本号提升到 `0.2.2`

意义：
- 确保客户端侧能正常看到并调用工具
- 为后续 fork 增强提供稳定基线

---

### 2. 修复 Zod 4 schema 导出兼容问题

相关提交：
- `3261aa5` `fix: remove z.undefined() from argsSchema to fix zod 4 toJSONSchema error`

说明：
- 去掉了会导致 `toJSONSchema` 出错的 `z.undefined()`

意义：
- 降低 schema 导出/工具注册阶段的兼容性问题
- 避免 MCP 客户端侧因 schema 转换失败而不可用

---

### 3. 增强 automator 稳定性与真实交互能力

相关提交：
- `3461b98` `fix: improve automator stability and touch tooling`

核心内容：
- 增加 `withRequestTimeout()`，为可能卡住的请求提供超时保护
- `page_getData`、`element_getData`、`mp_currentPage(withData=true)` 接入 timeout 保护
- 改善控制台日志重绑与简单去重逻辑
- 支持更稳定的自动连接/重连流程
- 新增真实交互工具：
  - `element_touch`
  - `element_swipe`
- 已提供 `element_getBoundingClientRect`

关键文件：
- `src/weappClient.ts`
- `src/tools/application.ts`
- `src/tools/page.ts`
- `src/tools/element.ts`

意义：
- agent 在读取 `data` 卡住时不会整轮阻塞
- 重连后日志能力更可用
- 可以覆盖比单纯 `tap` 更复杂的真实手势交互

---

### 4. README 改为面向当前 fork 的实际使用方式

相关提交：
- `618df0d` `docs: align README with local fork workflow`

核心内容：
- README 默认接入方式从“上游 npm 包”调整为“本地 fork 构建产物”
- MCP 配置示例改为直接指向本地 `dist/index.js`
- 权限示例改为 `mcp__weapp-dev__...`
- README 已纳入 fork 已有增强能力说明，如：
  - `mp_evaluate`
  - 本地构建使用方式
- 删除/修正了一些不再适合当前 fork 的旧表述

关键文件：
- `README.md`

意义：
- 降低新维护者或新 agent 被 README 误导的概率
- 让仓库文档和本机实际接入方式保持一致

---

### 5. 补齐页面等待能力与日志过滤能力

相关提交：
- `767d8dc` `feat: add lightweight wait helpers and local docs`

#### 新增页面等待工具

新增：
- `page_waitElementGone`
- `page_waitRoute`

位置：
- `src/tools/page.ts`

用途：
- `page_waitElementGone`：等待 loading、toast、弹层等元素消失
- `page_waitRoute`：等待页面路径变为目标值，适合确认导航真正完成

#### 增强日志工具

增强：
- `mp_getLogs` 新增过滤参数：
  - `type`
  - `contains`
  - `since`
  - `limit`

位置：
- `src/tools/application.ts`

意义：
- 避免只能“全量抓日志”
- 让 agent 更容易围绕特定问题做最小日志定位
- 页面状态等待不再只能依赖固定 `waitTimeout`

---

### 6. 本地落库官方 automator 文档

相关提交：
- `767d8dc` `feat: add lightweight wait helpers and local docs`

新增文档：
- `docs/official/wechat-devtools-automator/README.md`
- `docs/official/wechat-devtools-automator/automator.txt`
- `docs/official/wechat-devtools-automator/miniprogram.txt`
- `docs/official/wechat-devtools-automator/page.txt`
- `docs/official/wechat-devtools-automator/element.txt`
- `docs/official/wechat-devtools-automator/remote.txt`
- `docs/official/wechat-devtools-automator/example.txt`
- `docs/official/wechat-devtools-automator/faq.txt`
- `docs/README.md`

说明：
- 已将微信官方 `miniprogram-automator` 相关页面抓取为本地文本和索引
- 当前仓库内已可离线查官方 API 结构和 FAQ 重点

意义：
- 后续补功能时，不必每次重新联网查官方文档
- 便于对照“官方底层有，但 fork 尚未暴露”的能力

---

### 7. 修复 `mp_getLogs` 跨进程丢日志问题

说明：
- 排查确认 `mp_getLogs` 之前只读取 `WeappAutomatorManager` 进程内内存中的 `consoleLogs`
- 在使用 `inspector --cli node dist/index.js` 或其他按次启动 MCP 进程的场景下，日志监听虽然触发，但下一次调用读取日志时进程已变化，导致历史日志丢失
- 已改为将 `consoleLogs` 与项目选择状态一起持久化到配置文件，再由 `mp_getLogs` 读取

关键文件：
- `src/weappClient.ts`
- `src/tools/application.ts`

验证结果：
- 现在可稳定读到真实页面日志，例如：`[mcp-test] detail:backHome`
- 该修复对“本地构建产物接入 Claude Code”与“使用 inspector/脚本逐次调用工具”两类场景都更稳

意义：
- 避免把“日志为空”误判为“小程序未输出日志”
- 解决 tool 逐次启动或重连后日志状态丢失的问题
- 让 `mp_getLogs` 真正适合作为调试与交接链路的一部分

---

### 8. 增加连接健康检查、标准恢复工具与日志状态增强

说明：
- 新增 `mp_healthCheck`，统一返回连接、页面、项目和日志监听的健康状态
- 新增 `mp_recoverConnection`，把标准恢复顺序显式化，并返回恢复前后摘要
- `mp_getLogs` 现在除了日志内容，还会返回日志链路状态信息，如：
  - `listenerAttached`
  - `lastLogAt`
  - `lastListenerBindAt`
  - `logStoreMode`
  - `sessionId`
  - `sourceProjectPath`

关键文件：
- `src/weappClient.ts`
- `src/tools/application.ts`
- `src/prompts.ts`
- `src/index.ts`

意义：
- agent 可以先判断“当前是否健康”，再决定是调试还是恢复
- agent 可以区分“没有日志”与“日志监听异常”
- 连接失败后不必再靠人工经验决定恢复顺序

---

### 10. 增加页面断言工具

相关提交：
- `7bfc6b1` `feat: add page assertion tools`

说明：
- 新增 5 个轻量断言工具：
  - `page_expectRoute`
  - `page_expectVisible`
  - `page_expectElementText`
  - `page_expectCount`
  - `page_expectData`
- 断言结果统一返回 `pass`、`expected`、`actual` 与 `snapshot`
- 已在当前打开的微信开发者工具会话中完成自测

关键文件：
- `src/tools/page.ts`
- `README.md`
- `docs/weapp-dev-agent-guide.md`
- `docs/roadmap/agent-first-capability-matrix.md`

意义：
- agent 不必每次临时拼 route / 文本 / 数量 / data 判断逻辑
- 冒烟测试与轻量回归测试可以输出更稳定的结构化结果
- 为后续 scenario runner 和测试报告能力提供基础

---

### 11. 增加页面结构快照工具

说明：
- 新增 `page_snapshot`
- 可一次性返回：
  - 当前 route
  - query
  - 指定 `data` 路径和值
  - 指定选择器的元素摘要（text / size / offset 等）
- 不默认处理页面 title；标题可能来自原生 navigationBar 或页面内自定义节点，测试时应显式声明来源
- 已在当前打开的微信开发者工具会话中验证 detail 页快照输出

关键文件：
- `src/tools/page.ts`
- `README.md`
- `docs/weapp-dev-agent-guide.md`
- `docs/roadmap/agent-first-capability-matrix.md`

意义：
- agent 可以用一次调用拿到页面结构判断所需的大部分上下文
- 降低在回归或调试流程中多次拼 `page_getData` + `page_getElements` 的开销
- 为后续 `mp_runScenario` 提供更稳定的中间态快照

---

### 9. 增加 agent 使用手册

相关文档：
- `docs/weapp-dev-agent-guide.md`

说明：
- 新增面向 agent 的仓库内使用手册
- 内容包括：
  - 正确起手顺序
  - `9420` 作为主 automator 端口的说明
  - timeout / log / evaluate / wait helpers 的使用建议
  - 页面调试、data 调试、日志调试的推荐工作流
  - 推荐与不推荐的使用方式

意义：
- 方便后续维护者或其他 agent 快速理解 fork 的推荐用法
- 当前它是仓库文档，不会自动完整注入每个 agent 的上下文

---

## 当前对 agent 可见的信息层次

当前 agent 默认最容易看到的是：
- MCP server 全局 `instructions`
- 每个工具的 `name`、`description`、参数 schema
- 已注册的 server prompts
- 工具执行后的错误和返回文本

对应位置：
- `src/index.ts`
- `src/prompts.ts`
- `src/tools/application.ts`
- `src/tools/page.ts`
- `src/tools/element.ts`

补充说明：
- `docs/weapp-dev-agent-guide.md` 是仓库文档，不等于自动注入给每个 agent 的系统提示
- 目前从实际测试看，新 agent 已可较正确地使用现有 MCP，因此暂不强制需要额外 skills

---

## 关于 skills 的当前结论

截至 2026-04-14，当前判断是：
- `skills` 不是当前必需项
- 原因是新 agent 在没有额外 skill 的情况下，已经能正确起手并使用 MCP
- 当前优先级更高的是：
  - 保持 tool description 清晰
  - 保持 `instructions` 和 prompts 足够准确
  - 保持 README / docs / agent guide 同步

后续仅在以下情况再考虑引入 skill：
- 新 agent 频繁跳过 `mp_ensureConnection`
- 频繁不会选 `page_*` / `element_*` / `mp_*`
- 频繁在连接失败时走错恢复流程
- 需要把某条固定调试流程标准化为强约束入口

---

## 配套测试项目与验证记录

补充说明：
- 当前已在本机小程序项目 ` /Users/liting/Desktop/微信小程序动效` 中补了一套专门给 `weapp-dev` MCP 使用的测试页面与交互
- 该测试项目不是本仓库的一部分，但可作为当前 fork 的本机回归验证样本

已验证能力：
- 首页元素读取
- 页面导航：`index -> lab -> detail`
- 元素点击与输入
- `page_getData` / `page_setData`
- `page_waitRoute`
- 截图
- `mp_getLogs`
- 基础滚动与列表场景

截图产物：
- `weapp-lab-detail.png`
- `weapp-lab-advanced.png`

建议：
- 若后续继续维护此 fork，可保留一个类似的本机测试小程序，专门覆盖导航、输入、列表、滚动、日志、截图等基础链路

---

## 当前建议的交接阅读顺序

新接手维护者建议按这个顺序看：

1. `README.md`
   - 看当前 fork 的接入方式和工具总览
2. `docs/weapp-dev-agent-guide.md`
   - 看推荐工作流和使用心智模型
3. `docs/official/wechat-devtools-automator/README.md`
   - 看官方 API 对照入口
4. `src/index.ts`
   - 看 server `instructions`
5. `src/prompts.ts`
   - 看 MCP 内建的提示入口
6. `src/weappClient.ts`
   - 看连接、自动拉起、日志与 timeout 的核心逻辑
7. `src/tools/application.ts` / `src/tools/page.ts` / `src/tools/element.ts`
   - 看实际暴露给 MCP 的工具面

---

## 当前状态总结

### 已完成

当前 fork 已具备：
- 本地 fork 方式运行
- 与微信开发者工具自动化连接
- 自动拉起和项目选择能力
- `data` 读取超时保护
- 更稳的日志恢复与过滤
- 页面等待增强
- 真实手势交互增强
- 控制台日志跨进程持久化
- 本地官方文档索引
- 仓库内 agent 使用手册

### 待评估

当前未做但可后续评估：
- 把更多官方底层 API 继续封装为 MCP 工具
- 根据真实使用情况决定是否增加 skill
- 将部分推荐工作流进一步上提到 server prompts 或 instructions
- 是否补更多等待/断言类轻量工具，但保持最小改动原则
- 是否将“推荐工作流”和“恢复策略”进一步固化到更强的 MCP 引导文本中
