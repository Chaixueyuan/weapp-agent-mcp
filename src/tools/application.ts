import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import {
  imageContent,
  UserError,
  type ContentResult,
} from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  buildUrl,
  connectionContainerSchema,
  createFunctionFromSource,
  ensureConnectionParameters,
  formatJson,
  parseSelectorWithIndex,
  querySchema,
  summarizeElement,
  toSerializableValue,
  toErrorResult,
  toTextResult,
  waitOnPage,
  withUserErrorResult,
} from "./common.js";

const navigateParameters = connectionContainerSchema
  .extend({
    path: z.string().trim().min(1).optional(),
    query: querySchema,
    transition: z
      .enum([
        "navigateTo",
        "redirectTo",
        "reLaunch",
        "switchTab",
        "navigateBack",
      ])
      .default("navigateTo"),
    waitMs: z.coerce.number().int().nonnegative().optional(),
  });

const screenshotParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
  timeoutMs: z.coerce.number().int().positive().optional().default(30000),
});

const callWxMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const evaluateParameters = connectionContainerSchema.extend({
  functionSource: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const getConsoleLogsParameters = connectionContainerSchema.extend({
  clear: z.coerce.boolean().optional().default(false),
  contains: z.string().trim().min(1).optional(),
  type: z.enum(["log", "info", "warn", "error", "exception"]).optional(),
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional().default(100),
});

const currentPageParameters = connectionContainerSchema.extend({
  withData: z.coerce.boolean().optional().default(false),
});

const healthCheckParameters = connectionContainerSchema.extend({
  includePage: z.coerce.boolean().optional().default(true),
  includeLogs: z.coerce.boolean().optional().default(true),
});

const recoverConnectionParameters = connectionContainerSchema.extend({
  reconnect: z.coerce.boolean().optional().default(true),
});

const listProjectsParameters = z.object({});

const setDefaultProjectParameters = z.object({
  projectPath: z.string().trim().min(1),
});

const scenarioStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    path: z.string().trim().min(1),
    query: querySchema,
    transition: z.enum(["navigateTo", "redirectTo", "reLaunch", "switchTab", "navigateBack"]).optional().default("navigateTo"),
    waitMs: z.coerce.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("tap"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    waitMs: z.coerce.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("input"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    value: z.union([z.string(), z.coerce.number()]),
  }),
  z.object({
    type: z.literal("waitRoute"),
    path: z.string().trim().min(1),
    timeout: z.coerce.number().int().positive().optional().default(5000),
    retryInterval: z.coerce.number().int().positive().optional().default(200),
  }),
  z.object({
    type: z.literal("expectRoute"),
    path: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("expectVisible"),
    selector: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("expectText"),
    selector: z.string().trim().min(1),
    expected: z.string(),
    mode: z.enum(["equals", "includes"]).optional().default("equals"),
  }),
  z.object({
    type: z.literal("expectCount"),
    selector: z.string().trim().min(1),
    expected: z.coerce.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("expectData"),
    path: z.string().trim().min(1),
    expected: z.unknown(),
  }),
  z.object({
    type: z.literal("snapshot"),
    selectors: z.array(z.string().trim().min(1)).optional().default([]),
    dataPaths: z.array(z.string().trim().min(1)).optional().default([]),
    withData: z.coerce.boolean().optional().default(false),
    withElements: z.coerce.boolean().optional().default(true),
    withWxml: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().positive().optional().default(10),
  }),
  z.object({
    type: z.literal("getLogs"),
    clear: z.coerce.boolean().optional().default(false),
    contains: z.string().trim().min(1).optional(),
    logType: z.enum(["log", "info", "warn", "error", "exception"]).optional(),
    since: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().optional().default(100),
  }),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().trim().min(1).optional(),
    timeoutMs: z.coerce.number().int().positive().optional().default(30000),
  }),
]);

const runScenarioParameters = connectionContainerSchema.extend({
  stopOnFailure: z.coerce.boolean().optional().default(true),
  steps: z.array(scenarioStepSchema).min(1),
});

const generateScenarioReportParameters = runScenarioParameters.extend({
  title: z.string().trim().min(1).optional(),
  outputPath: z.string().trim().min(1).optional(),
  includeLogs: z.coerce.boolean().optional().default(true),
  includeSnapshots: z.coerce.boolean().optional().default(true),
  includePassedSteps: z.coerce.boolean().optional().default(true),
});

