import { dirname } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";

import {
  imageContent,
  UserError,
  type ContentResult,
} from "fastmcp";
import { z } from "zod";

import type { ConsoleLogEntry, WeappAutomatorManager } from "../weappClient.js";
import { SERVER_VERSION } from "../version.js";
import {
  AnyTool,
  ToolContext,
  areSerializableValuesEqual,
  booleanish,
  buildUrl,
  clampJsonByBytes,
  clampedTextResult,
  connectionContainerSchema,
  ensureConnectionParameters,
  formatJson,
  MAX_SNAPSHOT_ELEMENT_SUMMARIES,
  maxBytesSchema,
  numberish,
  parseSelectorWithIndex,
  pickByPaths,
  querySchema,
  readCurrentPage,
  requiredJsonValueSchema,
  runFunctionSourceInAppService,
  setOwnEnumerableValue,
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
    waitMs: numberish(z.number().int().nonnegative().max(600000)).optional(),
  })
  .superRefine((value, context) => {
    if (value.transition !== "navigateBack" && !value.path) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path is required unless transition is navigateBack",
      });
    }
    if (value.transition === "navigateBack" && value.path !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "navigateBack does not accept path",
      });
    }
    if (value.transition === "navigateBack" && value.query !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "navigateBack does not accept query",
      });
    }
    if (
      value.transition === "switchTab" &&
      value.query &&
      Object.keys(value.query).length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "switchTab does not support query parameters",
      });
    }
  });

const screenshotParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
  timeoutMs: numberish(z.number().int().positive().max(600000)).optional().default(30000),
  force: booleanish.optional().default(false),
});

const callWxMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).max(100).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const evaluateParameters = connectionContainerSchema.extend({
  functionSource: z.string().trim().min(1),
  args: z.array(z.unknown()).max(100).optional(),
  timeoutMs: numberish(z.number().int().positive().max(600000)).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const pollUntilParameters = connectionContainerSchema
  .extend({
    predicate: z.string().trim().min(1),
    predicateArgs: z.array(z.unknown()).max(100).optional(),
    action: z.string().trim().min(1).optional(),
    actionArgs: z.array(z.unknown()).max(100).optional(),
    pollIntervalMs: numberish(z.number().int().positive().max(60000)).optional().default(200),
    timeoutMs: numberish(z.number().int().positive().max(600000)).optional().default(15000),
    snapshotPaths: z.array(z.string().trim().min(1)).max(100).optional(),
    snapshotAfterMs: numberish(z.number().int().nonnegative().max(60000)).optional().default(0),
    maxBytes: maxBytesSchema.optional().default(50000),
  })
  .superRefine((value, context) => {
    if (!value.action && value.actionArgs !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["actionArgs"],
        message: "actionArgs requires action",
      });
    }
    if (value.snapshotAfterMs > 0 && !value.snapshotPaths?.length) {
      context.addIssue({
        code: "custom",
        path: ["snapshotAfterMs"],
        message: "snapshotAfterMs requires at least one snapshotPaths entry",
      });
    }
  });

const getConsoleLogsParameters = connectionContainerSchema.extend({
  clear: booleanish.optional().default(false),
  contains: z.string().trim().min(1).optional(),
  type: z.enum(["log", "info", "warn", "error", "exception"]).optional(),
  since: numberish(z.number().int().nonnegative()).optional(),
  limit: numberish(z.number().int().positive().max(1000)).optional().default(100),
  maxBytes: maxBytesSchema.optional().default(200000),
});

const currentPageParameters = connectionContainerSchema.extend({
  withData: booleanish.optional().default(false),
  dataPaths: z.array(z.string().trim().min(1)).max(100).optional(),
  maxBytes: maxBytesSchema.optional().default(50000),
});

const healthCheckParameters = connectionContainerSchema.extend({
  includePage: booleanish.optional().default(true),
  includeLogs: booleanish.optional().default(true),
});

const recoverConnectionParameters = connectionContainerSchema.extend({
  reconnect: booleanish.optional().default(true),
});

const listProjectsParameters = z.object({}).strict();

const setDefaultProjectParameters = z.object({
  projectPath: z.string().trim().min(1),
}).strict();

const scenarioStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    path: z.string().trim().min(1).optional(),
    query: querySchema,
    transition: z.enum(["navigateTo", "redirectTo", "reLaunch", "switchTab", "navigateBack"]).optional().default("navigateTo"),
    waitMs: numberish(z.number().int().nonnegative().max(60000)).optional(),
  }).strict(),
  z.object({
    type: z.literal("tap"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    waitMs: numberish(z.number().int().nonnegative().max(60000)).optional(),
  }).strict(),
  z.object({
    type: z.literal("input"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    value: z.union([z.string(), z.number().finite()]),
  }).strict(),
  z.object({
    type: z.literal("waitRoute"),
    path: z.string().trim().min(1),
    timeout: numberish(z.number().int().positive().max(60000)).optional().default(5000),
    retryInterval: numberish(z.number().int().positive().max(60000)).optional().default(200),
  }).strict(),
  z.object({
    type: z.literal("expectRoute"),
    path: z.string().trim().min(1),
  }).strict(),
  z.object({
    type: z.literal("expectVisible"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    type: z.literal("expectText"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    expected: z.string(),
    mode: z.enum(["equals", "includes"]).optional().default("equals"),
  }).strict(),
  z.object({
    type: z.literal("expectCount"),
    selector: z.string().trim().min(1),
    innerSelector: z.string().trim().min(1).optional(),
    expected: numberish(z.number().int().nonnegative()),
  }).strict(),
  z.object({
    type: z.literal("expectData"),
    path: z.string().trim().min(1),
    expected: requiredJsonValueSchema,
  }).strict(),
  z.object({
    type: z.literal("snapshot"),
    selectors: z.array(z.string().trim().min(1)).max(50).optional().default([]),
    dataPaths: z.array(z.string().trim().min(1)).max(50).optional().default([]),
    withData: booleanish.optional().default(false),
    withElements: booleanish.optional().default(true),
    withWxml: booleanish.optional().default(false),
    limit: numberish(z.number().int().positive().max(100)).optional().default(10),
    maxBytes: maxBytesSchema.optional().default(50000),
  }).strict(),
  z.object({
    type: z.literal("getLogs"),
    clear: booleanish.optional().default(false),
    contains: z.string().trim().min(1).optional(),
    logType: z.enum(["log", "info", "warn", "error", "exception"]).optional(),
    since: numberish(z.number().int().nonnegative()).optional(),
    limit: numberish(z.number().int().positive().max(1000)).optional().default(100),
    maxBytes: maxBytesSchema.optional().default(200000),
  }).strict(),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().trim().min(1).optional(),
    timeoutMs: numberish(z.number().int().positive().max(600000)).optional().default(30000),
  }).strict(),
]).superRefine((step, context) => {
  if (
    step.type === "navigate" &&
    step.transition !== "navigateBack" &&
    !step.path
  ) {
    context.addIssue({
      code: "custom",
      path: ["path"],
      message: "path is required unless transition is navigateBack",
    });
  }
  if (
    step.type === "navigate" &&
    step.transition === "switchTab" &&
    step.query &&
    Object.keys(step.query).length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["query"],
      message: "switchTab does not support query parameters",
    });
  }
  if (
    step.type === "navigate" &&
    step.transition === "navigateBack" &&
    step.path !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["path"],
      message: "navigateBack does not accept path",
    });
  }
  if (
    step.type === "navigate" &&
    step.transition === "navigateBack" &&
    step.query !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["query"],
      message: "navigateBack does not accept query",
    });
  }
  if (
    step.type === "snapshot" &&
    !step.withElements &&
    step.selectors.length > 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectors"],
      message: "selectors requires withElements=true",
    });
  }
  if (
    step.type === "snapshot" &&
    step.withWxml &&
    step.selectors.length === 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["withWxml"],
      message: "withWxml requires at least one selector",
    });
  }
});

const runScenarioParameters = connectionContainerSchema.extend({
  stopOnFailure: booleanish.optional().default(true),
  scenarioTimeoutMs: numberish(z.number().int().positive().max(600000)).optional().default(120000),
  maxBytes: maxBytesSchema.optional().default(500000),
  steps: z.array(scenarioStepSchema).min(1).max(25),
});

const generateScenarioReportParameters = runScenarioParameters.extend({
  title: z.string().trim().min(1).optional(),
  outputPath: z.string().trim().min(1).optional(),
  includeLogs: booleanish.optional().default(true),
  includeSnapshots: booleanish.optional().default(true),
  includePassedSteps: booleanish.optional().default(true),
});

// 控制台日志过滤：mp_getLogs 与 scenario getLogs step 共用，避免逻辑漂移。
function filterConsoleLogs(
  allLogs: ConsoleLogEntry[],
  options: { type?: string; contains?: string; since?: number; limit: number }
): ConsoleLogEntry[] {
  const sinceTimestamp =
    typeof options.since === "number" ? Date.now() - options.since : undefined;
  let logs = allLogs.filter((log) => {
    if (options.type && log.type !== options.type) {
      return false;
    }
    if (sinceTimestamp !== undefined && log.timestamp < sinceTimestamp) {
      return false;
    }
    if (options.contains) {
      const haystack = `${log.message} ${JSON.stringify(log.data ?? "")}`;
      if (!haystack.includes(options.contains)) {
        return false;
      }
    }
    return true;
  });
  if (logs.length > options.limit) {
    logs = logs.slice(-options.limit);
  }
  return logs;
}

