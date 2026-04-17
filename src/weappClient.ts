import { UserError, type SerializableValue } from "fastmcp";
import automator from "miniprogram-automator";
import net from "net";
import * as http from "node:http";
import * as https from "node:https";
import fs from "fs";
import path from "path";
import os from "os";

import {
  ConfigError,
  globalTimeoutMs,
  resolveConfig,
  type ConnectionOverrides,
  type WeappConnectionConfig,
} from "./config.js";

type ToolLogger = {
  debug: (message: string, data?: SerializableValue) => void;
  info: (message: string, data?: SerializableValue) => void;
  warn: (message: string, data?: SerializableValue) => void;
  error: (message: string, data?: SerializableValue) => void;
};

interface UseOptions {
  overrides?: ConnectionOverrides;
  reconnect?: boolean;
}

export interface ConsoleLogEntry {
  type: string;
  message: string;
  timestamp: number;
  data?: SerializableValue;
}

export interface LogStatusSnapshot {
  listenerAttached: boolean;
  lastLogAt: number | null;
  lastListenerBindAt: number | null;
  logStoreMode: "persisted";
  sessionId: string | null;
  sourceProjectPath: string | null;
  logCount: number;
  recentTypes: string[];
}

export interface ConnectionSnapshot {
  devtoolsOnline: boolean;
  wsReachable: boolean;
  automatorConnected: boolean;
  connectionMode: string | null;
  projectPath: string | null;
  wsEndpoint: string | null;
  port: number | null;
  sessionId: string | null;
}

export interface ConnectionDiagnosis {
  mode: "launch" | "connect";
  target: string | null;
  wsEndpoint: string | null;
  port: number | null;
  launchPort: number | null;
  projectPath: string | null;
  portListening: boolean;
  tcpReachable: boolean;
  websocketReachable: boolean;
  httpProbe: string | null;
  looksLikeIdeHttp: boolean;
  looksLikeAutomatorWs: boolean;
  ideProcessDetected: boolean;
  projectConfigured: boolean;
  safeToLaunch: boolean;
  reasonCode: string | null;
  suggestion: string;
  allowAutoLaunch: boolean;
}

interface HttpProbeResult {
  ok: boolean;
  statusCode: number | null;
  bodySnippet: string | null;
  error: string | null;
}

interface PersistedState {
  lastProjectPath: string | null;
  pendingProjects: { path: string; name: string }[];
  consoleLogs: ConsoleLogEntry[];
  sessionId: string | null;
  listenerAttached: boolean;
  lastLogAt: number | null;
  lastListenerBindAt: number | null;
  logStoreMode: "persisted";
  sourceProjectPath: string | null;
}

export class WeappAutomatorManager {
  private miniProgram?: MiniProgramInstance;
  private config?: WeappConnectionConfig;
  private consoleLogs: ConsoleLogEntry[] = [];
  private maxLogs = 1000; // 最多保存1000条日志
  private pendingProjects: { path: string; name: string }[] = [];
  private loggingAttachedProgram?: MiniProgramInstance;
  private sessionId: string | null = null;
  private listenerAttached = false;
  private lastLogAt: number | null = null;
  private lastListenerBindAt: number | null = null;
  private screenshotQueue: Promise<void> = Promise.resolve();
  private screenshotCooldownMs = 300;
  
  private static readonly CONFIG_FILE = path.join(
    process.env.USERPROFILE || process.env.HOME || os.tmpdir(),
    ".weapp-agent-mcp-config.json"
  );

  // 微信开发者工具目录名称（跨平台常量）
  private static readonly WECHAT_DEVTOOLS_DIR = "微信开发者工具";

  /**
   * 设置待选择项目列表（用于交互式选择）
   */
  async setPendingProjects(projects: { path: string; name: string }[]): Promise<void> {
    this.pendingProjects = projects;
    await this.savePendingProjects(projects);
  }

  /**
   * 保存待选择项目到配置文件（持久化，支持跨进程）
   */
  private async savePendingProjects(projects: { path: string; name: string }[]): Promise<void> {
    const state = await this.readPersistedState();
    state.pendingProjects = projects;
    if (this.config?.projectPath) {
      state.lastProjectPath = this.config.projectPath;
    }
    await this.writePersistedState(state);
  }

  /**
   * 从配置文件加载待选择项目
   */
  private async loadPendingProjects(): Promise<{ path: string; name: string }[]> {
    try {
      const state = await this.readPersistedState();
      return state.pendingProjects;
    } catch (error) {
      console.warn("[config] Failed to load pending projects:", error);
      return [];
    }
  }

  /**
   * 获取待选择项目列表
   */
  getPendingProjects(): { path: string; name: string }[] {
    return [...this.pendingProjects];
  }

  async consumePendingProject(selection: string): Promise<{ path: string; name: string } | null> {
    // 先从配置文件加载（支持跨进程）
    if (this.pendingProjects.length === 0) {
      this.pendingProjects = await this.loadPendingProjects();
    }
    
    const trimmed = selection.trim();
    
    // 验证编号格式（必须是纯数字）
    const index = parseInt(trimmed, 10) - 1;
    const isValidIndex = /^\d+$/.test(trimmed) && index >= 0 && index < this.pendingProjects.length;
    
    if (isValidIndex) {
      const selected = this.pendingProjects[index];
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return selected;
    }
    
    // 尝试解析路径（直接匹配）
    const byPath = this.pendingProjects.find(p => p.path === trimmed || p.name === trimmed);
    if (byPath) {
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return byPath;
    }
    
    // 失败时清空状态，避免误导
    this.pendingProjects = [];
    await this.savePendingProjects([]);
    return null;
  }
  
  /**
   * 获取错误提示信息（用于无效选择时显示）
   */
  async getSelectionHint(): Promise<string> {
    // 先从配置文件加载（支持跨进程）
    if (this.pendingProjects.length === 0) {
      this.pendingProjects = await this.loadPendingProjects();
    }
    if (this.pendingProjects.length === 0) {
      return "没有待选择的项目。请先调用 mp_listProjects 查看可用项目。";
    }
    const options = this.pendingProjects
      .map((p, i) => `  ${i + 1}. ${p.name} (${p.path})`)
      .join("\n");
    return `可用选项：\n${options}\n\n请输入编号（1-${this.pendingProjects.length}）或完整路径`;
  }

