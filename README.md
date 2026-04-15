# weapp-agent-mcp

`weapp-agent-mcp` 是一个面向 agent 的微信小程序 MCP 服务，基于 [`miniprogram-automator`](https://www.npmjs.com/package/miniprogram-automator) 封装微信开发者工具自动化能力，用于页面调试、元素操作、轻量回归测试与恢复友好型排查。

它适合：
- agent 主开发 / 主调试
- 串行截图与页面巡检
- 轻量 scenario / report
- 基于稳定 selector 的自动化验证

它当前不应被宣传为：
- 并发截图通道
- 超长高压全链路回归引擎

> 项目来源：本仓库基于上游 `weapp-dev-mcp` / `@yfme/weapp-dev-mcp` 演进而来，当前以独立发布与 agent-first 体验为目标继续维护。

## 文档导航

更完整的文档入口见 `docs/README.md`。

## 前置要求

- 已安装微信开发者工具，支持命令行访问（`cli` / `cli.bat`）
- 本地已安装 Node.js 18+ 和 `npm`
- 有可以在开发者工具中打开的小程序项目
- 已在微信开发者工具中开启自动化测试与服务端口

## 快速开始

### 方式一：通过 npm / npx 接入（推荐，普通用户默认这样用）

不需要先把仓库拉到本地，也不需要自己手动构建 `dist`。只要本机有 Node.js 和 `npx`，就可以直接在 MCP 客户端里这样配置：

```json
{
  "mcpServers": {
    "weapp-agent-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@chaixueyuan/weapp-agent-mcp"
      ],
      "env": {
        "WEAPP_WS_ENDPOINT": "ws://localhost:9420"
      }
    }
  }
}
```

> 如果你希望在 Claude 等客户端里用更短的别名，也可以把 MCP server key 命名为 `weapp-dev`，但发布包名和服务名以 `weapp-agent-mcp` 为准。

可选：如果你习惯全局安装，也可以先执行：

```bash
npm install -g @chaixueyuan/weapp-agent-mcp
```

然后把 MCP 配置改成：

```json
{
  "mcpServers": {
    "weapp-agent-mcp": {
      "command": "weapp-agent-mcp",
      "env": {
        "WEAPP_WS_ENDPOINT": "ws://localhost:9420"
      }
    }
  }
}
```

### 方式二：本地源码构建接入（仅开发者 / 贡献者）

只有在以下场景才需要这样用：

- 你正在开发这个仓库本身
- 你要调试尚未发布到 npm 的改动
- 你要在本地修改源码后立刻验证

```bash
npm install
npm run build
node dist/index.js
```

```json
{
  "mcpServers": {
    "weapp-agent-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/weapp-agent-mcp/dist/index.js"
      ],
      "env": {
        "WEAPP_WS_ENDPOINT": "ws://localhost:9420"
      }
    }
  }
}
```

### 本地开发

```bash
npm install
npm run dev
```

## 重要边界

- `mp_screenshot` 当前按串行单通道能力设计，不支持并发压测
- 复杂业务链建议拆成多个短 scenario，而不是一个超长 scenario
- `page_snapshot`、`mp_screenshot`、长 `mp_runScenario` 在连续复杂操作后可能超时
- 若出现连续失败，先运行 `mp_healthCheck`，必要时执行 `mp_recoverConnection`
- 稳定性高度依赖业务页面提供清晰的 `qa-*` selector 或其他稳定定位锚点

## MCP 客户端集成

### Claude Code 自动批准工具权限
由于使用 Claude Code 调用 MCP 工具时，会触发工具调用权限申请，此时可能会丢失 MCP 与微信开发者工具的连接状态，由于获取控制台输出高度依赖连接状态，此时会无法连贯的获取输出日志，所以建议手动添加权限：

在项目目录下创建 `.claude/settings.local.json` 文件，或在已有文件添加以下内容后即可免确认直接调用工具，或者根据需要添加您允许免确认调用的工具：

```json
{
  "permissions": {
    "allow": [
      "mcp__weapp-agent-mcp__mp_ensureConnection",
      "mcp__weapp-agent-mcp__mp_navigate",
      "mcp__weapp-agent-mcp__mp_screenshot",
      "mcp__weapp-agent-mcp__mp_callWx",
      "mcp__weapp-agent-mcp__mp_evaluate",
      "mcp__weapp-agent-mcp__mp_getLogs",
      "mcp__weapp-agent-mcp__mp_currentPage",
      "mcp__weapp-agent-mcp__mp_healthCheck",
      "mcp__weapp-agent-mcp__mp_recoverConnection",
      "mcp__weapp-agent-mcp__mp_listProjects",
      "mcp__weapp-agent-mcp__mp_setDefaultProject",
      "mcp__weapp-agent-mcp__page_getElement",
      "mcp__weapp-agent-mcp__page_getElements",
      "mcp__weapp-agent-mcp__page_waitElement",
      "mcp__weapp-agent-mcp__page_waitElementGone",
      "mcp__weapp-agent-mcp__page_waitRoute",
      "mcp__weapp-agent-mcp__page_waitTimeout",
      "mcp__weapp-agent-mcp__page_expectRoute",
      "mcp__weapp-agent-mcp__page_expectVisible",
      "mcp__weapp-agent-mcp__page_expectElementText",
      "mcp__weapp-agent-mcp__page_expectCount",
      "mcp__weapp-agent-mcp__page_expectData",
      "mcp__weapp-agent-mcp__page_getData",
      "mcp__weapp-agent-mcp__page_setData",
      "mcp__weapp-agent-mcp__page_callMethod",
      "mcp__weapp-agent-mcp__element_tap",
      "mcp__weapp-agent-mcp__element_touch",
      "mcp__weapp-agent-mcp__element_swipe",
      "mcp__weapp-agent-mcp__element_input",
      "mcp__weapp-agent-mcp__element_callMethod",
      "mcp__weapp-agent-mcp__element_getData",
      "mcp__weapp-agent-mcp__element_setData",
      "mcp__weapp-agent-mcp__element_getInnerElement",
      "mcp__weapp-agent-mcp__element_getInnerElements",
      "mcp__weapp-agent-mcp__element_getWxml",
      "mcp__weapp-agent-mcp__element_getStyles",
      "mcp__weapp-agent-mcp__element_scrollTo",
      "mcp__weapp-agent-mcp__element_getAttributes",
      "mcp__weapp-agent-mcp__element_getBoundingClientRect"
    ]
  }
}
```

> **注意：** 工具名称格式为 `mcp__<服务器名称>__<工具名称>`，请确保服务器名称与您的 MCP 配置中的名称一致。

### 启动微信开发者工具

在使用 MCP 服务器之前，需要先启动微信开发者工具并开启 WebSocket 服务。

💡 在开始之前：
1. 打开微信开发者工具
2. 进入 **设置 → 安全设置 → 服务端口**
3. 开启 **"HTTP 调试"** 和 **"自动化测试"**

**使用命令行启动**

使用命令行启动微信开发者工具并自动开启 WebSocket 服务：

**macOS/Linux：**
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project /path/to/your/project --auto-port 9420
```

**Windows：**
```cmd
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project C:\path\to\your\project --auto-port 9420
```

其中：
- `--project` 参数指定小程序项目目录路径（请替换为实际的项目路径）
- `--auto-port` 参数指定 WebSocket 服务端口（默认 9420）


**⚠️ 警告**
由于沙箱机制，部分客户端不允许 MCP 访问项目目录以外的微信开发者工具的 cli，所以这里只介绍了使用 WebSocket 服务


### 环境变量配置

通过环境变量控制自动化工具如何连接到微信开发者工具：

| 变量 | 说明 |
| --- | --- |
| `WEAPP_WS_ENDPOINT` | **【推荐】** 已运行的开发者工具 WebSocket 端点。设置后，服务器使用 `connect` 模式而不是启动新实例。示例：`ws://localhost:9420` |
| `WECHAT_DEVTOOLS_CLI_PATH` | 微信开发者工具 CLI 路径（如果默认路径有效则可选）。 |
| `WEAPP_AUTOMATOR_MODE` | 强制使用 `launch` 或 `connect` 模式。除非提供了 `WEAPP_WS_ENDPOINT`，否则默认为 `launch`。 |
| `WEAPP_DEVTOOLS_PORT` | 启动开发者工具时的首选端口（回退到可用端口）。 |
| `WEAPP_DEVTOOLS_TIMEOUT` | 启动超时时间（毫秒，默认 30000）。 |
| `WEAPP_AUTO_ACCOUNT` | 传递给 `--auto-account` 用于自动登录。 |
| `WEAPP_DEVTOOLS_TICKET` | 启动时传递给 `--ticket`。 |
| `WEAPP_TRUST_PROJECT` | 设置为 `true` 以在启动时包含 `--trust-project`。 |
| `WEAPP_DEVTOOLS_ARGS` | 启动时的额外 CLI 参数（空格分隔）。 |
| `WEAPP_DEVTOOLS_CWD` | 传递给开发者工具进程的工作目录。 |
| `WEAPP_AUTOCLOSE` | 设置为 `true` 时，每次工具调用后关闭开发者工具会话。 |
| `WEAPP_AUTOLAUNCH` | 设为 `true` 时，自动检测并启动开发者工具 |
| `WEAPP_LAUNCH_TIMEOUT` | 启动超时时间（毫秒，默认 45000） |
| `WEAPP_CONNECT_TIMEOUT` | 连接超时时间（毫秒，默认 45000） |
| `WEAPP_PROJECT_PATH` | 小程序项目路径（可选） |

> **注意：** 当启动开发者工具（`launch` 模式）时，必须通过 MCP 工具参数提供小程序项目目录：在执行操作前通过 `connection.projectPath` 提供（例如通过 `mp_ensureConnection`）。该值一旦建立，将在后续调用中持久化。

工具调用可以通过 `connection` 对象覆盖这些默认值中的大部分。

## 可用工具

### 应用工具（Application Tools）

- `mp_ensureConnection` – 确保自动化会话就绪；可选择强制重连或覆盖连接设置
- `mp_navigate` – 在小程序内导航，支持 `navigateTo`、`redirectTo`、`reLaunch`、`switchTab` 或 `navigateBack`
- `mp_screenshot` – 捕获屏幕截图并返回（或保存到磁盘）
- `mp_callWx` – 调用微信小程序 API 方法（如 `wx.showToast`）
- `mp_evaluate` – 向小程序 AppService 注入并执行函数代码，适合做显式运行时读取
- `mp_getLogs` – 获取小程序控制台日志，支持按 `type`、`contains`、`since`、`limit` 过滤，并返回日志监听状态（如 `listenerAttached`、`lastLogAt`、`sessionId`）
- `mp_runScenario` – 按顺序执行一组最小测试步骤，当前支持 `navigate`、`tap`、`input`、`waitRoute`、`expect*`、`snapshot`、`getLogs`、`screenshot`
- `mp_generateScenarioReport` – 执行 scenario 并输出 markdown 报告；可选写入 `outputPath`，适合产出轻量回归测试记录，并可引用截图路径
- `mp_currentPage` – 获取当前页面信息（路径、查询参数、尺寸和滚动位置），`withData` 为 true 时额外返回页面数据
- `mp_healthCheck` – 聚合连接、页面、项目路径和日志监听状态，判断当前是否健康、是否需要恢复
- `mp_recoverConnection` – 按标准顺序执行恢复，并返回恢复动作、恢复前后状态与最新 health
- `mp_listProjects` – 列出微信开发者工具中的最近项目，方便选择项目目录
- `mp_setDefaultProject` – 设置默认的小程序项目路径，设置后下次连接会自动使用该项目

### 页面工具（Page Tools）

- `page_getElement` – 通过选择器获取页面元素，返回元素摘要信息（tagName、text、value、size、offset）；设置 `withWxml: true` 可额外返回完整 outerWxml；**支持 [index=N] 语法选择第 N 个元素**
- `page_getElements` – 通过选择器获取页面元素数组，返回每个元素的摘要信息；设置 `withWxml: true` 可额外返回每个元素的完整 outerWxml；**支持 [index=N] 语法**
- `page_waitElement` – 等待元素出现在页面上（⚠️ 不适用于自定义组件内部元素）；**支持 [index=N] 语法；增加超时和重试间隔参数**
- `page_waitElementGone` – 等待元素从页面上消失；**支持 [index=N] 语法；支持超时和重试间隔参数**
- `page_waitRoute` – 等待当前页面路径变为指定值，适合确认导航真正完成；支持超时和重试间隔参数
- `page_waitTimeout` – 等待指定的毫秒数
- `page_expectRoute` – 断言当前页面路径是否等于预期值
- `page_expectVisible` – 断言页面上是否存在可定位到的元素；支持 `[index=N]` 语法
- `page_expectElementText` – 断言元素文本是否等于或包含预期值；支持 `[index=N]` 语法
- `page_expectCount` – 断言页面上匹配选择器的元素数量是否等于预期值
- `page_expectData` – 断言当前页面指定 `data` 路径的值是否与预期相等
- `page_snapshot` – 返回当前页面的轻量结构快照，聚合 route、query、指定 data 路径和值，以及关键选择器的元素摘要；不默认处理页面 title，标题校验请用明确选择器配合 `page_expectElementText`
- `page_getData` – 获取当前页面的数据对象，可选择指定子数据路径
- `page_setData` – 使用 `setData` 更新当前页面的数据
- `page_callMethod` – 调用当前页面实例上暴露的方法

### 元素工具（Element Tools）

- `element_tap` – 通过 CSS 选择器模拟点击 WXML 元素；**支持 [index=N] 语法选择第 N 个元素**
- `element_touch` – 对元素执行真实触摸事件；支持 `start` / `move` / `end` / `sequence` 四种模式，坐标基于元素左上角，默认取元素中心；**支持 [index=N] 语法**
- `element_swipe` – 对元素执行真实滑动手势；支持 `up` / `down` / `left` / `right`，可指定距离和持续时间；**支持 [index=N] 语法**
- `element_input` – 向元素输入文本（适用于 `input` 和 `textarea` 组件）
- `element_callMethod` – 调用自定义组件实例的方法
- `element_getData` – 获取自定义组件实例的渲染数据
- `element_setData` – 设置自定义组件实例的渲染数据
- `element_getInnerElement` – 获取元素内的元素（相当于 `element.$(selector)`），返回元素摘要信息；设置 `withWxml: true` 可额外返回完整 outerWxml
- `element_getInnerElements` – 获取元素内的元素数组（相当于 `element.$$(selector)`），返回元素摘要信息；设置 `withWxml: true` 可额外返回每个元素的完整 outerWxml
- `element_getWxml` – 获取元素 WXML（内部或外部）
- `element_getStyles` – 获取元素的 CSS 样式值，names 参数为样式名数组（如 `['color', 'fontSize']`）
- `element_scrollTo` – 滚动 scroll-view 组件到指定位置（x, y）
- `element_getAttributes` – 获取元素的特性值，names 参数为特性名数组（如 `['class', 'id', 'data-index']`）
- `element_getBoundingClientRect` – 获取元素相对于视口的边界矩形信息（left、top、width、height、right、bottom），考虑 CSS transform 变换（目前仅支持 ID 选择器、类选择器）

每个工具都接受可选的 `connection` 块来覆盖环境默认值（项目路径、CLI 路径、WebSocket 端点等）。


## 使用技巧

### 一般提示

- 连接前，在微信开发者工具中启用自动化（`设置 → 安全设置 → 服务端口`）
- 推荐首先调用 `mp_ensureConnection` 来验证连接并查看系统/页面详情
- 使用 `WEAPP_AUTOCLOSE=true` 适合无状态的一次性交互
- **导航时始终使用绝对路径**（以 `/` 开头）：`/pages/mine/mine`
- tabBar 页面使用 `switchTab`，普通页面使用 `navigateTo`
- `switchTab` 只应视为一种导航动作，不应默认作为底部 tab UI 选中态的判断依据；很多项目会自定义底部 tab

### 操作自定义组件

操作自定义组件时，有两种方法：

#### 方法一：使用 `innerSelector` 参数（推荐）

适用于 `element_tap`、`element_input`、`element_getWxml` 等工具：

```json
{
  "selector": "#my-component",
  "innerSelector": ".inner-button"
}
```

- `selector`：自定义组件的选择器
- `innerSelector`：组件内部元素的选择器

#### 方法二：使用元素内查询工具

适用于 `element_getInnerElement` 和 `element_getInnerElements`：

```json
{
  "selector": "#my-component",
  "targetSelector": ".inner-button"
}
```

#### 限制说明

- `page_waitElement` **不适用于**自定义组件内部元素。请使用 `page_waitTimeout` 配合元素查询工具进行轮询检查。
- 页面跳转校验可优先使用 `page_waitRoute`，比单纯 `mp_navigate` 后固定等待更稳。
- 临时弹层、loading、toast 等消失场景可使用 `page_waitElementGone`。

### 自动启动功能（AutoLaunch）

当配置 `WEAPP_AUTOLAUNCH=true` 时，MCP 服务器可以自动检测并启动微信开发者工具：

1. **自动检测端口**：检测 9420 端口是否有服务运行
2. **无服务则启动**：如果端口未占用，自动调用 CLI 启动开发者工具
3. **项目选择**：
   - 如果有默认项目配置，自动使用
   - 如果没有默认项目，自动列出最近项目供选择
   - 支持输入项目编号（如 `1`）或完整路径

#### 配置示例

```json
{
  "mcpServers": {
    "weapp-agent-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@chaixueyuan/weapp-agent-mcp"
      ],
      "env": {
        "WEAPP_AUTOLAUNCH": "true",
        "WEAPP_PROJECT_PATH": "D:\\path\\to\\your\\project"
      }
    }
  }
}
```

#### 工作流程

1. 首次连接时，检测到 `WEAPP_AUTOLAUNCH=true`
2. 检查 9420 端口是否有服务
3. 无服务则自动启动开发者工具（使用 `cli.bat auto --project <path> --auto-port 9420`）
4. 等待 45 秒让开发者工具就绪
5. 建立 WebSocket 连接
6. **后续连接自动复用现有连接**

> **提示**：使用 `mp_setDefaultProject` 设置默认项目后，下次连接无需再次选择项目。
