import { UserError } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  booleanish,
  clampedTextResult,
  connectionContainerSchema,
  formatJson,
  maxBytesSchema,
  numberish,
  resolveElement,
  setOwnEnumerableValue,
  summarizeElement,
  toSerializableValue,
  toTextResult,
  waitOnPage,
  parseSelectorWithIndex,
  withUserErrorResult,
} from "./common.js";

const tapElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  waitMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
});

const touchMovePointSchema = z.object({
  x: numberish(z.number().finite()),
  y: numberish(z.number().finite()),
  delayMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
}).strict();

const touchElementParameters = connectionContainerSchema
  .extend({
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    phase: z.enum(["start", "move", "end", "sequence"]),
    x: numberish(z.number().finite()).optional(),
    y: numberish(z.number().finite()).optional(),
    moves: z.array(touchMovePointSchema).max(100).optional(),
    holdMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
    waitMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
    identifier: numberish(z.number().int().nonnegative()).optional().default(1),
  })
  .superRefine((value, context) => {
    if (value.phase !== "sequence" && value.moves !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["moves"],
        message: "moves is only supported when phase is 'sequence'",
      });
    }
    if (
      (value.phase === "move" || value.phase === "end") &&
      value.holdMs !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["holdMs"],
        message: "holdMs is only supported when phase is 'start' or 'sequence'",
      });
    }
    const totalMs =
      (value.holdMs ?? 0) +
      (value.waitMs ?? 0) +
      (value.moves ?? []).reduce((sum, move) => sum + (move.delayMs ?? 0), 0);
    if (totalMs > 600000) {
      context.addIssue({
        code: "custom",
        message: "touch gesture total wait budget must not exceed 600000ms",
      });
    }
  });

const swipeElementParameters = connectionContainerSchema
  .extend({
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    direction: z.enum(["up", "down", "left", "right"]),
    distance: numberish(z.number().positive().finite()).optional(),
    durationMs: numberish(z.number().int().positive().max(600000)).optional().default(300),
    startX: numberish(z.number().finite()).optional(),
    startY: numberish(z.number().finite()).optional(),
    waitMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
    identifier: numberish(z.number().int().nonnegative()).optional().default(1),
  })
  .superRefine((value, context) => {
    if ((value.durationMs ?? 300) + (value.waitMs ?? 0) > 600000) {
      context.addIssue({
        code: "custom",
        message: "swipe durationMs + waitMs must not exceed 600000ms",
      });
    }
  });

const inputTextParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  value: z.union([z.string(), z.number().finite()]),
});

const callElementMethodParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).max(100).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const setElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  data: z
    .record(z.string(), z.unknown())
    .refine((value) => Object.keys(value).length <= 100, {
      message: "data must contain at most 100 entries",
    }),
});

const getInnerElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
  withWxml: booleanish.optional().default(false),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getInnerElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
  withWxml: booleanish.optional().default(false),
  limit: numberish(z.number().int().positive().max(100)).optional().default(100),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getElementWxmlParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  outer: booleanish.optional().default(false),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getElementStylesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)).min(1).max(100),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const scrollToParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  x: numberish(z.number().finite()),
  y: numberish(z.number().finite()),
});

const getAttributesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)).min(1).max(100),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const getBoundingClientRectParameters = connectionContainerSchema
  .extend({
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.innerSelector && parseSelectorWithIndex(value.selector)) {
      context.addIssue({
        code: "custom",
        path: ["selector"],
        message:
          "selector[index=N] cannot be combined with innerSelector for boundingClientRect",
      });
    }
  });

export function createElementTools(
  manager: WeappAutomatorManager
): AnyTool[] {
  return [
    createTapElementTool(manager),
    createTouchElementTool(manager),
    createSwipeElementTool(manager),
    createInputTextTool(manager),
    createCallElementMethodTool(manager),
    createGetElementDataTool(manager),
    createSetElementDataTool(manager),
    createGetInnerElementTool(manager),
    createGetInnerElementsTool(manager),
    createGetElementWxmlTool(manager),
    createGetElementStylesTool(manager),
    createScrollToTool(manager),
    createGetAttributesTool(manager),
    createGetBoundingClientRectTool(manager),
  ];
}

function createTapElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_tap",
    description: "模拟点击 WXML 元素(element.tap())。selector 用 CSS 选择器定位;要点击自定义组件内部的元素时,用 selector 定位组件(如 #my-comp 或标签名)、innerSelector 定位组件内部元素 —— 这是 page_* 无法穿透自定义组件时的正确做法。selector 支持 [index=N] 取第 N 个(0 基,仅作用于 selector,innerSelector 内不支持下标)。waitMs:点击后额外等待的毫秒数,用于等待导航/重渲染稳定再做下一步。",
    parameters: tapElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = tapElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          try {
            await element.tap();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `点击元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 失败: ${message}`
            );
          }

          if (waitMs) {
            await waitOnPage(page, waitMs);
          }

          return toTextResult(
            `已点击元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""}${waitMs ? ` 并等待 ${waitMs}ms` : ""}。`
          );
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createTouchElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_touch",
    description: "对元素派发底层触摸事件(touchstart/touchmove/touchend)。多数场景不需要它:简单点击用 element_tap,滑动/拖拽用 element_swipe;只有需要自定义多点/长按/分段手势时才用本工具。phase:'start'/'move'/'end' 是单个事件,需自己跨多次调用拼成完整手势;'sequence' 在一次调用内完成 touchstart→moves→touchend(推荐)。x/y 可选,相对元素左上角的像素坐标,默认取元素中心。moves[] 仅在 'sequence' 下使用,是中间移动点序列(每点可带 delayMs)。holdMs:touchstart 后按住的毫秒数(长按)。identifier:触摸点 id(多指时区分,默认 1)。waitMs:整个手势后额外等待毫秒。innerSelector:定位自定义组件内部元素(selector 定位组件)。selector 支持 [index=N](仅作用于 selector)。",
    parameters: touchElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = touchElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      try {
        return await manager.withPage(
          context.log,
          { overrides: args.connection },
          async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const position = await getResolvedTouchPosition(element, {
            x: args.x,
            y: args.y,
            identifier: args.identifier,
          });

          if (args.phase === "start") {
            await element.touchstart(buildTouchEvent(position));
            if (args.holdMs) {
              await waitOnPage(page, args.holdMs);
            }
          } else if (args.phase === "move") {
            await element.touchmove(buildTouchEvent(position));
          } else if (args.phase === "end") {
            await element.touchend(buildTouchEndEvent(position));
          } else {
            let started = false;
            let ended = false;
            let finalPosition = position;
            try {
              await element.touchstart(buildTouchEvent(position));
              started = true;

              if (args.holdMs) {
                await waitOnPage(page, args.holdMs);
              }

              const moves = args.moves ?? [];
              for (const move of moves) {
                finalPosition = await getResolvedTouchPosition(element, {
                  x: move.x,
                  y: move.y,
                  identifier: args.identifier,
                });
                await element.touchmove(buildTouchEvent(finalPosition));
                if (move.delayMs) {
                  await waitOnPage(page, move.delayMs);
                }
              }

              await element.touchend(buildTouchEndEvent(finalPosition));
              ended = true;
            } finally {
              if (started && !ended) {
                await element
                  .touchend(buildTouchEndEvent(finalPosition))
                  .catch(() => undefined);
              }
            }
          }

          if (waitMs) {
            await waitOnPage(page, waitMs);
          }

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              phase: args.phase,
              start: position,
              moves: args.moves ?? [],
              holdMs: args.holdMs ?? 0,
              waitMs: waitMs ?? 0,
            })
          );
          }
        );
      } catch (error) {
        if (error instanceof UserError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(
          `对元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 执行触摸操作失败: ${message}`
        );
      }
      }),
    timeoutMs: 660000,
  };
}

function createSwipeElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_swipe",
    description: "对元素执行真实滑动手势(自动 touchstart→多段 touchmove→touchend),适合列表/轮播/可拖拽区域等需要 touch 序列的场景。比 element_touch 简单,优先用本工具做滑动。direction:手指移动方向 up/down/left/right。distance:滑动距离 px,默认取元素宽或高的 60%。durationMs:手势总时长,默认 300。startX/startY:起点相对元素左上角的像素坐标,默认元素中心。waitMs:手势后额外等待毫秒。innerSelector:定位自定义组件内部元素(selector 定位组件)。selector 支持 [index=N](仅作用于 selector)。",
    parameters: swipeElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = swipeElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      try {
        return await manager.withPage(
          context.log,
          { overrides: args.connection },
          async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const metrics = await getElementMetrics(element);
          const start = resolveTouchPosition(metrics, {
            x: args.startX,
            y: args.startY,
            identifier: args.identifier,
          });

          const distance = args.distance ?? getDefaultSwipeDistance(metrics.size, args.direction);
          const durationMs = args.durationMs ?? 300;
          const steps = 6;
          const delayMs = Math.max(0, Math.round(durationMs / steps));
          const moves = buildSwipeMoves({
            startX: start.pageX,
            startY: start.pageY,
            distance,
            direction: args.direction,
            steps,
            delayMs,
          });

          let started = false;
          let ended = false;
          let finalPosition = start;
          try {
            await element.touchstart(buildTouchEvent(start));
            started = true;
            for (const move of moves) {
              finalPosition = {
                identifier: args.identifier,
                pageX: move.pageX,
                pageY: move.pageY,
              };
              await element.touchmove(buildTouchEvent(finalPosition));
              if (move.delayMs) {
                await waitOnPage(page, move.delayMs);
              }
            }

            await element.touchend(buildTouchEndEvent(finalPosition));
            ended = true;
          } finally {
            if (started && !ended) {
              await element
                .touchend(buildTouchEndEvent(finalPosition))
                .catch(() => undefined);
            }
          }

          if (waitMs) {
            await waitOnPage(page, waitMs);
          }

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              direction: args.direction,
              distance,
              durationMs,
              start,
              end: {
                pageX: finalPosition.pageX,
                pageY: finalPosition.pageY,
              },
              steps,
              waitMs: waitMs ?? 0,
            })
          );
          }
        );
      } catch (error) {
        if (error instanceof UserError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(
          `对元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 执行滑动操作失败: ${message}`
        );
      }
      }),
    timeoutMs: 660000,
  };
}

function createInputTextTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_input",
    description: "向输入类元素(input/textarea 等)填值(element.input())。value 接受字符串或数字。要填自定义组件内部的输入框时,用 selector 定位组件、innerSelector 定位内部输入元素。selector 支持 [index=N] 取第 N 个(0 基,仅作用于 selector)。注意:非输入类元素调用会失败。",
    parameters: inputTextParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = inputTextParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          try {
            await element.input(args.value);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `向元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 输入失败: ${message}`
            );
          }
          return toTextResult(
            `已向元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 输入值 "${args.value}"。`
          );
        }
      );
      }),
  };
}

function createCallElementMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_callMethod",
    description: "调用自定义组件实例的方法(element.callMethod()),返回该方法的返回值(序列化后放在 result)。仅对自定义组件实例有效,普通 WXML 元素会失败;调用页面级方法请用 page_callMethod。读/写组件实例数据用 element_getData / element_setData。method:方法名;args:按顺序展开传入方法的参数数组。要定位嵌套在外层组件内的组件,用 selector + innerSelector。selector 支持 [index=N](仅作用于 selector)。",
    parameters: callElementMethodParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = callElementMethodParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const callArgs = args.args ?? [];
          let result;
          try {
            result = await element.callMethod(args.method, ...callArgs);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `调用元素方法 "${args.method}"（${args.selector}${args.innerSelector ? ` -> ${args.innerSelector}` : ""}）失败: ${message}。注意 element_callMethod 仅对自定义组件实例有效。`
            );
          }
          return clampedTextResult(
            {
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              method: args.method,
              arguments: callArgs,
              result: toSerializableValue(result),
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                innerSelector: args.innerSelector ?? null,
                method: args.method,
              },
              note: "组件方法返回结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
  };
}

function createGetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getData",
    description: "读取自定义组件实例的渲染数据(element.data())。仅对自定义组件实例有效;读页面 data 用 page_getData。不传 path 返回整棵组件 data(可能很大、易超 token 上限,建议尽量传 path)。path 取精确子值,如 'list.0.id'(单条路径,不支持 page_getData 的 paths[] 多路径/[*] 通配)。结果超过 maxBytes(默认 50000B,最大 1000000B)会截断。要定位嵌套组件用 selector + innerSelector。selector 支持 [index=N](仅作用于 selector)。",
    parameters: getElementDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getElementDataParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          let data;
          try {
            data = await manager.withRequestTimeout(
              () => (args.path !== undefined ? element.data(args.path) : element.data()),
              { description: `读取组件数据${args.path ? ` (${args.path})` : ""}` }
            );
          } catch (error) {
            if (error instanceof UserError) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            const hint = /is not a function/i.test(message)
              ? "。该 selector 可能选到了组件内部的普通元素（element.data 仅对自定义组件实例有效）；请改用组件标签选择器（如 feature-card[index=0] / custom-tab-bar），而非组件内部的根 class"
              : "";
            throw new UserError(
              `读取组件数据（${args.selector}${args.innerSelector ? ` -> ${args.innerSelector}` : ""}）失败: ${message}${hint}`
            );
          }
          return clampedTextResult(
            {
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              path: args.path ?? null,
              data: toSerializableValue(data),
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                innerSelector: args.innerSelector ?? null,
                path: args.path ?? null,
              },
              note: "组件数据超过 maxBytes 已截断。建议传 path 只读取需要的字段。",
            }
          );
        }
      );
      }),
  };
}

function createSetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_setData",
    description: "写自定义组件实例的渲染数据(element.setData())。仅对自定义组件实例有效;写页面 data 用 page_setData,读用 element_getData。data 为最多 100 个键的 键→值 对象,合并进组件 data(键可用小程序 setData 的路径写法如 'list[0].done')。要定位嵌套组件用 selector + innerSelector。selector 支持 [index=N](仅作用于 selector)。",
    parameters: setElementDataParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = setElementDataParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const dataKeys = Object.keys(args.data ?? {});
          try {
            await element.setData(args.data);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `更新组件数据（${args.selector}${args.innerSelector ? ` -> ${args.innerSelector}` : ""}）失败: ${message}。注意 element_setData 仅对自定义组件实例有效。`
            );
          }
          return toTextResult(
            `已更新组件数据键: ${dataKeys.length ? dataKeys.join(", ") : "(无)"}。`
          );
        }
      );
      }),
  };
}

function createGetInnerElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getInnerElement",
    description: "在一个已定位元素的范围内查询单个子元素(element.$(targetSelector)),返回该子元素摘要(tagName/text/value/size/offset)。用法:selector(+可选 innerSelector)先定位作用域元素,targetSelector 是在该作用域内执行的查询 —— 适合在某容器/自定义组件内部缩小查询范围;若从页面根查询请用 page_getElement。withWxml=true 时额外返回该子元素的完整 outerWxml(可能很大)。结果超过 maxBytes(默认 50000B)返回 {truncated,bytes,maxBytes,note,data} 包装,关掉 withWxml 或调大 maxBytes。selector 支持 [index=N](仅作用于 selector,innerSelector/targetSelector 内不支持下标)。",
    parameters: getInnerElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getInnerElementParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.$ !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持查询内部元素。`
            );
          }

          let innerElement;
          try {
            innerElement = await element.$(args.targetSelector);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `在元素 "${args.selector}" 内查询选择器 "${args.targetSelector}" 失败: ${message}`
            );
          }
          if (!innerElement) {
            throw new UserError(
              `在元素 "${args.selector}" 内未找到选择器 "${args.targetSelector}" 对应的元素。`
            );
          }

          const summary = await summarizeElement(innerElement, { withWxml: args.withWxml });

          return clampedTextResult(
            {
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              ...summary,
            },
            args.maxBytes,
            {
              identity: {
                parentSelector: args.selector,
                parentInnerSelector: args.innerSelector ?? null,
                targetSelector: args.targetSelector,
              },
              note: "结果超过 maxBytes 已截断。建议关闭 withWxml 或调大 maxBytes。",
            }
          );
        }
      );
      }),
  };
}

function createGetInnerElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getInnerElements",
    description: "在一个已定位元素的范围内查询子元素数组(element.$$(targetSelector)),返回 {count,totalCount,limited,elements[]},每个元素含摘要(tagName/text/value/size/offset)及其数组 index。limit 默认/最大 100，避免一次汇总全部子元素卡住连接；totalCount 是总命中数，count 是实际返回数。用法:selector(+可选 innerSelector)定位作用域元素,targetSelector 是在该作用域内执行的查询。withWxml=true 额外返回每个元素的完整 outerWxml。结果超过 maxBytes(默认 50000B)返回截断包装。selector 支持 [index=N](仅作用于 selector,innerSelector/targetSelector 内不支持下标)。",
    parameters: getInnerElementsParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getInnerElementsParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.$$ !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持查询内部元素数组。`
            );
          }

          let innerElements;
          try {
            innerElements = await element.$$(args.targetSelector);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `在元素 "${args.selector}" 内查询选择器 "${args.targetSelector}" 失败: ${message}`
            );
          }
          if (!Array.isArray(innerElements)) {
            throw new UserError(
              `在元素 "${args.selector}" 内查询选择器 "${args.targetSelector}" 失败。`
            );
          }

          const totalCount = innerElements.length;
          const limitedElements = innerElements.slice(0, args.limit);
          const elementsInfo: Array<Record<string, unknown>> = [];
          for (let index = 0; index < limitedElements.length; index += 1) {
            elementsInfo.push({
                index,
                ...(await summarizeElement(limitedElements[index], {
                  withWxml: args.withWxml,
                })),
            });
          }

          return clampedTextResult(
            {
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              count: limitedElements.length,
              totalCount,
              limit: args.limit,
              limited: limitedElements.length < totalCount,
              elements: elementsInfo,
            },
            args.maxBytes,
            {
              identity: {
                parentSelector: args.selector,
                targetSelector: args.targetSelector,
                count: limitedElements.length,
                totalCount,
                limited: limitedElements.length < totalCount,
              },
              note: "结果超过 maxBytes 已截断。建议关闭 withWxml 或调大 maxBytes。",
            }
          );
        }
      );
      }),
  };
}

function createGetElementWxmlTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getWxml",
    description: "获取元素 WXML。默认 element.wxml() 返回内部 WXML;outer=true 返回含元素自身的 outerWxml。要读自定义组件内部的 WXML,用 selector 定位组件、innerSelector 定位内部元素。结果超过 maxBytes(默认 50000B)返回 {truncated,bytes,maxBytes,note,data} 包装(WXML 最容易撑爆);截断时改用更具体的 selector 或调大 maxBytes。selector 支持 [index=N](仅作用于 selector)。",
    parameters: getElementWxmlParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getElementWxmlParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const methodName = args.outer ? "outerWxml" : "wxml";
          if (typeof element[methodName] !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取 ${methodName}。`
            );
          }

          let wxml;
          try {
            wxml = await element[methodName]();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `获取元素 "${args.selector}" 的 ${methodName} 失败: ${message}`
            );
          }
          return clampedTextResult(
            {
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              type: args.outer ? "outerWxml" : "wxml",
              wxml: toSerializableValue(wxml),
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                type: args.outer ? "outerWxml" : "wxml",
              },
              note: "WXML 超过 maxBytes 已截断。建议改用更具体的 selector 或调大 maxBytes。",
            }
          );
        }
      );
      }),
  };
}

function createGetElementStylesTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getStyles",
    description: "读取元素的计算样式值(element.style(name))。names 为样式名数组,用 camelCase(如 ['color','fontSize','backgroundColor']);单个读不到的名返回 null,全部读取失败则报错。结果超过 maxBytes（默认 50000B）会截断。要读自定义组件内部元素的样式,用 selector 定位组件、innerSelector 定位内部元素。selector 支持 [index=N](仅作用于 selector)。",
    parameters: getElementStylesParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getElementStylesParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.style !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取样式。`
            );
          }

          const styles: Record<string, unknown> = {};
          const errors: unknown[] = [];
          for (const name of args.names) {
            try {
              setOwnEnumerableValue(styles, name, toSerializableValue(await element.style(name)));
            } catch (error) {
              errors.push(error);
              setOwnEnumerableValue(styles, name, null);
            }
          }
          if (errors.length === args.names.length) {
            const firstError = errors[0];
            const message = firstError instanceof Error ? firstError.message : String(firstError);
            throw new UserError(`读取元素 "${args.selector}" 样式失败: ${message}`);
          }

          return clampedTextResult(
            {
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              styles,
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                innerSelector: args.innerSelector ?? null,
              },
              note: "元素样式结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
  };
}

function createScrollToTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_scrollTo",
    description: "将 scroll-view 组件滚动到指定绝对偏移(element.scrollTo(x,y))。仅对 scroll-view 组件有效,其它元素会失败;非 scroll-view 的滚动用手势 element_swipe。x/y 为目标 scrollLeft/scrollTop 像素值(绝对位置,非增量)。要定位自定义组件内部的 scroll-view,用 selector 定位组件、innerSelector 定位内部元素。selector 支持 [index=N](仅作用于 selector)。",
    parameters: scrollToParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = scrollToParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.scrollTo !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持滚动操作，仅 scroll-view 组件可使用此功能。`
            );
          }

          try {
            await element.scrollTo(args.x, args.y);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `滚动元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 失败: ${message}`
            );
          }

          return toTextResult(
            `已将元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 滚动到位置 (${args.x}, ${args.y})。`
          );
        }
      );
      }),
  };
}

function createGetAttributesTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getAttributes",
    description: "读取元素的 WXML 特性值(element.attribute(name)),如 ['class','id','data-index']。读 CSS 样式请用 element_getStyles。单个读不到的特性返回 null,全部读取失败则报错。结果超过 maxBytes（默认 50000B）会截断。要读自定义组件内部元素的特性,用 selector 定位组件、innerSelector 定位内部元素。selector 支持 [index=N](仅作用于 selector)。⚠️ 对象型 data-*(如 data-item 绑定了对象)经 WXML attribute 只能拿到字符串 '[object Object]'——需要结构化值请改用 element_getBoundingClientRect 返回的 dataset。",
    parameters: getAttributesParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getAttributesParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.attribute !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取特性。`
            );
          }

          const attributes: Record<string, unknown> = {};
          const errors: unknown[] = [];
          for (const name of args.names) {
            try {
              setOwnEnumerableValue(attributes, name, toSerializableValue(await element.attribute(name)));
            } catch (error) {
              errors.push(error);
              setOwnEnumerableValue(attributes, name, null);
            }
          }
          if (errors.length === args.names.length) {
            const firstError = errors[0];
            const message = firstError instanceof Error ? firstError.message : String(firstError);
            throw new UserError(`读取元素 "${args.selector}" 特性失败: ${message}`);
          }

          return clampedTextResult(
            {
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              attributes,
            },
            args.maxBytes,
            {
              identity: {
                selector: args.selector,
                innerSelector: args.innerSelector ?? null,
              },
              note: "元素特性结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
  };
}

function createGetBoundingClientRectTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getBoundingClientRect",
    description: "获取元素相对视口的边界矩形(left/top/width/height/right/bottom),为 CSS transform 变换后的实际渲染尺寸与位置。返回还包含 `dataset`(元素完整 data-* 绑定对象,含对象型值)与 `id`——这是读取卡片/组件绑定数据(如 plateCode/path/cardStyle)的便捷途径,优于 element_getAttributes(后者对对象型 data-* 只能拿到 '[object Object]')。支持跨组件查询:selector 设为组件选择器、innerSelector 设为内部元素选择器(内部用 >>> 穿透,比 selectComponent 更可靠)。仅支持 ID 选择器、类选择器。selector 支持 [index=N],但底层 SelectorQuery 无法可靠表达“第 N 个父元素里的 innerSelector”,因此 [index=N] 不能与 innerSelector 同时使用。选择器查询未返回矩形时抛错；微信 SelectorQuery 无法可靠区分元素不存在与 display:none。",
    parameters: getBoundingClientRectParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getBoundingClientRectParameters.parse(rawArgs ?? {});
      const { selector, innerSelector } = args;
      const parsed = parseSelectorWithIndex(selector);
      const baseSelector = parsed ? parsed.baseSelector : selector;
      const indexHint = parsed ? parsed.index : -1;

      return manager.withMiniProgram(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const fullSelector = innerSelector ? `${baseSelector} >>> ${innerSelector}` : baseSelector;

          let result;
          try {
            result = await manager.runSerializedEvaluate(
              () =>
                miniProgram.evaluate(
                  (sel: string, innerSel: string | undefined, idx: number) => {
                    return new Promise((resolve, reject) => {
                      // @ts-expect-error - wx 是小程序运行时全局对象
                      const query = wx.createSelectorQuery();

                      // 如果有 innerSelector，使用 >>> 拼接成穿透选择器，这比 selectComponent 更可靠
                      const full = innerSel ? `${sel} >>> ${innerSel}` : sel;
                      const useIndex = idx >= 0;

                      if (useIndex) {
                        query.selectAll(full).boundingClientRect();
                      } else {
                        query.select(full).boundingClientRect();
                      }

                      query.exec((res: unknown[]) => {
                        if (!res || res.length === 0) {
                          reject(new Error(`Element not found: "${full}". (exec returned ${JSON.stringify(res)})`));
                          return;
                        }

                        let target: unknown;
                        if (useIndex) {
                          const list = res[0] as unknown[] | undefined;
                          if (!Array.isArray(list) || list.length === 0) {
                            reject(new Error(`Element not found for selectAll: "${full}".`));
                            return;
                          }
                          if (idx >= list.length) {
                            reject(new Error(`Index ${idx} out of range (0-${list.length - 1}) for selector "${full}".`));
                            return;
                          }
                          target = list[idx];
                        } else {
                          target = res[0];
                        }

                        if (!target) {
                          reject(
                            new Error(
                              `Element not found or not in layout: "${full}".`
                            )
                          );
                          return;
                        }
                        resolve(target);
                      });
                    });
                  },
                  baseSelector,
                  innerSelector,
                  indexHint
                ),
              {
                description: "获取元素边界矩形",
                timeoutMs: 10000,
              }
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new UserError(
              `获取元素 "${fullSelector}"${indexHint >= 0 ? `[index=${indexHint}]` : ""} 的边界矩形失败: ${message}`
            );
          }

          return toTextResult(
            formatJson({
              selector,
              innerSelector: innerSelector ?? null,
              boundingClientRect: toSerializableValue(result),
            })
          );
        }
      );
      }),
  };
}