  async getConsoleLogs(): Promise<ConsoleLogEntry[]> {
    const state = await this.readPersistedState();
    this.consoleLogs = state.consoleLogs;
    this.sessionId = state.sessionId;
    this.listenerAttached = state.listenerAttached;
    this.lastLogAt = state.lastLogAt;
    this.lastListenerBindAt = state.lastListenerBindAt;
    return [...this.consoleLogs];
  }

  async getLogStatus(): Promise<LogStatusSnapshot> {
    const state = await this.readPersistedState();
    const logs = Array.isArray(state.consoleLogs) ? state.consoleLogs : [];
    const recentTypes = [...new Set(logs.slice(-20).map((log) => log.type))];
    return {
      listenerAttached: state.listenerAttached,
      lastLogAt: state.lastLogAt,
      lastListenerBindAt: state.lastListenerBindAt,
      logStoreMode: "persisted",
      sessionId: state.sessionId,
      sourceProjectPath: state.sourceProjectPath,
      logCount: logs.length,
      recentTypes,
    };
  }

  async clearConsoleLogs(): Promise<void> {
    this.consoleLogs = [];
    const state = await this.readPersistedState();
    state.consoleLogs = [];
    state.lastLogAt = null;
    await this.writePersistedState(state);
  }

  private appendConsoleLog(entry: ConsoleLogEntry): void {
    const previous = this.consoleLogs[this.consoleLogs.length - 1];
    if (previous) {
      const sameType = previous.type === entry.type;
      const sameMessage = previous.message === entry.message;
      const sameData = JSON.stringify(previous.data) === JSON.stringify(entry.data);
      const closeInTime = Math.abs(previous.timestamp - entry.timestamp) <= 100;
      if (sameType && sameMessage && sameData && closeInTime) {
        return;
      }
    }

    this.consoleLogs.push(entry);
    if (this.consoleLogs.length > this.maxLogs) {
      this.consoleLogs.shift();
    }

    this.lastLogAt = entry.timestamp;

    void this.persistConsoleLogs();
  }

  /**
   * 保存项目路径到配置文件
   */
  private async saveProjectPath(projectPath: string): Promise<void> {
    try {
      const state = await this.readPersistedState();
      state.lastProjectPath = projectPath;
      await this.writePersistedState(state);
    } catch (error) {
      console.warn("[config] Failed to save project path:", error);
    }
  }

  private async loadProjectPath(): Promise<string | null> {
    try {
      const state = await this.readPersistedState();
      return state.lastProjectPath;
    } catch (error) {
      console.warn("[config] Failed to load project path:", error);
      return null;
    }
  }

  private createDefaultState(): PersistedState {
    return {
      lastProjectPath: this.config?.projectPath || null,
      pendingProjects: [],
      consoleLogs: [],
      sessionId: this.sessionId,
      listenerAttached: this.listenerAttached,
      lastLogAt: this.lastLogAt,
      lastListenerBindAt: this.lastListenerBindAt,
      logStoreMode: "persisted",
      sourceProjectPath: this.config?.projectPath || null,
    };
  }

