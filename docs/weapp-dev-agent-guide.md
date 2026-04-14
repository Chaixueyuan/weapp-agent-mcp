# weapp-dev fork 版 Agent 使用手册

日期：2026-04-14  
适用对象：需要在 Claude Code 中直接使用 `weapp-dev` MCP 的 agent

## 这是什么

这是当前 `weapp-dev-mcp` fork 的面向 agent 使用说明。

当前仓库提供的是一个通过微信开发者工具自动化能力控制小程序页面的 MCP 服务。对 agent 来说，它不是普通文档查询工具，而是一套可执行的页面调试工具。

当前本机常见接入形态：
- MCP 名称：`weapp-dev`
- 推荐连接端点：`ws://localhost:9420`
- 推荐启动文件：本仓库的 `dist/index.js`
- 可配合 `WEAPP_AUTOLAUNCH=true` 自动拉起微信开发者工具

## 使用前必须知道的前提

### 1. 先连通，再做页面操作

推荐固定顺序：
1. 先调用 `mp_ensureConnection`
2. 再调用 `mp_currentPage`
3. 需要观察界面时调用 `mp_screenshot`
4. 之后再调用 `page_*` 或 `element_*`

不要一上来直接操作页面元素。

### 2. `9420` 才是主 automator 端口

历史上可能会看到其他调试端口，但当前推荐自动化连接端口是：
- `ws://localhost:9420`

如果你在排查连接问题，优先确认这个端点，而不是把其他调试端口当成 automator 主入口。

### 3. 连接失败时不要盲重试

推荐恢复顺序：
1. 先重新调用 `mp_ensureConnection`
2. 若有明确重连需要，再使用 `reconnect=true`
3. 如果提示项目选择问题，调用 `mp_listProjects` 或在 `mp_ensureConnection` 中传 `projectSelection`

不要在相同参数下无脑重复调用很多次。

## 当前 fork 的关键增强

### 1. `data` 读取带超时保护

涉及能力：
- `page_getData`
- `element_getData`
- `mp_currentPage` 的 `withData=true`

意义：
- 如果底层 `page.data()` / `element.data()` 卡住，不会无限等待
- agent 可以更快进入下一步判断

### 2. 日志恢复更稳定

涉及能力：
- `mp_getLogs`

当前 fork 已增强：
- 重连后重新绑定日志监听
- 避免重复绑定
- 简单日志去重
- 支持按 `type`、`contains`、`since`、`limit` 过滤

### 3. 提供 `mp_evaluate`

适用场景：
- 想读取 `getApp().globalData`
- `page_getData` 不稳定时做显式调试读取
- 想进行更深一层的运行时检查

注意：
- `mp_evaluate` 是增强工具
- 不应默认替代标准页面/元素读取流程

### 4. 新增更稳的等待能力

涉及能力：
- `page_waitElement`
- `page_waitElementGone`
- `page_waitRoute`

建议：
- 路由跳转确认优先使用 `page_waitRoute`
- loading、toast、弹层消失可优先用 `page_waitElementGone`

## 工具分层理解

### 1. 连接与页面上下文层

常用工具：
- `mp_ensureConnection`
- `mp_currentPage`
- `mp_screenshot`
- `mp_getLogs`
- `mp_evaluate`

用途：
- 建立连接
- 确认当前页面
- 通过截图建立稳定上下文
- 补充日志与运行时状态

### 2. 页面层

常用工具：
- `page_getElement`
- `page_getElements`
- `page_waitElement`
- `page_waitElementGone`
- `page_waitRoute`
- `page_getData`
- `page_callMethod`

用途：
- 做页面结构和状态判断
- 等待页面状态变化
- 在必要时读取页面 data 或调用页面方法

### 3. 元素层

常用工具：
- `element_tap`
- `element_input`
- `element_touch`
- `element_swipe`
- `element_getData`
- `element_getWxml`
- `element_getStyles`
- `element_getBoundingClientRect`

用途：
- 进行真实交互
- 获取元素可见状态、布局和局部数据

## 推荐的标准工作流

### 场景 A：页面调试

推荐顺序：
1. `mp_ensureConnection`
2. `mp_currentPage`
3. `mp_screenshot`
4. `page_getElements` / `page_getElement`
5. `element_tap` / `element_input`
6. 再次 `mp_currentPage` / `mp_screenshot`
7. 需要时用 `page_waitRoute` 或 `page_waitElementGone`

适合：
- 看页面
- 点页面
- 验证跳转
- 验证 tab 切换
- 做冒烟测试

### 场景 B：data 调试

推荐顺序：
1. `mp_ensureConnection`
2. `mp_currentPage`（必要时 `withData=true`）
3. `page_getData`
4. 若超时或不稳定，再考虑 `mp_evaluate`

推荐策略：
- 先走标准 API
- 标准 API 不稳定时，再显式使用 `mp_evaluate`
- 不要默认所有读取都走 `evaluate`

### 场景 C：日志调试

推荐顺序：
1. `mp_ensureConnection`
2. 触发动作
3. `mp_getLogs`
4. 若连接疑似异常，重新 `mp_ensureConnection`
5. 必要时带 `reconnect=true`
6. 再次触发动作并重新取日志

## 推荐与不推荐

### 推荐
- 新开 agent / 新会话验证最新 MCP 配置
- 先 `mp_ensureConnection`
- 先看页面路径和截图
- 把页面路径、截图、元素状态作为主判断依据
- 把 `data` 和日志作为补充信息
- 需要深层读取时显式使用 `mp_evaluate`

### 不推荐
- 跳过连接检查直接操作页面
- 把 `page_getData` 当唯一判断依据
- 把 `mp_getLogs` 当唯一真相源
- 在同样参数下无脑重试很多次
- 默认所有深层调试都直接走 `mp_evaluate`

## 一个最实用的心智模型

可以把当前 `weapp-dev` fork 理解成三层：

### 1. 页面操作层
最稳定、最推荐：
- 当前页
- 截图
- 元素查询
- 点击
- 输入

### 2. 运行时补充层
可用但要谨慎：
- `page_getData`
- `element_getData`
- `mp_getLogs`

### 3. 深度调试层
显式使用，不默认走：
- `mp_evaluate`

## 给其他 agent 的一句话指令模板

如果你要把这套工具交给另一个 agent，最简单可以直接这样说：

- 使用 `weapp-dev` MCP 调试微信小程序。
- 先 `mp_ensureConnection`；若连接异常，优先走一次标准重连流程。
- 再 `mp_currentPage`，根据需要使用截图、元素查询、点击与输入。
- 页面判断优先依赖页面路径、截图和元素状态。
- `page_getData` 与 `element_getData` 可用，但若超时不要卡住，必要时改用 `mp_evaluate` 做显式深层读取。
- 日志通过 `mp_getLogs` 获取，复杂场景结合过滤参数与重连流程使用。

## 补充说明

- 这份手册是仓库内参考文档，不会自动完整注入到每个 agent 的上下文。
- agent 默认最先看到的是 MCP 服务器的 `instructions`、每个工具的 `description` / 参数定义，以及服务器注册的 prompts。
- 如果希望 agent 更稳定地按这份手册使用 MCP，后续可把“标准工作流”和“恢复顺序”进一步收敛到 skill 或更强的 server prompts 中。