export function createApplicationTools(
  manager: WeappAutomatorManager
): AnyTool[] {
  return [
    createEnsureConnectionTool(manager),
    createHealthCheckTool(manager),
    createRecoverConnectionTool(manager),
    createNavigateTool(manager),
    createScreenshotTool(manager),
    createCallWxMethodTool(manager),
    createEvaluateTool(manager),
    createGetConsoleLogsTool(manager),
    createRunScenarioTool(manager),
    createGenerateScenarioReportTool(manager),
    createCurrentPageTool(manager),
    createListProjectsTool(manager),
    createSetDefaultProjectTool(manager),
  ];
}

function createEnsureConnectionTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_ensureConnection",
    description:
      "检查小程序自动化会话是否就绪。先调用这个工具，再调用 mp_screenshot、page_* 或 element_* 工具。若失败，优先用 reconnect=true 重试一次；若返回项目选择提示，则传 projectSelection。",
    parameters: ensureConnectionParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = ensureConnectionParameters.parse(rawArgs ?? {});

      if (args.projectSelection) {
        const selected = await manager.consumePendingProject(args.projectSelection);
        if (selected) {
          await manager.setDefaultProject(selected.path);
          context.log.info(`已选择项目: ${selected.name} (${selected.path})`);
        } else {
          const hint = await manager.getSelectionHint();
          return toErrorResult(
            `无效的选择: "${args.projectSelection}"\n\n${hint}`
          );
        }
      }

      const result = await manager.withMiniProgram<ContentResult>(
        context.log,
        {
          overrides: args.connection,
          reconnect: args.reconnect ?? false,
        },
        async (miniProgram, config) => {
          const page = await miniProgram.currentPage();
          let systemInfo: unknown;
          try {
            systemInfo = await miniProgram.systemInfo();
          } catch {
            systemInfo = null;
          }

          return toTextResult(
            formatJson({
              mode: config.mode,
              projectPath: config.projectPath,
              wsEndpoint: config.wsEndpoint,
              port: config.port,
              autoClose: config.autoClose ?? false,
              currentPage: page
                ? { path: page.path, query: page.query }
                : null,
              systemInfo,
            })
          );
        }
      );

      return result;
      }),
    timeoutMs: 60000,
  };
}

function createHealthCheckTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_healthCheck",
    description: "聚合返回当前小程序自动化环境的健康状态，包括连接、页面、项目和日志监听状态。建议在调试前先调用。",
    parameters: healthCheckParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = healthCheckParameters.parse(rawArgs ?? {});
        return manager.withMiniProgram<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (miniProgram, config) => {
            const connection = await manager.getConnectionSnapshot();
            const logStatus = args.includeLogs ? await manager.getLogStatus() : null;
            const page = args.includePage ? await miniProgram.currentPage().catch(() => null) : null;
            const currentRoute = page?.path ?? null;
            const automatorConnected = connection.automatorConnected;
            const listenerAttached = logStatus?.listenerAttached ?? false;
            const ok = Boolean(connection.devtoolsOnline && connection.wsReachable && automatorConnected);
            const needsRecovery = !ok || (args.includeLogs && !listenerAttached);
            const summary = !ok
              ? "disconnected"
              : needsRecovery
                ? "degraded"
                : "connected";

            return toTextResult(
              formatJson({
                ok,
                summary,
                needsRecovery,
                devtoolsOnline: connection.devtoolsOnline,
                wsReachable: connection.wsReachable,
                automatorConnected,
                connectionMode: connection.connectionMode,
                projectPath: connection.projectPath,
                wsEndpoint: connection.wsEndpoint,
                port: connection.port,
                currentRoute,
                listenerAttached: logStatus?.listenerAttached ?? null,
                lastLogAt: logStatus?.lastLogAt ?? null,
                logStoreMode: logStatus?.logStoreMode ?? null,
                sessionId: logStatus?.sessionId ?? connection.sessionId,
                sourceProjectPath: logStatus?.sourceProjectPath ?? null,
                checkedAt: Date.now(),
                warnings: [
                  ...(args.includeLogs && !listenerAttached ? ["listener not attached"] : []),
                  ...(args.includePage && !currentRoute ? ["current route unavailable"] : []),
                ],
                errors: [
                  ...(!connection.devtoolsOnline ? ["devtools offline"] : []),
                  ...(!automatorConnected ? ["automator session missing"] : []),
                ],
              })
            );
          }
        );
      }),
    timeoutMs: 15000,
  };
}

function createRecoverConnectionTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_recoverConnection",
    description: "按标准顺序恢复 automator 会话、日志监听和项目上下文，并返回恢复前后状态。",
    parameters: recoverConnectionParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = recoverConnectionParameters.parse(rawArgs ?? {});
        const recovery = await manager.recoverConnection(context.log, {
          overrides: args.connection,
          reconnect: args.reconnect,
        });
        const afterLog = await manager.getLogStatus();
        const recovered = recovery.after.automatorConnected && afterLog.listenerAttached;

        return toTextResult(
          formatJson({
            ok: recovered,
            recovered,
            actions: recovery.actions,
            before: recovery.before,
            after: recovery.after,
            health: {
              ok: recovered,
              summary: recovered ? "connected" : "degraded",
              needsRecovery: !recovered,
            },
            warnings: afterLog.listenerAttached ? [] : ["listener not attached after recovery"],
            errors: recovered ? [] : ["connection recovery incomplete"],
          })
        );
      }),
    timeoutMs: 60000,
  };
}

function createNavigateTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_navigate",
    description:
      "在小程序内导航，支持 navigateTo、redirectTo、reLaunch、switchTab 和 navigateBack。",
    parameters: navigateParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = navigateParameters.parse(rawArgs ?? {});
      const transition = args.transition ?? "navigateTo";
      const overrides = args.connection;
      const waitMs = args.waitMs;
      const providedPath = args.path;

      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides },
        async (miniProgram) => {
          let url: string | undefined;
          let page;

          if (transition === "navigateBack") {
            page = await miniProgram.navigateBack();
          } else {
            if (!providedPath) {
              return toErrorResult(
                "参数 path 是必需的，除非 transition 是 navigateBack。"
              );
            }
            url = buildUrl(providedPath, args.query);
            switch (transition) {
              case "navigateTo":
                page = await miniProgram.navigateTo(url);
                break;
              case "redirectTo":
                page = await miniProgram.redirectTo(url);
                break;
              case "reLaunch":
                page = await miniProgram.reLaunch(url);
                break;
              case "switchTab":
                page = await miniProgram.switchTab(url);
                break;
              default:
                return toErrorResult(`不支持的 transition: ${transition}`);
            }
          }

          if (waitMs && page) {
            await page.waitFor(waitMs);
          }

          const activePage = page ?? (await miniProgram.currentPage());

          return toTextResult(
            formatJson({
              transition,
              url,
              activePage: activePage
                ? { path: activePage.path, query: activePage.query }
                : null,
            })
          );
        }
      );
      }),
  };
}

function createScreenshotTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_screenshot",
    description:
      "截取当前小程序视口的截图。需要已有活动会话；若提示没有活动会话，请先调用 mp_ensureConnection。默认返回内联图片，或保存到文件路径。支持 timeoutMs；注意官方说明该能力仅支持开发者工具模拟器。",
    parameters: screenshotParameters,
    timeoutMs: 60000,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = screenshotParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram, config) => {
          const currentPage = await miniProgram.currentPage().catch(() => null);
          const screenshotMode = args.path ? "file" : "inline";

          context.log.info("Starting miniProgram.screenshot", {
            mode: screenshotMode,
            path: args.path ?? null,
            timeoutMs: args.timeoutMs,
            route: currentPage?.path ?? null,
            connectionMode: config.mode,
            wsEndpoint: config.wsEndpoint ?? null,
            projectPath: config.projectPath ?? null,
          });

          let output: string | void;
          try {
            output = await manager.runSerializedScreenshot(
              context.log,
              () => manager.withRequestTimeout(
                () => miniProgram.screenshot(args.path ? { path: args.path } : undefined),
                {
                  timeoutMs: args.timeoutMs,
                  description: `执行页面截图（mode=${screenshotMode}）`,
                }
              )
            );
          } catch (error) {
            if (error instanceof UserError) {
              throw new UserError(
                `${error.message}\n\n截图诊断：\n- 当前 route: ${currentPage?.path ?? "unknown"}\n- 截图模式: ${screenshotMode}\n- 输出路径: ${args.path ?? "<inline>"}\n- 工具超时: ${args.timeoutMs}ms\n- 官方说明：miniProgram.screenshot 仅支持开发者工具模拟器，客户端不可用。`
              );
            }
            throw error;
          }

          if (typeof output === "string") {
            context.log.info("miniProgram.screenshot returned inline base64", {
              size: output.length,
            });
            const buffer = Buffer.from(output, "base64");
            const image = await imageContent({ buffer });
            return { content: [image] };
          }

          if (args.path) {
            context.log.info("miniProgram.screenshot saved file", {
              path: args.path,
            });
            return toTextResult(
              formatJson({
                ok: true,
                mode: "file",
                path: args.path,
                route: currentPage?.path ?? null,
                timeoutMs: args.timeoutMs,
              })
            );
          }

          return toErrorResult(
            "截图未产生图片数据。官方说明：miniProgram.screenshot 不传 path 时应返回 base64；若当前环境为客户端而非开发者工具模拟器，截图能力可能不可用。"
          );
        }
      );
      }),
  };
}

function createCallWxMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_callWx",
    description: "调用微信小程序 API 方法，（如 `wx.pageScrollTo`）。",
    parameters: callWxMethodParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = callWxMethodParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const callArgs = args.args ?? [];
          const result = await miniProgram.callWxMethod(
            args.method,
            ...callArgs
          );
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

function createEvaluateTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_evaluate",
    description: "向小程序 AppService 注入并执行函数代码，返回执行结果。适合在 page.data 不稳定时做显式调试读取。",
    parameters: evaluateParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = evaluateParameters.parse(rawArgs ?? {});
      const fn = createFunctionFromSource(args.functionSource, "functionSource");
      const callArgs = args.args ?? [];

      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          let result;
          try {
            result = await manager.withRequestTimeout(
              () => miniProgram.evaluate(fn, ...callArgs),
              { description: "执行小程序 evaluate" }
            );
          } catch (error) {
            if (error instanceof UserError) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`执行 evaluate 失败: ${message}`);
          }

          return toTextResult(
            formatJson({
              functionSource: args.functionSource,
              arguments: callArgs,
              result: toSerializableValue(result),
            })
          );
        }
      );
      }),
  };
}

function createGetConsoleLogsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_getLogs",
    description: "获取小程序控制台日志。可选择在获取后清空日志。",
    parameters: getConsoleLogsParameters,
    execute: async (rawArgs) =>
      withUserErrorResult(async () => {
      const args = getConsoleLogsParameters.parse(rawArgs ?? {});
      const allLogs = await manager.getConsoleLogs();
      const sinceTimestamp =
        typeof args.since === "number" ? Date.now() - args.since : undefined;

      let logs = allLogs.filter((log) => {
        if (args.type && log.type !== args.type) {
          return false;
        }
        if (sinceTimestamp !== undefined && log.timestamp < sinceTimestamp) {
          return false;
        }
        if (args.contains) {
          const haystack = `${log.message} ${JSON.stringify(log.data ?? "")}`;
          if (!haystack.includes(args.contains)) {
            return false;
          }
        }
        return true;
      });

      const limit = args.limit ?? 100;
      if (logs.length > limit) {
        logs = logs.slice(-limit);
      }

      if (args.clear) {
        await manager.clearConsoleLogs();
      }

      const logStatus = await manager.getLogStatus();

      return toTextResult(
        formatJson({
          count: logs.length,
          totalCount: allLogs.length,
          listenerAttached: logStatus.listenerAttached,
          lastLogAt: logStatus.lastLogAt,
          lastListenerBindAt: logStatus.lastListenerBindAt,
          logStoreMode: logStatus.logStoreMode,
          sessionId: logStatus.sessionId,
          sourceProjectPath: logStatus.sourceProjectPath,
          recentTypes: logStatus.recentTypes,
          filters: {
            type: args.type ?? null,
            contains: args.contains ?? null,
            since: args.since ?? null,
            limit,
          },
          logs: logs.map(log => ({
            type: log.type,
            message: log.message,
            timestamp: log.timestamp,
            data: log.data,
          })),
        })
      );
      }),
  };
}

function createRunScenarioTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_runScenario",
    description: "按顺序执行一组页面调试/测试步骤。最小版支持 navigate、tap、input、waitRoute、expect、snapshot 和 getLogs。适合短链路分段执行，不建议把整条复杂业务链一次性塞进单个 scenario。",
    parameters: runScenarioParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = runScenarioParameters.parse(rawArgs ?? {});
        const summary = await runScenario(manager, context, args.steps, args.connection, args.stopOnFailure);
        return toTextResult(formatJson(summary));
      }),
    timeoutMs: 120000,
  };
}

function createGenerateScenarioReportTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_generateScenarioReport",
    description: "执行 scenario 并输出最小 markdown 回归报告；可选写入 outputPath。适合把步骤结果、快照和日志整理成人可复核的产物。",
    parameters: generateScenarioReportParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = generateScenarioReportParameters.parse(rawArgs ?? {});
        const summary = await runScenario(manager, context, args.steps, args.connection, args.stopOnFailure);
        const markdown = buildScenarioReportMarkdown({
          title: args.title,
          includeLogs: args.includeLogs,
          includeSnapshots: args.includeSnapshots,
          includePassedSteps: args.includePassedSteps,
          summary,
        });

        if (args.outputPath) {
          await mkdir(dirname(args.outputPath), { recursive: true });
          await writeFile(args.outputPath, markdown, "utf-8");
        }

        return toTextResult(
          formatJson({
            ok: summary.ok,
            outputPath: args.outputPath ?? null,
            title: args.title ?? null,
            totalSteps: summary.totalSteps,
            executedSteps: summary.executedSteps,
            passedSteps: summary.passedSteps,
            failedSteps: summary.failedSteps,
            report: markdown,
          })
        );
      }),
    timeoutMs: 120000,
  };
}

function createCurrentPageTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_currentPage",
    description:
      "获取当前页面的信息，包括路径、查询参数、尺寸和滚动位置。通常在 mp_ensureConnection 成功后立即调用，用于确认当前页面。withData 为 true 时额外返回页面数据。",
    parameters: currentPageParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = currentPageParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const page = await miniProgram.currentPage();
          if (!page) {
            return toTextResult(formatJson({ error: "当前没有活动页面" }));
          }

          const [size, scrollTop] = await Promise.all([
            page.size().catch(() => null),
            page.scrollTop().catch(() => null),
          ]);

          const result: Record<string, unknown> = {
            path: page.path,
            query: toSerializableValue(page.query),
            size: toSerializableValue(size),
            scrollTop: toSerializableValue(scrollTop),
          };

          if (args.withData) {
            const data = await manager.withRequestTimeout(
              () => page.data(),
              { description: "读取当前页面数据" }
            ).catch(() => null);
            result.data = toSerializableValue(data);
          }

          return toTextResult(formatJson(result));
        }
      );
      }),
  };
}

function createListProjectsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_listProjects",
    description: "列出微信开发者工具中的最近项目，方便在 mp_ensureConnection 返回项目选择提示后继续选择项目。",
    parameters: listProjectsParameters,
    execute: async () =>
      withUserErrorResult(async () => {
      const projects = await manager.listRecentProjects();
      const defaultProject = await manager.getDefaultProject();

      return toTextResult(
        formatJson({
          defaultProject,
          projects: projects.map((p, i) => ({
            index: i,
            name: p.name,
            path: p.path,
          })),
        })
      );
      }),
    timeoutMs: 10000,
  };
}

async function runScenario(
  manager: WeappAutomatorManager,
  context: ToolContext,
  steps: Array<z.infer<typeof scenarioStepSchema>>,
  connection: z.infer<typeof runScenarioParameters>["connection"],
  stopOnFailure: boolean,
): Promise<{
  ok: boolean;
  stopOnFailure: boolean;
  totalSteps: number;
  executedSteps: number;
  passedSteps: number;
  failedSteps: number;
  results: Array<Record<string, unknown>>;
}> {
  const results: Array<Record<string, unknown>> = [];
  let failed = false;
  const totalSteps = steps.length;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      const result = await executeScenarioStep(manager, context, step, connection);
      const pass = getScenarioStepPass(step, result);
      results.push({
        index,
        type: step.type,
        pass,
        step,
        result,
      });
      if (!pass && stopOnFailure) {
        failed = true;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        index,
        type: step.type,
        pass: false,
        step,
        error: buildScenarioFailureMessage(step, message, {
          index,
          totalSteps,
        }),
      });
      if (stopOnFailure) {
        failed = true;
        break;
      }
    }
  }

  const passedCount = results.filter((item) => item.pass === true).length;
  return {
    ok: !failed && results.every((item) => item.pass !== false),
    stopOnFailure,
    totalSteps: steps.length,
    executedSteps: results.length,
    passedSteps: passedCount,
    failedSteps: results.length - passedCount,
    results,
  };
}