  private async readPersistedState(): Promise<PersistedState> {
    try {
      const content = await fs.promises.readFile(WeappAutomatorManager.CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(content) as Partial<PersistedState>;
      return {
        lastProjectPath: typeof parsed.lastProjectPath === "string" ? parsed.lastProjectPath : null,
        pendingProjects: Array.isArray(parsed.pendingProjects) ? parsed.pendingProjects : [],
        consoleLogs: Array.isArray(parsed.consoleLogs) ? parsed.consoleLogs as ConsoleLogEntry[] : [],
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        listenerAttached: typeof parsed.listenerAttached === "boolean" ? parsed.listenerAttached : false,
        lastLogAt: typeof parsed.lastLogAt === "number" ? parsed.lastLogAt : null,
        lastListenerBindAt: typeof parsed.lastListenerBindAt === "number" ? parsed.lastListenerBindAt : null,
        logStoreMode: "persisted",
        sourceProjectPath: typeof parsed.sourceProjectPath === "string" ? parsed.sourceProjectPath : null,
      };
    } catch {
      return this.createDefaultState();
    }
  }

  private async writePersistedState(state: PersistedState): Promise<void> {
    const configDir = path.dirname(WeappAutomatorManager.CONFIG_FILE);
    await fs.promises.mkdir(configDir, { recursive: true });
    const tmpPath = WeappAutomatorManager.CONFIG_FILE + ".tmp";
    await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await fs.promises.rename(tmpPath, WeappAutomatorManager.CONFIG_FILE);
  }

  private async persistConsoleLogs(): Promise<void> {
    try {
      const state = await this.readPersistedState();
      state.consoleLogs = [...this.consoleLogs];
      state.sessionId = this.sessionId ?? state.sessionId;
      state.listenerAttached = this.listenerAttached;
      state.lastLogAt = this.lastLogAt ?? state.lastLogAt;
      state.lastListenerBindAt = this.lastListenerBindAt ?? state.lastListenerBindAt;
      state.logStoreMode = "persisted";
      state.sourceProjectPath = this.config?.projectPath || state.sourceProjectPath || null;
      if (this.config?.projectPath) {
        state.lastProjectPath = this.config.projectPath;
      }
      await this.writePersistedState(state);
    } catch (error) {
      console.warn("[config] Failed to persist console logs:", error);
    }
  }

  private async persistStateMeta(): Promise<void> {
    try {
      const state = await this.readPersistedState();
      state.sessionId = this.sessionId ?? state.sessionId;
      state.listenerAttached = this.listenerAttached;
      state.lastLogAt = this.lastLogAt ?? state.lastLogAt;
      state.lastListenerBindAt = this.lastListenerBindAt ?? state.lastListenerBindAt;
      state.logStoreMode = "persisted";
      state.sourceProjectPath = this.config?.projectPath || state.sourceProjectPath || null;
      if (this.config?.projectPath) {
        state.lastProjectPath = this.config.projectPath;
      }
      await this.writePersistedState(state);
    } catch (error) {
      console.warn("[config] Failed to persist state meta:", error);
    }
  }

  async withRequestTimeout<T>(
    operation: () => Promise<T>,
    options?: { timeoutMs?: number; description?: string }
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? globalTimeoutMs;
    const description = options?.description ?? "请求";
    let timer: NodeJS.Timeout | null = null;

    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new UserError(
                this.withRecoveryTag(
                  "REQUEST_TIMEOUT",
                  `${description} 超时 (${timeoutMs}ms)。请重试一次；如仍失败，请重新执行 mp_ensureConnection 并传 reconnect=true。`
                )
              )
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async runSerializedScreenshot<T>(
    log: ToolLogger,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.screenshotQueue;
    let release!: () => void;
    this.screenshotQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);
    log.info("Acquired screenshot lane", {
      cooldownMs: this.screenshotCooldownMs,
    });

    try {
      return await operation();
    } finally {
      await new Promise((resolve) => setTimeout(resolve, this.screenshotCooldownMs));
      release();
    }
  }

  async diagnoseConnection(
    overrides?: ConnectionOverrides,
    options?: { strictMode?: boolean }
  ): Promise<ConnectionDiagnosis> {
    let config: WeappConnectionConfig;
    try {
      config = resolveConfig(overrides, this.config, {
        allowIncompleteConnect: options?.strictMode !== true,
        allowIncompleteLaunch: options?.strictMode !== true,
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        return {
          mode: overrides?.mode === "connect" ? "connect" : "launch",
          target: overrides?.wsEndpoint ?? null,
          wsEndpoint: overrides?.wsEndpoint ?? null,
          port: this.getConfiguredPortFromOverrides(overrides),
          launchPort: this.getLaunchPortFromOverrides(overrides),
          projectPath: overrides?.projectPath ?? null,
          portListening: false,
          tcpReachable: false,
          websocketReachable: false,
          httpProbe: null,
          looksLikeIdeHttp: false,
          looksLikeAutomatorWs: false,
          ideProcessDetected: await this.isDevToolsProcessRunning(),
          projectConfigured: Boolean(overrides?.projectPath),
          safeToLaunch: false,
          reasonCode: "INVALID_CONNECTION_CONFIG",
          suggestion: error.message,
          allowAutoLaunch: false,
        };
      }
      throw error;
    }

    const port = this.getConfiguredPort(config);
    const launchPort = this.getLaunchPort(config);
    const probeWsEndpoint = this.getProbeWsEndpoint(config);
    const target = config.wsEndpoint ?? probeWsEndpoint ?? (launchPort ? `auto-port:${launchPort}` : null);
    const [portListening, ideProcessDetected] = await Promise.all([
      port ? this.isPortInUse(port) : Promise.resolve(false),
      this.isDevToolsProcessRunning(),
    ]);
    const tcpReachable = portListening;
    let websocketReachable = false;
    let httpProbe: string | null = null;
    let looksLikeIdeHttp = false;
    let looksLikeAutomatorWs = false;
    let reasonCode: string | null = null;
    let suggestion = "当前目标可继续连接。";
    let safeToLaunch = config.mode === "launch";
    let allowAutoLaunch = config.mode === "launch";

    if (probeWsEndpoint) {
      const wsProbe = await this.probeWebSocketEndpoint(probeWsEndpoint, config.connectTimeout ?? 3000);
      websocketReachable = wsProbe.ok;
      looksLikeAutomatorWs = wsProbe.ok;
      if (!wsProbe.ok) {
        const httpResult = await this.probeHttpEndpoint(probeWsEndpoint, config.connectTimeout ?? 3000);
        httpProbe = this.formatHttpProbe(httpResult);
        looksLikeIdeHttp = this.looksLikeIdeHttpProbe(httpResult);
      }
    }

    if (config.mode === "connect") {
      safeToLaunch = false;
      allowAutoLaunch = Boolean(config.autoLaunch && config.projectPath);

      if (!config.wsEndpoint) {
        reasonCode = "INVALID_WS_ENDPOINT";
        suggestion = "connect 模式必须提供可连接的 websocket endpoint。请先确认自动化端口。";
      } else if (!portListening) {
        reasonCode = "PORT_NOT_LISTENING";
        suggestion = allowAutoLaunch
          ? "目标端口未监听。请先确认自动化服务是否已启动；若确需由 MCP 拉起，请显式提供项目路径并确认 launch 策略。"
          : "目标端口未监听。请不要自动切端口，先确认微信开发者工具已开启自动化。";
      } else if (looksLikeIdeHttp) {
        reasonCode = "IDE_HTTP_PORT_NOT_WS";
        suggestion = "当前端口看起来是 IDE HTTP 服务端口，不是自动化 websocket 端口。请不要重复启动 IDE，请确认自动化端口或重新开启自动化。";
        allowAutoLaunch = false;
      } else if (!websocketReachable) {
        reasonCode = "AUTOMATION_NOT_ENABLED";
        suggestion = "端口已监听，但 websocket 握手失败。请检查微信开发者工具是否已开启自动化测试。";
        allowAutoLaunch = false;
      } else {
        suggestion = "当前 websocket 目标可连接，可继续执行 mp_ensureConnection。";
      }
    } else {
      safeToLaunch = !looksLikeIdeHttp;
      allowAutoLaunch = safeToLaunch;

      if (!config.projectPath) {
        reasonCode = "PROJECT_NOT_OPENED";
        suggestion = "launch 模式必须提供项目路径，或先通过项目选择流程确定目标项目。";
        safeToLaunch = false;
        allowAutoLaunch = false;
      } else if (ideProcessDetected && websocketReachable) {
        reasonCode = "IDE_ALREADY_RUNNING";
        suggestion = "检测到微信开发者工具已经在运行，且当前自动化 websocket 已可达。为避免重复拉起导致 IDE 状态异常，已阻止 launch。请改用 connect 模式。";
        safeToLaunch = false;
        allowAutoLaunch = false;
      } else if (ideProcessDetected && looksLikeIdeHttp) {
        reasonCode = "IDE_ALREADY_RUNNING";
        suggestion = "检测到微信开发者工具已经在运行，且当前端口更像 IDE HTTP 服务。为避免重复拉起导致 IDE 状态异常，已阻止 launch。请改用 connect 模式或先手动关闭现有 IDE。";
        safeToLaunch = false;
        allowAutoLaunch = false;
      } else if (ideProcessDetected) {
        reasonCode = "LAUNCH_MODE_BLOCKED";
        suggestion = "检测到微信开发者工具进程已经在运行。为避免重复拉起新的 IDE，已停止 launch。请先确认现有 IDE 的自动化状态，必要时改用 connect 模式。";
        safeToLaunch = false;
        allowAutoLaunch = false;
      } else {
        suggestion = "当前未发现明显的重复启动风险；如需建立会话，可继续执行 mp_ensureConnection。";
      }
    }

    return {
      mode: config.mode,
      target,
      wsEndpoint: config.wsEndpoint ?? null,
      port,
      launchPort,
      projectPath: config.projectPath ?? null,
      portListening,
      tcpReachable,
      websocketReachable,
      httpProbe,
      looksLikeIdeHttp,
      looksLikeAutomatorWs,
      ideProcessDetected,
      projectConfigured: Boolean(config.projectPath),
      safeToLaunch,
      reasonCode,
      suggestion,
      allowAutoLaunch,
    };
  }

  async withMiniProgram<T>(
    log: ToolLogger,
    options: UseOptions,
    handler: (
      miniProgram: MiniProgramInstance,
      config: WeappConnectionConfig
    ) => Promise<T>
  ): Promise<T> {
    const { overrides, reconnect } = options;
    let effectiveOverrides: ConnectionOverrides = {
      args: overrides?.args,
      ...overrides,
    };
    let config = resolveConfig(effectiveOverrides, this.config, {
      allowIncompleteConnect: true,
      allowIncompleteLaunch: true,
    });

    const diagnosis = await this.diagnoseConnection(effectiveOverrides, { strictMode: false });
    if (diagnosis.reasonCode === "PROJECT_NOT_OPENED" && config.mode === "launch") {
      const defaultProject = await this.getDefaultProject();
      if (defaultProject) {
        log.info(`使用默认项目: ${defaultProject}`);
        effectiveOverrides = {
          ...effectiveOverrides,
          projectPath: defaultProject,
        };
        config = resolveConfig(effectiveOverrides, this.config, {
          allowIncompleteConnect: true,
        });
      } else {
        const projects = await this.listRecentProjects();
        if (projects.length === 1) {
          const [onlyProject] = projects;
          await this.saveProjectPath(onlyProject.path);
          log.info(`使用唯一项目: ${onlyProject.path}`);
          effectiveOverrides = {
            ...effectiveOverrides,
            projectPath: onlyProject.path,
          };
          config = resolveConfig(effectiveOverrides, this.config, {
            allowIncompleteConnect: true,
          });
        } else {
          await this.setPendingProjects(projects);
          const response = this.formatProjectSelectionResponse(projects, defaultProject);
          throw new UserError(this.withRecoveryTag("PROJECT_SELECTION_REQUIRED", response));
        }
      }
    } else if (diagnosis.reasonCode) {
      throw new UserError(formatDiagnosisError(diagnosis));
    }

    try {
      config = resolveConfig(effectiveOverrides, this.config);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new UserError(this.withRecoveryTag("INVALID_CONNECTION_CONFIG", error.message));
      }
      throw error;
    }

    if (reconnect) {
      await this.close(log);
    }

    const isAlive = await this.isConnectionAlive();
    const canReuse =
      this.miniProgram && this.config && isSameConfig(this.config, config) && isAlive;
    if (!canReuse) {
      await this.close(log);
      log.info("Establishing WeChat DevTools automation session", {
        mode: config.mode,
        projectPath: config.projectPath,
        wsEndpoint: config.wsEndpoint,
        port: config.port,
      });
      try {
        if (config.mode === "connect") {
          const timeoutMs = config.connectTimeout ?? 45000;
          log.info(`Connecting with ${timeoutMs}ms timeout...`);
          this.miniProgram = await this.connectWithTimeout(config, timeoutMs);
        } else {
          this.miniProgram = await this.connect(config);
        }
        this.config = config;
        if (!this.miniProgram) {
          throw new Error('MiniProgram not initialized');
        }
        this.attachLogging(this.miniProgram, log);
      } catch (error) {
        this.loggingAttachedProgram = undefined;
        this.miniProgram = undefined;
        this.config = undefined;
        const message = error instanceof Error ? error.message : String(error);
        const failureDiagnosis = await this.diagnoseConnection(overrides, { strictMode: false });
        throw new UserError(
          this.withRecoveryTag(
            config.mode === "connect"
              ? "CONNECT_MODE_FAILED"
              : "LAUNCH_MODE_FAILED",
            `Failed to ${
              config.mode === "connect" ? "connect to" : "launch"
            } WeChat DevTools: ${message}\n\n${formatDiagnosisDetails(failureDiagnosis)}\n\nNext step: retry mp_ensureConnection once with reconnect=true. If auto-launch is enabled and the project is ambiguous, call mp_listProjects or retry mp_ensureConnection with projectSelection.`
          )
        );
      }
    } else if (this.miniProgram) {
      this.attachLogging(this.miniProgram, log);
    }

    const activeProgram = this.miniProgram!;
    try {
      return await handler(activeProgram, config);
    } finally {
      if (config.autoClose) {
        await this.close(log);
      }
    }
  }

  async withPage<T>(
    log: ToolLogger,
    options: UseOptions,
    handler: (
      page: PageInstance,
      miniProgram: MiniProgramInstance,
      config: WeappConnectionConfig
    ) => Promise<T>
  ): Promise<T> {
    return this.withMiniProgram(log, options, async (miniProgram, config) => {
      const page = await miniProgram.currentPage();
      if (!page) {
        throw new UserError(
          this.withRecoveryTag(
            "NO_ACTIVE_PAGE",
            "Mini Program page stack is empty. Ensure the project window is open, then call mp_ensureConnection again before using page_* or element_* tools."
          )
        );
      }
      return handler(page, miniProgram, config);
    });
  }

  async close(log?: ToolLogger): Promise<void> {
    if (!this.miniProgram) {
      return;
    }

    try {
      if (this.config?.mode === "launch") {
        await this.miniProgram.close();
      } else {
        this.miniProgram.disconnect();
      }
      log?.debug("Closed WeChat DevTools automation session");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.warn("Failed to close WeChat DevTools cleanly", { message });
    } finally {
      this.miniProgram.removeAllListeners();
      this.loggingAttachedProgram = undefined;
      this.listenerAttached = false;
      void this.persistStateMeta();
      this.miniProgram = undefined;
      this.config = undefined;
    }
  }

  /**
   * 带超时控制的 WebSocket 连接
   */
  private async connectWithTimeout(
    config: WeappConnectionConfig,
    timeoutMs: number = 15000
  ): Promise<MiniProgramInstance> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<MiniProgramInstance>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = await Promise.race([
        automator.connect({ wsEndpoint: config.wsEndpoint! }),
        timeoutPromise
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  }

  /**
   * 验证连接是否真的可用
   */
  private async isConnectionAlive(): Promise<boolean> {
    try {
      if (!this.miniProgram) return false;
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      });

      try {
        const page = await Promise.race([
          this.miniProgram.currentPage(),
          timeoutPromise
        ]);
        if (timer) clearTimeout(timer);
        return page !== null && page !== undefined;
      } catch (e) {
        if (timer) clearTimeout(timer);
        throw e;
      }
    } catch {
      return false;
    }
  }

