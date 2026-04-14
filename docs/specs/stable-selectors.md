# 稳定选择器规范

目标：让 agent 能稳定、重复地定位页面关键元素，而不是依赖脆弱的视觉结构、样式 class 或临时文本。

## 为什么需要这份规范

对 agent-first 调试来说，最容易失稳的不是连接，而是元素定位。

常见问题包括：

- 改了样式 class，自动化 selector 立刻失效
- 文案一改，基于文本的定位就漂移
- 列表项结构一变，层级选择器全部报废
- 自定义组件内部元素难以稳定命中

所以稳定选择器不是“锦上添花”，而是 agent 可持续开发的基础设施。

## 基本原则

### 1. 关键交互元素必须有稳定 selector

以下元素必须提供稳定定位方式：

- 页面主入口按钮
- 导航按钮
- 表单输入框
- 列表项点击区
- tab / 标签切换项
- 开关、滑块、Stepper 等状态控件
- toast / modal 的确认与取消入口
- 调试页关键开关和重置按钮

### 2. 优先使用专用 selector，不依赖样式 class

推荐顺序：

1. 专用 `qa-*` class 或 `data-qa`
2. 稳定 `id`
3. 必要时的结构辅助 selector
4. 最后才是文本匹配或样式 class

### 3. 样式 class 和测试 selector 分离

不要把“为了样式存在的 class”同时当作“自动化锚点”。

错误示例：

- `.primary-btn`
- `.card`
- `.title`

这类 class 在样式重构时极易变化。

## 推荐命名规范

建议统一采用 `qa-*` 作为自动化定位前缀。

### 页面级

- `qa-page-index`
- `qa-page-lab`
- `qa-page-detail`

### 区块级

- `qa-section-input`
- `qa-section-filter`
- `qa-section-actions`

### 控件级

- `qa-btn-enter-lab`
- `qa-btn-trigger-toast`
- `qa-input-search`
- `qa-switch-notify`
- `qa-tab-a`
- `qa-tab-b`

### 列表级

- 列表容器：`qa-list-orders`
- 列表项：`qa-item-order`
- 列表项内按钮：`qa-btn-order-open`

### 调试入口级

- `qa-debug-reset-state`
- `qa-debug-switch-mock`
- `qa-debug-login-test-account`

## 列表场景规范

列表是最容易失稳的场景，建议统一如下：

### 1. 列表容器有独立 selector

例如：

- `qa-list-card`
- `qa-list-message`

### 2. 列表项有统一 selector + 数据字段

例如：

```xml
<view class="qa-item-card" data-id="{{item.id}}" data-qa="card-item">
```

这样 agent 可以先定位列表项，再结合 `data-id` 做二次判断。

### 3. 不要依赖第几个元素是目标元素

不推荐默认写死：

- 第 1 个按钮
- 第 3 个卡片
- 第二层第一个 view

应优先依赖：

- `data-id`
- `data-key`
- `data-tag`
- `qa-*`

## 输入与表单场景规范

### 推荐

- 输入框：`qa-input-*`
- 提交按钮：`qa-btn-submit-*`
- 清空按钮：`qa-btn-clear-*`
- 错误提示：`qa-error-*`

### 不推荐

- 只靠 placeholder 文本定位
- 只靠输入框在页面中的顺序定位

## 自定义组件场景规范

如果关键交互藏在自定义组件内部，应显式给组件外层或内部关键节点提供稳定 selector。

### 推荐

- 组件容器：`qa-widget-user-card`
- 组件内部按钮：`qa-btn-user-card-open`

### 不推荐

- 让 agent 依赖组件内部深层结构去猜
- 让 agent 只靠局部文本反推组件状态

## 调试 / 测试入口规范

如果项目要长期支持 agent 调试，建议业务项目预留一组显式调试入口：

- `qa-debug-entry`
- `qa-debug-reset-cache`
- `qa-debug-reset-state`
- `qa-debug-enable-mock`
- `qa-debug-switch-account`

这样 agent 能更快构造目标状态，而不是每次都从自然业务流入口绕过去。

## 推荐写法示例

### 示例 1：按钮

```xml
<button class="primary-btn qa-btn-enter-lab" bindtap="goLab">进入测试实验室</button>
```

说明：

- `primary-btn` 负责样式
- `qa-btn-enter-lab` 负责自动化定位

### 示例 2：列表项

```xml
<view class="list-card qa-item-card" data-id="{{item.id}}" data-tag="{{item.tag}}" bindtap="openDetail">
```

说明：

- `list-card` 负责样式
- `qa-item-card` 负责统一定位
- `data-id` / `data-tag` 负责精确区分目标项

## 反例

### 1. 只靠文案定位

```xml
<button>提交</button>
```

问题：

- 文案变更就失效
- 多个“提交”时无法区分

### 2. 只靠样式 class

```xml
<button class="primary-btn">提交</button>
```

问题：

- 样式重构时很容易改名
- 无法表达业务语义

### 3. 只靠层级结构

```text
.section > view:nth-child(2) > button
```

问题：

- 结构轻微变化就全部失效

## 对 agent 的直接收益

有了稳定选择器后，agent 能做到：

- 优先查询高价值元素，而不是扫整页结构
- 页面重构后仍保持较高成功率
- 更容易把断言工具和场景编排做成可复用能力
- 更容易生成结构化报告，而不是人工解释“我点的是哪个按钮”

## 落地建议

### 最小落地模板

建议业务页面至少补齐这 4 类节点：

- 页面根节点：`qa-page-*`
- 主操作按钮：`qa-btn-*`
- 关键输入框：`qa-input-*`
- 关键结果节点：`qa-text-*` / `qa-state-*`

一个最小可测页面示例：

```xml
<view class="page qa-page-detail">
  <view class="title qa-text-detail-title">详情页已打开</view>
  <button class="primary-btn qa-btn-back-home" bindtap="backHome">返回首页</button>
  <input class="search-input qa-input-keyword" />
</view>
```

这样 agent 至少可以稳定做：

- route 断言
- 标题 / 关键文本断言
- 主按钮点击
- 输入行为验证

## 落地建议

### 第一阶段

先给以下元素补齐：

- 页面主入口
- 核心按钮
- 输入框
- tab / 标签
- 列表项
- 调试入口

### 第二阶段

再补：

- 关键状态文本
- 错误提示节点
- modal / toast 相关入口
- 自定义组件内部关键节点

## 与 MCP 能力的关系

这份规范不是官方 automator 自动提供的能力，也不是 MCP 单侧就能完全解决的问题。

它依赖业务小程序本身配合落地。

因此它虽然是文档规范，但在 agent-first 路线中优先级应视为 `P0`。
