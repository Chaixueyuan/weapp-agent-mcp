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
  querySchema,
  toSerializableValue,
  toErrorResult,
  toTextResult,
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
      "截取当前小程序视口的截图。需要已有活动会话；若提示没有活动会话，请先调用 mp_ensureConnection。默认返回内联图片，或保存到文件路径。",
    parameters: screenshotParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = screenshotParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const output = await miniProgram.screenshot(
            args.path ? { path: args.path } : undefined
          );

          if (typeof output === "string") {
            const buffer = Buffer.from(output, "base64");
            const image = await imageContent({ buffer });
            return { content: [image] };
          }

          if (args.path) {
            return toTextResult(`截图已保存到 ${args.path}`);
          }

          return toErrorResult("截图未产生图片数据。");
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