  private async connect(
    config: WeappConnectionConfig
  ): Promise<MiniProgramInstance> {
    if (config.mode === "connect") {
      return automator.connect({ wsEndpoint: config.wsEndpoint! });
    }

    return automator.launch({
      cliPath: config.cliPath,
      projectPath: config.projectPath!,
      timeout: config.timeout,
      port: this.getLaunchPort(config),
      account: config.account,
      ticket: config.ticket,
      trustProject: config.trustProject,
      args: config.args,
      cwd: config.cwd,
    });
  }

  private withRecoveryTag(tag: string, message: string): string {
    return `[${tag}] ${message}`;
  }

  private async probeWebSocketEndpoint(
    wsEndpoint: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; error: string | null }> {
    try {
      await Promise.race([
        automator.connect({ wsEndpoint }).then((miniProgram) => {
          miniProgram.disconnect();
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return { ok: true, error: null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeHttpEndpoint(
    endpoint: string,
    timeoutMs: number
  ): Promise<HttpProbeResult> {
    try {
      const url = new URL(endpoint);
      const client = url.protocol === "wss:" ? https : http;
      const pathName = `${url.pathname || "/"}${url.search || ""}`;
      const result = await new Promise<HttpProbeResult>((resolve) => {
        const req = client.request(
          {
            hostname: url.hostname,
            port: url.port ? Number(url.port) : undefined,
            path: pathName,
            method: "GET",
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => {
              if (chunks.reduce((sum, item) => sum + item.length, 0) < 2048) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
            });
            res.on("end", () => {
              resolve({
                ok: true,
                statusCode: res.statusCode ?? null,
                bodySnippet: Buffer.concat(chunks).toString("utf8").trim().slice(0, 200) || null,
                error: null,
              });
            });
          }
        );
        req.on("error", (error) => {
          resolve({
            ok: false,
            statusCode: null,
            bodySnippet: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        req.on("timeout", () => {
          req.destroy(new Error(`HTTP probe timeout after ${timeoutMs}ms`));
        });
        req.end();
      });
      return result;
    } catch (error) {
      return {
        ok: false,
        statusCode: null,
        bodySnippet: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private formatHttpProbe(result: HttpProbeResult): string | null {
    if (!result.ok) {
      return result.error;
    }
    const status = result.statusCode ?? "unknown";
    return result.bodySnippet ? `HTTP ${status}: ${result.bodySnippet}` : `HTTP ${status}`;
  }

  private looksLikeIdeHttpProbe(result: HttpProbeResult): boolean {
    if (!result.ok) {
      return false;
    }
    const body = result.bodySnippet?.toLowerCase() ?? "";
    return body.includes("cannot get /") || body.includes("wechat") || body.includes("devtools");
  }

  private getProbeWsEndpoint(config: WeappConnectionConfig): string | undefined {
    if (config.wsEndpoint) {
      return config.wsEndpoint;
    }
    const launchPort = this.getLaunchPort(config);
    if (!launchPort) {
      return undefined;
    }
    return `ws://127.0.0.1:${launchPort}`;
  }

  private getLaunchPort(config: WeappConnectionConfig): number {
    return typeof config.port === "number" ? config.port : 9420;
  }

  private getConfiguredPortFromOverrides(overrides?: ConnectionOverrides): number | null {
    if (typeof overrides?.port === "number") {
      return overrides.port;
    }
    if (overrides?.wsEndpoint) {
      try {
        const endpoint = new URL(overrides.wsEndpoint);
        if (endpoint.port) {
          return Number(endpoint.port);
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  private getLaunchPortFromOverrides(overrides?: ConnectionOverrides): number | null {
    return typeof overrides?.port === "number" ? overrides.port : null;
  }

  private async isDevToolsProcessRunning(): Promise<boolean> {
    try {
      const { execFile } = await import("node:child_process");
      const command = process.platform === "win32" ? "tasklist" : "pgrep";
      const args = process.platform === "win32" ? ["/FI", "IMAGENAME eq wechatwebdevtools.exe"] : ["-f", "wechatwebdevtools|微信开发者工具|cli.bat"];
      return await new Promise<boolean>((resolve) => {
        execFile(command, args, { timeout: 3000 }, (error, stdout) => {
          if (process.platform === "win32") {
            resolve(!error && stdout.toLowerCase().includes("wechatwebdevtools"));
            return;
          }
          resolve(!error && stdout.trim().length > 0);
        });
      });
    } catch {
      return false;
    }
  }

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = new net.Server();
      
      server.once("error", () => {
        resolve(true);
      });
      
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      
      server.listen(port, "127.0.0.1");
    });
  }

  private getConfiguredPort(config: WeappConnectionConfig): number {
    if (typeof config.port === "number") {
      return config.port;
    }

    if (config.wsEndpoint) {
      try {
        const endpoint = new URL(config.wsEndpoint);
        if (endpoint.port) {
          return Number(endpoint.port);
        }
        if (endpoint.protocol === "wss:") {
          return 443;
        }
        if (endpoint.protocol === "ws:") {
          return 80;
        }
      } catch {
      }
    }

    return 9420;
  }

  private async isValidWeappProject(projectPath: string): Promise<boolean> {
    const configPath = path.join(projectPath, "project.config.json");
    
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      const content = await fs.promises.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      return !!(config.appid || config.projectname);
    } catch {
      return false;
    }
  }
  
  /**
   * 从 WeappLocalData/*.json 读取项目（PRD要求的新路径）
   * 支持 Windows 和 macOS 平台
   */
  private async listProjectsFromWeappLocalData(): Promise<{ path: string; name: string }[]> {
    const projects: { path: string; name: string }[] = [];
    
    // 定位 WeappLocalData 目录的父目录
    let userDataBasePath: string;
    
    if (process.platform === 'darwin') {
      const macOSPath1 = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        WeappAutomatorManager.WECHAT_DEVTOOLS_DIR
      );
      const macOSPath2 = path.join(
        os.homedir(),
        "Library",
        "Containers",
        "com.tencent.xinWeChat",
        "Data",
        "Library",
        "Application Support",
        "com.tencent.xinWeChat"
      );
      
      try {
        await fs.promises.access(macOSPath1);
        userDataBasePath = macOSPath1;
      } catch {
        userDataBasePath = macOSPath2;
      }
    } else {
      // Windows: C:\Users\{username}\AppData\Local\{WECHAT_DEVTOOLS_DIR}\User Data
      userDataBasePath = path.join(
        os.homedir(),
        "AppData",
        "Local",
        WeappAutomatorManager.WECHAT_DEVTOOLS_DIR,
        "User Data"
      );
    }
    
    // 查找所有 hash 子目录（可能有多个）
    const weappLocalDataPaths: string[] = [];
    try {
      const entries = await fs.promises.readdir(userDataBasePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)) {
          weappLocalDataPaths.push(path.join(userDataBasePath, entry.name, "WeappLocalData"));
        }
      }
    } catch (error) {
      console.warn(`[MpListProjects] 读取 User Data 目录失败: ${(error as Error).message}`);
    }
    
    // 遍历所有 WeappLocalData 目录收集项目
    for (const weappLocalDataPath of weappLocalDataPaths) {
      try {
        const files = await fs.promises.readdir(weappLocalDataPath);
        const localStorageFiles = files.filter(f => f.startsWith('localstorage_') && f.endsWith('.json'));
        
        for (const file of localStorageFiles) {
          try {
            const filePath = path.join(weappLocalDataPath, file);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);
            
            // 遍历 JSON 对象，查找项目信息
            for (const [key, value] of Object.entries(data)) {
              // 跳过明显不是项目路径的键（如数字时间戳）
              if (/^\d+$/.test(key)) continue;
              
              const projectInfo = value as any;
              if (projectInfo && (projectInfo.projectPath || projectInfo.projectName)) {
                const projectPath = projectInfo.projectPath || key;
                const projectName = projectInfo.projectName || projectInfo.appName || path.basename(projectPath);
                
                // 验证项目有效性
                if (await this.isValidWeappProject(projectPath)) {
                  if (!projects.find(p => p.path === projectPath)) {
                    projects.push({ path: projectPath, name: projectName });
                  }
                }
              }
            }
          } catch (error) {
            console.warn(`[MpListProjects] 解析 localstorage 文件失败: ${file}, error: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        console.warn(`[MpListProjects] 读取 WeappLocalData 目录失败: ${weappLocalDataPath}, error: ${(error as Error).message}`);
      }
    }
    
    return projects;
  }

  /**
   * 获取微信开发者工具的最近项目列表
   * 优先从 WeappLocalData/*.json 读取（PRD要求）
   * Fallback 到原有扫描逻辑
   */
  async listRecentProjects(): Promise<{ path: string; name: string }[]> {
    // 1. 尝试从 WeappLocalData 读取
    const weappLocalDataProjects = await this.listProjectsFromWeappLocalData();
    if (weappLocalDataProjects.length > 0) {
      return weappLocalDataProjects.slice(0, 10);
    }
    
    // 2. Fallback 到原有逻辑
    const projects: { path: string; name: string }[] = [];
    const startTime = Date.now();
    const SCAN_TIMEOUT_MS = 5000;
    const MAX_DEPTH = 2;
    
    const isTimeout = () => Date.now() - startTime > SCAN_TIMEOUT_MS;
    
    const scanDir = async (dir: string, depth = 0): Promise<void> => {
      if (depth > MAX_DEPTH || isTimeout()) return;
      
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (isTimeout()) return;
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            const isValid = await this.isValidWeappProject(fullPath);
            if (isValid) {
              if (!projects.find(p => p.path === fullPath)) {
                projects.push({ path: fullPath, name: entry.name });
              }
            } else if (depth < MAX_DEPTH) {
              await scanDir(fullPath, depth + 1);
            }
          }
        }
      } catch {
        // 忽略权限错误
      }
    };
    
    // 微信开发者工具的用户数据目录
    const userDataPath = path.join(
      os.homedir(),
      "AppData",
      "Local",
      "微信开发者工具",
      "User Data"
    );
    
    let userDataDir = userDataPath;
    try {
      const exists = await fs.promises.access(userDataPath).then(() => true).catch(() => false);
      if (!exists) {
        // 尝试 fallback 方式
        userDataDir = userDataPath;
      } else {
        const entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)) {
            userDataDir = path.join(userDataPath, entry.name);
            break;
          }
        }
      }
    } catch {
      // 忽略错误
    }
    
    const possiblePaths = [
      path.join(userDataDir, "Default", "Local Storage", "weapp-devtools-state"),
      path.join(userDataDir, "weapp-devtools-state"),
      path.join(userDataDir, "Default", "Preferences"),
    ];
    
    for (const statePath of possiblePaths) {
      if (isTimeout()) break;
      try {
        const exists = await fs.promises.access(statePath).then(() => true).catch(() => false);
        if (exists) {
          const content = await fs.promises.readFile(statePath, "utf-8");
          const data = JSON.parse(content);
          
          if (data.recentProjects || data.recent || data.projects) {
            const recentList = data.recentProjects || data.recent || data.projects;
            if (Array.isArray(recentList)) {
              for (const item of recentList) {
                if (isTimeout()) break;
                const projectPath = item.path || item.projectPath || item;
                const projectName = item.name || item.projectName || path.basename(projectPath);
                
                if (projectPath) {
                  const isValid = await this.isValidWeappProject(projectPath);
                  if (isValid && !projects.find(p => p.path === projectPath)) {
                    projects.push({ path: projectPath, name: projectName });
                  }
                }
              }
            }
          }
        }
      } catch {
        // 继续尝试下一个路径
      }
    }
    
    if (projects.length === 0 && !isTimeout()) {
      const commonDirs = [
        path.join(os.homedir(), "Documents", "WeChatProjects"),
        path.join(os.homedir(), "Desktop"),
      ];
      
      for (const dir of commonDirs) {
        if (isTimeout()) break;
        try {
          await scanDir(dir, 0);
        } catch {
          // 忽略错误
        }
      }
    }
    
    return projects.slice(0, 10);
  }
  
  /**
   * 获取默认项目路径
   */
  async getDefaultProject(): Promise<string | null> {
    return this.loadProjectPath();
  }
  
  /**
   * 设置默认项目路径
   */
  async setDefaultProject(projectPath: string): Promise<boolean> {
    if (!(await this.isValidWeappProject(projectPath))) {
      return false;
    }
    await this.saveProjectPath(projectPath);
    return true;
  }

  /**
   * 格式化项目选择响应（标准化 Response Tags 格式）
   */
  private formatProjectSelectionResponse(
    projects: { path: string; name: string }[],
    defaultProject?: string | null
  ): string {
    // Case 1: 只有一个项目
    if (projects.length === 1) {
      return `[ONLY_ONE_PROJECT]
检测到您的小程序项目列表只有一个：

📁 ${projects[0].name}
   ${projects[0].path}

请选择操作：
A. 使用该项目
B. 重新选择其他项目
C. 输入新项目路径`;
    }

    // Case 2: 有默认项目配置
    if (defaultProject) {
      return `[DEFAULT_PROJECT_CONFIGURED]
您已配置默认项目：
📁 ${path.basename(defaultProject)}
   ${defaultProject}

请选择操作：
A. 使用默认项目（继续）
B. 重新选择项目（从列表选）
C. 输入新项目路径`;
    }

    // Case 3: 多个项目需要选择
    if (projects.length > 1) {
      const projectList = projects.map((p, i) => `${i + 1}|${p.name}|${p.path}`).join("\n");
      return `[SELECTION_REQUIRED]
请选择小程序项目：

${projectList}

请输入编号（如：1）或项目完整路径：`;
    }

    // Case 4: 空列表
    return `[PROJECT_LIST_EMPTY]
未检测到小程序项目。

可能的原因：
• 微信开发者工具尚未打开过任何项目
• 新安装的开发者工具

请选择操作：
A. 我已打开开发者工具（重新检测）
B. 帮我打开开发者工具
C. 直接输入项目路径`;
  }

  private getDefaultCliPath(): string | undefined {
    if (process.platform === 'darwin') {
      return '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
    } else if (process.platform === 'win32') {
      return 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
    }
    return undefined;
  }

  private async launchDevTools(config: WeappConnectionConfig, log: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
    // 使用配置的 cliPath 或平台默认路径
    const cliPath = config.cliPath || this.getDefaultCliPath();
    if (!cliPath) {
      throw new Error("cliPath not configured and no default path for this platform, cannot auto launch DevTools");
    }
    if (!config.projectPath) {
      throw new Error("projectPath not configured, cannot auto launch DevTools");
    }

    // 验证 CLI 路径是否存在且可执行
    try {
      await fs.promises.access(cliPath, fs.constants.X_OK);
    } catch {
      throw new Error(`CLI path not found or not executable: ${cliPath}`);
    }

    const { spawn } = await import("child_process");
    
    // Windows 上执行 bat 文件需要用 cmd /c
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    // auto 命令使用 --auto-port 指定自动化端口
    const autoArgs = [
      "auto",
      "--project", config.projectPath,
      "--auto-port", String(config.port ?? 9420),
    ];
    
    if (config.account) {
      autoArgs.push("--auto-account", config.account);
    }
    if (config.ticket) {
      autoArgs.push("--ticket", config.ticket);
    }
    if (config.trustProject) {
      autoArgs.push("--trust-project");
    }
    if (config.args) {
      autoArgs.push(...config.args);
    }
    
    // 根据平台选择执行方式
    let command: string;
    let commandArgs: string[];
    
    if (isWindows) {
      // Windows: 使用 cmd /c 执行 bat 文件
      command = "cmd.exe";
      commandArgs = ["/c", cliPath, ...autoArgs];
    } else if (isMac) {
      command = cliPath;
      commandArgs = autoArgs;
    } else {
      // 其他 POSIX 系统: 直接执行 CLI
      command = cliPath;
      commandArgs = autoArgs;
    }
    
    const logCommand = `${cliPath} ${autoArgs.join(" ")}`;
    log.info(`Launching: ${logCommand}`);
    
    const proc = spawn(command, commandArgs, {
      cwd: config.cwd,
      detached: true,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    });
    
    // 监听错误事件以便调试
    proc.on("error", (err) => {
      log.warn(`Failed to launch DevTools: ${err.message}`);
    });
    
    proc.unref();
    
    log.info(`DevTools launched with PID: ${proc.pid}`);
  }

  async getConnectionSnapshot(): Promise<ConnectionSnapshot> {
    const persisted = await this.readPersistedState();
    const config = this.config;
    const projectPath = config?.projectPath || persisted.lastProjectPath || null;
    const wsEndpoint = config?.wsEndpoint || null;
    const automatorConnected = await this.isConnectionAlive();
    const diagnosis = config
      ? await this.diagnoseConnection(toConnectionOverrides(config), { strictMode: false })
      : null;
    const port = diagnosis?.port ?? null;
    const devtoolsOnline = Boolean(
      automatorConnected || diagnosis?.portListening || diagnosis?.ideProcessDetected
    );

    return {
      devtoolsOnline,
      wsReachable: Boolean(automatorConnected || diagnosis?.websocketReachable),
      automatorConnected,
      connectionMode: config?.mode || null,
      projectPath,
      wsEndpoint,
      port,
      sessionId: this.sessionId || persisted.sessionId || null,
    };
  }

  async recoverConnection(log: ToolLogger, options?: UseOptions): Promise<{
    actions: string[];
    before: ConnectionSnapshot & { listenerAttached: boolean; lastLogAt: number | null };
    after: ConnectionSnapshot & { listenerAttached: boolean; lastLogAt: number | null };
  }> {
    const beforeConnection = await this.getConnectionSnapshot();
    const beforeLog = await this.getLogStatus();
    const actions: string[] = [];

    await this.withMiniProgram(
      log,
      {
        overrides: options?.overrides,
        reconnect: options?.reconnect ?? true,
      },
      async () => {
        actions.push("reconnected automator");
        return null;
      }
    );

    const afterConnection = await this.getConnectionSnapshot();
    const afterLog = await this.getLogStatus();

    if (!beforeLog.listenerAttached && afterLog.listenerAttached) {
      actions.push("rebound console listener");
    }
    if (!beforeConnection.projectPath && afterConnection.projectPath) {
      actions.push("reused persisted project path");
    }

    return {
      actions,
      before: {
        ...beforeConnection,
        listenerAttached: beforeLog.listenerAttached,
        lastLogAt: beforeLog.lastLogAt,
      },
      after: {
        ...afterConnection,
        listenerAttached: afterLog.listenerAttached,
        lastLogAt: afterLog.lastLogAt,
      },
    };
  }

  private attachLogging(miniProgram: MiniProgramInstance, log: ToolLogger) {
    if (this.loggingAttachedProgram === miniProgram) {
      this.listenerAttached = true;
      return;
    }

    this.loggingAttachedProgram = miniProgram;
    this.listenerAttached = true;
    this.lastListenerBindAt = Date.now();
    this.sessionId = this.createSessionId();
    void this.persistStateMeta();

    miniProgram.on("console", (event: unknown) => {
      const serialized = toSerializable(event);
      const args = (event as any)?.args;
      const logEntry: ConsoleLogEntry = {
        type: typeof (event as any)?.type === "string" ? (event as any).type : "log",
        message: Array.isArray(args) ? args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ") : String(serialized),
        timestamp: Date.now(),
        data: serialized,
      };

      this.appendConsoleLog(logEntry);

      log.debug("Mini Program console event", {
        event: serialized,
      });
    });
    miniProgram.on("exception", (event: unknown) => {
      const serialized = toSerializable(event);
      const logEntry: ConsoleLogEntry = {
        type: "exception",
        message: typeof (event as any)?.message === "string" ? (event as any).message : String(serialized),
        timestamp: Date.now(),
        data: serialized,
      };

      this.appendConsoleLog(logEntry);

      log.error("Mini Program exception", {
        event: serialized,
      });
    });
  }

  private createSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

type MiniProgramInstance = Awaited<ReturnType<typeof automator.launch>>;
type PageInstance = NonNullable<
  Awaited<ReturnType<MiniProgramInstance["currentPage"]>>
>;

function toSerializable(value: unknown): SerializableValue {
  if (value === null || value === undefined) {
    return value as SerializableValue;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item)) as SerializableValue;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => [key, toSerializable(val)]
    );
    return Object.fromEntries(entries) as SerializableValue;
  }
  return String(value) as SerializableValue;
}

function toConnectionOverrides(config: WeappConnectionConfig): ConnectionOverrides {
  return {
    mode: config.mode,
    cliPath: config.cliPath,
    projectPath: config.projectPath,
    wsEndpoint: config.wsEndpoint,
    timeout: config.timeout,
    port: config.port,
    account: config.account,
    ticket: config.ticket,
    trustProject: config.trustProject,
    args: config.args,
    cwd: config.cwd,
    autoClose: config.autoClose,
    autoLaunch: config.autoLaunch,
    launchTimeout: config.launchTimeout,
    connectTimeout: config.connectTimeout,
  };
}

function formatDiagnosisDetails(diagnosis: ConnectionDiagnosis): string {
  return formatJson({
    target: diagnosis.target,
    mode: diagnosis.mode,
    port: diagnosis.port,
    launchPort: diagnosis.launchPort,
    portListening: diagnosis.portListening,
    websocketReachable: diagnosis.websocketReachable,
    httpProbe: diagnosis.httpProbe,
    looksLikeIdeHttp: diagnosis.looksLikeIdeHttp,
    looksLikeAutomatorWs: diagnosis.looksLikeAutomatorWs,
    ideProcessDetected: diagnosis.ideProcessDetected,
    safeToLaunch: diagnosis.safeToLaunch,
    allowAutoLaunch: diagnosis.allowAutoLaunch,
    suggestion: diagnosis.suggestion,
  });
}

function formatDiagnosisError(diagnosis: ConnectionDiagnosis): string {
  const tag = diagnosis.reasonCode ?? "CONNECT_MODE_FAILED";
  return `[${tag}] ${diagnosis.suggestion}\n\n${formatDiagnosisDetails(diagnosis)}`;
}

function formatJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function isSameConfig(
  a: WeappConnectionConfig,
  b: WeappConnectionConfig
): boolean {
  return (
    a.mode === b.mode &&
    a.cliPath === b.cliPath &&
    a.projectPath === b.projectPath &&
    a.wsEndpoint === b.wsEndpoint &&
    a.timeout === b.timeout &&
    a.port === b.port &&
    a.account === b.account &&
    a.ticket === b.ticket &&
    a.trustProject === b.trustProject &&
    a.cwd === b.cwd &&
    a.autoClose === b.autoClose &&
    areArgsEqual(a.args, b.args)
  );
}

function areArgsEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}
