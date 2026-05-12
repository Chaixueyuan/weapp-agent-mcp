import { UserError } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  connectionContainerSchema,
  formatJson,
  resolveElement,
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
  waitMs: z.coerce.number().int().nonnegative().optional(),
});

const touchMovePointSchema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
  delayMs: z.coerce.number().int().nonnegative().optional(),
});

const touchElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  phase: z.enum(["start", "move", "end", "sequence"]),
  x: z.coerce.number().optional(),
  y: z.coerce.number().optional(),
  moves: z.array(touchMovePointSchema).optional(),
  holdMs: z.coerce.number().int().nonnegative().optional(),
  waitMs: z.coerce.number().int().nonnegative().optional(),
  identifier: z.coerce.number().int().nonnegative().optional().default(1),
});

const swipeElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  direction: z.enum(["up", "down", "left", "right"]),
  distance: z.coerce.number().positive().optional(),
  durationMs: z.coerce.number().int().positive().optional().default(300),
  startX: z.coerce.number().optional(),
  startY: z.coerce.number().optional(),
  waitMs: z.coerce.number().int().nonnegative().optional(),
  identifier: z.coerce.number().int().nonnegative().optional().default(1),
});

const inputTextParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  value: z.union([z.string(), z.coerce.number()]),
});

const callElementMethodParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const getElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
});

const setElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  data: z.record(z.string(), z.unknown()),
});

const getInnerElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
  withWxml: z.boolean().optional().default(false),
});

const getInnerElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
  withWxml: z.boolean().optional().default(false),
});

const getElementWxmlParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  outer: z.boolean().optional().default(false),
});

const getElementStylesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)),
});

const scrollToParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  x: z.coerce.number(),
  y: z.coerce.number(),
});

const getAttributesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)),
});

const getBoundingClientRectParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
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
    description: "通过 CSS 选择器模拟点击 WXML 元素。支持 [index=N] 语法选择第 N 个元素。如需点击自定义组件内部的元素，请使用 innerSelector 参数：selector 设为组件 ID 选择器(如 #my-component)或标签选择器，innerSelector 设为组件内部元素的选择器。",
    parameters: tapElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = tapElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      return manager.withPage(
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

          let element;
          if (indexHint === undefined) {
            element = await resolveElement(
              page,
              args.selector,
              args.innerSelector
            );
          } else {
            if (typeof page.$$ !== "function") {
              throw new UserError("当前页面不支持查询元素数组。");
            }

            let elements = await page.$$(selector);
            if (!Array.isArray(elements) || elements.length === 0) {
              throw new UserError(`未找到元素: "${selector}"`);
            }

            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }

            element = elements[indexHint];

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
          }

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
  };
}

function createTouchElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_touch",
    description: "对元素执行真实触摸事件。支持 start、move、end 和 sequence 四种模式；坐标基于元素左上角，默认取元素中心；支持 [index=N] 语法。",
    parameters: touchElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = touchElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveIndexedElement(
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
            await element.touchend({
              touches: [],
              changeTouches: [position],
            });
          } else {
            await element.touchstart(buildTouchEvent(position));

            if (args.holdMs) {
              await waitOnPage(page, args.holdMs);
            }

            const moves = args.moves ?? [];
            for (const move of moves) {
              const nextPosition = await getResolvedTouchPosition(element, {
                x: move.x,
                y: move.y,
                identifier: args.identifier,
              });
              await element.touchmove(buildTouchEvent(nextPosition));
              if (move.delayMs) {
                await waitOnPage(page, move.delayMs);
              }
            }

            const finalPosition = moves.length
              ? await getResolvedTouchPosition(element, {
                  x: moves[moves.length - 1].x,
                  y: moves[moves.length - 1].y,
                  identifier: args.identifier,
                })
              : position;

            await element.touchend({
              touches: [],
              changeTouches: [finalPosition],
            });
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
      }),
  };
}

function createSwipeElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_swipe",
    description: "对元素执行真实滑动手势。适合列表、轮播、可拖拽区域等需要 touch 序列的场景；支持 [index=N] 语法。",
    parameters: swipeElementParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = swipeElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;

      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveIndexedElement(
            page,
            args.selector,
            args.innerSelector
          );

          const { size } = await getElementMetrics(element);
          const start = await getResolvedTouchPosition(element, {
            x: args.startX,
            y: args.startY,
            identifier: args.identifier,
          });

          const distance = args.distance ?? getDefaultSwipeDistance(size, args.direction);
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
            offsetLeft: 0,
            offsetTop: 0,
          });

          await element.touchstart(buildTouchEvent(start));
          for (const move of moves) {
            const position = {
              identifier: args.identifier,
              pageX: move.pageX,
              pageY: move.pageY,
              clientX: move.pageX,
              clientY: move.pageY,
            };
            await element.touchmove(buildTouchEvent(position));
            if (move.delayMs) {
              await waitOnPage(page, move.delayMs);
            }
          }

          const lastMove = moves[moves.length - 1] ?? {
            pageX: start.pageX,
            pageY: start.pageY,
          };
          await element.touchend({
            touches: [],
            changeTouches: [
              {
                identifier: args.identifier,
                pageX: lastMove.pageX,
                pageY: lastMove.pageY,
                clientX: lastMove.pageX,
                clientY: lastMove.pageY,
              },
            ],
          });

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
                pageX: lastMove.pageX,
                pageY: lastMove.pageY,
              },
              steps,
              waitMs: waitMs ?? 0,
            })
          );
        }
      );
      }),
  };
}

function createInputTextTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_input",
    description: "向指定元素输入文本。",
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

          await element.input(args.value);
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
    description: "调用组件实例指定方法，仅自定义组件可以使用。",
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
          const result = await element.callMethod(args.method, ...callArgs);
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
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

function createGetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getData",
    description: "获取组件实例渲染数据，仅自定义组件可以使用。不传 path 时返回完整组件 data 对象；传 path（如 'list.0.id'）返回精确子值。",
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

          const data = await manager.withRequestTimeout(
            () => (args.path !== undefined ? element.data(args.path) : element.data()),
            { description: `读取组件数据${args.path ? ` (${args.path})` : ""}` }
          );
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              path: args.path ?? null,
              data: toSerializableValue(data),
            })
          );
        }
      );
      }),
  };
}

function createSetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_setData",
    description: "设置组件实例渲染数据，仅自定义组件可以使用。",
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

          await element.setData(args.data);
          const dataKeys = Object.keys(args.data ?? {});
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
    description: "在元素范围内获取元素，相当于 element.$(selector)。设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。",
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

          const innerElement = await element.$(args.targetSelector);
          if (!innerElement) {
            throw new UserError(
              `在元素 "${args.selector}" 内未找到选择器 "${args.targetSelector}" 对应的元素。`
            );
          }

          const summary = await summarizeElement(innerElement, { withWxml: args.withWxml });

          return toTextResult(
            formatJson({
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              ...summary,
            })
          );
        }
      );
      }),
  };
}

function createGetInnerElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getInnerElements",
    description: "在元素范围内获取元素数组，相当于 element.$$(selector)。设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。",
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

          const innerElements = await element.$$(args.targetSelector);
          if (!Array.isArray(innerElements)) {
            throw new UserError(
              `在元素 "${args.selector}" 内查询选择器 "${args.targetSelector}" 失败。`
            );
          }

          const elementsInfo = await Promise.all(
            innerElements.map(async (el, index) => {
              const summary = await summarizeElement(el, { withWxml: args.withWxml });
              return {
                index,
                ...summary,
              };
            })
          );

          return toTextResult(
            formatJson({
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              count: innerElements.length,
              elements: elementsInfo,
            })
          );
        }
      );
      }),
  };
}

function createGetElementWxmlTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getWxml",
    description: "获取元素 WXML。默认获取内部 WXML(element.wxml())，设置 outer 为 true 可获取包含元素本身的 WXML(element.outerWxml())。",
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

          const wxml = await element[methodName]();
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              type: args.outer ? "outerWxml" : "wxml",
              wxml: toSerializableValue(wxml),
            })
          );
        }
      );
      }),
  };
}

function createGetElementStylesTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getStyles",
    description: "获取元素的样式值。names 为样式名数组（如 ['color', 'fontSize', 'backgroundColor']）。",
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

          await Promise.all(
            args.names.map(async (name) => {
              try {
                styles[name] = await element.style(name);
              } catch {
                styles[name] = null;
              }
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              styles,
            })
          );
        }
      );
      }),
  };
}

function createScrollToTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_scrollTo",
    description: "滚动 scroll-view 组件到指定位置。仅适用于 scroll-view 组件。",
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

          await element.scrollTo(args.x, args.y);

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
    description: "获取元素的特性值。names 为特性名数组（如 ['class', 'id', 'data-index']）。",
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

          await Promise.all(
            args.names.map(async (name) => {
              try {
                attributes[name] = await element.attribute(name);
              } catch {
                attributes[name] = null;
              }
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              attributes,
            })
          );
        }
      );
      }),
  };
}

function createGetBoundingClientRectTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getBoundingClientRect",
    description: "获取元素相对于视口的边界矩形信息（left、top、width、height、right、bottom）。此方法返回的是考虑 CSS transform 变换后的实际渲染尺寸和位置。支持跨组件查询：若需获取自定义组件内部元素，可将 selector 设为组件选择器，innerSelector 设为内部元素选择器。注意：目前仅支持 ID 选择器、类选择器。",
    parameters: getBoundingClientRectParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = getBoundingClientRectParameters.parse(rawArgs ?? {});
      const { selector, innerSelector } = args;

      return manager.withMiniProgram(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const fullSelector = innerSelector ? `${selector} >>> ${innerSelector}` : selector;

          let result;
          try {
            result = await miniProgram.evaluate(
              (sel: string, innerSel?: string) => {
                return new Promise((resolve, reject) => {
                  // @ts-expect-error - wx 是小程序运行时全局对象
                  const query = wx.createSelectorQuery();

                  // 如果有 innerSelector，使用 >>> 拼接成穿透选择器，这比 selectComponent 更可靠
                  const full = innerSel ? `${sel} >>> ${innerSel}` : sel;

                  query.select(full).boundingClientRect();

                  query.exec((res: unknown[]) => {
                    if (res && res.length > 0) {
                      if (res[0]) {
                        resolve(res[0]);
                      } else {
                        // Selector matched but element not in layout (display:none / hidden
                        // popup / not mounted yet). Return zero-sized rect with a flag so
                        // callers can disambiguate from a missing element, matching the
                        // behavior of element_getWxml which still returns wxml in this case.
                        resolve({
                          left: 0,
                          top: 0,
                          right: 0,
                          bottom: 0,
                          width: 0,
                          height: 0,
                          rendered: false,
                          note: "selector matched but element is not in layout (display:none / hidden / not yet mounted)",
                        });
                      }
                    } else {
                      reject(new Error(`Element not found: "${full}". (exec returned ${JSON.stringify(res)})`));
                    }
                  });
                });
              },
              selector,
              innerSelector
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new UserError(
              `获取元素 "${fullSelector}" 的边界矩形失败: ${message}`
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

async function resolveIndexedElement(
  page: any,
  selector: string,
  innerSelector?: string
): Promise<any> {
  const parsed = parseSelectorWithIndex(selector);
  if (!parsed) {
    return resolveElement(page, selector, innerSelector);
  }

  if (typeof page.$$ !== "function") {
    throw new UserError("当前页面不支持查询元素数组。");
  }

  const elements = await page.$$(parsed.baseSelector);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new UserError(`未找到元素: "${parsed.baseSelector}"`);
  }

  if (parsed.index < 0 || parsed.index >= elements.length) {
    throw new UserError(`索引 ${parsed.index} 超出范围 (0-${elements.length - 1})。`);
  }

  let element = elements[parsed.index];
  if (innerSelector) {
    if (typeof element.$ !== "function") {
      throw new UserError(`元素 "${selector}" 不支持查询内部元素。`);
    }
    const inner = await element.$(innerSelector);
    if (!inner) {
      throw new UserError(
        `在元素 "${selector}" 内未找到选择器 "${innerSelector}" 对应的元素。`
      );
    }
    element = inner;
  }

  return element;
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

async function getResolvedTouchPosition(
  element: any,
  options: { x?: number; y?: number; identifier?: number }
): Promise<{
  identifier: number;
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
}> {
  const { size, offset } = await getElementMetrics(element);
  const relativeX = options.x ?? size.width / 2;
  const relativeY = options.y ?? size.height / 2;

  return {
    identifier: options.identifier ?? 1,
    pageX: offset.left + relativeX,
    pageY: offset.top + relativeY,
    clientX: offset.left + relativeX,
    clientY: offset.top + relativeY,
  };
}

function buildTouchEvent(position: {
  identifier: number;
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
}): {
  touches: Array<{
    identifier: number;
    pageX: number;
    pageY: number;
    clientX: number;
    clientY: number;
  }>;
  changeTouches: Array<{
    identifier: number;
    pageX: number;
    pageY: number;
    clientX: number;
    clientY: number;
  }>;
} {
  return {
    touches: [position],
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
  offsetLeft: number;
  offsetTop: number;
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