async function executeScenarioStep(
  manager: WeappAutomatorManager,
  context: ToolContext,
  step: z.infer<typeof scenarioStepSchema>,
  connection: z.infer<typeof runScenarioParameters>["connection"],
): Promise<Record<string, unknown>> {
  switch (step.type) {
    case "navigate": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const transition = step.transition ?? "navigateTo";
        const url = transition === "navigateBack" ? undefined : buildUrl(step.path, step.query);
        let page;
        if (transition === "navigateBack") {
          page = await miniProgram.navigateBack();
        } else if (transition === "navigateTo") {
          page = await miniProgram.navigateTo(url!);
        } else if (transition === "redirectTo") {
          page = await miniProgram.redirectTo(url!);
        } else if (transition === "reLaunch") {
          page = await miniProgram.reLaunch(url!);
        } else {
          page = await miniProgram.switchTab(url!);
        }
        if (step.waitMs && page) {
          await waitOnPage(page, step.waitMs);
        }
        const activePage = page ?? (await miniProgram.currentPage());
        return {
          transition,
          url: url ?? null,
          activePage: activePage ? { path: activePage.path, query: toSerializableValue(activePage.query) } : null,
        };
      });
    }
    case "tap": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const element = await resolveScenarioElement(page, step.selector, step.innerSelector);
        await element.tap();
        if (step.waitMs) {
          await waitOnPage(page, step.waitMs);
        }
        return { selector: step.selector, innerSelector: step.innerSelector ?? null, tapped: true };
      });
    }
    case "input": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const element = await resolveScenarioElement(page, step.selector, step.innerSelector);
        await element.input(step.value);
        return { selector: step.selector, innerSelector: step.innerSelector ?? null, value: step.value };
      });
    }
    case "waitRoute": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const start = Date.now();
        while (Date.now() - start < step.timeout) {
          const page = await miniProgram.currentPage();
          if (page?.path === step.path) {
            return { path: step.path, matched: true, waitTime: Date.now() - start, query: toSerializableValue(page.query) };
          }
          await new Promise(resolve => setTimeout(resolve, step.retryInterval));
        }
        const currentPage = await miniProgram.currentPage().catch(() => null);
        return { path: step.path, matched: false, actual: currentPage?.path ?? null };
      });
    }
    case "expectRoute": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const page = await miniProgram.currentPage();
        const actual = page?.path ?? null;
        return { pass: actual === step.path, expected: step.path, actual, snapshot: { path: actual, query: toSerializableValue(page?.query ?? null) } };
      });
    }
    case "expectVisible": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        let selector = step.selector;
        let indexHint: number | undefined;
        const parsed = parseSelectorWithIndex(selector);
        if (parsed) {
          selector = parsed.baseSelector;
          indexHint = parsed.index;
        }
        const elements = typeof page.$$ === "function" ? await page.$$(selector) : [];
        const count = Array.isArray(elements) ? elements.length : 0;
        const pass = indexHint !== undefined ? indexHint >= 0 && indexHint < count : count > 0;
        return { pass, expected: true, actual: pass, snapshot: { selector: step.selector, count, index: indexHint ?? null } };
      });
    }
    case "expectText": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const element = await resolveScenarioElement(page, step.selector);
        const actual = typeof element?.text === "function" ? await element.text().catch(() => null) : null;
        const normalized = typeof actual === "string" ? actual : String(actual ?? "");
        const pass = step.mode === "includes" ? normalized.includes(step.expected) : normalized === step.expected;
        return { pass, expected: step.expected, actual: normalized, snapshot: { selector: step.selector, mode: step.mode } };
      });
    }
    case "expectCount": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const elements = typeof page.$$ === "function" ? await page.$$(step.selector) : [];
        const actual = Array.isArray(elements) ? elements.length : 0;
        return { pass: actual === step.expected, expected: step.expected, actual, snapshot: { selector: step.selector } };
      });
    }
    case "expectData": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const actual = await manager.withRequestTimeout(() => page.data(step.path), { description: `读取页面数据 (${step.path})` });
        const normalizedActual = toSerializableValue(actual);
        const normalizedExpected = toSerializableValue(step.expected);
        return { pass: JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected), expected: normalizedExpected, actual: normalizedActual, snapshot: { path: step.path } };
      });
    }
    case "snapshot": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const page = await miniProgram.currentPage();
        if (!page) {
          throw new UserError("当前没有可用页面，无法生成快照。");
        }
        const data: Record<string, unknown> = {};
        if (step.withData) {
          const fullData = await manager.withRequestTimeout(() => page.data(), { description: "读取页面完整数据快照" });
          data["$"] = toSerializableValue(fullData);
        }
        for (const path of step.dataPaths) {
          const value = await manager.withRequestTimeout(() => page.data(path), { description: `读取页面数据快照 (${path})` });
          data[path] = toSerializableValue(value);
        }
        const elements: Array<Record<string, unknown>> = [];
        if (step.withElements && typeof page.$$ === "function") {
          for (const selector of step.selectors) {
            const matched = await page.$$(selector).catch(() => []);
            const list = Array.isArray(matched) ? matched.slice(0, step.limit) : [];
            const summaries = await Promise.all(list.map(async (element: any, index: number) => ({ selector, index, ...(await summarizeElement(element, { withWxml: step.withWxml })) })));
            elements.push(...summaries);
          }
        }
        return { route: page.path, query: toSerializableValue(page.query ?? null), data, selectors: step.selectors, elementCount: elements.length, elements };
      });
    }
    case "getLogs": {
      const allLogs = await manager.getConsoleLogs();
      const sinceTimestamp = typeof step.since === "number" ? Date.now() - step.since : undefined;
      let logs = allLogs.filter((log) => {
        if (step.logType && log.type !== step.logType) {
          return false;
        }
        if (sinceTimestamp !== undefined && log.timestamp < sinceTimestamp) {
          return false;
        }
        if (step.contains) {
          const haystack = `${log.message} ${JSON.stringify(log.data ?? "")}`;
          if (!haystack.includes(step.contains)) {
            return false;
          }
        }
        return true;
      });
      if (logs.length > step.limit) {
        logs = logs.slice(-step.limit);
      }
      if (step.clear) {
        await manager.clearConsoleLogs();
      }
      const logStatus = await manager.getLogStatus();
      return {
        count: logs.length,
        totalCount: allLogs.length,
        listenerAttached: logStatus.listenerAttached,
        lastLogAt: logStatus.lastLogAt,
        sessionId: logStatus.sessionId,
        logs: logs.map((log) => ({ type: log.type, message: log.message, timestamp: log.timestamp, data: log.data })),
      };
    }
    case "screenshot": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const currentPage = await miniProgram.currentPage().catch(() => null);
        const screenshotMode = step.path ? "file" : "inline";
        const output = await manager.runSerializedScreenshot(
          context.log,
          () => manager.withRequestTimeout(
            () => miniProgram.screenshot(step.path ? { path: step.path } : undefined),
            {
              timeoutMs: step.timeoutMs,
              description: `执行 scenario 截图（mode=${screenshotMode}）`,
            }
          )
        );
        if (typeof output === "string") {
          return {
            ok: true,
            mode: "inline",
            path: step.path ?? null,
            route: currentPage?.path ?? null,
            timeoutMs: step.timeoutMs,
            data: output,
          };
        }
        return {
          ok: true,
          mode: "file",
          path: step.path ?? null,
          route: currentPage?.path ?? null,
          timeoutMs: step.timeoutMs,
        };
      });
    }
  }
}

