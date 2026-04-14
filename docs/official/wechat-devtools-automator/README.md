# 微信小程序自动化官方文档索引

这组文档通过 `doko` 从微信官方页面抓取后落地到当前项目，方便后续在本地直接查看和检索 `miniprogram-automator` 官方 API。

## 文档来源

- Automator：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/automator.html`
- MiniProgram：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/miniprogram.html`
- Page：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/page.html`
- Element：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/element.html`
- 真机自动化：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/remote.html`
- 常用示例：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/example.html`
- FAQ：`https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/faq.html`

## 本地文件

- `docs/official/wechat-devtools-automator/automator.txt`
- `docs/official/wechat-devtools-automator/miniprogram.txt`
- `docs/official/wechat-devtools-automator/page.txt`
- `docs/official/wechat-devtools-automator/element.txt`
- `docs/official/wechat-devtools-automator/remote.txt`
- `docs/official/wechat-devtools-automator/example.txt`
- `docs/official/wechat-devtools-automator/faq.txt`

## 快速导航

如果你是 agent，建议按问题进入：

- 想看连接 / 启动：直接看 `automator.txt`
- 想看小程序全局能力：直接看 `miniprogram.txt`
- 想看页面选择器、`waitFor`、`data`：直接看 `page.txt`
- 想看元素交互、滚动、滑动、组件方法：直接看 `element.txt`
- 想看真机自动化：直接看 `remote.txt`
- 想看官方测试示例：直接看 `example.txt`
- 想确认官方边界和限制：直接看 `faq.txt`


### 1. Automator

对应文件：`docs/official/wechat-devtools-automator/automator.txt`

核心内容：
- `automator.connect(options)`：连接已启动的开发者工具 WebSocket
- `automator.launch(options)`：启动并连接开发者工具

关键参数：
- `wsEndpoint`
- `cliPath`
- `projectPath`
- `timeout`
- `port`
- `account`
- `projectConfig`
- `ticket`

适合查看：
- 连接模式与启动模式的原始定义
- CLI 拉起方式
- 官方默认 CLI 路径

### 2. MiniProgram

对应文件：`docs/official/wechat-devtools-automator/miniprogram.txt`

核心导航 API：
- `pageStack()`
- `navigateTo(url)`
- `redirectTo(url)`
- `navigateBack()`
- `reLaunch(url)`
- `switchTab(url)`
- `currentPage()`

运行时与系统 API：
- `systemInfo()`
- `callWxMethod(method, ...args)`
- `callPluginWxMethod(pluginId, method, ...args)`
- `evaluate(appFunction, ...args)`
- `pageScrollTo(scrollTop)`
- `screenshot(options?)`
- `exposeFunction(name, bindingFunction)`

Mock / 测试相关 API：
- `mockWxMethod()`
- `mockPluginWxMethod()`
- `restoreWxMethod()`
- `restorePluginWxMethod()`
- `testAccounts()`
- `stopAudits()`

登录与远程调试：
- `getTicket()`
- `setTicket(ticket)`
- `refreshTicket()`
- `remote(auto?)`
- `disconnect()`
- `close()`

事件：
- `console`
- `exception`

适合查看：
- 官方对 `evaluate`、`mockWxMethod`、`remote`、`ticket` 机制的定义
- 真机调试与多账号调试能力边界

### 3. Page

对应文件：`docs/official/wechat-devtools-automator/page.txt`

属性：
- `path`
- `query`

核心方法：
- `$(selector)`
- `$$(selector)`
- `waitFor(condition)`
- `data(path?)`
- `setData(data)`
- `size()`
- `scrollTop()`
- `callMethod(method, ...args)`

适合查看：
- 页面级选择器能力
- `waitFor` 三种用法：选择器、超时、断言函数
- `data(path?)` 的官方定义

### 4. Element

对应文件：`docs/official/wechat-devtools-automator/element.txt`

基础查询与读取：
- `$(selector)`
- `$$(selector)`
- `size()`
- `offset()`
- `text()`
- `attribute(name)`
- `property(name)`
- `wxml()`
- `outerWxml()`
- `value()`
- `style(name)`

交互 API：
- `tap()`
- `longpress()`
- `touchstart(options)`
- `touchmove(options)`
- `touchend(options)`
- `trigger(type, detail?)`
- `input(value)`

组件 / 容器 API：
- `callMethod(method, ...args)`
- `data(path?)`
- `setData(data)`
- `callContextMethod(method, ...args)`
- `scrollWidth()`
- `scrollHeight()`
- `scrollTo(x, y)`
- `swipeTo(index)`
- `moveTo(x, y)`
- `slideTo(value)`

适合查看：
- 官方原始元素能力边界
- `attribute` vs `property` 的区别
- 真实触摸事件结构 `touches / changedTouches`
- 哪些方法仅适用于特定组件

### 5. 真机自动化

对应文件：`docs/official/wechat-devtools-automator/remote.txt`

核心内容：
- 支持通过远程调试控制真机运行自动化脚本
- 可以通过 `miniProgram.remote()` 启动真机调试
- 支持扫码连接后在真机上继续执行脚本

适合查看：
- 真机自动化的官方启动方式
- 模拟器调通后迁移到真机的官方路径

### 6. 常用示例

对应文件：`docs/official/wechat-devtools-automator/example.txt`

核心示例：
- 错误处理：`try/catch`
- 模板快照测试：结合 `wxml()` 和 Jest snapshot
- 测试环境注入：通过 `evaluate()` 改 `getApp().globalData`
- 伪造请求结果：通过 `mockWxMethod('request', ...)`

适合查看：
- 官方推荐测试写法
- `evaluate` 与 `mockWxMethod` 的典型使用模式

### 7. FAQ

对应文件：`docs/official/wechat-devtools-automator/faq.txt`

核心结论：
- 系统原生授权弹窗通常不能直接操作，需要提前手工授权
- 像位置选择这类原生能力，可用 `miniProgram.mockWxMethod` 伪造结果
- 脚本不退出时，记得调用 `miniProgram.close()` 或 `miniProgram.disconnect()`
- 多账号调试依赖 `miniProgram.testAccounts()`
- 多机同账号可以配合 `miniProgram.getTicket()`

## 对当前 fork 最有参考价值的页面

如果后续只想快速查最相关的官方 API，优先看这四个文件：
- `docs/official/wechat-devtools-automator/automator.txt`
- `docs/official/wechat-devtools-automator/miniprogram.txt`
- `docs/official/wechat-devtools-automator/page.txt`
- `docs/official/wechat-devtools-automator/element.txt`

因为当前仓库的 MCP 工具实现，基本就是围绕这四层在做封装：
- `automator`：启动 / 连接
- `MiniProgram`：应用级能力
- `Page`：页面级能力
- `Element`：元素级能力

## 备注

- 当前保留的是适合本地检索的纯文本抓取结果，不是官方页面原始 HTML。
- 如果后续要做更深入的 API 对照，建议在此目录下继续补一份“官方 API ↔ 当前 MCP 工具映射表”。