export function createApplicationTools(
  manager: WeappAutomatorManager
): AnyTool[] {
  return [
    createDiagnoseConnectionTool(manager),
    createEnsureConnectionTool(manager),
    createHealthCheckTool(manager),
    createRecoverConnectionTool(manager),
    createNavigateTool(manager),
    createScreenshotTool(manager),
    createCallWxMethodTool(manager),
    createEvaluateTool(manager),
    createPollUntilTool(manager),
    createGetConsoleLogsTool(manager),
    createRunScenarioTool(manager),
    createGenerateScenarioReportTool(manager),
    createCurrentPageTool(manager),
    createListProjectsTool(manager),
    createSetDefaultProjectTool(manager),
  ];
}

function createDiagnoseConnectionTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_diagnoseConnection",
    description:
      "只读探测当前连接目标的状态（port 是否监听、devtools 是否在线、ws 是否可达、automator 是否已连），不启动 IDE、不重连、不改任何项目状态。\n\n何时用：只想拿一份不改动现状的连接快照时（如用户问“为什么连不上”但不想动环境），或在 mp_ensureConnection / mp_recoverConnection 已失败后，用本工具读细节辅助判断。\n何时不用：想“把连接弄通”时不要先调本工具——直接调 mp_ensureConnection，它会自愈/自动拉起 IDE，并在返回里自带一份 diagnosis。\n\n⚠️ 本工具是保守设计：它如实报告 “port not listening / automation not enabled” 等，但**不会修复**。这种红色结果**不是死路、也不需要找用户确认**——下一步就是调 mp_ensureConnection 让它自动拉起/重连。\n\n返回 JSON 含各探测项的布尔/状态字段；红色项只代表“当前未就绪”，不代表无法恢复。connection 可选，传入可临时覆盖 projectPath / wsEndpoint / mode / port 等连接参数，省略则用已配置的默认值。",
    parameters: connectionContainerSchema,
    execute: async (rawArgs, _context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = connectionContainerSchema.parse(rawArgs ?? {});
        const diagnosis = await manager.diagnoseConnection(args.connection, {
          strictMode: false,
        });
        return toTextResult(formatJson(diagnosis));
      }),
    timeoutMs: 30000,
  };
}

function createEnsureConnectionTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_ensureConnection",
    description:
      "确保小程序自动化会话就绪——这是连接链路的**默认入口**：在 mp_screenshot / page_* / element_* 之前先调它。它会**自愈**:会话未就绪时自动拉起微信开发者工具 / 重启 cli auto 并建立 automator 连接,不只是被动检查。\n\n何时用:任何“先连上再操作”的场景,直接调本工具,不需要先 mp_diagnoseConnection(那是只读探测,可跳过)。\n失败时:**先读错误信息里的 Next step 引导**,通常是 ① 带 reconnect=true 重试,或 ② 先 mp_listProjects 再带 projectSelection 重试——不要原样重试同一调用,也不要直接停下来找用户。\n\ndefaultProject 不在 recents 时,server 会用 defaultProject 重启 cli auto,第一次仍可能失败——此时按错误信息 retry 即可。\n\n返回 JSON 含 mode / projectPath / defaultProjectPath / wsEndpoint / port / 内嵌 diagnosis / currentPage(已就绪可信,无需再调 mp_currentPage 校验)/ systemInfo。connect 模式无法确认 IDE 当前打开项目时 projectPath 会是 null，defaultProjectPath 仅表示持久化默认值，不会冒充当前项目。\n\n参数:reconnect=true 强制丢弃现有会话重连(用于会话疑似失效/卡死);projectSelection 传 mp_listProjects 返回的 index / name / path 之一,用于在“需要选择项目”的提示后定向选中；所选路径会用于当前 ensure 并保存为默认项目，同名项目请用 index 或完整 path 消歧。connection 可选,覆盖默认连接参数。",
    parameters: ensureConnectionParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = ensureConnectionParameters.parse(rawArgs ?? {});
        let effectiveConnection = args.connection;

      if (args.projectSelection) {
        const selected = await manager.consumePendingProject(args.projectSelection);
        if (selected) {
          const persisted = await manager.setDefaultProject(selected.path);
          if (!persisted) {
            return toErrorResult(`所选项目路径已失效或不是有效小程序项目: ${selected.path}`);
          }
          effectiveConnection = {
            args: args.connection?.args,
            ...args.connection,
            projectPath: selected.path,
          };
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
          overrides: effectiveConnection,
          reconnect: args.reconnect ?? false,
        },
        async (miniProgram, config) => {
          const page = await readCurrentPage(
            manager,
            miniProgram,
            "ensureConnection 读取当前页面"
          );
          if (!page) {
            throw new UserError(
              "[NO_ACTIVE_PAGE] Automator 已连接，但当前没有活动页面。请确认项目已完成启动，再用 reconnect=true 重试 mp_ensureConnection。"
            );
          }
          let systemInfo: unknown;
          try {
            systemInfo = await manager.withRequestTimeout(
              () => miniProgram.systemInfo(),
              { timeoutMs: 5000, description: "ensureConnection 读取系统信息" }
            );
          } catch {
            systemInfo = null;
          }
          const diagnosis = await manager.diagnoseConnection(effectiveConnection, {
            strictMode: false,
          });

          return toTextResult(
            formatJson({
              mode: config.mode,
              projectPath: config.projectPath ?? null,
              defaultProjectPath: diagnosis.defaultProjectPath,
              wsEndpoint: config.wsEndpoint,
              port: diagnosis.port,
              autoClose: config.autoClose ?? false,
              diagnosis,
              currentPage: { path: page.path, query: page.query },
              systemInfo,
            })
          );
        }
      );

      return result;
      }),
    timeoutMs: 1260000,
  };
}

function createHealthCheckTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_healthCheck",
    description:
      "只读聚合当前自动化环境健康状态:连接(devtoolsOnline / wsReachable / automatorConnected)、当前页面路由、项目、日志监听、以及上次 mp_screenshot 结果(lastScreenshotOk / errorCode)。不修复任何东西——要恢复用 mp_recoverConnection,要建立连接用 mp_ensureConnection。\n\n何时用:操作出问题时先调它看全局状态;尤其在 mp_screenshot / page_snapshot 反复失败后,先 healthCheck 再决定是否 mp_recoverConnection。\n关键字段:summary='degraded' 表示至少一项能力降级,但不一定可通过重连修复；**只有 needsRecovery=true 才调 mp_recoverConnection**。连接全绿但 lastScreenshotOk=false 时会返回 summary='degraded' + needsRecovery=false,说明是截图通道降级,不要循环重连。\n\nserverVersion 是**本 MCP server 的版本号**(不是小程序版本、不是基础库版本、不是开发者工具版本),反馈/调试时带上它即可。\n\n参数:includePage=true 额外探当前路由,includeLogs=true 额外查日志监听状态(都默认 true;探测失败只会进 warnings,不影响其余字段)。connection 可选,覆盖默认连接参数。",
    parameters: healthCheckParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = healthCheckParameters.parse(rawArgs ?? {});
        const connection = await manager.getConnectionSnapshot(args.connection);
        const logStatus = args.includeLogs ? await manager.getLogStatus(args.connection) : null;
        const page =
          args.includePage && connection.automatorConnected
            ? await manager.getActivePageSnapshot(args.connection)
            : null;
        const currentRoute = page?.path ?? null;
        const automatorConnected = connection.automatorConnected;
        const listenerAttached = logStatus?.listenerAttached ?? false;
        const screenshotStatus = manager.getScreenshotStatus(args.connection);
        const screenshotEverRan = screenshotStatus.lastScreenshotAt !== null;
        const screenshotRecentlyFailed =
          screenshotEverRan && screenshotStatus.lastScreenshotOk === false;
        const ok = Boolean(connection.devtoolsOnline && connection.wsReachable && automatorConnected);
        const needsRecovery =
          !ok ||
          (args.includeLogs && !listenerAttached);
        const summary = !ok
          ? "disconnected"
          : needsRecovery || screenshotRecentlyFailed
            ? "degraded"
            : "connected";

        return toTextResult(
          formatJson({
            ok,
            summary,
            serverVersion: SERVER_VERSION,
            needsRecovery,
            devtoolsOnline: connection.devtoolsOnline,
            wsReachable: connection.wsReachable,
            automatorConnected,
            connectionMode: connection.connectionMode,
            projectPath: connection.projectPath,
            defaultProjectPath: connection.defaultProjectPath,
            wsEndpoint: connection.wsEndpoint,
            port: connection.port,
            currentRoute,
            listenerAttached: logStatus?.listenerAttached ?? null,
            lastLogAt: logStatus?.lastLogAt ?? null,
            logStoreMode: logStatus?.logStoreMode ?? null,
            sessionId: logStatus?.sessionId ?? connection.sessionId,
            sourceProjectPath: logStatus?.sourceProjectPath ?? null,
            lastScreenshotAt: screenshotStatus.lastScreenshotAt,
            lastScreenshotOk: screenshotStatus.lastScreenshotOk,
            lastScreenshotErrorCode: screenshotStatus.lastScreenshotErrorCode,
            checkedAt: Date.now(),
            warnings: [
              ...(args.includeLogs && !listenerAttached ? ["listener not attached"] : []),
              ...(args.includePage && !currentRoute ? ["current route unavailable"] : []),
              ...(screenshotRecentlyFailed
                ? [
                    `last mp_screenshot failed (code=${screenshotStatus.lastScreenshotErrorCode ?? "UNKNOWN"}); screenshot channel is degraded but connection recovery is not recommended while needsRecovery=false`,
                  ]
                : []),
            ],
            errors: [
              ...(!connection.devtoolsOnline ? ["devtools offline"] : []),
              ...(!automatorConnected ? ["automator session missing"] : []),
            ],
          })
        );
      }),
    timeoutMs: 30000,
  };
}

function createRecoverConnectionTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_recoverConnection",
    description:
      "按标准顺序修复一个**已存在但降级/失效**的连接:重建 automator 会话 → 重挂日志监听 → 恢复项目上下文,并返回恢复前后对比。\n\n何时用:这是**升级修复步**——只有当 mp_healthCheck 显示 needsRecovery=true 时调它,而不是只看 summary='degraded' 就重连。\n何时不用:首次“建立连接”不要用本工具,用 mp_ensureConnection(它才负责自动拉起 IDE)；连接全绿但截图失败且 needsRecovery=false 时也不要用,重连无法修复截图通道。与 ensure(reconnect=true) 的区别:本工具跑一套有序修复并报告 before/after,ensure 只是把会话弄就绪。\n\n返回 JSON 含 ok / recovered、actions[](做了哪些修复)、before/after 状态、health.summary、warnings/errors。recovered=true 只表示连接恢复完成；若历史截图仍失败,health.summary 会保持 degraded 但 needsRecovery=false。recovered=false 说明连接修复未完成——此时不要无限重试,确认开发者工具确实在运行,必要时反馈给用户。\n\n参数:reconnect 默认 true(丢弃旧会话重连);设 false 仅在不想强制重连、只想跑其余修复步骤时用。connection 可选,覆盖默认连接参数。",
    parameters: recoverConnectionParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = recoverConnectionParameters.parse(rawArgs ?? {});
        const recovery = await manager.recoverConnection(context.log, {
          overrides: args.connection,
          reconnect: args.reconnect,
        });
        const afterLog = await manager.getLogStatus(args.connection);
        const recovered = recovery.after.automatorConnected && afterLog.listenerAttached;
        const screenshotStatus = manager.getScreenshotStatus(args.connection);
        const screenshotRecentlyFailed =
          screenshotStatus.lastScreenshotAt !== null && screenshotStatus.lastScreenshotOk === false;

        return toTextResult(
          formatJson({
            ok: recovered,
            recovered,
            actions: recovery.actions,
            before: recovery.before,
            after: recovery.after,
            health: {
              ok: recovered,
              summary: recovered && !screenshotRecentlyFailed ? "connected" : "degraded",
              needsRecovery: !recovered,
              lastScreenshotOk: screenshotStatus.lastScreenshotOk,
              lastScreenshotErrorCode: screenshotStatus.lastScreenshotErrorCode,
            },
            warnings: [
              ...(!afterLog.listenerAttached ? ["listener not attached after recovery"] : []),
              ...(screenshotRecentlyFailed
                ? [
                    `connection recovered, but screenshot channel remains degraded (code=${screenshotStatus.lastScreenshotErrorCode ?? "UNKNOWN"}); do not repeat connection recovery`,
                  ]
                : []),
            ],
            errors: recovered ? [] : ["connection recovery incomplete"],
          })
        );
      }),
    timeoutMs: 1260000,
  };
}

function createNavigateTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_navigate",
    description:
      "在小程序内导航并返回导航后的 activePage(path+query)。**返回的 activePage 是这次导航 resolve 的真实当前页,可直接信任,无需再调 mp_currentPage 或 mp_evaluate 交叉校验路由。**\n\ntransition 怎么选:\n- navigateTo(默认):压栈打开新页,可 navigateBack 返回。\n- redirectTo:关掉当前页再打开,不入栈。\n- reLaunch:关掉所有页栈后打开(回首页 / 重置状态用)。\n- switchTab:**仅用于 app.json tabBar 里注册的 tab 页,且不支持 query**;跳非 tabBar 页会报 'can not switch to no-tabBar page' —— 这种情况改用 navigateTo。(不确定哪些是 tab 页时,custom-tab-bar 项目 tabBar 可能为空,需查 app.json 的 tabBar.list 或 pages。)\n- navigateBack:返回上一页,此时 path 可省略;其余 transition 都必须传 path。\n\nquery 用 query 参数传(对象,如 {id:'1'}),会自动拼到 url,不要手动拼进 path;switchTab 除外。\n\n⚠️ waitMs 是 dumb sleep,不是等条件。时序敏感场景(onShow 鉴权 / SSE 初始化 / 异步 setData)建议 waitMs 留小(如 500 给 transition 过渡),再用 mp_pollUntil 等具体条件就绪。若 waitMs 阶段超时,错误里会带 currentRoute 帮你判断导航是否其实已生效。",
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

          try {
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
          } catch (navError) {
            const message = navError instanceof Error ? navError.message : String(navError);
            // switchTab 只能跳 app.json tabBar 注册的页；裸 SDK 错误不带下一步，这里补 hint
            if (transition === "switchTab" && /tab-?bar|tabbar/i.test(message)) {
              throw new UserError(
                `switchTab 失败: ${message}。"${providedPath}" 不是 app.json tabBar 里注册的 tab 页 —— 改用 transition:"navigateTo"（或 reLaunch）导航到该页。`
              );
            }
            throw new UserError(
              `${transition} 导航到 "${url ?? providedPath ?? ""}" 失败: ${message}`
            );
          }

          if (waitMs) {
            try {
              await waitOnPage(page, waitMs);
            } catch (waitError) {
              const message = waitError instanceof Error ? waitError.message : String(waitError);
              const probed = await manager.withRequestTimeout(
                () => miniProgram.currentPage(),
                {
                  timeoutMs: 3000,
                  description: "导航等待失败后读取当前页面",
                }
              ).catch(() => null);
              throw new UserError(
                `mp_navigate waitFor(${waitMs}ms) 失败: ${message}。当前 route: ${probed?.path ?? "unknown"}（导航本身可能已完成，仅 waitFor 阶段超时）。建议：1) 增大 waitMs；2) 用 mp_pollUntil 等待具体元素或 data 字段就绪。`
              );
            }
          }

          const activePage = page ?? (await readCurrentPage(
            manager,
            miniProgram,
            "导航后读取当前页面"
          ));

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
    timeoutMs: 660000,
  };
}

function classifyScreenshotError(error: unknown): {
  code: "SCREENSHOT_TIMEOUT" | "SIMULATOR_HIDDEN" | "RENDERER_NOT_READY" | "LOCAL_OUTPUT_ERROR" | "EMPTY_OUTPUT" | "UNKNOWN";
  hint: string;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const msg = raw.toLowerCase();
  if (
    msg.includes("eacces") ||
    msg.includes("eperm") ||
    msg.includes("enoent") ||
    msg.includes("enospc") ||
    msg.includes("eisdir") ||
    msg.includes("erofs") ||
    msg.includes("edquot") ||
    msg.includes("enametoolong") ||
    msg.includes("is a directory") ||
    msg.includes("read-only") ||
    msg.includes("permission denied") ||
    msg.includes("创建截图目录失败")
  ) {
    return {
      code: "LOCAL_OUTPUT_ERROR",
      hint: "截图帧可能已获取，但本地输出路径不可写或磁盘空间不足。请更换可写路径并检查剩余空间；该错误不代表截图通道失效。",
    };
  }
  if (msg.includes("empty screenshot output") || msg.includes("zero-byte screenshot")) {
    return {
      code: "EMPTY_OUTPUT",
      hint: "截图调用已返回，但没有产生有效图片字节。请确认模拟器正在前台渲染；若连续出现，改用页面结构与数据断言完成验证。",
    };
  }
  if (msg.includes("[request_timeout]") || msg.includes("timeout") || msg.includes("超时")) {
    return {
      code: "SCREENSHOT_TIMEOUT",
      hint: "截图超时（帧没在 timeoutMs 内拿回）。建议：1) 适度提高 timeoutMs（默认 30000，可到 60000）再试一次；2) ⚠️ 若 mp_healthCheck 全绿、甚至 mp_recoverConnection 后单张截图仍超时，那就不是连接问题、也别再加大 timeoutMs 空等——这是该环境截图通道拿不回帧（设备离线态 / 模拟器未前台渲染 / 构建不支持截图），改用 page_getElements 坐标 + page_getData/page_expectData 数据断言兜底（与 UNKNOWN 同源）。",
    };
  }
  if (msg.includes("simulator") || msg.includes("模拟器") || msg.includes("hidden") || msg.includes("not visible")) {
    return {
      code: "SIMULATOR_HIDDEN",
      hint: "模拟器窗口可能被隐藏 / 最小化 / 不在前台。建议：把开发者工具窗口聚焦到前台，确保模拟器面板可见后重试。",
    };
  }
  if (msg.includes("renderer") || msg.includes("page") || msg.includes("loading") || msg.includes("页面") || msg.includes("正在加载")) {
    return {
      code: "RENDERER_NOT_READY",
      hint: "渲染器尚未就绪。建议：先调 page_waitElement 等待关键元素出现，或加 page_waitTimeout 留出渲染时间后重试。",
    };
  }
  return {
    code: "UNKNOWN",
    hint: "未匹配到已知失败模式。⚠️ 若 mp_healthCheck 全绿(连接正常)却仍反复截图失败，这通常不是连接问题——多半是该环境的渲染/截图通道本身不可用(模拟器未在前台渲染 / 设备离线态 / 该 DevTools 构建不支持截图)。此时 mp_recoverConnection 无效，不要反复重试；改用 page_getElements 的 offset/size 坐标 + page_getData/page_expectData 数据断言来完成验证。仅当 healthCheck 显示断连时才考虑 mp_recoverConnection。请把本错误的完整 message 反馈给维护者，以便加精确归因。",
  };
}