async function getElementMetrics(element: any): Promise<{
  size: { width: number; height: number };
  offset: { left: number; top: number };
}> {
  const [size, offset] = await Promise.all([
    typeof element?.size === "function" ? element.size() : null,
    typeof element?.offset === "function" ? element.offset() : null,
  ]);

  if (!size || !offset) {
    throw new UserError("目标元素不支持读取 size/offset，无法执行真实手势。");
  }

  const width = Number(size.width);
  const height = Number(size.height);
  const left = Number(offset.left);
  const top = Number(offset.top);

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(left) ||
    !Number.isFinite(top)
  ) {
    throw new UserError("目标元素的 size/offset 无法转换为有效坐标，无法执行真实手势。");
  }

  return {
    size: { width, height },
    offset: { left, top },
  };
}

type TouchPosition = {
  identifier: number;
  pageX: number;
  pageY: number;
};

// 纯函数：从已取得的 size/offset 计算触摸坐标，避免重复 round-trip。
function resolveTouchPosition(
  metrics: { size: { width: number; height: number }; offset: { left: number; top: number } },
  options: { x?: number; y?: number; identifier?: number }
): TouchPosition {
  const relativeX = options.x ?? metrics.size.width / 2;
  const relativeY = options.y ?? metrics.size.height / 2;
  return {
    identifier: options.identifier ?? 1,
    pageX: metrics.offset.left + relativeX,
    pageY: metrics.offset.top + relativeY,
  };
}

async function getResolvedTouchPosition(
  element: any,
  options: { x?: number; y?: number; identifier?: number }
): Promise<TouchPosition> {
  const metrics = await getElementMetrics(element);
  return resolveTouchPosition(metrics, options);
}

function buildTouchEvent(position: TouchPosition) {
  return {
    touches: [position],
    ...buildChangedTouchFields(position),
  };
}

function buildTouchEndEvent(position: TouchPosition) {
  return {
    touches: [],
    ...buildChangedTouchFields(position),
  };
}

function buildChangedTouchFields(position: TouchPosition) {
  return {
    // Official docs/runtime use changedTouches; the bundled SDK typings use
    // changeTouches. Send both so gestures work across DevTools/SDK versions.
    changedTouches: [position],
    changeTouches: [position],
  };
}

function getDefaultSwipeDistance(
  size: { width: number; height: number },
  direction: "up" | "down" | "left" | "right"
): number {
  return direction === "left" || direction === "right"
    ? Math.max(20, size.width * 0.6)
    : Math.max(20, size.height * 0.6);
}

function buildSwipeMoves(options: {
  startX: number;
  startY: number;
  distance: number;
  direction: "up" | "down" | "left" | "right";
  steps: number;
  delayMs: number;
}): Array<{ pageX: number; pageY: number; delayMs: number }> {
  const deltaX =
    options.direction === "left"
      ? -options.distance
      : options.direction === "right"
        ? options.distance
        : 0;
  const deltaY =
    options.direction === "up"
      ? -options.distance
      : options.direction === "down"
        ? options.distance
        : 0;

  return Array.from({ length: options.steps }, (_, index) => {
    const ratio = (index + 1) / options.steps;
    return {
      pageX: options.startX + deltaX * ratio,
      pageY: options.startY + deltaY * ratio,
      delayMs: options.delayMs,
    };
  });
}