function getScenarioStepPass(step: z.infer<typeof scenarioStepSchema>, result: Record<string, unknown>): boolean {
  if (step.type.startsWith("expect") || step.type === "waitRoute") {
    return result.pass === true || result.matched === true;
  }
  return true;
}

function buildScenarioFailureMessage(
  step: z.infer<typeof scenarioStepSchema>,
  message: string,
  context: { index: number; totalSteps: number }
): string {
  const hints: string[] = [];

  if (step.type === "screenshot") {
    hints.push("截图步骤当前按单通道能力设计，不要并发执行。若连续失败，先运行 mp_healthCheck，必要时执行 mp_recoverConnection。");
  }

  if (step.type === "snapshot") {
    hints.push("page_snapshot 在复杂连续操作后可能超时；建议只在关键节点采集快照，不要在长链路中高频叠加。若失败，先运行 mp_healthCheck，必要时执行 mp_recoverConnection。");
  }

  if (context.totalSteps >= 10) {
    hints.push("当前 scenario 步数较多，长链路压测下可能整体超时；更推荐拆成多个短 scenario 分段执行。",
    );
  }

  if (!hints.length) {
    return message;
  }

  return `${message}\n\n建议：\n- ${hints.join("\n- ")}`;
}

function buildScenarioReportMarkdown(input: {
  title?: string;
  includeLogs: boolean;
  includeSnapshots: boolean;
  includePassedSteps: boolean;
  summary: {
    ok: boolean;
    stopOnFailure: boolean;
    totalSteps: number;
    executedSteps: number;
    passedSteps: number;
    failedSteps: number;
    results: Array<Record<string, unknown>>;
  };
}): string {
  const title = input.title?.trim() || "Scenario Report";
  const lines: string[] = [
    `# ${title}`,
    "",
    "## Summary",
    "",
    `- Status: ${input.summary.ok ? "PASS" : "FAIL"}`,
    `- stopOnFailure: ${input.summary.stopOnFailure}`,
    `- totalSteps: ${input.summary.totalSteps}`,
    `- executedSteps: ${input.summary.executedSteps}`,
    `- passedSteps: ${input.summary.passedSteps}`,
    `- failedSteps: ${input.summary.failedSteps}`,
    "",
    "## Steps",
    "",
  ];

  for (const item of input.summary.results) {
    const pass = item.pass === true;
    if (!input.includePassedSteps && pass) {
      continue;
    }
    const index = typeof item.index === "number" ? item.index : -1;
    const type = typeof item.type === "string" ? item.type : "unknown";
    lines.push(`### ${index + 1}. ${type} ${pass ? "PASS" : "FAIL"}`);
    lines.push("");

    const step = item.step;
    if (step && typeof step === "object") {
      lines.push("**Step**");
      lines.push("```json");
      lines.push(formatJson(step));
      lines.push("```");
      lines.push("");
    }

    if (typeof item.error === "string") {
      lines.push("**Error**");
      lines.push("```");
      lines.push(item.error);
      lines.push("```");
      lines.push("");
      continue;
    }

    const result = item.result;
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      const filtered = filterScenarioReportResult(record, {
        includeLogs: input.includeLogs,
        includeSnapshots: input.includeSnapshots,
      });
      if (type === "screenshot" && typeof record.path === "string" && record.path) {
        lines.push(`**Screenshot**: \`${record.path}\``);
        lines.push("");
      }
      lines.push("**Result**");
      lines.push("```json");
      lines.push(formatJson(filtered));
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

function filterScenarioReportResult(
  result: Record<string, unknown>,
  options: { includeLogs: boolean; includeSnapshots: boolean },
): Record<string, unknown> {
  const next = { ...result };
  if (!options.includeLogs && Array.isArray(next.logs)) {
    delete next.logs;
  }
  if (!options.includeSnapshots) {
    if ("elements" in next) {
      delete next.elements;
    }
    if ("data" in next) {
      delete next.data;
    }
    if ("snapshot" in next) {
      delete next.snapshot;
    }
    if (next.mode === "inline" && "data" in next) {
      delete next.data;
    }
  }
  return next;
}

async function resolveScenarioElement(page: any, selector: string, innerSelector?: string): Promise<any> {
  let baseSelector = selector;
  let indexHint: number | undefined;
  const parsed = parseSelectorWithIndex(selector);
  if (parsed) {
    baseSelector = parsed.baseSelector;
    indexHint = parsed.index;
  }

  if (indexHint === undefined) {
    let element = await page.$(baseSelector);
    if (!element) {
      throw new UserError(`Element not found for selector "${selector}".`);
    }
    if (innerSelector) {
      if (typeof element.$ !== "function") {
        throw new UserError(`Element for selector "${selector}" does not support nested queries.`);
      }
      const inner = await element.$(innerSelector);
      if (!inner) {
        throw new UserError(`Element not found for selector "${innerSelector}" within "${selector}".`);
      }
      element = inner;
    }
    return element;
  }

  if (typeof page.$$ !== "function") {
    throw new UserError("当前页面不支持查询元素数组。");
  }
  const elements = await page.$$(baseSelector);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new UserError(`Element not found for selector "${baseSelector}".`);
  }
  if (indexHint < 0 || indexHint >= elements.length) {
    throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
  }
  let element = elements[indexHint];
  if (innerSelector) {
    if (typeof element.$ !== "function") {
      throw new UserError(`Element for selector "${selector}" does not support nested queries.`);
    }
    const inner = await element.$(innerSelector);
    if (!inner) {
      throw new UserError(`Element not found for selector "${innerSelector}" within "${selector}".`);
    }
    element = inner;
  }
  return element;
}

function createSetDefaultProjectTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_setDefaultProject",
    description: "设置默认的小程序项目路径，设置后下次连接会优先使用该项目。通常用于修复项目选择失败后的后续重试。",
    parameters: setDefaultProjectParameters,
    execute: async (rawArgs) =>
      withUserErrorResult(async () => {
      const args = setDefaultProjectParameters.parse(rawArgs);
      const success = await manager.setDefaultProject(args.projectPath);

      if (success) {
        return toTextResult(
          formatJson({
            success: true,
            message: `已设置默认项目: ${args.projectPath}`,
          })
        );
      }
      return toErrorResult(`无效的项目路径或项目目录不存在: ${args.projectPath}`);
      }),
    timeoutMs: 5000,
  };
}