async function captureMiniProgramScreenshot(
  manager: WeappAutomatorManager,
  miniProgram: any,
  path: string | undefined,
  timeoutMs: number
): Promise<{ output: string | void; method: "automator" | "direct-temp-file" }> {
  try {
    const output = await miniProgram.screenshot(path ? { path } : undefined);
    if (path) {
      await assertScreenshotFile(path);
    }
    return {
      output,
      method: "automator",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("fail to capture screenshot")) {
      throw error;
    }

    // DevTools 会先 wx.saveFile 再读截图；已保存文件空间满时截图成功也会被统一报错。
    const directResult = await manager.runSerializedEvaluate<{
      data?: string;
      error?: string;
    }>(
      () =>
        miniProgram.evaluate(function () {
          return new Promise((resolve) => {
            const root = globalThis as any;
            const bridge = root.WeixinJSBridge;
            const wxApi = root.wx;
            if (!bridge?.invoke || !wxApi?.getFileSystemManager) {
              resolve({ error: "private screenshot bridge unavailable" });
              return;
            }
            bridge.invoke("private_captureScreen", {}, (capture: any) => {
              if (
                typeof capture?.errMsg !== "string" ||
                !capture.errMsg.includes(":ok") ||
                typeof capture.tempFilePath !== "string"
              ) {
                resolve({ error: capture?.errMsg ?? "private_captureScreen failed" });
                return;
              }
              wxApi.getFileSystemManager().readFile({
                filePath: capture.tempFilePath,
                encoding: "base64",
                success(readResult: any) {
                  resolve({ data: readResult?.data });
                },
                fail(readError: any) {
                  resolve({ error: readError?.errMsg ?? "direct temp-file read failed" });
                },
              });
            });
          });
        }),
      {
        description: "执行截图 direct-temp-file fallback",
        timeoutMs,
      }
    );

    if (typeof directResult?.data !== "string" || directResult.data.length === 0) {
      throw new Error(
        `${message}; direct temp-file fallback failed: ${directResult?.error ?? "unknown error"}`
      );
    }
    if (path) {
      await writeFile(path, directResult.data, "base64");
      await assertScreenshotFile(path);
      return { output: undefined, method: "direct-temp-file" };
    }
    return { output: directResult.data, method: "direct-temp-file" };
  }
}

async function assertScreenshotFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`EISDIR: screenshot output path is not a file: ${path}`);
  }
  if (info.size === 0) {
    throw new Error(`Empty screenshot output: zero-byte screenshot file at ${path}`);
  }
}

function createScreenshotTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_screenshot",
    description:
      "截取当前小程序视口截图。需已有活动会话(无会话先 mp_ensureConnection)。**不传 path 返回内联图片(image content);传 path 则存文件并返回 JSON {ok,path,route} —— 此时拿不到图像本身，route 为可空诊断字段。** 父目录不存在会自动 mkdir -p；文件模式会验证输出存在且非零字节后才返回成功。\n\n⚠️ 截图是**单通道串行**能力:全局一次只跑一个,不要并发拍图;超时后也不要立刻重发(底层那条超时请求仍占着单通道,再发会互相打乱)—— 等本次调用返回再说。截图前不会额外读取 currentPage，避免非必要请求先占住截图通道。仅支持开发者工具模拟器(客户端环境可能返回 EMPTY_OUTPUT)。\n\n失败时返回 reasonCode 并附可操作建议:SCREENSHOT_TIMEOUT、SIMULATOR_HIDDEN、RENDERER_NOT_READY、LOCAL_OUTPUT_ERROR、EMPTY_OUTPUT、UNKNOWN。只有 RENDERER_NOT_READY 会自动重试一次；本地输出错误不会计入截图通道连续失败。连续 2 次拿不回帧后,后续截图会直接返回 SCREENSHOT_UNAVAILABLE 跳过;确认环境恢复后传 force:true 再试。",
    parameters: screenshotParameters,
    timeoutMs: 660000,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = screenshotParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram, config) => {
          // 先确认本次调用的真实连接目标，再读取该目标的截图连败状态。
          // 否则关闭旧会话后切到新目标时，会被旧目标的失败记录错误短路。
          const ssStatus = manager.getScreenshotStatus(args.connection);
          if (!args.force && ssStatus.failureStreak >= 2) {
            return toErrorResult(
              `[SCREENSHOT_UNAVAILABLE] 已跳过本次截图：本环境已连续 ${ssStatus.failureStreak} 次拿不回帧（最近一次 ${ssStatus.lastScreenshotErrorCode ?? "?"}）。这是该开发者工具环境的截图通道本身不通（设备离线态 / 模拟器未在前台渲染 / 该构建不支持 captureScreenshot），与连接状态、调用频率无关——mp_recoverConnection 也无效，别再反复重试空等超时。请改用 page_getElements 的 offset/size 坐标 + page_getData/page_expectData 数据断言来完成验证。若已确认环境恢复（如重开 / 前置模拟器窗口），传 force:true 再试一次。`
            );
          }
          if (args.path) {
            try {
              await mkdir(dirname(args.path), { recursive: true });
            } catch (mkdirError) {
              const message = mkdirError instanceof Error ? mkdirError.message : String(mkdirError);
              manager.recordScreenshotResult(false, "LOCAL_OUTPUT_ERROR");
              throw new UserError(`创建截图目录失败 (${dirname(args.path)}): ${message}`);
            }
          }
          const screenshotMode = args.path ? "file" : "inline";
          const currentRoute: string | null = null;

          context.log.info("Starting miniProgram.screenshot", {
            mode: screenshotMode,
            path: args.path ?? null,
            timeoutMs: args.timeoutMs,
            route: currentRoute,
            connectionMode: config.mode,
            wsEndpoint: config.wsEndpoint ?? null,
            projectPath: config.projectPath ?? null,
          });

          let output: string | void | undefined;
          let captureMethod: "automator" | "direct-temp-file" = "automator";
          let attempts = 0;
          let lastError: unknown = null;
          let lastClassification: ReturnType<typeof classifyScreenshotError> | null = null;
          while (attempts < 2) {
            attempts++;
            try {
              const capture = await manager.runSerializedScreenshot(
                context.log,
                () =>
                  captureMiniProgramScreenshot(
                    manager,
                    miniProgram,
                    args.path,
                    args.timeoutMs
                  ),
                {
                  timeoutMs: args.timeoutMs,
                  description: `执行页面截图（mode=${screenshotMode}, attempt=${attempts}）`,
                }
              );
              output = capture.output;
              captureMethod = capture.method;
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              lastClassification = classifyScreenshotError(error);
              // 仅对"重试可能有救"的失败重试——实际只有 RENDERER_NOT_READY(等 1s 渲染器就绪)。
              // SIMULATOR_HIDDEN 重试无意义；SCREENSHOT_TIMEOUT 时底层 miniProgram.screenshot()
              // 仍在单通道 WS 上运行（withRequestTimeout 只是 reject、不能取消它），再发一发会与
              // 那条孤儿请求并发、打乱单通道；UNKNOWN 多为该环境根本截不了(渲染/截图通道不可用)，
              // 重试只会再白等一轮长超时——这几类都直接 break，返回可操作提示。
              const shouldRetry =
                attempts < 2 &&
                lastClassification.code === "RENDERER_NOT_READY";
              if (!shouldRetry) {
                break;
              }
              context.log.warn(
                `mp_screenshot 第 ${attempts} 次失败 [${lastClassification.code}]，1s 后重试`
              );
              await new Promise((r) => setTimeout(r, 1000));
            }
          }

          if (lastError) {
            const classification = lastClassification ?? classifyScreenshotError(lastError);
            manager.recordScreenshotResult(false, classification.code);
            const baseMsg = lastError instanceof Error ? lastError.message : String(lastError);
            throw new UserError(
              `[${classification.code}] ${baseMsg}\n\n截图诊断：\n- 当前 route: ${currentRoute ?? "not probed (to keep screenshot lane clear)"}\n- 截图模式: ${screenshotMode}\n- 输出路径: ${args.path ?? "<inline>"}\n- 工具超时: ${args.timeoutMs}ms\n- 重试次数: ${attempts}\n- 建议: ${classification.hint}`
            );
          }

          if (typeof output === "string") {
            context.log.info("miniProgram.screenshot returned inline base64", {
              size: output.length,
            });
            const buffer = Buffer.from(output, "base64");
            if (buffer.byteLength === 0) {
              manager.recordScreenshotResult(false, "EMPTY_OUTPUT");
              return toErrorResult(
                "[EMPTY_OUTPUT] 截图返回了空图片数据。官方说明：miniProgram.screenshot 不传 path 时应返回非空 base64；若当前环境为客户端而非开发者工具模拟器，截图能力可能不可用。"
              );
            }
            manager.recordScreenshotResult(true);
            const image = await imageContent({ buffer });
            return { content: [image] };
          }

          if (args.path) {
            manager.recordScreenshotResult(true);
            context.log.info("miniProgram.screenshot saved file", {
              path: args.path,
            });
            return toTextResult(
              formatJson({
                ok: true,
                mode: "file",
                path: args.path,
                route: currentRoute,
                timeoutMs: args.timeoutMs,
                attempts,
                captureMethod,
              })
            );
          }

          manager.recordScreenshotResult(false, "EMPTY_OUTPUT");
          return toErrorResult(
            "[EMPTY_OUTPUT] 截图未产生图片数据。官方说明：miniProgram.screenshot 不传 path 时应返回 base64；若当前环境为客户端而非开发者工具模拟器，截图能力可能不可用。"
          );
        }
      );
      }),
  };
}

function createCallWxMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_callWx",
    description:
      "调用微信小程序 API。method **不带 wx. 前缀**(内部自动拼),例如传 `pageScrollTo` 而非 `wx.pageScrollTo`。args 是按位置依次展开的参数数组:多数 wx API 收单个 options 对象,所以传 `[{ scrollTop: 0, duration: 300 }]`(数组里放那一个 options 对象),而不是裸对象。返回 {method, arguments, result},result 为 API 返回值。\n\n何时用:直接触发 wx.* 能力(滚动、剪贴板、storage 等)。要读 / 改 page.data 或跑任意页面逻辑用 mp_evaluate;要等某条件就绪用 mp_pollUntil。",
    parameters: callWxMethodParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = callWxMethodParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const callArgs = args.args ?? [];
          let result;
          try {
            result = await miniProgram.callWxMethod(args.method, ...callArgs);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`调用 wx.${args.method} 失败: ${message}`);
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
              note: "wx 方法返回结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
  };
}

function createEvaluateTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_evaluate",
    description:
      "向小程序 AppService 注入并执行一个函数,返回其结果。functionSource 必须是**完整的 function 表达式字符串**(如 `function(){ return getCurrentPages().pop().data.ready }` 或 `() => wx.getStorageSync('token')`),不能是裸语句。函数体跑在 AppService 上下文,可用 getCurrentPages()、getApp()、wx 等全局;args 数组会按顺序作为函数入参展开。返回值经 JSON 序列化,别返回 DOM/句柄类不可序列化对象。\n\n适合在 page.data 不稳定时显式读取 / 状态机断言 / 内联绕过 modal。可选 timeoutMs 覆盖默认 15s(上限 600s),用于长耗时异步。⚠️ 等任意条件请用 `mp_pollUntil`(内置 predicate 轮询,比 evaluate+waitTimeout+evaluate 手写循环稳);要调 wx.* API 用 `mp_callWx`。注意:函数体别遍历完整 prototype 链或做复杂反射,可能命中 SDK wrapper 抛 'Cannot read property is of undefined',保持函数体最小。",
    parameters: evaluateParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = evaluateParameters.parse(rawArgs ?? {});
      const callArgs = args.args ?? [];
      const timeoutMs = args.timeoutMs ?? 15000;

      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          let result;
          try {
            result = await manager.runSerializedEvaluate(
              () =>
                miniProgram.evaluate(
                  runFunctionSourceInAppService,
                  args.functionSource,
                  callArgs
                ),
              { description: "执行小程序 evaluate", timeoutMs }
            );
          } catch (error) {
            if (error instanceof UserError) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`执行 evaluate 失败: ${message}`);
          }

          return clampedTextResult(
            {
              functionSource: args.functionSource,
              arguments: callArgs,
              timeoutMs,
              result: toSerializableValue(result),
            },
            args.maxBytes,
            {
              identity: { timeoutMs },
              note: "evaluate 返回结果超过 maxBytes 已截断。",
            }
          );
        }
      );
      }),
    timeoutMs: 660000,
  };
}

function createPollUntilTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_pollUntil",
    description:
      "**通用 wait-for-condition / waitData 工具**:轮询执行 predicate(返回任意真值即命中)直到命中或超时,可选在命中后执行 action,并按 snapshotPaths 拍 before/after 快照。典型场景:等 page.data 某字段变化(predicate 写 `function(){ return getCurrentPages().pop().data.conversationHistory.length === 1 }`)、等异步状态切换、等 SSE 流式中段、时序敏感打断。\n\npredicate / action 是 function 源码字符串,跑在 AppService(可用 getCurrentPages、wx 等);predicateArgs / actionArgs 是按顺序展开给这两个函数的入参数组。轮询由 server 端管理,重连不留脏 setInterval。\n\nsnapshotPaths 走点路径取值,支持 [N] 下标、负索引、[*] 通配(如 `conversationHistory[*].aiStatus`、`list.length`);before = predicate 命中时刻的 page.data,after = action 跑完且等 snapshotAfterMs 后的 page.data(snapshotAfterMs 给异步 setData 留时间,默认 0,上限 60000,仅在传 snapshotPaths 时有效)。结果超过 maxBytes(默认 50000B)会截断。\n\n注意:timeoutMs(默认 15s,上限 600s)是 predicate、action、等待和快照的整体预算;若比单次 evaluate 还短,可能只跑 1 次 predicate 就超时。",
    parameters: pollUntilParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = pollUntilParameters.parse(rawArgs ?? {});
        const predicateArgs = args.predicateArgs ?? [];
        const actionArgs = args.actionArgs ?? [];
        const interval = args.pollIntervalMs;
        const overall = args.timeoutMs;

        return manager.withMiniProgram<ContentResult>(
          context.log,
          { overrides: args.connection },
          async (miniProgram) => {
            const startedAt = Date.now();
            const remainingBudget = (phase: string): number => {
              const remaining = overall - (Date.now() - startedAt);
              if (remaining <= 0) {
                throw new UserError(
                  `[REQUEST_TIMEOUT] mp_pollUntil 整体超时 (${overall}ms)，无法继续${phase}。`
                );
              }
              return remaining;
            };
            let iterations = 0;
            let lastValue: unknown = undefined;
            let matched = false;
            let lastError: string | null = null;

            while (Date.now() - startedAt < overall) {
              const remainingBeforePredicate = overall - (Date.now() - startedAt);
              if (remainingBeforePredicate <= 0) {
                break;
              }
              iterations++;
              try {
                lastValue = await manager.runSerializedEvaluate(
                  () =>
                    miniProgram.evaluate(
                      runFunctionSourceInAppService,
                      args.predicate,
                      predicateArgs
                    ),
                  {
                    description: "执行 pollUntil predicate",
                    timeoutMs: Math.min(remainingBeforePredicate, 15000),
                  }
                );
                lastError = null;
                if (lastValue) {
                  matched = true;
                  break;
                }
              } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                if (lastError.includes("[REQUEST_TIMEOUT]")) {
                  break;
                }
              }
              const remaining = overall - (Date.now() - startedAt);
              if (remaining <= 0) break;
              await new Promise((r) => setTimeout(r, Math.min(interval, remaining)));
            }

            const elapsedMs = Date.now() - startedAt;
            let before: Record<string, unknown> | undefined;
            let after: Record<string, unknown> | undefined;
            let actionRan = false;
            let actionError: string | null = null;

            if (matched && args.snapshotPaths?.length) {
              const page = await readCurrentPage(
                manager,
                miniProgram,
                "读取 before 快照活动页面",
                remainingBudget("读取 before 快照活动页面")
              );
              if (!page) {
                throw new UserError("predicate 已命中，但当前没有活动页面，无法生成请求的 before 快照。");
              }
              let data;
              try {
                data = await manager.withRequestTimeout(
                  () => page.data(),
                  {
                    description: "拍 before 快照",
                    timeoutMs: remainingBudget("拍 before 快照"),
                  }
                );
              } catch (error) {
                if (error instanceof UserError) {
                  throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new UserError(`生成 before 快照失败: ${message}`);
              }
              before = pickByPaths(data, args.snapshotPaths).values;
            }

            if (matched && args.action) {
              try {
                const remainingBeforeAction = remainingBudget("执行 action");
                await manager.runSerializedEvaluate(
                  () =>
                    miniProgram.evaluate(
                      runFunctionSourceInAppService,
                      args.action!,
                      actionArgs
                    ),
                  {
                    description: "执行 pollUntil action",
                    timeoutMs: Math.min(remainingBeforeAction, 15000),
                  }
                );
                actionRan = true;
              } catch (error) {
                actionError = error instanceof Error ? error.message : String(error);
              }
            }

            if (actionRan && args.snapshotPaths?.length && args.snapshotAfterMs > 0) {
              const remainingBeforeDelay = remainingBudget("等待 after 快照");
              if (args.snapshotAfterMs >= remainingBeforeDelay) {
                throw new UserError(
                  `[REQUEST_TIMEOUT] action 已执行，但 snapshotAfterMs=${args.snapshotAfterMs}ms 超出 mp_pollUntil 剩余预算 ${remainingBeforeDelay}ms，未生成 after 快照。`
                );
              }
              await new Promise((r) => setTimeout(r, args.snapshotAfterMs));
            }

            if (matched && actionRan && args.snapshotPaths?.length) {
              const afterPage = await readCurrentPage(
                manager,
                miniProgram,
                "读取 after 快照活动页面",
                remainingBudget("读取 after 快照活动页面")
              );
              if (!afterPage) {
                throw new UserError("action 已执行，但当前没有活动页面，无法生成请求的 after 快照。");
              }
              let data;
              try {
                data = await manager.withRequestTimeout(
                  () => afterPage.data(),
                  {
                    description: "拍 after 快照",
                    timeoutMs: remainingBudget("拍 after 快照"),
                  }
                );
              } catch (error) {
                if (error instanceof UserError) {
                  throw error;
                }
                const message = error instanceof Error ? error.message : String(error);
                throw new UserError(`生成 after 快照失败: ${message}`);
              }
              after = pickByPaths(data, args.snapshotPaths).values;
            }

            const payload = {
              matched,
              iterations,
              elapsedMs,
              pollIntervalMs: interval,
              timeoutMs: overall,
              finalPredicateValue: toSerializableValue(lastValue),
              lastPredicateError: lastError,
              actionRan,
              actionError,
              before: before ?? null,
              after: after ?? null,
              snapshotPaths: args.snapshotPaths ?? null,
            };
            const result = clampedTextResult(payload, args.maxBytes, {
              identity: {
                matched,
                iterations,
                elapsedMs,
                actionRan,
              },
              note: "pollUntil 结果超过 maxBytes 已截断。建议缩小 snapshotPaths 或让 predicate 只返回必要状态。",
            });
            return !matched || actionError ? { ...result, isError: true } : result;
          }
        );
      }),
    timeoutMs: 660000,
  };
}

function createGetConsoleLogsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_getLogs",
    description:
      "读取当前连接目标的小程序控制台日志,支持过滤。不同项目 / wsEndpoint 的持久化日志会隔离,不会混读或互相清空。常见用法:操作前用 clear=true 清空当前目标缓冲,操作后再读以拿到本次产生的日志。\n\n过滤参数:\n- contains:子串匹配(对 message + 序列化后的 data 一起匹配,非正则)。\n- type:按级别过滤,枚举 log/info/warn/error/exception(exception 是未捕获异常,区别于 console.error)。\n- since:**相对时间窗口,单位毫秒** —— 只返回过去 N ms 内的日志(不是绝对时间戳)。\n- limit:最多返回条数,默认 100,取**最新的 N 条**。\n\n返回 {count, totalCount, logs[], filters, listenerAttached...}:count 是过滤后条数,totalCount 是当前目标缓冲区总条数(count<totalCount 说明被 limit/过滤截断)。listenerAttached=false 说明日志监听没挂上,可能漏日志,需 mp_recoverConnection。clear=true 只清空当前连接目标的缓冲。",
    parameters: getConsoleLogsParameters,
    execute: async (rawArgs) =>
      withUserErrorResult(async () => {
      const args = getConsoleLogsParameters.parse(rawArgs ?? {});
      const allLogs = await manager.getConsoleLogs(args.connection);
      const limit = args.limit ?? 100;
      const logs = filterConsoleLogs(allLogs, {
        type: args.type,
        contains: args.contains,
        since: args.since,
        limit,
      });

      if (args.clear) {
        await manager.clearConsoleLogs(args.connection);
      }

      const logStatus = await manager.getLogStatus(args.connection);

      return clampedTextResult(
        {
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
        },
        args.maxBytes,
        {
          identity: {
            count: logs.length,
            totalCount: allLogs.length,
          },
          note: "日志结果超过 maxBytes 已截断。建议缩小 limit / since / contains。",
        }
      );
      }),
  };
}

function createRunScenarioTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_runScenario",
    description:
      "按顺序执行一组小程序调试/回归步骤,一次调用跑完并汇总每步 pass/fail。用于把一条短链路脚本化复跑(导航→操作→断言);只做单次交互探查请用单个 page_*/element_* 工具。要把结果整理成 markdown 复核产物时改用 mp_generateScenarioReport(参数相同)。\n\nsteps[] 每项必带 `type`,最多 25 步,共 12 种(分动作类与断言类):\n● 动作类(不返回 pass,只在抛错时算失败):\n  - navigate {path?, query?, transition?=navigateTo|redirectTo|reLaunch|switchTab|navigateBack, waitMs?} — 只有 navigateBack 可省略 path;waitMs 是 dumb sleep,时序敏感场景宁可用 waitRoute 步或拆出来用 mp_pollUntil\n  - tap {selector, innerSelector?, waitMs?}\n  - input {selector, innerSelector?, value(string|number)}\n  - snapshot {selectors?[], dataPaths?[], withData?=false, withElements?=true, withWxml?=false, limit?=10, maxBytes?=50000} — 每个 selector 受 limit 限制，所有 selector 合计最多汇总 100 个元素摘要；超 maxBytes 会截断并返回 note;比独立 page_snapshot 弱\n  - getLogs {clear?, contains?, logType?, since?, limit?=100}\n  - screenshot {path?, timeoutMs?=30000} — 不传 path 时**不回传 base64**(只给 note),要图请单独调 mp_screenshot 或传 path 存文件;连续 2 次截图通道失败后会短路\n● 断言类(决定 scenario 整体 ok/pass):\n  - waitRoute {path, timeout?=5000, retryInterval?=200} — 轮询直到 route 命中,返回 matched\n  - expectRoute {path} — 即时断言当前 route\n  - expectVisible {selector} — 命中 ≥1 个即过\n  - expectText {selector, expected, mode?=equals|includes}\n  - expectCount {selector, expected(整数)}\n  - expectData {path, expected} — 必须显式给 expected;path 未解析到值且 expected 省略时直接判失败(避免 undefined===undefined 静默判过)\n\n⚠️ selector 用 page.$ / page.$$,**不穿透自定义组件内部**;组件内元素用 innerSelector(在父元素内再查),取第 N 个匹配用 `selector[index=N]` 语法。\n⚠️ 想要真正验证就必须放至少一个断言步:纯动作步全部不抛错也只代表跑通了,ok=true 不等于断言通过。\n\nstopOnFailure 默认 true:遇到首个失败步即停,后续步不执行;设 false 跑完所有步再汇总。scenarioTimeoutMs 控制整体预算,默认 120000ms、最大 600000ms。maxBytes 控制聚合结果大小,默认 500000B。\n\n建议每个 scenario 保持短(≤ ~10 步):snapshot/screenshot 在长链路后段更易超时/抖动 — 拆成多个短 scenario 分段跑。\n\n返回 {ok, totalSteps, executedSteps, passedSteps, failedSteps, results[]},每个 result = {index, type, pass, step, result 或 error}。",
    parameters: runScenarioParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = runScenarioParameters.parse(rawArgs ?? {});
        const summary = await runScenario(
          manager,
          context,
          args.steps,
          args.connection,
          args.stopOnFailure,
          args.scenarioTimeoutMs
        );
        return clampedTextResult(
          { ...summary },
          args.maxBytes,
          {
            identity: {
              ok: summary.ok,
              totalSteps: summary.totalSteps,
              executedSteps: summary.executedSteps,
              passedSteps: summary.passedSteps,
              failedSteps: summary.failedSteps,
            },
            note: "scenario 聚合结果超过 maxBytes 已截断。建议拆分 scenario 或缩小 snapshot/getLogs 输出。",
          }
        );
      }),
    timeoutMs: 660000,
  };
}

function createGenerateScenarioReportTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_generateScenarioReport",
    description:
      "执行一个 scenario(步骤定义与执行语义完全同 mp_runScenario:同样的 12 种 step、断言/动作 pass 规则、stopOnFailure 默认 true、selector 不穿透自定义组件等 — 先看 mp_runScenario 了解如何写 steps[]),并额外生成一份人可复核的 markdown 回归报告。只需要机器可读的 pass/fail 结果、不要报告时,用 mp_runScenario。\n\nmarkdown 始终通过返回值的 `report` 字段回传(无论是否写盘);传 outputPath 时同时写入该路径(父目录自动 mkdir -p 创建)。\n\n报告内容开关:includePassedSteps=false 只保留失败步(适合失败聚焦报告);includeSnapshots=false 从各步结果剥掉 data/elements/snapshot;includeLogs=false 剥掉 logs。title 为报告大标题(默认 'Scenario Report')。\n\n返回 {ok, outputPath, title, totalSteps, executedSteps, passedSteps, failedSteps, report}。",
    parameters: generateScenarioReportParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
        const args = generateScenarioReportParameters.parse(rawArgs ?? {});
        const summary = await runScenario(
          manager,
          context,
          args.steps,
          args.connection,
          args.stopOnFailure,
          args.scenarioTimeoutMs
        );
        const title = normalizeMarkdownHeading(args.title ?? "Scenario Report");
        const markdown = buildScenarioReportMarkdown({
          title,
          includeLogs: args.includeLogs,
          includeSnapshots: args.includeSnapshots,
          includePassedSteps: args.includePassedSteps,
          summary,
        });

        if (args.outputPath) {
          try {
            await mkdir(dirname(args.outputPath), { recursive: true });
            await writeFile(args.outputPath, markdown, "utf-8");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(
              `写入 scenario 报告失败 (${args.outputPath}): ${message}`
            );
          }
        }

        return clampedTextResult(
          {
            ok: summary.ok,
            outputPath: args.outputPath ?? null,
            title,
            totalSteps: summary.totalSteps,
            executedSteps: summary.executedSteps,
            passedSteps: summary.passedSteps,
            failedSteps: summary.failedSteps,
            report: markdown,
          },
          args.maxBytes,
          {
            identity: {
              ok: summary.ok,
              outputPath: args.outputPath ?? null,
              totalSteps: summary.totalSteps,
              executedSteps: summary.executedSteps,
              passedSteps: summary.passedSteps,
              failedSteps: summary.failedSteps,
            },
            note: "scenario 报告返回值超过 maxBytes 已截断；传 outputPath 时磁盘报告仍为完整内容。",
          }
        );
      }),
    timeoutMs: 660000,
  };
}

function createCurrentPageTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_currentPage",
    description:
      "获取当前页面信息(path、query、size、scrollTop)。withData=true 额外返回 page.data。\n\n何时用:想一次拿“路由 + 尺寸/滚动 + 部分 data”的概览时。\n何时改用别的:只想读 data 字段 → 用 page_getData;想断言/等待某个路由 → 用 page_expectRoute / page_waitRoute(它们已替你处理路由滞后),不要在这里读 path 再手动比较。\n\n⚠️ 路由滞后:path 来自 SDK currentPage() 句柄,是**快照型**,仅在“刚做完快速 navigate / reLaunch / switchTab 的那一瞬间”可能落后于真实路由;稳态下可信。**刚导航完一般不用调本工具**——mp_navigate 返回的 activePage 已经可信。只有在确实怀疑该瞬间滞后时,才用 mp_evaluate 跑 `return getCurrentPages().slice(-1)[0].route` 交叉校验,别默认每次都加这步。\n\n参数:dataPaths 只取关键字段、避免大数组爆 token,支持点路径、数组下标(含负数如 [-1])、.length、以及通配 [*](如 ['conversationHistory[*].aiStatus','isSearching']);解析不到的路径会进返回里的 missingPaths。maxBytes 默认 50000,超出按字节截断并置 truncated=true,字节数见 bytes(字段名与 page_getData 一致)。connection 可选。",
    parameters: currentPageParameters,
    execute: async (rawArgs, context: ToolContext) =>
      withUserErrorResult(async () => {
      const args = currentPageParameters.parse(rawArgs ?? {});
      return manager.withMiniProgram<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const page = await readCurrentPage(
            manager,
            miniProgram,
            "读取当前页面"
          );
          if (!page) {
            throw new UserError("当前没有活动页面。");
          }

          const [size, scrollTop] = await Promise.all([
            manager.withRequestTimeout(
              () => page.size(),
              { description: "读取当前页面尺寸" }
            ).catch(() => null),
            manager.withRequestTimeout(
              () => page.scrollTop(),
              { description: "读取当前页面滚动位置" }
            ).catch(() => null),
          ]);

          const result: Record<string, unknown> = {
            path: page.path,
            query: toSerializableValue(page.query),
            size: toSerializableValue(size),
            scrollTop: toSerializableValue(scrollTop),
          };

          const wantData = args.withData || (args.dataPaths && args.dataPaths.length > 0);
          if (wantData) {
            let data;
            try {
              data = await manager.withRequestTimeout(
                () => page.data(),
                { description: "读取当前页面数据" }
              );
            } catch (error) {
              if (error instanceof UserError) {
                throw error;
              }
              const message = error instanceof Error ? error.message : String(error);
              throw new UserError(`读取当前页面数据失败: ${message}`);
            }

            let dataPayload: unknown;
            let missingPaths: string[] | null = null;
            const isPicked = !!(args.dataPaths && args.dataPaths.length > 0);
            if (isPicked) {
              const picked = pickByPaths(data, args.dataPaths!);
              dataPayload = picked.values;
              missingPaths = picked.missing;
            } else {
              dataPayload = toSerializableValue(data);
            }

            result.data = dataPayload;
            result.bytes = Buffer.byteLength(
              JSON.stringify(dataPayload) ?? "",
              "utf8"
            );
            result.maxBytes = args.maxBytes;
            if (isPicked) {
              result.dataPaths = args.dataPaths;
              result.missingPaths = missingPaths;
            }
          }

          return clampedTextResult(result, args.maxBytes, {
            identity: {
              path: page.path,
            },
            note: "当前页面结果超过 maxBytes 已截断。建议缩小 dataPaths 或关闭 withData。",
          });
        }
      );
      }),
  };
}

function createListProjectsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_listProjects",
    description:
      "列出微信开发者工具里的最近项目(返回 { defaultProject, projects:[{index,name,path}] }),并显示当前 defaultProject。\n\n何时用:① mp_ensureConnection 返回“需要选择项目”提示后,先调本工具看有哪些项目,再把某项的 index / name / path 作为 projectSelection 传回 mp_ensureConnection;② 想固定后续连接用哪个项目时,把 path 传给 mp_setDefaultProject;③ 不确定有哪个项目可连时先调它确认。\n\n注意:返回的是“可连接的项目”,不是项目内的页面路由——要找页面路径需读项目的 app.json,本工具不提供。无参数。",
    parameters: listProjectsParameters,
    execute: async (rawArgs) =>
      withUserErrorResult(async () => {
      listProjectsParameters.parse(rawArgs ?? {});
      const projects = await manager.listRecentProjects();
      const defaultProject = await manager.getDefaultProject();
      await manager.setPendingProjects(projects);

      return toTextResult(
        formatJson({
          defaultProject,
          projects: projects.map((p, i) => ({
            index: i + 1,
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
  scenarioTimeoutMs: number,
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
  const startedAt = Date.now();

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      const remainingMs = scenarioTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw new UserError(`Scenario 整体超时 (${scenarioTimeoutMs}ms)。`);
      }
      const result = await manager.withRequestTimeout(
        () => executeScenarioStep(manager, context, step, connection),
        {
          timeoutMs: remainingMs,
          description: `执行 scenario 第 ${index + 1} 步 (${step.type})`,
        }
      );
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
      if (stopOnFailure || Date.now() - startedAt >= scenarioTimeoutMs) {
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
        if (transition !== "navigateBack" && !step.path) {
          throw new UserError("navigate step 缺少 path；只有 navigateBack 可省略 path。");
        }
        const url = transition === "navigateBack" ? undefined : buildUrl(step.path!, step.query);
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
        if (step.waitMs) {
          await waitOnPage(page, step.waitMs);
        }
        const activePage = page ?? (await manager.withRequestTimeout(
          () => miniProgram.currentPage(),
          { description: "scenario 导航后读取当前页面" }
        ));
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
        let lastError: string | null = null;
        let lastPath: string | null = null;
        while (Date.now() - start < step.timeout) {
          try {
            const remainingBeforeQuery = step.timeout - (Date.now() - start);
            const page = await manager.withRequestTimeout(
              () => miniProgram.currentPage(),
              {
                timeoutMs: Math.max(1, remainingBeforeQuery),
                description: "等待 scenario 页面路由读取",
              }
            );
            lastError = null;
            lastPath = page?.path ?? null;
            if (page?.path === step.path) {
              return { path: step.path, matched: true, waitTime: Date.now() - start, query: toSerializableValue(page.query) };
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
          const remaining = step.timeout - (Date.now() - start);
          if (remaining > 0) {
            await new Promise(resolve =>
              setTimeout(resolve, Math.min(step.retryInterval, remaining))
            );
          }
        }
        return {
          path: step.path,
          matched: false,
          actual: lastPath,
          lastError,
        };
      });
    }
    case "expectRoute": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const page = await manager.withRequestTimeout(
          () => miniProgram.currentPage(),
          { description: "scenario 路由断言读取当前页面" }
        );
        const actual = page?.path ?? null;
        return { pass: actual === step.path, expected: step.path, actual, snapshot: { path: actual, query: toSerializableValue(page?.query ?? null) } };
      });
    }
    case "expectVisible": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        if (step.innerSelector) {
          const elements = await queryScenarioInnerElements(
            page,
            step.selector,
            step.innerSelector
          );
          const count = elements.length;
          return {
            pass: count > 0,
            expected: true,
            actual: count > 0,
            snapshot: {
              selector: step.selector,
              innerSelector: step.innerSelector,
              count,
            },
          };
        }
        let selector = step.selector;
        let indexHint: number | undefined;
        const parsed = parseSelectorWithIndex(selector);
        if (parsed) {
          selector = parsed.baseSelector;
          indexHint = parsed.index;
        }
        if (typeof page.$$ !== "function") {
          throw new UserError("当前页面不支持查询元素数组。");
        }
        const elements = await page.$$(selector);
        if (!Array.isArray(elements)) {
          throw new UserError(`查询选择器 "${selector}" 失败。`);
        }
        const count = elements.length;
        const pass = indexHint !== undefined ? indexHint >= 0 && indexHint < count : count > 0;
        return { pass, expected: true, actual: pass, snapshot: { selector: step.selector, count, index: indexHint ?? null } };
      });
    }
    case "expectText": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const element = await resolveScenarioElement(
          page,
          step.selector,
          step.innerSelector
        );
        if (typeof element?.text !== "function") {
          throw new UserError(`元素 "${step.selector}" 不支持读取文本。`);
        }
        const actual = await element.text();
        const normalized = typeof actual === "string" ? actual : String(actual);
        const pass = step.mode === "includes" ? normalized.includes(step.expected) : normalized === step.expected;
        return {
          pass,
          expected: step.expected,
          actual: normalized,
          snapshot: {
            selector: step.selector,
            innerSelector: step.innerSelector ?? null,
            mode: step.mode,
          },
        };
      });
    }
    case "expectCount": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const elements = step.innerSelector
          ? await queryScenarioInnerElements(page, step.selector, step.innerSelector)
          : await queryScenarioPageElements(page, step.selector);
        const actual = elements.length;
        return {
          pass: actual === step.expected,
          expected: step.expected,
          actual,
          snapshot: {
            selector: step.selector,
            innerSelector: step.innerSelector ?? null,
          },
        };
      });
    }
    case "expectData": {
      return manager.withPage(context.log, { overrides: connection }, async (page) => {
        const actual = await manager.withRequestTimeout(() => page.data(step.path), { description: `读取页面数据 (${step.path})` });
        const normalizedActual = toSerializableValue(actual);
        const normalizedExpected = toSerializableValue(step.expected);
        return { pass: areSerializableValuesEqual(normalizedActual, normalizedExpected), expected: normalizedExpected, actual: normalizedActual, pathResolved: actual !== undefined, snapshot: { path: step.path } };
      });
    }
    case "snapshot": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const page = await manager.withRequestTimeout(
          () => miniProgram.currentPage(),
          { description: "scenario 快照读取当前页面" }
        );
        if (!page) {
          throw new UserError("当前没有可用页面，无法生成快照。");
        }
        const data: Record<string, unknown> = {};
        if (step.withData) {
          const fullData = await manager.withRequestTimeout(() => page.data(), { description: "读取页面完整数据快照" });
          setOwnEnumerableValue(data, "$", toSerializableValue(fullData));
        }
        for (const path of step.dataPaths) {
          const value = await manager.withRequestTimeout(() => page.data(path), { description: `读取页面数据快照 (${path})` });
          setOwnEnumerableValue(data, path, toSerializableValue(value));
        }
        const elements: Array<Record<string, unknown>> = [];
        let processedSelectorCount = 0;
        let elementsLimited = false;
        if (step.withElements && step.selectors.length > 0 && typeof page.$$ !== "function") {
          throw new UserError("当前页面不支持查询元素数组，无法生成请求的 scenario 元素快照。");
        }
        if (step.withElements && typeof page.$$ === "function") {
          for (const selector of step.selectors) {
            if (elements.length >= MAX_SNAPSHOT_ELEMENT_SUMMARIES) {
              elementsLimited = true;
              break;
            }
            const matched = await page.$$(selector);
            if (!Array.isArray(matched)) {
              throw new UserError(`查询选择器 "${selector}" 失败。`);
            }
            processedSelectorCount++;
            const remaining =
              MAX_SNAPSHOT_ELEMENT_SUMMARIES - elements.length;
            const list = matched.slice(0, Math.min(step.limit, remaining));
            if (matched.length > list.length) {
              elementsLimited = true;
            }
            for (let index = 0; index < list.length; index += 1) {
              elements.push({
                selector,
                index,
                ...(await summarizeElement(list[index], {
                  withWxml: step.withWxml,
                })),
              });
            }
          }
          if (processedSelectorCount < step.selectors.length) {
            elementsLimited = true;
          }
        }
        const snapshotResult = {
          route: page.path,
          query: toSerializableValue(page.query ?? null),
          data,
          selectors: step.selectors,
          elementCount: elements.length,
          elementsLimited,
          processedSelectorCount,
          elementSummaryLimit: MAX_SNAPSHOT_ELEMENT_SUMMARIES,
          elements,
        };
        const clamped = clampJsonByBytes(snapshotResult, step.maxBytes);
        if (clamped.truncated) {
          return {
            route: page.path,
            truncated: true,
            bytes: clamped.bytes,
            maxBytes: step.maxBytes,
            note: "scenario snapshot 超过 maxBytes 已截断。建议缩小 selectors / 关闭 withWxml / 降低 limit，或调大 maxBytes。",
            data: clamped.value,
          };
        }
        return snapshotResult;
      });
    }
    case "getLogs": {
      const allLogs = await manager.getConsoleLogs(connection);
      const logs = filterConsoleLogs(allLogs, {
        type: step.logType,
        contains: step.contains,
        since: step.since,
        limit: step.limit,
      });
      if (step.clear) {
        await manager.clearConsoleLogs(connection);
      }
      const logStatus = await manager.getLogStatus(connection);
      const result = {
        count: logs.length,
        totalCount: allLogs.length,
        listenerAttached: logStatus.listenerAttached,
        lastLogAt: logStatus.lastLogAt,
        sessionId: logStatus.sessionId,
        logs: logs.map((log) => ({ type: log.type, message: log.message, timestamp: log.timestamp, data: log.data })),
      };
      const clamped = clampJsonByBytes(result, step.maxBytes);
      return clamped.truncated
        ? {
            count: logs.length,
            totalCount: allLogs.length,
            truncated: true,
            bytes: clamped.bytes,
            maxBytes: step.maxBytes,
            note: "scenario 日志结果超过 maxBytes 已截断。建议缩小 limit / since / contains。",
            data: clamped.value,
          }
        : result;
    }
    case "screenshot": {
      return manager.withMiniProgram(context.log, { overrides: connection }, async (miniProgram) => {
        const screenshotStatus = manager.getScreenshotStatus(connection);
        if (screenshotStatus.failureStreak >= 2) {
          throw new UserError(
            `[SCREENSHOT_UNAVAILABLE] 已跳过 scenario 截图：本环境已连续 ${screenshotStatus.failureStreak} 次拿不回帧（最近一次 ${screenshotStatus.lastScreenshotErrorCode ?? "?"}）。请先确认模拟器已恢复前台渲染，再用独立 mp_screenshot(force=true) 验证。`
          );
        }
        if (step.path) {
          try {
            await mkdir(dirname(step.path), { recursive: true });
          } catch (error) {
            manager.recordScreenshotResult(false, "LOCAL_OUTPUT_ERROR");
            const message = error instanceof Error ? error.message : String(error);
            throw new UserError(`创建 scenario 截图目录失败 (${dirname(step.path)}): ${message}`);
          }
        }
        const screenshotMode = step.path ? "file" : "inline";
        const currentRoute: string | null = null;
        let capture;
        try {
          capture = await manager.runSerializedScreenshot(
            context.log,
            () =>
              captureMiniProgramScreenshot(
                manager,
                miniProgram,
                step.path,
                step.timeoutMs
              ),
            {
              timeoutMs: step.timeoutMs,
              description: `执行 scenario 截图（mode=${screenshotMode}）`,
            }
          );
        } catch (error) {
          const classification = classifyScreenshotError(error);
          manager.recordScreenshotResult(false, classification.code);
          const message = error instanceof Error ? error.message : String(error);
          throw new UserError(`[${classification.code}] ${message}\n建议: ${classification.hint}`);
        }
        const output = capture.output;
        if (typeof output === "string") {
          const imageBytes = Buffer.from(output, "base64").byteLength;
          if (imageBytes === 0) {
            manager.recordScreenshotResult(false, "EMPTY_OUTPUT");
            throw new UserError(
              "[EMPTY_OUTPUT] scenario 截图返回了空图片数据；未传 path 时 SDK 必须返回非空 base64。"
            );
          }
          manager.recordScreenshotResult(true);
          // 不把 raw base64（常 1-5MB）塞进 scenario 文本结果，否则灌爆 agent 上下文、
          // 可能超 MCP 消息上限。需要图像请单独调 mp_screenshot（走 image content block），
          // 或给本步传 path 存文件。
          return {
            ok: true,
            mode: "inline",
            path: step.path ?? null,
            route: currentRoute,
            timeoutMs: step.timeoutMs,
            bytes: imageBytes,
            captureMethod: capture.method,
            note: "scenario 内联截图不回传 base64；需要图像请单独调 mp_screenshot，或给本步传 path 存文件。",
          };
        }
        if (!step.path) {
          manager.recordScreenshotResult(false, "EMPTY_OUTPUT");
          throw new UserError(
            "[EMPTY_OUTPUT] scenario 截图未产生图片数据；未传 path 时 SDK 必须返回 base64。"
          );
        }
        manager.recordScreenshotResult(true);
        return {
          ok: true,
          mode: "file",
          path: step.path ?? null,
          route: currentRoute,
          timeoutMs: step.timeoutMs,
          captureMethod: capture.method,
        };
      });
    }
  }
}

