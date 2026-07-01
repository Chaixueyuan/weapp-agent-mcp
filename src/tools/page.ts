import { UserError, type ContentResult } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  areSerializableValuesEqual,
  booleanish,
  clampedTextResult,
  connectionContainerSchema,
  formatJson,
  MAX_SNAPSHOT_ELEMENT_SUMMARIES,
  maxBytesSchema,
  numberish,
  requiredJsonValueSchema,
  summarizeElement,
  toSerializableValue,
  toTextResult,
  resolveElement,
  setOwnEnumerableValue,
  parseSelectorWithIndex,
  pickByPaths,
  readCurrentPage,
  waitOnPage,
  withUserErrorResult,
} from "./common.js";

const getPageDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
  paths: z.array(z.string().trim().min(1)).max(100).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const setPageDataParameters = connectionContainerSchema.extend({
  data: z
    .record(z.string(), z.unknown())
    .refine((value) => Object.keys(value).length <= 100, {
      message: "data must contain at most 100 entries",
    }),
});

const callPageMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).max(100).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const waitForElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  timeout: numberish(z.number().int().positive().max(600000)).optional().default(5000),
  retryInterval: numberish(z.number().int().positive().max(60000)).optional().default(200),
});

const waitForTimeoutParameters = connectionContainerSchema.extend({
  milliseconds: numberish(z.number().int().nonnegative().max(600000)),
});

const waitForElementGoneParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  timeout: numberish(z.number().int().positive().max(600000)).optional().default(5000),
  retryInterval: numberish(z.number().int().positive().max(60000)).optional().default(200),
});

const waitForRouteParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1),
  timeout: numberish(z.number().int().positive().max(600000)).optional().default(5000),
  retryInterval: numberish(z.number().int().positive().max(60000)).optional().default(200),
});

const getElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  withWxml: booleanish.optional().default(false),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  withWxml: booleanish.optional().default(false),
  limit: numberish(z.number().int().positive().max(100)).optional().default(100),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const expectRouteParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1),
});

const expectVisibleParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
});

const expectElementTextParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  expected: z.string(),
  mode: z.enum(["equals", "includes"]).optional().default("equals"),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const expectCountParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  expected: numberish(z.number().int().nonnegative()),
});

const expectDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1),
  expected: requiredJsonValueSchema,
  maxBytes: maxBytesSchema.optional().default(50000),
});

const pageSnapshotParameters = connectionContainerSchema
  .extend({
    selectors: z.array(z.string().trim().min(1)).max(50).optional().default([]),
    dataPaths: z.array(z.string().trim().min(1)).max(50).optional().default([]),
    withData: booleanish.optional().default(false),
    withElements: booleanish.optional().default(true),
    withWxml: booleanish.optional().default(false),
    limit: numberish(z.number().int().positive().max(100)).optional().default(10),
    maxBytes: maxBytesSchema.optional().default(50000),
  })
  .superRefine((value, context) => {
    if (!value.withElements && value.selectors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["selectors"],
        message: "selectors requires withElements=true",
      });
    }
    if (value.withWxml && value.selectors.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["withWxml"],
        message: "withWxml requires at least one selector",
      });
    }
  });

export function createPageTools(manager: WeappAutomatorManager): AnyTool[] {
  return [
    createGetElementTool(manager),
    createGetElementsTool(manager),
    createWaitForElementTool(manager),
    createWaitForElementGoneTool(manager),
    createWaitForRouteTool(manager),
    createWaitForTimeoutTool(manager),
    createExpectRouteTool(manager),
    createExpectVisibleTool(manager),
    createExpectElementTextTool(manager),
    createExpectCountTool(manager),
    createExpectDataTool(manager),
    createPageSnapshotTool(manager),
    createGetPageDataTool(manager),
    createSetPageDataTool(manager),
    createCallPageMethodTool(manager),
  ];
}

function createGetElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElement",
    description: "通过选择器获取单个页面元素，相当于 page.$(selector)。返回该元素摘要 {tagName,text,value,size,offset}（取不到的字段为 null，不代表元素不存在）；withWxml=true 额外返回完整 outerWxml。支持 `selector[index=N]` 选第 N 个（0 基，仅作用于 selector，innerSelector 内不支持下标）。⚠️ 单次查询，元素不存在直接抛错——若元素来自 setData 后异步渲染 / SSE 流式 / navigateTo 未稳定，先用 `page_waitElement` 等到再调本工具；等任意非元素条件（page.data 字段变化等）用 `mp_pollUntil`。⚠️ page.$ 默认不穿透自定义组件（取决于组件 styleIsolation/addGlobalClass）；组件内部元素用 selector(组件)+innerSelector，或 element_getInnerElement(s)；本工具的 innerSelector 同样是「在已匹配元素内部再查一层」。结果超过 maxBytes（默认 50000B）返回 {selector,index,truncated,bytes,maxBytes,note,data} 包装——多由 withWxml 引起，可关掉它或调大 maxBytes。",
    parameters: getElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          let selector = args.selector;
          let indexHint: number | undefined;
          
          // 解析 [index=N] 语法
          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          if (indexHint === undefined) {
            const element = await resolveElement(
              page,
              args.selector,
              args.innerSelector
            );
            const summary = await summarizeElement(element, {
              withWxml: args.withWxml,
            });
            return clampedTextResult(
              { selector: args.selector, index: null, ...summary },
              args.maxBytes,
              {
                identity: { selector: args.selector, index: null },
                note: "元素结果超过 maxBytes 已截断。建议关闭 withWxml 或调大 maxBytes。",
              }
            );
          }

          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );
          const summary = await summarizeElement(element, { withWxml: args.withWxml });
          return clampedTextResult(
            { selector: args.selector, index: indexHint, ...summary },
            args.maxBytes,
            {
              identity: { selector: args.selector, index: indexHint },
              note: "元素结果超过 maxBytes 已截断。建议关闭 withWxml 或调大 maxBytes。",
            }
          );
        }
      );
      }),
  };
}

function createGetElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElements",
    description: "通过选择器获取页面元素数组，相当于 page.$$(selector)。返回 {selector,count,totalCount,limited,elements:[{index,tagName,text,value,size,offset}]}；limit 默认/最大 100，避免大页面一次汇总所有元素卡住连接；totalCount 是总命中数，count 是实际返回数。无匹配时返回 count:0 的空列表（不抛错，这是与会抛错的 page_getElement 的关键区别——批量/计数用本工具，单个必存在的元素用 page_getElement）。withWxml=true 给每个元素附完整 outerWxml。支持 `selector[index=N]`（0 基）只取第 N 个。⚠️ page.$$ 默认不穿透自定义组件（是否穿透取决于组件 styleIsolation/addGlobalClass，可用 page_getElements 看实际命中数判断）；组件内部元素用 element_getInnerElements，或 element_* 工具的 selector(组件)+innerSelector(内部)。结果超过 maxBytes（默认 50000B）返回截断包装。",
    parameters: getElementsParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getElementsParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          let selector = args.selector;
          let indexHint: number | undefined;
          
          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          let elements;
          try {
            elements = await page.$$(selector);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`查询选择器 "${selector}" 失败: ${message}`);
          }
          if (!Array.isArray(elements)) {
            throw new UserError(`查询选择器 "${selector}" 失败。`);
          }

          const totalCount = elements.length;
          let limited = false;
          if (indexHint !== undefined) {
            elements =
              indexHint >= 0 && indexHint < elements.length
                ? [elements[indexHint]]
                : [];
          } else {
            limited = elements.length > args.limit;
            elements = elements.slice(0, args.limit);
          }

          const elementsInfo: Array<Record<string, unknown>> = [];
          for (let index = 0; index < elements.length; index += 1) {
            elementsInfo.push({
                index: indexHint !== undefined ? indexHint : index,
                ...(await summarizeElement(elements[index], {
                  withWxml: args.withWxml,
                })),
            });
          }

          return clampedTextResult(
            {
              selector: args.selector,
              count: elements.length,
              totalCount,
              limit: indexHint === undefined ? args.limit : null,
              limited,
              elements: elementsInfo,
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                count: elements.length,
                totalCount,
                limited,
              },
              note: "元素列表超过 maxBytes 已截断。建议关闭 withWxml、缩小选择器或调大 maxBytes。",
            }
          );
        }
      );
      }),
  };
}

function createWaitForElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElement",
    description: "轮询等待选择器对应的元素出现（最长 timeout 毫秒，每 retryInterval 毫秒重试一次）。何时用：元素来自 setData 后异步渲染 / SSE 流式 / navigateTo 未稳定——先 wait 到再用 `page_getElement` 取内容（本工具只确认出现，返回 {selector,index?,found:true,waitTime}，不返回元素摘要）。元素若必然已存在则直接用 `page_getElement`（一次性、不存在即抛错）。等任意非元素条件（page.data 字段变化 / SSE done / aiStatus='completed'）用 `mp_pollUntil`（通用 predicate 轮询）。支持 `selector[index=N]`（0 基）。timeout 默认 5000ms，SSE/异步场景建议调大到 10000+；retryInterval 默认 200ms。超时抛错并带具体排查建议（模板插值 class / shadow 不穿透 / 连接级故障 / timeout 太短）。",
    parameters: waitForElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = waitForElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          const startTime = Date.now();
          const timeout = args.timeout;
          const retryInterval = args.retryInterval;

          let selector = args.selector;
          let indexHint: number | undefined;
          let lastError: string | null = null;

          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          while (Date.now() - startTime < timeout) {
            try {
              const remainingBeforeQuery = timeout - (Date.now() - startTime);
              let elements = await manager.withRequestTimeout(
                () => page.$$(selector),
                {
                  timeoutMs: Math.max(1, remainingBeforeQuery),
                  description: `等待元素查询 (${selector})`,
                }
              );
              lastError = null;
              if (!Array.isArray(elements)) {
                throw new UserError(`查询选择器 "${selector}" 失败。`);
              }
              if (elements.length === 0) {
              } else if (indexHint !== undefined) {
                if (indexHint >= 0 && indexHint < elements.length) {
                  return toTextResult(formatJson({
                    selector: args.selector,
                    index: indexHint,
                    found: true,
                    waitTime: Date.now() - startTime,
                  }));
                }
              } else {
                return toTextResult(formatJson({
                  selector: args.selector,
                  found: true,
                  waitTime: Date.now() - startTime,
                }));
              }
            } catch (error) {
              if (error instanceof UserError) {
                throw error;
              }
              // 记录底层错误（多为连接级故障），别让它被吞成"元素没找到"
              lastError = error instanceof Error ? error.message : String(error);
            }
            const remaining = timeout - (Date.now() - startTime);
            if (remaining > 0) {
              await new Promise(resolve =>
                setTimeout(resolve, Math.min(retryInterval, remaining))
              );
            }
          }

          throw new UserError(
            `等待元素 "${args.selector}" 超时 (${timeout}ms)。${lastError ? `⚠️ 轮询期间持续报错（很可能是连接级故障，而非元素缺失）：${lastError}。建议先调 mp_healthCheck，必要时 mp_recoverConnection。` : "可能原因：1) selector 含模板插值（如 `toast-{{variant}}`），渲染后字面值不同 — 调 `page_snapshot(selectors=[...], withWxml=true)` 看实际合成 class；2) 元素在自定义组件 shadow 内 — page.$ 默认不穿透（取决于 styleIsolation/addGlobalClass），改用 `element_getInnerElement(s)` + innerSelector；3) 元素真的没渲染 — 调 `page_snapshot(withElements=true)` 列出当前 DOM 摘要，或用 `mp_pollUntil` 等具体的 page.data 状态；4) timeout 太短 — 默认 5000ms，SSE/异步场景调大到 10000+。"}`
          );
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createWaitForElementGoneTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElementGone",
    description: "轮询等待选择器对应的元素从页面消失（最长 timeout 毫秒，每 retryInterval 毫秒重试）。何时用：验证 toast / loading / 弹窗 / 骨架屏已消失。成功返回 {selector,gone:true,waitTime}。带 `selector[index=N]` 时，该索引越界也算「已消失」。timeout 默认 5000ms，retryInterval 默认 200ms。等任意非元素条件（page.data 变化等）改用 `mp_pollUntil`。超时抛错;若轮询期间持续底层报错会提示可能是连接级故障，建议 mp_healthCheck / mp_recoverConnection。",
    parameters: waitForElementGoneParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = waitForElementGoneParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          const startTime = Date.now();
          const timeout = args.timeout;
          const retryInterval = args.retryInterval;

          let selector = args.selector;
          let indexHint: number | undefined;
          let lastError: string | null = null;

          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          while (Date.now() - startTime < timeout) {
            try {
              const remainingBeforeQuery = timeout - (Date.now() - startTime);
              const elements = await manager.withRequestTimeout(
                () => page.$$(selector),
                {
                  timeoutMs: Math.max(1, remainingBeforeQuery),
                  description: `等待元素消失查询 (${selector})`,
                }
              );
              lastError = null;
              if (!Array.isArray(elements)) {
                throw new UserError(`查询选择器 "${selector}" 失败。`);
              }
              const isGone =
                elements.length === 0 ||
                (indexHint !== undefined && (indexHint < 0 || indexHint >= elements.length));

              if (isGone) {
                return toTextResult(formatJson({
                  selector: args.selector,
                  gone: true,
                  waitTime: Date.now() - startTime,
                }));
              }
            } catch (error) {
              if (error instanceof UserError) {
                throw error;
              }
              lastError = error instanceof Error ? error.message : String(error);
            }
            const remaining = timeout - (Date.now() - startTime);
            if (remaining > 0) {
              await new Promise(resolve =>
                setTimeout(resolve, Math.min(retryInterval, remaining))
              );
            }
          }

          throw new UserError(
            `等待元素 "${args.selector}" 消失超时 (${timeout}ms)。${lastError ? `⚠️ 轮询期间持续报错（很可能是连接级故障）：${lastError}。建议先调 mp_healthCheck，必要时 mp_recoverConnection。` : ""}`
          );
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createWaitForRouteTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitRoute",
    description: "轮询等待当前页面路径变为指定值,用于验证跳转真正完成（尤其是由 tap / callMethod 间接触发的跳转）。path 传页面路由,与 page.path 同形：无前导 `/`、不含 query（如 `pages/detail/detail`）。成功返回 {path,matched:true,waitTime,query}；超时抛错并附当前实际 path 便于排查。注意：`mp_navigate` 返回的 activePage 已是可信的最新路由,导航后通常无需再 waitRoute;本工具主要用于间接跳转。timeout 默认 5000ms,retryInterval 默认 200ms。",
    parameters: waitForRouteParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = waitForRouteParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const startTime = Date.now();
          const timeout = args.timeout;
          const retryInterval = args.retryInterval;
          let lastError: string | null = null;
          let lastPath: string | null = null;

          while (Date.now() - startTime < timeout) {
            try {
              const remainingBeforeQuery = timeout - (Date.now() - startTime);
              const page = await manager.withRequestTimeout(
                () => miniProgram.currentPage(),
                {
                  timeoutMs: Math.max(1, remainingBeforeQuery),
                  description: "等待页面路由读取",
                }
              );
              lastError = null;
              lastPath = page?.path ?? null;
              if (page?.path === args.path) {
                return toTextResult(formatJson({
                  path: args.path,
                  matched: true,
                  waitTime: Date.now() - startTime,
                  query: toSerializableValue(page.query),
                }));
              }
            } catch (error) {
              lastError = error instanceof Error ? error.message : String(error);
            }
            const remaining = timeout - (Date.now() - startTime);
            if (remaining > 0) {
              await new Promise(resolve =>
                setTimeout(resolve, Math.min(retryInterval, remaining))
              );
            }
          }

          throw new UserError(
            `等待页面路径变为 "${args.path}" 超时 (${timeout}ms)。当前页面: "${lastPath ?? "(无)"}"。${lastError ? ` 轮询期间最近一次读取路由失败: ${lastError}。` : ""}`
          );
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createWaitForTimeoutTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitTimeout",
    description: "等待指定的毫秒数（dumb sleep）。⚠️ 仅用于「渲染 tick 留白」等无明确信号的极短等待；等任意条件（page.data 变化 / SSE done / 异步状态切换）请改用 `mp_pollUntil`，否则容易出现时间太短抓空 / 时间太长拖慢测试。",
    parameters: waitForTimeoutParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = waitForTimeoutParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await waitOnPage(page, args.milliseconds);
          return toTextResult(`已等待 ${args.milliseconds}ms。`);
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createExpectRouteTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectRoute",
    description: "一次性断言当前页面路径是否等于预期值（不轮询、不抛错——失败返回 pass:false）。返回 {pass,expected,actual,snapshot:{path,query}}，读 `pass` 判断结果。path 须与 page.path 同形：无前导 `/`、不含 query。若路由可能尚未稳定,先用 `page_waitRoute` 等到再断言。",
    parameters: expectRouteParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectRouteParameters.parse(rawArgs ?? {});
        return manager.withMiniProgram<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (miniProgram) => {
            const page = await readCurrentPage(
              manager,
              miniProgram,
              "路由断言读取当前页面"
            );
            const actual = page?.path ?? null;
            const pass = actual === args.path;
            return toTextResult(formatJson({
              pass,
              expected: args.path,
              actual,
              snapshot: {
                path: actual,
                query: toSerializableValue(page?.query ?? null),
              },
            }));
          }
        );
      }),
  };
}

function createExpectVisibleTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectVisible",
    description: "一次性断言选择器能否在页面定位到元素（基于 page.$$ 命中数 > 0,或带 [index=N] 时该索引在范围内）。⚠️ 只判「存在/可定位」,不检查视觉可见性（不看 display/opacity/视口）。不轮询、不抛错——结果在返回的 {pass,expected:true,actual,snapshot:{selector,count,index}} 的 `pass` 里。⚠️ page.$$ 默认不穿透自定义组件（是否穿透取决于组件 styleIsolation/addGlobalClass，可用 page_getElements 看实际命中数判断）,组件内部元素会误判 pass:false,此类用 element_getInnerElements 校验。支持 `selector[index=N]`（0 基）。",
    parameters: expectVisibleParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectVisibleParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            let selector = args.selector;
            let indexHint: number | undefined;
            const parsed = parseSelectorWithIndex(selector);
            if (parsed) {
              selector = parsed.baseSelector;
              indexHint = parsed.index;
            }
            if (typeof page.$$ !== "function") {
              throw new UserError("当前页面不支持查询元素数组。");
            }
            let elements;
            try {
              elements = await page.$$(selector);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new UserError(`查询选择器 "${selector}" 失败: ${message}`);
            }
            if (!Array.isArray(elements)) {
              throw new UserError(`查询选择器 "${selector}" 失败。`);
            }
            const count = elements.length;
            const pass = indexHint !== undefined ? indexHint >= 0 && indexHint < count : count > 0;
            return toTextResult(formatJson({
              pass,
              expected: true,
              actual: pass,
              snapshot: {
                selector: args.selector,
                count,
                index: indexHint ?? null,
              },
            }));
          }
        );
      }),
  };
}

function createExpectElementTextTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectElementText",
    description: "一次性断言元素文本（element.text(),含子节点渲染文本,非 input 的 value）是否匹配预期。mode='equals'(默认,整串精确相等) 或 'includes'(子串包含)。返回 {pass,expected,actual,snapshot:{selector,mode}}——读 `pass`,失败时看 `actual` 排查。结果超过 maxBytes（默认 50000B）会截断。⚠️ 与 page_expectVisible/Count 不同:元素不存在时本工具抛错(而非返回 pass:false)。支持 `selector[index=N]`（0 基）。校验 input/textarea 的输入值请改走 element 取 value,不要用本工具。",
    parameters: expectElementTextParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectElementTextParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            const element = await resolveElement(page, args.selector);
            if (typeof element?.text !== "function") {
              throw new UserError(`元素 "${args.selector}" 不支持读取文本。`);
            }
            let actual;
            try {
              actual = await element.text();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new UserError(`读取元素 "${args.selector}" 文本失败: ${message}`);
            }
            const normalized = typeof actual === "string" ? actual : String(actual ?? "");
            const pass = args.mode === "includes"
              ? normalized.includes(args.expected)
              : normalized === args.expected;
            return clampedTextResult(
              {
                pass,
                expected: args.expected,
                actual: normalized,
                snapshot: {
                  selector: args.selector,
                  mode: args.mode,
                },
              },
              args.maxBytes,
              {
                identity: {
                  pass,
                  selector: args.selector,
                  mode: args.mode,
                },
                note: "元素文本断言结果超过 maxBytes 已截断。",
              }
            );
          }
        );
      }),
  };
}

function createExpectCountTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectCount",
    description: "一次性断言匹配选择器的元素数量是否「精确等于」expected（基于 page.$$,不是 >=）。支持 `selector[index=N]`，此时命中该索引计 1、越界计 0。不抛错——结果在返回的 {pass,expected,actual,snapshot:{selector,index}} 的 `pass` 里,失败看 `actual`。⚠️ page.$$ 默认不穿透自定义组件（是否穿透取决于组件 styleIsolation/addGlobalClass，可用 page_getElements 看实际命中数判断）,组件内部的元素不计入,会偏少。",
    parameters: expectCountParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectCountParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            if (typeof page.$$ !== "function") {
              throw new UserError("当前页面不支持查询元素数组。");
            }
            const parsed = parseSelectorWithIndex(args.selector);
            const selector = parsed?.baseSelector ?? args.selector;
            let elements;
            try {
              elements = await page.$$(selector);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new UserError(`查询选择器 "${selector}" 失败: ${message}`);
            }
            if (!Array.isArray(elements)) {
              throw new UserError(`查询选择器 "${selector}" 失败。`);
            }
            const actual = parsed
              ? parsed.index >= 0 && parsed.index < elements.length
                ? 1
                : 0
              : elements.length;
            return toTextResult(formatJson({
              pass: actual === args.expected,
              expected: args.expected,
              actual,
              snapshot: {
                selector: args.selector,
                index: parsed?.index ?? null,
              },
            }));
          }
        );
      }),
  };
}

function createExpectDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectData",
    description: "一次性断言当前页面某个 data 路径的值是否与 expected 深度相等。expected 为必填——省略会抛错（早期省略会让缺失路径与 undefined 误判为相等而静默判过,故强制传)。返回 {pass,expected,actual,pathResolved,snapshot:{path}}:读 `pass`;`pathResolved`(=actual 是否 !==undefined) 用来区分「路径不存在」与「值确实是 undefined」。对象键插入顺序不影响比较结果。结果超过 maxBytes（默认 50000B）会截断。path 为单条点/方括号路径(如 `user.profile.name`、`list[0].id`),不支持 page_getData 的 `[*]` 通配投影。",
    parameters: expectDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectDataParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            const actual = await readPageData(
              manager,
              page,
              args.path,
              `读取页面数据 (${args.path})`
            );
            const actualSerialized = toSerializableValue(actual);
            const pass = areSerializableValuesEqual(actualSerialized, args.expected);
            const pathResolved = actual !== undefined;
            return clampedTextResult(
              {
                pass,
                expected: toSerializableValue(args.expected),
                actual: actualSerialized,
                pathResolved,
                snapshot: {
                  path: args.path,
                },
              },
              args.maxBytes,
              {
                identity: {
                  pass,
                  path: args.path,
                  pathResolved,
                },
                note: "页面数据断言结果超过 maxBytes 已截断。",
              }
            );
          }
        );
      }),
  };
}

function createPageSnapshotTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_snapshot",
    description: "返回当前页面的轻量结构快照,聚合 route、query、指定 data 路径、关键选择器的元素摘要。最适合「不确定页面上有什么」时探查 DOM/状态（page_waitElement 超时排查也会指向它）。返回 {route,query,selectors,elementCount,elementsLimited,processedSelectorCount,elementSummaryLimit,elements:[{selector,index,tagName,text,value,size,offset}],data?,hint?}。⚠️ 不传 selectors/dataPaths/withData 时只返回 route——这不代表页面为空,会附 hint 提示补参。withData=true 会把整棵 data 树塞进 data['$']（token 炸弹,大对象改用 dataPaths 按字段投影）。limit 默认 10,限制每个 selector 返回的元素数；所有 selector 合计最多汇总 100 个元素摘要，达到上限时 elementsLimited=true。整个快照超过 maxBytes（默认 50000B）返回 truncated 包装。单个已知字段用 page_getData,单个元素用 page_getElement。对自定义组件同样默认不穿透（取决于 styleIsolation/addGlobalClass）。",
    parameters: pageSnapshotParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = pageSnapshotParameters.parse(rawArgs ?? {});
        return manager.withMiniProgram<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (miniProgram) => {
            const page = await readCurrentPage(
              manager,
              miniProgram,
              "页面快照读取当前页面"
            );
            if (!page) {
              throw new UserError("当前没有可用页面，无法生成快照。");
            }

            const data: Record<string, unknown> = {};
            if (args.withData) {
              const fullData = await readPageData(
                manager,
                page,
                undefined,
                "读取页面完整数据快照"
              );
              setOwnEnumerableValue(data, "$", toSerializableValue(fullData));
            }

            for (const path of args.dataPaths) {
              const value = await readPageData(
                manager,
                page,
                path,
                `读取页面数据快照 (${path})`
              );
              setOwnEnumerableValue(data, path, toSerializableValue(value));
            }

            const elements: Array<Record<string, unknown>> = [];
            let processedSelectorCount = 0;
            let elementsLimited = false;
            if (args.withElements) {
              if (args.selectors.length > 0 && typeof page.$$ !== "function") {
                throw new UserError("当前页面不支持查询元素数组，无法生成请求的元素快照。");
              }
              for (const selector of args.selectors) {
                if (elements.length >= MAX_SNAPSHOT_ELEMENT_SUMMARIES) {
                  elementsLimited = true;
                  break;
                }
                let matched;
                try {
                  matched = await page.$$(selector);
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  throw new UserError(`查询选择器 "${selector}" 失败: ${message}`);
                }
                if (!Array.isArray(matched)) {
                  throw new UserError(`查询选择器 "${selector}" 失败。`);
                }
                processedSelectorCount++;
                const remaining =
                  MAX_SNAPSHOT_ELEMENT_SUMMARIES - elements.length;
                const list = matched.slice(0, Math.min(args.limit, remaining));
                if (matched.length > list.length) {
                  elementsLimited = true;
                }
                for (let index = 0; index < list.length; index += 1) {
                  elements.push({
                    selector,
                    index,
                    ...(await summarizeElement(list[index], {
                      withWxml: args.withWxml,
                    })),
                  });
                }
              }
              if (processedSelectorCount < args.selectors.length) {
                elementsLimited = true;
              }
            }

            const result: Record<string, unknown> = {
              route: page.path,
              query: toSerializableValue(page.query ?? null),
              selectors: args.selectors,
              elementCount: elements.length,
              elementsLimited,
              processedSelectorCount,
              elementSummaryLimit: MAX_SNAPSHOT_ELEMENT_SUMMARIES,
              elements,
            };
            if (Object.keys(data).length > 0) {
              result.data = data;
            }
            if (args.selectors.length === 0 && !args.withData && args.dataPaths.length === 0) {
              result.hint =
                "未提供 selectors / dataPaths / withData，仅返回 route。这并不代表页面为空。如需结构快照请传 selectors（如 ['.container', '.card']）或 withData=true 获取页面数据；按字段裁剪请用 dataPaths。";
            }
            return clampedTextResult(result, args.maxBytes, {
              identity: { route: page.path },
              note: "快照超过 maxBytes 已截断。建议缩小 selectors / 关闭 withWxml / 降低 limit，或调大 maxBytes。",
            });
          }
        );
      }),
  };
}

function createGetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getData",
    description:
      "获取当前页面的数据对象。三种模式：1) 无参 → 返回整树（小心 token 限制）；2) 传 path → 返回单个子路径；3) 传 paths[] → 按多路径投影（**推荐用于大对象**，支持 `conversationHistory[*].aiStatus` 这种 wildcard 语法、`conversationHistory.length`、`conversationHistory[-1].aiStatus` 负索引）。默认 maxBytes=50000 字节硬截断，超出返回 truncated=true 标识。paths 与 path 互斥时 paths 优先。",
    parameters: getPageDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getPageDataParameters.parse(rawArgs ?? {});
      const usePaths = Array.isArray(args.paths) && args.paths.length > 0;
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const data = await readPageData(
            manager,
            page,
            usePaths ? undefined : args.path,
            `读取页面数据${usePaths ? ` (paths=${args.paths!.length})` : args.path ? ` (${args.path})` : ""}`
          );

          let resultValue: unknown;
          let missing: string[] | null = null;
          if (usePaths) {
            const picked = pickByPaths(data, args.paths!);
            resultValue = picked.values;
            missing = picked.missing;
          } else {
            resultValue = toSerializableValue(data);
          }

          const dataBytes = Buffer.byteLength(
            JSON.stringify(resultValue) ?? "",
            "utf8"
          );
          // route = 实际解析到的当前页路由(注意 path 字段指的是数据子路径入参,二者不同)。
          // web-view 等场景下 DevTools 的 App.getCurrentPage 可能返回宿主/栈底页,
          // 回显 route 让「这次 data 到底来自哪个页」可见,避免静默读到别的页面数据。
          const route =
            typeof (page as { path?: unknown }).path === "string"
              ? (page as { path: string }).path
              : null;
          return clampedTextResult(
            {
              route,
              path: args.path ?? null,
              paths: args.paths ?? null,
              missingPaths: missing,
              truncated: false,
              bytes: dataBytes,
              maxBytes: args.maxBytes,
              data: resultValue,
            },
            args.maxBytes,
            {
              identity: {
                route,
                path: args.path ?? null,
                paths: args.paths ?? null,
                // 截断时也保留诊断价值高、体积小的 missingPaths。
                missingPaths: missing,
              },
              note: "页面数据结果超过 maxBytes 已截断。建议改用 paths 只读取需要的字段。",
            }
          );
        }
      );
      }),
  };
}

function createSetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_setData",
    description: "用 page.setData 直接更新当前页面 data（传 data 对象,最多 100 个键;键为顶层字段或微信路径语法如 `list[0].done`,作为部分合并写入）。返回已更新的键名列表确认,不回显值。⚠️ 直接改状态、绕过页面逻辑/事件处理——若想模拟真实交互请改用 `page_callMethod` 调页面方法或用 element_tap 等触发;本工具仅用于强制构造测试状态。",
    parameters: setPageDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = setPageDataParameters.parse(rawArgs ?? {});
      const dataKeys = Object.keys(args.data ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          try {
            await page.setData(args.data);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`更新页面数据失败: ${message}`);
          }
          return toTextResult(
            `已更新页面数据键: ${dataKeys.length ? dataKeys.join(", ") : "(无)"}。`
          );
        }
      );
      }),
  };
}

function createCallPageMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_callMethod",
    description: "调用当前页面实例上暴露的方法(等价 page.callMethod(method, ...args),会 await 结果)。args[] 按位置展开为实参(非命名参数;传一个对象就是第一个位置参数)。返回 {method,arguments,result},result 为方法返回值。何时用:触发页面真实逻辑(优于直接 page_setData 改状态);调组件实例方法用 element_callMethod。方法不存在或内部抛错会以 UserError 返回失败信息。",
    parameters: callPageMethodParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = callPageMethodParameters.parse(rawArgs ?? {});
      const callArgs = args.args ?? [];
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          let result;
          try {
            result = await page.callMethod(args.method, ...callArgs);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`调用页面方法 "${args.method}" 失败: ${message}`);
          }
          return clampedTextResult(
            {
              method: args.method,
              arguments: callArgs,
              result: toSerializableValue(result),
            },
            args.maxBytes,
            {
              identity: { method: args.method },
              note: "页面方法返回结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
  };
}

async function readPageData(
  manager: WeappAutomatorManager,
  page: any,
  path: string | undefined,
  description: string
): Promise<unknown> {
  try {
    return await manager.withRequestTimeout(
      () => (path === undefined ? page.data() : page.data(path)),
      { description }
    );
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`${description}失败: ${message}`);
  }
}
