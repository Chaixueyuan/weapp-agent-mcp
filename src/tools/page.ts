import { UserError, type ContentResult } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  connectionContainerSchema,
  formatJson,
  summarizeElement,
  toSerializableValue,
  toTextResult,
  resolveElement,
  parseSelectorWithIndex,
  withUserErrorResult,
} from "./common.js";

const getPageDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
});

const setPageDataParameters = connectionContainerSchema.extend({
  data: z.record(z.string(), z.unknown()),
});

const callPageMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const waitForElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  timeout: z.coerce.number().int().positive().optional().default(5000),
  retryInterval: z.coerce.number().int().positive().optional().default(200),
});

const waitForTimeoutParameters = connectionContainerSchema.extend({
  milliseconds: z.coerce.number().int().nonnegative(),
});

const waitForElementGoneParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  timeout: z.coerce.number().int().positive().optional().default(5000),
  retryInterval: z.coerce.number().int().positive().optional().default(200),
});

const waitForRouteParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1),
  timeout: z.coerce.number().int().positive().optional().default(5000),
  retryInterval: z.coerce.number().int().positive().optional().default(200),
});

const getElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  withWxml: z.boolean().optional().default(false),
});

const getElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  withWxml: z.boolean().optional().default(false),
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
});

const expectCountParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  expected: z.coerce.number().int().nonnegative(),
});

const expectDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1),
  expected: z.unknown(),
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
    createGetPageDataTool(manager),
    createSetPageDataTool(manager),
    createCallPageMethodTool(manager),
  ];
}

function createGetElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElement",
    description: "通过选择器获取页面元素，相当于 page.$(selector)。返回每个元素的摘要信息（tagName、text、value、size、offset）；设置 withWxml 为 true 可额外返回元素的完整 outerWxml。支持 [index=N] 语法选择第 N 个元素。",
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
            return toTextResult(
              formatJson({
                selector: args.selector,
                index: null,
                ...summary,
              })
            );
          }

          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          let elements = await page.$$(selector);
          if (!Array.isArray(elements) || elements.length === 0) {
            throw new UserError(`元素未找到: "${selector}"`);
          }

          // 如果有索引提示，取对应元素
          if (indexHint !== undefined) {
            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }
            elements = [elements[indexHint]];
          }

          let element = elements[0];
          if (args.innerSelector) {
            if (typeof element.$ !== "function") {
              throw new UserError(`元素 "${args.selector}" 不支持查询内部元素。`);
            }
            const inner = await element.$(args.innerSelector);
            if (!inner) {
              throw new UserError(
                `在元素 "${args.selector}" 内未找到选择器 "${args.innerSelector}" 对应的元素。`
              );
            }
            element = inner;
          }

          const summary = await summarizeElement(element, { withWxml: args.withWxml });
          return toTextResult(formatJson({
            selector: args.selector,
            index: indexHint,
            ...summary,
          }));
        }
      );
      }),
  };
}

function createGetElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElements",
    description: "通过选择器获取页面元素数组，相当于 page.$$(selector)。返回每个元素的摘要信息（tagName、text、value、size、offset）；设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。支持 [index=N] 语法选择第 N 个元素。",
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

          let elements = await page.$$(selector);
          if (!Array.isArray(elements)) {
            throw new UserError(`查询选择器 "${selector}" 失败。`);
          }

          if (indexHint !== undefined) {
            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }
            elements = [elements[indexHint]];
          }

          const elementsInfo = await Promise.all(
            elements.map(async (el: any, index: number) => {
              const summary = await summarizeElement(el, { withWxml: args.withWxml });
              return {
                index: indexHint !== undefined ? indexHint : index,
                ...summary,
              };
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              count: elements.length,
              elements: elementsInfo,
            })
          );
        }
      );
      }),
  };
}

function createWaitForElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElement",
    description: "等待指定选择器的元素出现在页面上。支持 [index=N] 语法选择第 N 个元素。增强版：增加了超时和重试间隔参数。",
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

          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          while (Date.now() - startTime < timeout) {
            try {
              let elements = await page.$$(selector);
              if (!Array.isArray(elements) || elements.length === 0) {
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
            }
            await new Promise(resolve => setTimeout(resolve, retryInterval));
          }

          throw new UserError(`等待元素 "${args.selector}" 超时 (${timeout}ms)。`);
        }
      );
      }),
  };
}

function createWaitForElementGoneTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElementGone",
    description: "等待指定选择器的元素从页面上消失。支持 [index=N] 语法选择第 N 个元素。",
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

          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          while (Date.now() - startTime < timeout) {
            try {
              const elements = await page.$$(selector);
              const isGone =
                !Array.isArray(elements) ||
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
            }
            await new Promise(resolve => setTimeout(resolve, retryInterval));
          }

          throw new UserError(`等待元素 "${args.selector}" 消失超时 (${timeout}ms)。`);
        }
      );
      }),
  };
}

function createWaitForRouteTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitRoute",
    description: "等待当前页面路径变为指定值。适合验证页面跳转是否真正完成。",
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

          while (Date.now() - startTime < timeout) {
            const page = await miniProgram.currentPage();
            if (page?.path === args.path) {
              return toTextResult(formatJson({
                path: args.path,
                matched: true,
                waitTime: Date.now() - startTime,
                query: toSerializableValue(page.query),
              }));
            }
            await new Promise(resolve => setTimeout(resolve, retryInterval));
          }

          const currentPage = await miniProgram.currentPage().catch(() => null);
          throw new UserError(
            `等待页面路径变为 "${args.path}" 超时 (${timeout}ms)。当前页面: "${currentPage?.path ?? "(无)"}"。`
          );
        }
      );
      }),
  };
}

function createWaitForTimeoutTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitTimeout",
    description: "等待指定的毫秒数。",
    parameters: waitForTimeoutParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = waitForTimeoutParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await page.waitFor(args.milliseconds);
          return toTextResult(`已等待 ${args.milliseconds}ms。`);
        }
      );
      }),
  };
}

function createExpectRouteTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectRoute",
    description: "断言当前页面路径是否等于预期值。",
    parameters: expectRouteParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectRouteParameters.parse(rawArgs ?? {});
        return manager.withMiniProgram<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (miniProgram) => {
            const page = await miniProgram.currentPage();
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
    description: "断言页面上是否存在可定位到的元素。支持 [index=N] 语法。",
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
            const elements = typeof page.$$ === "function" ? await page.$$(selector) : [];
            const count = Array.isArray(elements) ? elements.length : 0;
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
    description: "断言元素文本是否等于或包含预期值。支持 [index=N] 语法。",
    parameters: expectElementTextParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectElementTextParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            const element = await resolveElement(page, args.selector);
            const actual = typeof element?.text === "function" ? await element.text().catch(() => null) : null;
            const normalized = typeof actual === "string" ? actual : String(actual ?? "");
            const pass = args.mode === "includes"
              ? normalized.includes(args.expected)
              : normalized === args.expected;
            return toTextResult(formatJson({
              pass,
              expected: args.expected,
              actual: normalized,
              snapshot: {
                selector: args.selector,
                mode: args.mode,
              },
            }));
          }
        );
      }),
  };
}

function createExpectCountTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_expectCount",
    description: "断言页面上匹配选择器的元素数量是否等于预期值。",
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
            const elements = await page.$$(args.selector);
            const actual = Array.isArray(elements) ? elements.length : 0;
            return toTextResult(formatJson({
              pass: actual === args.expected,
              expected: args.expected,
              actual,
              snapshot: {
                selector: args.selector,
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
    description: "断言当前页面指定 data 路径的值是否与预期相等。",
    parameters: expectDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = expectDataParameters.parse(rawArgs ?? {});
        return manager.withPage<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (page) => {
            const actual = await manager.withRequestTimeout(
              () => page.data(args.path),
              { description: `读取页面数据 (${args.path})` }
            );
            const pass = JSON.stringify(toSerializableValue(actual)) === JSON.stringify(toSerializableValue(args.expected));
            return toTextResult(formatJson({
              pass,
              expected: toSerializableValue(args.expected),
              actual: toSerializableValue(actual),
              snapshot: {
                path: args.path,
              },
            }));
          }
        );
      }),
  };
}

function createGetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getData",
    description: "获取当前页面的数据对象，可选择指定子数据路径。",
    parameters: getPageDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getPageDataParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const data = await manager.withRequestTimeout(
            () => page.data(args.path),
            { description: `读取页面数据${args.path ? ` (${args.path})` : ""}` }
          );
          return toTextResult(
            formatJson({
              path: args.path ?? null,
              data: toSerializableValue(data),
            })
          );
        }
      );
      }),
  };
}

function createSetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_setData",
    description: "使用 setData 更新当前页面的数据。",
    parameters: setPageDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = setPageDataParameters.parse(rawArgs ?? {});
      const dataKeys = Object.keys(args.data ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await page.setData(args.data);
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
    description: "调用当前页面实例上暴露的方法。参数可以作为数组提供。",
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
          return toTextResult(
            formatJson({
              method: args.method,
              arguments: callArgs,
              result: toSerializableValue(result),
            })
          );
        }
      );
      }),
  };
}