function getScenarioStepPass(_step: z.infer<typeof scenarioStepSchema>, result: Record<string, unknown>): boolean {
  // 按结果字段判定，而非靠 step.type 名前缀：任何返回 pass/matched 的 step 都据实判定，
  // 将来新增 expect 类 step 即使不以 "expect" 开头也不会被静默判过。
  // 动作类 step（navigate/tap/input/snapshot/getLogs/screenshot）不返回 pass/matched，
  // 未抛错即视为成功。
  if ("pass" in result) {
    return result.pass === true;
  }
  if ("matched" in result) {
    return result.matched === true;
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
    hints.push("截图步骤当前按单通道能力设计，不要并发执行。若连续失败，先运行 mp_healthCheck；仅 needsRecovery=true 时执行 mp_recoverConnection。");
  }

  if (step.type === "snapshot") {
    hints.push("page_snapshot 在复杂连续操作后可能超时；建议只在关键节点采集快照，不要在长链路中高频叠加。若失败，先运行 mp_healthCheck；仅 needsRecovery=true 时执行 mp_recoverConnection。");
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
  const title = normalizeMarkdownHeading(input.title ?? "Scenario Report");
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
      appendMarkdownCodeBlock(lines, formatJson(step), "json");
    }

    if (typeof item.error === "string") {
      lines.push("**Error**");
      appendMarkdownCodeBlock(lines, item.error);
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
        lines.push(`**Screenshot**: ${formatMarkdownInlineCode(record.path)}`);
        lines.push("");
      }
      lines.push("**Result**");
      appendMarkdownCodeBlock(lines, formatJson(filtered), "json");
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

function normalizeMarkdownHeading(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim() || "Scenario Report";
}

function appendMarkdownCodeBlock(
  lines: string[],
  content: string,
  language = ""
): void {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  lines.push(`${fence}${language}`, content, fence, "");
}

function formatMarkdownInlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(1, longestRun + 1));
  return `${fence} ${value} ${fence}`;
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

async function queryScenarioPageElements(page: any, selector: string): Promise<any[]> {
  if (typeof page.$$ !== "function") {
    throw new UserError("当前页面不支持查询元素数组。");
  }
  const parsed = parseSelectorWithIndex(selector);
  const elements = await page.$$(parsed?.baseSelector ?? selector);
  if (!Array.isArray(elements)) {
    throw new UserError(`查询选择器 "${selector}" 失败。`);
  }
  if (!parsed) {
    return elements;
  }
  return parsed.index >= 0 && parsed.index < elements.length
    ? [elements[parsed.index]]
    : [];
}

async function queryScenarioInnerElements(
  page: any,
  selector: string,
  innerSelector: string
): Promise<any[]> {
  let parent: any;
  try {
    parent = await resolveScenarioElement(page, selector);
  } catch (error) {
    if (
      error instanceof UserError &&
      /Element not found|元素未找到|索引 .*超出范围/.test(error.message)
    ) {
      return [];
    }
    throw error;
  }
  if (typeof parent.$$ !== "function") {
    throw new UserError(`Element for selector "${selector}" does not support nested array queries.`);
  }
  const elements = await parent.$$(innerSelector);
  if (!Array.isArray(elements)) {
    throw new UserError(
      `查询元素 "${selector}" 内部选择器 "${innerSelector}" 失败。`
    );
  }
  return elements;
}

function createSetDefaultProjectTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "mp_setDefaultProject",
    description:
      "把指定项目设为持久化的默认项目;设置后**下次** mp_ensureConnection 会优先用它连接。本工具只写默认值,**不会自己建立连接**。\n\n何时用:只想修改后续连接默认项目、暂时不建立连接时。projectPath 传 mp_listProjects 返回的 projects[].path(项目目录绝对路径);路径无效或目录不存在会返回错误,不会静默成功。\n与 mp_ensureConnection 的 projectSelection 区别:projectSelection 会在当前 ensure 调用里立即选中并连接该项目,同时也保存为默认项目;本工具只保存默认项目。设完需再调 mp_ensureConnection 才真正连上。",
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
