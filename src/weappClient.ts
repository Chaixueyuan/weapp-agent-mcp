import { UserError, type SerializableValue } from "fastmcp";
import automator from "miniprogram-automator";
import net from "net";
import { randomUUID } from "node:crypto";
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
import {
  clampJsonByBytes,
  formatJson,
  readCurrentPage,
  toSerializableValue,
} from "./tools/common.js";

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
  sourceTarget?: string;
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
  defaultProjectPath: string | null;
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
  defaultProjectPath: string | null;
  portListening: boolean;
  tcpReachable: boolean;
  websocketReachable: boolean;
  httpProbe: string | null;
  looksLikeIdeHttp: boolean;
  looksLikeAutomatorWs: boolean;
  ideProcessDetected: boolean;
  projectConfigured: boolean;
  safeToLaunch: boolean | null;
  reasonCode: string | null;
  suggestion: string;
  allowAutoLaunch: boolean;
  // 本地 connect 目标端口未监听且允许自动拉起时为 true。
  recoverableByEnsure: boolean;
}

interface HttpProbeResult {
  ok: boolean;
  statusCode: number | null;
  bodySnippet: string | null;
  error: string | null;
}

interface PersistedState {
  lastProjectPath: string | null;
  defaultProjectPath: string | null;
  pendingProjects: { path: string; name: string }[];
  consoleLogs: ConsoleLogEntry[];
  sessionId: string | null;
  listenerAttached: boolean;
  lastLogAt: number | null;
  lastListenerBindAt: number | null;
  logStoreMode: "persisted";
  sourceProjectPath: string | null;
  sourceTarget: string | null;
  sessions: Record<string, PersistedSessionState>;
}

interface PersistedSessionState {
  listenerAttached: boolean;
  lastLogAt: number | null;
  lastListenerBindAt: number | null;
  sourceProjectPath: string | null;
  sourceTarget: string | null;
  processId: number | null;
  updatedAt: number;
}

export class WeappAutomatorManager {
  private miniProgram?: MiniProgramInstance;
  private config?: WeappConnectionConfig;
  private consoleLogs: ConsoleLogEntry[] = [];
  private maxLogs = 1000; // 最多保存1000条日志
  private maxLogEntryBytes = 32 * 1024;
  private pendingProjects: { path: string; name: string }[] = [];
  private loggingAttachedProgram?: MiniProgramInstance;
  private sessionId: string | null = null;
  private listenerAttached = false;
  private lastLogAt: number | null = null;
  private lastListenerBindAt: number | null = null;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private connectionSetupQueue: Promise<void> = Promise.resolve();
  private activeSessionUsers = 0;
  private autoClosePending = false;
  private pendingConsoleLogs: ConsoleLogEntry[] = [];
  private consoleLogFlushTimer: NodeJS.Timeout | null = null;
  private screenshotQueue: Promise<void> = Promise.resolve();
  private evaluateQueue: Promise<void> = Promise.resolve();
  private screenshotCooldownMs = 300;
  private closeTimeoutMs = 15000;
  private lastScreenshotAt: number | null = null;
  private lastScreenshotOk: boolean | null = null;
  private lastScreenshotErrorCode: string | null = null;
  // 连续"拿不回帧"次数（环境截图通道不通时会持续累积）；成功即清零。
  // SIMULATOR_HIDDEN 有明确用户修复动作，不计入。用于短路跳过注定失败的截图，免得每次白等超时。
  private screenshotFailureStreak = 0;
  private screenshotTargetConfig?: WeappConnectionConfig;
  
  private static readonly CONFIG_FILE = path.join(
    process.env.USERPROFILE || process.env.HOME || os.tmpdir(),
    ".weapp-agent-mcp-config.json"
  );

  // 微信开发者工具目录名称（跨平台常量）
  private static readonly WECHAT_DEVTOOLS_DIR = "微信开发者工具";
  private static readonly MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;
  private static readonly MAX_RECENT_PROJECT_STATE_BYTES = 10 * 1024 * 1024;
  private static readonly MAX_RECENT_PROJECT_STATE_FILES = 100;
  private static readonly MAX_RECENT_PROJECTS = 10;

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
    await this.updatePersistedState((state) => {
      state.pendingProjects = projects;
    });
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
    const byPath = this.pendingProjects.find((project) => project.path === trimmed);
    if (byPath) {
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return byPath;
    }

    const byName = this.pendingProjects.filter((project) => project.name === trimmed);
    if (byName.length === 1) {
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return byName[0];
    }

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

  async getConsoleLogs(overrides?: ConnectionOverrides): Promise<ConsoleLogEntry[]> {
    await this.flushPendingConsoleLogs();
    await this.waitForPersistedStateWrites();
    const state = await this.readPersistedState();
    if (this.isLocalTargetMismatch(overrides)) {
      return [];
    }
    const target = this.getLogTargetKey(overrides);
    if (!target) {
      this.consoleLogs = [];
      return [];
    }
    this.consoleLogs = this.filterLogsForTarget(state.consoleLogs, target);
    return [...this.consoleLogs];
  }

  async getLogStatus(overrides?: ConnectionOverrides): Promise<LogStatusSnapshot> {
    await this.flushPendingConsoleLogs();
    if (this.sessionId && this.listenerAttached) {
      await this.persistStateMeta();
    }
    await this.waitForPersistedStateWrites();
    const state = await this.readPersistedState();
    const logs = Array.isArray(state.consoleLogs) ? state.consoleLogs : [];
    const targetMismatch = this.isLocalTargetMismatch(overrides);
    const target = targetMismatch ? null : this.getLogTargetKey(overrides);
    const visibleLogs =
      targetMismatch || !target ? [] : this.filterLogsForTarget(logs, target);
    const recentTypes = [...new Set(visibleLogs.slice(-20).map((log) => log.type))];
    const preferLocalSession = this.sessionId !== null && !targetMismatch;
    const localSession = this.sessionId ? state.sessions[this.sessionId] : undefined;
    const matchingPersistedSession = target
      ? Object.entries(state.sessions)
          .filter(([, session]) =>
            session.listenerAttached &&
            isPersistedSessionProcessAlive(session.processId) &&
            normalizeLogTargetKey(session.sourceTarget) === target
          )
          .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)[0]
      : undefined;
    const fallbackListenerAttached = target
      ? Boolean(matchingPersistedSession)
      : false;
    const fallbackLastLogAt = target
      ? matchingPersistedSession?.[1].lastLogAt ??
        visibleLogs[visibleLogs.length - 1]?.timestamp ??
        null
      : null;
    const fallbackLastListenerBindAt = target
      ? matchingPersistedSession?.[1].lastListenerBindAt ?? null
      : null;
    const fallbackSessionId = target
      ? matchingPersistedSession?.[0] ?? null
      : null;
    const fallbackSourceProjectPath = target
      ? matchingPersistedSession?.[1].sourceProjectPath ?? null
      : null;
    return {
      listenerAttached: targetMismatch
        ? false
        : preferLocalSession
          ? this.listenerAttached
          : fallbackListenerAttached,
      lastLogAt: targetMismatch
        ? null
        : preferLocalSession
          ? this.lastLogAt
          : fallbackLastLogAt,
      lastListenerBindAt: targetMismatch
        ? null
        : preferLocalSession
          ? this.lastListenerBindAt
          : fallbackLastListenerBindAt,
      logStoreMode: "persisted",
      sessionId: targetMismatch
        ? null
        : preferLocalSession
          ? this.sessionId
          : fallbackSessionId,
      sourceProjectPath: targetMismatch
        ? null
        : preferLocalSession
          ? this.listenerAttached
            ? normalizeProjectPath(this.config?.projectPath) ??
              localSession?.sourceProjectPath ??
              null
            : null
          : fallbackSourceProjectPath,
      logCount: visibleLogs.length,
      recentTypes,
    };
  }

  async clearConsoleLogs(overrides?: ConnectionOverrides): Promise<void> {
    if (this.isLocalTargetMismatch(overrides)) {
      throw new UserError(
        this.withRecoveryTag(
          "CONNECTION_TARGET_MISMATCH",
          "请求的连接目标与当前日志监听会话不一致，已拒绝清空日志，避免误清另一个目标的日志。"
        )
      );
    }
    const target = this.getLogTargetKey(overrides);
    if (!target) {
      throw new UserError(
        this.withRecoveryTag(
          "LOG_TARGET_REQUIRED",
          "当前未指定或建立连接目标，已拒绝清空日志，避免误清其它项目的持久化日志。请先执行 mp_ensureConnection，或显式传 connection。"
        )
      );
    }
    const keepOtherTargets = (entry: ConsoleLogEntry): boolean =>
      normalizeLogTargetKey(entry.sourceTarget) !== target;
    this.consoleLogs = this.consoleLogs.filter(keepOtherTargets);
    this.pendingConsoleLogs = this.pendingConsoleLogs.filter(keepOtherTargets);
    if (this.consoleLogFlushTimer) {
      clearTimeout(this.consoleLogFlushTimer);
      this.consoleLogFlushTimer = null;
    }
    this.lastLogAt = null;
    await this.updatePersistedState((state) => {
      state.consoleLogs = state.consoleLogs.filter(keepOtherTargets);
      for (const session of Object.values(state.sessions)) {
        if (normalizeLogTargetKey(session.sourceTarget) === target) {
          session.lastLogAt = null;
        }
      }
      state.lastLogAt = state.consoleLogs.length
        ? state.consoleLogs[state.consoleLogs.length - 1].timestamp
        : null;
    });
  }

  private getLogTargetKey(overrides?: ConnectionOverrides): string | null {
    try {
      const config = resolveConfig(overrides, this.config, {
        allowIncompleteConnect: true,
        allowIncompleteLaunch: true,
      });
      return this.getLogTargetKeyForConfig(config);
    } catch {
      return null;
    }
  }

  private getLogTargetKeyForConfig(
    config: WeappConnectionConfig | undefined
  ): string | null {
    if (!config) {
      return null;
    }
    if (config.mode === "connect") {
      return config.wsEndpoint
        ? `connect:${normalizeWsEndpointForIdentity(config.wsEndpoint)}`
        : null;
    }
    return config.projectPath
      ? `launch:${normalizeProjectPath(config.projectPath)}:${this.getLaunchPort(config)}`
      : null;
  }

  private filterLogsForTarget(
    logs: ConsoleLogEntry[],
    target: string | null
  ): ConsoleLogEntry[] {
    return target
      ? logs.filter((entry) => normalizeLogTargetKey(entry.sourceTarget) === target)
      : [...logs];
  }

  private isLocalTargetMismatch(overrides?: ConnectionOverrides): boolean {
    if (!overrides || !this.config) {
      return false;
    }
    try {
      const requestedConfig = resolveConfig(overrides, this.config, {
        allowIncompleteConnect: true,
        allowIncompleteLaunch: true,
      });
      return !isSameConfig(this.config, requestedConfig);
    } catch {
      return true;
    }
  }

  private appendConsoleLog(entry: ConsoleLogEntry): void {
    const normalizedEntry = normalizeConsoleLogEntry(entry, this.maxLogEntryBytes);
    if (!normalizedEntry) {
      return;
    }
    entry = normalizedEntry;
    const previous = this.consoleLogs[this.consoleLogs.length - 1];
    if (previous) {
      const sameType = previous.type === entry.type;
      const sameMessage = previous.message === entry.message;
      const sameData = JSON.stringify(previous.data) === JSON.stringify(entry.data);
      const sameTarget = previous.sourceTarget === entry.sourceTarget;
      const closeInTime = Math.abs(previous.timestamp - entry.timestamp) <= 100;
      if (sameType && sameMessage && sameData && sameTarget && closeInTime) {
        return;
      }
    }

    this.consoleLogs.push(entry);
    if (this.consoleLogs.length > this.maxLogs) {
      this.consoleLogs.shift();
    }

    this.lastLogAt = entry.timestamp;

    this.pendingConsoleLogs.push(entry);
    if (this.pendingConsoleLogs.length > this.maxLogs) {
      this.pendingConsoleLogs.splice(0, this.pendingConsoleLogs.length - this.maxLogs);
    }
    this.scheduleConsoleLogFlush();
  }

  /**
   * 保存项目路径到配置文件
   */
  private async saveProjectPath(projectPath: string): Promise<boolean> {
    try {
      await this.updatePersistedState((state) => {
        state.lastProjectPath = normalizeProjectPath(projectPath);
      });
      return true;
    } catch (error) {
      console.warn("[config] Failed to save project path:", error);
      return false;
    }
  }

  private async saveDefaultProjectPath(projectPath: string): Promise<boolean> {
    try {
      await this.updatePersistedState((state) => {
        const normalizedPath = normalizeProjectPath(projectPath);
        state.defaultProjectPath = normalizedPath;
        state.lastProjectPath = normalizedPath;
      });
      return true;
    } catch (error) {
      console.warn("[config] Failed to save default project path:", error);
      return false;
    }
  }

  private async loadProjectPath(): Promise<string | null> {
    try {
      await this.waitForPersistedStateWrites();
      const state = await this.readPersistedState();
      return state.defaultProjectPath ?? state.lastProjectPath;
    } catch (error) {
      console.warn("[config] Failed to load project path:", error);
      return null;
    }
  }

  private createDefaultState(): PersistedState {
    const projectPath = normalizeProjectPath(this.config?.projectPath);
    return {
      lastProjectPath: projectPath,
      defaultProjectPath: null,
      pendingProjects: [],
      consoleLogs: [],
      sessionId: this.sessionId,
      listenerAttached: this.listenerAttached,
      lastLogAt: this.lastLogAt,
      lastListenerBindAt: this.lastListenerBindAt,
      logStoreMode: "persisted",
      sourceProjectPath: projectPath,
      sourceTarget: this.getLogTargetKeyForConfig(this.config),
      sessions: {},
    };
  }

  private async readPersistedState(): Promise<PersistedState> {
    try {
      const content = await fs.promises.readFile(WeappAutomatorManager.CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(content) as Partial<PersistedState>;
      return {
        lastProjectPath: typeof parsed.lastProjectPath === "string" ? parsed.lastProjectPath : null,
        defaultProjectPath:
          typeof parsed.defaultProjectPath === "string"
            ? parsed.defaultProjectPath
            : null,
        pendingProjects: Array.isArray(parsed.pendingProjects)
          ? parsed.pendingProjects
              .map(normalizeProjectEntry)
              .filter((entry): entry is { path: string; name: string } => entry !== null)
              .slice(0, 100)
          : [],
        consoleLogs: Array.isArray(parsed.consoleLogs)
          ? parsed.consoleLogs
              .map((entry) => normalizeConsoleLogEntry(entry, this.maxLogEntryBytes))
              .filter((entry): entry is ConsoleLogEntry => entry !== null)
              .slice(-this.maxLogs)
          : [],
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
        listenerAttached: typeof parsed.listenerAttached === "boolean" ? parsed.listenerAttached : false,
        lastLogAt: typeof parsed.lastLogAt === "number" ? parsed.lastLogAt : null,
        lastListenerBindAt: typeof parsed.lastListenerBindAt === "number" ? parsed.lastListenerBindAt : null,
        logStoreMode: "persisted",
        sourceProjectPath: typeof parsed.sourceProjectPath === "string" ? parsed.sourceProjectPath : null,
        sourceTarget: normalizeLogTargetKey(parsed.sourceTarget),
        sessions: normalizePersistedSessions(parsed.sessions),
      };
    } catch {
      return this.createDefaultState();
    }
  }

  private enqueuePersistedStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateWriteQueue.then(operation, operation);
    this.stateWriteQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async waitForPersistedStateWrites(): Promise<void> {
    await this.stateWriteQueue;
  }

  private enqueueConnectionSetupOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.connectionSetupQueue.then(operation, operation);
    this.connectionSetupQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async withPersistedStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${WeappAutomatorManager.CONFIG_FILE}.lock`;
    const startedAt = Date.now();
    let lockHandle: Awaited<ReturnType<typeof fs.promises.open>> | null = null;

    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    while (!lockHandle) {
      try {
        lockHandle = await fs.promises.open(lockPath, "wx");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw error;
        }
        const stale = await fs.promises
          .stat(lockPath)
          .then((stat) => Date.now() - stat.mtimeMs > 30000)
          .catch(() => false);
        if (stale) {
          // 原子抢占：用 rename 把陈旧锁移到本进程独占的临时名，只有 rename 成功的
          // 进程才算"偷到"了锁；rename 失败（已被他人抢走/释放）就回到 open('wx') 重试，
          // 避免多个进程各自 unlink 误删别人刚创建的新锁导致两个写者同入临界区。
          const stolenPath = `${lockPath}.${process.pid}.${randomUUID()}.stolen`;
          try {
            await fs.promises.rename(lockPath, stolenPath);
            await fs.promises.unlink(stolenPath).catch(() => undefined);
          } catch {
            // 另一个进程已抢走或锁已释放；回到循环重试 open('wx')。
          }
          continue;
        }
        if (Date.now() - startedAt > 5000) {
          throw new Error(`Timed out waiting for persisted-state lock: ${lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
      }
    }

    // 持锁期间周期性刷新 mtime，避免较慢的 operation()（>30s）被其他进程误判为 stale
    // 而抢走锁——只有真正卡死/崩溃（不再刷新）的持锁者才会被判定 stale。
    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.promises.utimes(lockPath, now, now).catch(() => undefined);
    }, 10000);
    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    try {
      await this.cleanupOrphanStateTempFiles();
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await lockHandle.close().catch(() => undefined);
      await fs.promises.unlink(lockPath).catch(() => undefined);
    }
  }

  private async cleanupOrphanStateTempFiles(): Promise<void> {
    // 进程在持锁/写 tmp 期间被强杀（kill -9）会遗留
    // `${CONFIG_FILE}.${pid}.${uuid}.tmp`。持有锁时不会有其他进程在写，故可安全清理
    // 足够旧的孤儿临时文件，避免它们在 home 目录里无限累积。
    try {
      const configDir = path.dirname(WeappAutomatorManager.CONFIG_FILE);
      const base = path.basename(WeappAutomatorManager.CONFIG_FILE);
      const entries = await fs.promises.readdir(configDir);
      const now = Date.now();
      await Promise.all(
        entries
          .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".tmp"))
          .map(async (name) => {
            const full = path.join(configDir, name);
            const stat = await fs.promises.stat(full).catch(() => null);
            if (stat && now - stat.mtimeMs > 30000) {
              await fs.promises.unlink(full).catch(() => undefined);
            }
          })
      );
    } catch {
      // best-effort 清理，失败忽略。
    }
  }

  private async writePersistedStateContent(content: string): Promise<void> {
    const configDir = path.dirname(WeappAutomatorManager.CONFIG_FILE);
    await fs.promises.mkdir(configDir, { recursive: true });
    const tmpPath =
      `${WeappAutomatorManager.CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, content, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.promises.rename(tmpPath, WeappAutomatorManager.CONFIG_FILE);
    } finally {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
    }
  }

  private async writePersistedState(state: PersistedState): Promise<void> {
    const content = JSON.stringify(state, null, 2);
    await this.enqueuePersistedStateOperation(() =>
      this.withPersistedStateLock(() => this.writePersistedStateContent(content))
    );
  }

  private async updatePersistedState(
    update: (state: PersistedState) => void
  ): Promise<void> {
    await this.enqueuePersistedStateOperation(() =>
      this.withPersistedStateLock(async () => {
        const state = await this.readPersistedState();
        update(state);
        await this.writePersistedStateContent(JSON.stringify(state, null, 2));
      })
    );
  }

  private scheduleConsoleLogFlush(): void {
    if (this.consoleLogFlushTimer) {
      return;
    }
    this.consoleLogFlushTimer = setTimeout(() => {
      this.consoleLogFlushTimer = null;
      void this.flushPendingConsoleLogs();
    }, 50);
  }

  private async flushPendingConsoleLogs(): Promise<void> {
    if (this.consoleLogFlushTimer) {
      clearTimeout(this.consoleLogFlushTimer);
      this.consoleLogFlushTimer = null;
    }
    const pending = this.pendingConsoleLogs.splice(0);
    if (pending.length === 0) {
      return;
    }
    try {
      await this.updatePersistedState((state) => {
        for (const entry of pending) {
          const previous = state.consoleLogs[state.consoleLogs.length - 1];
          const isDuplicate =
            previous?.type === entry.type &&
            previous.message === entry.message &&
            JSON.stringify(previous.data) === JSON.stringify(entry.data) &&
            previous.sourceTarget === entry.sourceTarget &&
            Math.abs(previous.timestamp - entry.timestamp) <= 100;
          if (!isDuplicate) {
            state.consoleLogs.push(entry);
          }
        }
        state.consoleLogs = state.consoleLogs.slice(-this.maxLogs);
        state.logStoreMode = "persisted";
        if (this.config?.projectPath) {
          state.lastProjectPath = normalizeProjectPath(this.config.projectPath);
        }
        this.updatePersistedSessionState(state);
      });
    } catch (error) {
      this.pendingConsoleLogs.unshift(...pending);
      if (this.pendingConsoleLogs.length > this.maxLogs) {
        this.pendingConsoleLogs.splice(0, this.pendingConsoleLogs.length - this.maxLogs);
      }
      console.warn("[config] Failed to persist console logs:", error);
    }
  }

  private async persistStateMeta(): Promise<void> {
    try {
      await this.updatePersistedState((state) => {
        state.logStoreMode = "persisted";
        if (this.config?.projectPath) {
          state.lastProjectPath = normalizeProjectPath(this.config.projectPath);
        }
        this.updatePersistedSessionState(state);
      });
    } catch (error) {
      console.warn("[config] Failed to persist state meta:", error);
    }
  }

  private updatePersistedSessionState(state: PersistedState): void {
    const now = Date.now();
    for (const [id, session] of Object.entries(state.sessions)) {
      if (
        !session ||
        now - Number(session.updatedAt || 0) > 24 * 60 * 60 * 1000 ||
        !isPersistedSessionProcessAlive(session.processId)
      ) {
        delete state.sessions[id];
      }
    }

    if (this.sessionId) {
      if (this.listenerAttached) {
        state.sessions[this.sessionId] = {
          listenerAttached: true,
          lastLogAt: this.lastLogAt,
          lastListenerBindAt: this.lastListenerBindAt,
          sourceProjectPath: normalizeProjectPath(this.config?.projectPath),
          sourceTarget: this.getLogTargetKeyForConfig(this.config),
          processId: process.pid,
          updatedAt: now,
        };
      } else {
        delete state.sessions[this.sessionId];
      }
    }

    const activeSessions = Object.entries(state.sessions)
      .filter(([, session]) => session.listenerAttached)
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
    const latest = activeSessions[0];
    state.listenerAttached = activeSessions.length > 0;
    state.sessionId = latest?.[0] ?? null;
    state.lastListenerBindAt = latest?.[1].lastListenerBindAt ?? null;
    state.sourceProjectPath = latest?.[1].sourceProjectPath ?? null;
    state.sourceTarget = latest?.[1].sourceTarget ?? null;
    state.lastLogAt = state.consoleLogs.length
      ? state.consoleLogs[state.consoleLogs.length - 1].timestamp
      : null;
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
                  `${description} 超时 (${timeoutMs}ms)。底层 SDK 请求可能仍在运行；不要立即重复提交有副作用的操作。请先执行 mp_healthCheck，必要时执行 mp_recoverConnection。`
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
    operation: () => Promise<T>,
    timeout?: { timeoutMs?: number; description?: string }
  ): Promise<T> {
    return this.runSerializedOperation(
      this.screenshotQueue,
      (queue) => {
        this.screenshotQueue = queue;
      },
      operation,
      timeout,
      {
        cooldownMs: this.screenshotCooldownMs,
        onAcquired: () => {
          log.info("Acquired screenshot lane", {
            cooldownMs: this.screenshotCooldownMs,
          });
        },
      }
    );
  }

  async runSerializedEvaluate<T>(
    operation: () => Promise<T>,
    timeout?: { timeoutMs?: number; description?: string }
  ): Promise<T> {
    return this.runSerializedOperation(
      this.evaluateQueue,
      (queue) => {
        this.evaluateQueue = queue;
      },
      operation,
      timeout
    );
  }

  private async runSerializedOperation<T>(
    previous: Promise<void>,
    setQueue: (queue: Promise<void>) => void,
    operation: () => Promise<T>,
    timeout?: { timeoutMs?: number; description?: string },
    options?: { cooldownMs?: number; onAcquired?: () => void }
  ): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    setQueue(current);

    const startedAt = Date.now();
    try {
      if (timeout) {
        await this.withRequestTimeout(
          () => previous.catch(() => undefined),
          timeout
        );
      } else {
        await previous.catch(() => undefined);
      }
    } catch (error) {
      // 该调用在排队阶段已超时，不启动 operation；但仍要等前序请求真正结束后
      // 才释放自己的占位，避免后续调用绕过仍在运行的前序请求。
      void previous.then(release, release);
      throw error;
    }

    const remainingTimeout =
      timeout?.timeoutMs === undefined
        ? undefined
        : timeout.timeoutMs - (Date.now() - startedAt);
    if (remainingTimeout !== undefined && remainingTimeout <= 0) {
      release();
      throw new UserError(
        this.withRecoveryTag(
          "REQUEST_TIMEOUT",
          `${timeout?.description ?? "请求"} 超时 (${timeout?.timeoutMs}ms)，预算已在等待串行通道时耗尽。`
        )
      );
    }

    try {
      options?.onAcquired?.();
    } catch (error) {
      release();
      throw error;
    }
    const operationPromise = Promise.resolve().then(operation);
    void (async () => {
      try {
        await operationPromise;
      } catch {
        // 调用方会收到原始错误；这里只负责等底层请求结束后释放 lane。
      } finally {
        if (options?.cooldownMs) {
          await new Promise((resolve) => setTimeout(resolve, options.cooldownMs));
        }
        release();
      }
    })();

    return timeout && remainingTimeout !== undefined
      ? this.withRequestTimeout(() => operationPromise, {
          ...timeout,
          timeoutMs: remainingTimeout,
        })
      : operationPromise;
  }

  recordScreenshotResult(ok: boolean, errorCode?: string | null): void {
    this.lastScreenshotAt = Date.now();
    this.lastScreenshotOk = ok;
    this.lastScreenshotErrorCode = ok ? null : errorCode ?? null;
    if (ok) {
      this.screenshotFailureStreak = 0;
    } else if (errorCode !== "SIMULATOR_HIDDEN" && errorCode !== "LOCAL_OUTPUT_ERROR") {
      // 用户可直接修复的前台/本地输出问题不算"环境截不了"的连败。
      this.screenshotFailureStreak++;
    }
  }

  getScreenshotStatus(overrides?: ConnectionOverrides): {
    lastScreenshotAt: number | null;
    lastScreenshotOk: boolean | null;
    lastScreenshotErrorCode: string | null;
    failureStreak: number;
  } {
    const trackedTarget = this.screenshotTargetConfig ?? this.config;
    if (overrides && trackedTarget) {
      try {
        const requestedConfig = resolveConfig(overrides, this.config, {
          allowIncompleteConnect: true,
          allowIncompleteLaunch: true,
        });
        if (!isSameConfig(trackedTarget, requestedConfig)) {
          return this.emptyScreenshotStatus();
        }
      } catch {
        return this.emptyScreenshotStatus();
      }
    }
    return {
      lastScreenshotAt: this.lastScreenshotAt,
      lastScreenshotOk: this.lastScreenshotOk,
      lastScreenshotErrorCode: this.lastScreenshotErrorCode,
      failureStreak: this.screenshotFailureStreak,
    };
  }

  private emptyScreenshotStatus(): {
    lastScreenshotAt: null;
    lastScreenshotOk: null;
    lastScreenshotErrorCode: null;
    failureStreak: 0;
  } {
    return {
      lastScreenshotAt: null,
      lastScreenshotOk: null,
      lastScreenshotErrorCode: null,
      failureStreak: 0,
    };
  }

  private syncScreenshotTarget(config: WeappConnectionConfig): void {
    if (
      !this.screenshotTargetConfig ||
      !isSameConfig(this.screenshotTargetConfig, config)
    ) {
      this.lastScreenshotAt = null;
      this.lastScreenshotOk = null;
      this.lastScreenshotErrorCode = null;
      this.screenshotFailureStreak = 0;
    }
    this.screenshotTargetConfig = config;
  }

  async diagnoseConnection(
    overrides?: ConnectionOverrides,
    options?: { strictMode?: boolean; activeSessionKnownAlive?: boolean }
  ): Promise<ConnectionDiagnosis> {
    let config: WeappConnectionConfig;
    try {
      config = resolveConfig(overrides, this.config, {
        allowIncompleteConnect: options?.strictMode !== true,
        allowIncompleteLaunch: options?.strictMode !== true,
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        const projectPath = overrides?.projectPath ?? null;
        const defaultProjectPath = await this.getDefaultProject();
        return {
          mode: overrides?.mode === "connect" ? "connect" : "launch",
          target: overrides?.wsEndpoint ?? null,
          wsEndpoint: overrides?.wsEndpoint ?? null,
          port: this.getConfiguredPortFromOverrides(overrides),
          launchPort: this.getLaunchPortFromOverrides(overrides),
          projectPath,
          defaultProjectPath,
          portListening: false,
          tcpReachable: false,
          websocketReachable: false,
          httpProbe: null,
          looksLikeIdeHttp: false,
          looksLikeAutomatorWs: false,
          ideProcessDetected: await this.isDevToolsProcessRunning(),
          projectConfigured: Boolean(projectPath ?? defaultProjectPath),
          safeToLaunch: false,
          reasonCode: "INVALID_CONNECTION_CONFIG",
          suggestion: error.message,
          allowAutoLaunch: false,
          recoverableByEnsure: false,
        };
      }
      throw error;
    }

    const endpointKind = classifyWsEndpoint(config.wsEndpoint);
    const invalidConnectEndpoint =
      config.mode === "connect" && endpointKind === "invalid";
    const port = invalidConnectEndpoint ? null : this.getConfiguredPort(config);
    const launchPort = this.getLaunchPort(config);
    const probeWsEndpoint = invalidConnectEndpoint
      ? undefined
      : this.getProbeWsEndpoint(config);
    const target = config.wsEndpoint ?? probeWsEndpoint ?? (launchPort ? `auto-port:${launchPort}` : null);
    const targetHost = this.getConfiguredHost(config);
    const activeSessionMatches = Boolean(
      this.miniProgram &&
      this.config &&
      isSameConfig(this.config, config)
    );
    const activeSessionAlive =
      activeSessionMatches &&
      (options?.activeSessionKnownAlive === true || await this.isConnectionAlive());
    const [tcpProbeReachable, ideProcessDetected] = await Promise.all([
      port ? this.isPortInUse(port, targetHost) : Promise.resolve(false),
      this.isDevToolsProcessRunning(),
    ]);
    let tcpReachable = tcpProbeReachable;
    let portListening = tcpReachable;
    let websocketReachable = false;
    let httpProbe: string | null = null;
    let looksLikeIdeHttp = false;
    let looksLikeAutomatorWs = false;
    let reasonCode: string | null = null;
    let suggestion = "当前目标可继续连接。";
    let safeToLaunch: boolean | null = config.mode === "launch";
    let allowAutoLaunch = config.mode === "launch";

    if (probeWsEndpoint) {
      if (activeSessionAlive) {
        // A second temporary automator connection can disturb the existing
        // single-channel DevTools session. The healthy matching session is
        // already stronger reachability evidence than another connect/disconnect.
        websocketReachable = true;
        looksLikeAutomatorWs = true;
        tcpReachable = true;
        portListening = true;
      } else {
        // connectTimeout controls the real session establishment. A read-only
        // diagnosis must stay short, otherwise health/ensure can spend the full
        // connect budget twice (websocket probe + HTTP probe) before doing work.
        const probeTimeoutMs = Math.min(config.connectTimeout ?? 3000, 5000);
        const wsProbe = await this.probeWebSocketEndpoint(probeWsEndpoint, probeTimeoutMs);
        websocketReachable = wsProbe.ok;
        looksLikeAutomatorWs = wsProbe.ok;
        if (wsProbe.ok) {
          tcpReachable = true;
          portListening = true;
        } else {
          const httpResult = await this.probeHttpEndpoint(probeWsEndpoint, probeTimeoutMs);
          httpProbe = this.formatHttpProbe(httpResult);
          looksLikeIdeHttp = this.looksLikeIdeHttpProbe(httpResult);
        }
      }
    }

    if (config.mode === "connect") {
      // launch 概念在 connect 模式不适用，置 null 表示 N/A，避免恒 false 的噪音误导 agent
      safeToLaunch = null;
      allowAutoLaunch =
        config.autoLaunch !== false &&
        classifyWsEndpoint(config.wsEndpoint) === "local";

      if (!config.wsEndpoint || endpointKind === "invalid") {
        reasonCode = "INVALID_WS_ENDPOINT";
        suggestion = !config.wsEndpoint
          ? "connect 模式必须提供可连接的 websocket endpoint。请先确认自动化端口。"
          : `connect 模式的 wsEndpoint 不是合法 URL: ${config.wsEndpoint}`;
        allowAutoLaunch = false;
      } else if (websocketReachable) {
        suggestion = "当前 websocket 目标可连接，可继续执行 mp_ensureConnection。";
      } else if (!portListening) {
        reasonCode = "PORT_NOT_LISTENING";
        suggestion = ideProcessDetected
          ? "开发者工具进程已在运行，但自动化端口暂未监听——直接调用 mp_ensureConnection 尝试建立会话/重连即可（它会自愈），通常无需人工去开启自动化或确认端口，也不要停下来问用户。"
          : allowAutoLaunch
            ? "目标端口未监听。请先确认自动化服务是否已启动；若确需由 MCP 拉起，请显式提供项目路径并确认 launch 策略。"
            : "目标端口未监听。请不要自动切端口，先确认微信开发者工具已开启自动化。";
      } else if (looksLikeIdeHttp) {
        reasonCode = "IDE_HTTP_PORT_NOT_WS";
        suggestion = "当前端口看起来是 IDE HTTP 服务端口，不是自动化 websocket 端口。最常见原因：connection.port 传成了 IDE 的服务端口——它应当是【自动化端口】（会传给 cli auto --auto-port，默认 9420），不是 IDE HTTP 端口。请去掉 port 改用默认 9420 重试，或显式传正确的自动化端口；不要重复启动 IDE。";
        allowAutoLaunch = false;
      } else if (!websocketReachable) {
        reasonCode = "AUTOMATION_NOT_ENABLED";
        suggestion = "端口已监听，但 websocket 握手失败。请检查微信开发者工具是否已开启自动化测试。";
        allowAutoLaunch = false;
      }
    } else {
      safeToLaunch = !looksLikeIdeHttp;
      allowAutoLaunch = safeToLaunch;

      if (!config.projectPath) {
        reasonCode = "PROJECT_NOT_OPENED";
        suggestion = "launch 模式必须提供项目路径，或先通过项目选择流程确定目标项目。";
        safeToLaunch = false;
        allowAutoLaunch = false;
      } else if (activeSessionAlive) {
        suggestion = "当前 launch 会话已连接且可用，无需重复拉起微信开发者工具。";
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

    // 本地端口未监听时 ensure 可通过 cli auto 自愈；自动化端口已被其它
    // 服务占用或握手失败时，ensure 无法替用户改变 IDE 安全设置。
    const recoverableByEnsure =
      reasonCode === "PORT_NOT_LISTENING" &&
      classifyWsEndpoint(config.wsEndpoint) === "local" &&
      config.autoLaunch !== false;
    const resolvedProjectPath = config.projectPath ?? null;
    const defaultProjectPath = await this.getDefaultProject();

    return {
      mode: config.mode,
      target,
      wsEndpoint: config.wsEndpoint ?? null,
      port,
      launchPort,
      projectPath: resolvedProjectPath,
      defaultProjectPath,
      portListening,
      tcpReachable,
      websocketReachable,
      httpProbe,
      looksLikeIdeHttp,
      looksLikeAutomatorWs,
      ideProcessDetected,
      projectConfigured: Boolean(resolvedProjectPath ?? defaultProjectPath),
      safeToLaunch,
      reasonCode,
      suggestion,
      allowAutoLaunch,
      recoverableByEnsure,
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
    const { miniProgram, config } = await this.ensureMiniProgramSession(log, options);
    this.activeSessionUsers += 1;
    try {
      return await handler(miniProgram, config);
    } finally {
      if (config.autoClose) {
        this.autoClosePending = true;
      }
      this.activeSessionUsers = Math.max(0, this.activeSessionUsers - 1);
      if (this.activeSessionUsers === 0 && this.autoClosePending) {
        this.autoClosePending = false;
        await this.enqueueConnectionSetupOperation(() => this.close(log));
      }
    }
  }

  private ensureMiniProgramSession(
    log: ToolLogger,
    options: UseOptions
  ): Promise<{ miniProgram: MiniProgramInstance; config: WeappConnectionConfig }> {
    return this.enqueueConnectionSetupOperation(async () => {
      const { overrides, reconnect } = options;
      let effectiveOverrides: ConnectionOverrides = {
        args: overrides?.args,
        ...overrides,
      };
      let config = resolveConfig(effectiveOverrides, this.config, {
        allowIncompleteConnect: true,
        allowIncompleteLaunch: true,
      });

      if (
        this.activeSessionUsers > 0 &&
        this.miniProgram &&
        this.config &&
        (reconnect || !isSameConfig(this.config, config))
      ) {
        throw new UserError(
          this.withRecoveryTag(
            "CONNECTION_BUSY",
            "另一个工具调用仍在使用当前 automator 会话，暂不能重连或切换连接目标。请等待该调用结束后重试。"
          )
        );
      }

      if (
        !reconnect &&
        this.miniProgram &&
        this.config &&
        isSameConfig(this.config, config) &&
        (await this.isConnectionAlive())
      ) {
        this.config = config;
        await this.attachLogging(this.miniProgram, log);
        this.syncScreenshotTarget(config);
        return { miniProgram: this.miniProgram, config };
      }

      const diagnosis = await this.diagnoseConnection(effectiveOverrides, { strictMode: false });
      if (diagnosis.reasonCode === "PROJECT_NOT_OPENED" && config.mode === "launch") {
        const resolved = await this.resolveAutoLaunchProjectPath(config);
        if (resolved) {
          log.info(`使用项目 (source=${resolved.source}): ${resolved.path}`);
          effectiveOverrides = {
            ...effectiveOverrides,
            projectPath: resolved.path,
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
            const response = this.formatProjectSelectionResponse(projects);
            throw new UserError(this.withRecoveryTag("PROJECT_SELECTION_REQUIRED", response));
          }
        }
      } else if (
        diagnosis.reasonCode === "PORT_NOT_LISTENING" &&
        config.mode === "connect"
      ) {
        const targetPort = this.getConfiguredPort(config);
        const endpointKind = classifyWsEndpoint(config.wsEndpoint);
        if (endpointKind === "invalid") {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_INVALID_WS_ENDPOINT",
              `配置的 wsEndpoint (${config.wsEndpoint}) 不是合法 URL，无法判断目标主机，server 不会自动 cli auto。请检查 wsEndpoint 配置。`
            )
          );
        }
        if (endpointKind === "remote") {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_REMOTE_ENDPOINT",
              `配置的远程 wsEndpoint (${config.wsEndpoint}) 当前不可达。server 不会在本机自动拉起远程 DevTools，请在远端确认自动化服务。`
            )
          );
        }
        if (config.autoLaunch === false) {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_AUTOLAUNCH_DISABLED",
              `自动化端口 ${targetPort} 未监听，且 connection.autoLaunch=false。请先启动开发者工具自动化服务，或允许 mp_ensureConnection 自动拉起。`
            )
          );
        }
        const resolved = await this.resolveAutoLaunchProjectPath(config);
        if (!resolved) {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_AUTOLAUNCH_NO_PROJECT",
              `自动化端口 ${targetPort} 未监听，且未能确定小程序项目路径。请在小程序项目根目录（含 project.config.json）下启动 MCP server，或通过环境变量 WEAPP_PROJECT_PATH / connection.projectPath 指定项目路径。`
            )
          );
        }
        const projectPath = resolved.path;
        if (!(await this.isValidWeappProject(projectPath))) {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_INVALID_PROJECT",
              `自动起端口失败：目录 ${projectPath} 不是有效的小程序项目（缺少 project.config.json 或 appid）。请在小程序项目根目录下启动 MCP server。`
            )
          );
        }
        log.info(
          `自动化端口 ${targetPort} 未监听，使用 cli auto 自动启动 (project source=${resolved.source}): ${projectPath}`
        );
        const launchConfig: WeappConnectionConfig = {
          ...config,
          projectPath,
          port: targetPort,
        };
        try {
          await this.launchDevTools(launchConfig, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_AUTOLAUNCH_FAILED",
              `自动启动 cli auto 失败：${message}。请检查微信开发者工具的 CLI/HTTP 调用权限、cliPath 和项目路径 (${projectPath})，修正后再用 reconnect=true 重试 mp_ensureConnection；不要自行重复运行 cli auto。`
            )
          );
        }
        const launchTimeoutMs = config.launchTimeout ?? 45000;
        const portReady = await this.waitForPortListening(targetPort, launchTimeoutMs, log);
        if (!portReady) {
          throw new UserError(
            this.withRecoveryTag(
              "PORT_NOT_LISTENING_AUTOLAUNCH_TIMEOUT",
              `已尝试 cli auto 启动，但 ${launchTimeoutMs}ms 内端口 ${targetPort} 仍未监听。常见原因：cli 路径错误、微信开发者工具安全设置未开启 CLI/HTTP 调用、或项目路径无效。请修正后再用 reconnect=true 重试 mp_ensureConnection；不要自行重复运行 cli auto。`
            )
          );
        }
        log.info(`端口 ${targetPort} 已监听，继续 connect (project source=${resolved.source})`);
        effectiveOverrides = {
          ...effectiveOverrides,
          projectPath,
        };
        void this.saveProjectPath(projectPath).catch(() => {});
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
      if (
        config.mode === "launch" &&
        config.projectPath &&
        !(await this.isValidWeappProject(config.projectPath))
      ) {
        throw new UserError(
          this.withRecoveryTag(
            "INVALID_PROJECT",
            `目录 ${config.projectPath} 不是有效的小程序项目（缺少有效 project.config.json）。`
          )
        );
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
            throw new Error("MiniProgram not initialized");
          }
          await this.attachLogging(this.miniProgram, log);
        } catch (error) {
          await this.close(log);
          const message = error instanceof Error ? error.message : String(error);
          const failureDiagnosis = await this.diagnoseConnection(effectiveOverrides, { strictMode: false });
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
        this.config = config;
        await this.attachLogging(this.miniProgram, log);
      }

      if (!this.miniProgram) {
        throw new UserError(
          this.withRecoveryTag(
            "NO_AUTOMATOR_SESSION",
            "Mini Program automation session was not initialized."
          )
        );
      }
      this.syncScreenshotTarget(config);
      return { miniProgram: this.miniProgram, config };
    });
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
      const page = await readCurrentPage(this, miniProgram, "读取当前页面");
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
    await this.flushPendingConsoleLogs();
    if (!this.miniProgram) {
      if (this.sessionId || this.listenerAttached) {
        this.loggingAttachedProgram = undefined;
        this.listenerAttached = false;
        await this.persistStateMeta();
        this.sessionId = null;
      }
      this.screenshotQueue = Promise.resolve();
      this.evaluateQueue = Promise.resolve();
      this.autoClosePending = false;
      return;
    }

    try {
      if (this.config?.mode === "launch") {
        await this.withRequestTimeout(
          () => this.miniProgram!.close(),
          {
            timeoutMs: this.closeTimeoutMs,
            description: "关闭 WeChat DevTools automation session",
          }
        );
      } else {
        this.miniProgram.disconnect();
      }
      log?.debug("Closed WeChat DevTools automation session");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.warn("Failed to close WeChat DevTools cleanly", { message });
    } finally {
      try {
        this.miniProgram.removeAllListeners();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log?.warn("Failed to remove Mini Program listeners during cleanup", {
          message,
        });
      }
      this.loggingAttachedProgram = undefined;
      this.listenerAttached = false;
      await this.persistStateMeta();
      this.sessionId = null;
      this.miniProgram = undefined;
      this.config = undefined;
      this.screenshotQueue = Promise.resolve();
      this.evaluateQueue = Promise.resolve();
      this.autoClosePending = false;
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
    let timedOut = false;
    const connectPromise = automator.connect({ wsEndpoint: config.wsEndpoint! });
    const timeoutPromise = new Promise<MiniProgramInstance>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        connectPromise,
        timeoutPromise
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        void connectPromise.then(
          (lateProgram) => {
            try {
              lateProgram.disconnect();
            } catch {
              // Best-effort cleanup for a connection that arrived after timeout.
            }
          },
          () => undefined
        );
      }
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
    let timer: NodeJS.Timeout | null = null;
    const connectPromise = automator.connect({ wsEndpoint }).then((miniProgram) => {
      try {
        miniProgram.disconnect();
      } catch {
        // Reachability was already proven; cleanup failure must not turn the
        // read-only probe into a false negative.
      }
    });
    try {
      await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Connection timeout after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
      return { ok: true, error: null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
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
        let settled = false;
        let absoluteTimer: NodeJS.Timeout | null = null;
        let req: http.ClientRequest;
        const finish = (probeResult: HttpProbeResult, destroy = false): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (absoluteTimer) {
            clearTimeout(absoluteTimer);
          }
          if (destroy) {
            req.destroy();
          }
          resolve(probeResult);
        };
        const failureResult = (error: unknown): HttpProbeResult => ({
          ok: false,
          statusCode: null,
          bodySnippet: null,
          error: error instanceof Error ? error.message : String(error),
        });

        req = client.request(
          {
            hostname: normalizeUrlHostname(url.hostname),
            port: url.port ? Number(url.port) : undefined,
            path: pathName,
            method: "GET",
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let capturedBytes = 0;
            const successResult = (): HttpProbeResult => ({
              ok: true,
              statusCode: res.statusCode ?? null,
              bodySnippet:
                Buffer.concat(chunks).toString("utf8").trim().slice(0, 200) ||
                null,
              error: null,
            });
            res.on("data", (chunk) => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              const remaining = 2048 - capturedBytes;
              if (remaining > 0) {
                const captured = buffer.subarray(0, remaining);
                chunks.push(captured);
                capturedBytes += captured.length;
              }
              if (capturedBytes >= 2048) {
                finish(successResult(), true);
              }
            });
            res.on("end", () => {
              finish(successResult());
            });
            res.on("error", (error) => {
              finish(failureResult(error));
            });
          }
        );
        req.on("error", (error) => {
          finish(failureResult(error));
        });
        req.on("timeout", () => {
          finish(failureResult(new Error(`HTTP probe timeout after ${timeoutMs}ms`)), true);
        });
        absoluteTimer = setTimeout(() => {
          finish(failureResult(new Error(`HTTP probe timeout after ${timeoutMs}ms`)), true);
        }, timeoutMs);
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
    if (config.mode === "connect" && config.wsEndpoint) {
      return getWsEndpointPort(config.wsEndpoint) ??
        (typeof config.port === "number" ? config.port : 9420);
    }
    return typeof config.port === "number" ? config.port : 9420;
  }

  private getConfiguredPortFromOverrides(overrides?: ConnectionOverrides): number | null {
    if (overrides?.mode !== "launch" && overrides?.wsEndpoint) {
      return getWsEndpointPort(overrides.wsEndpoint);
    }
    return typeof overrides?.port === "number" ? overrides.port : null;
  }

  private getLaunchPortFromOverrides(overrides?: ConnectionOverrides): number | null {
    if (overrides?.mode !== "launch" && overrides?.wsEndpoint) {
      return getWsEndpointPort(overrides.wsEndpoint);
    }
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

  private async isPortInUse(
    port: number,
    host: string = "127.0.0.1",
    timeoutMs: number = 1750
  ): Promise<boolean> {
    // 单次 TCP 探测会因冷启动/瞬时抖动假阴性（端口其实已监听却报 false），
    // 进而让 diagnose/healthCheck/ensure 三处探测在不同瞬间互相矛盾。重试一次显著降假阴性：
    // 第一次失败再快速试一次，任一次连上即视为监听中。
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const remainingBeforeProbe = timeoutMs - (Date.now() - startedAt);
      if (remainingBeforeProbe <= 0) {
        return false;
      }
      if (await this.tryConnectPort(port, host, Math.min(800, remainingBeforeProbe))) {
        return true;
      }
      if (attempt === 0) {
        const remainingBeforeRetry = timeoutMs - (Date.now() - startedAt);
        if (remainingBeforeRetry <= 0) {
          return false;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(150, remainingBeforeRetry))
        );
      }
    }
    return false;
  }

  private tryConnectPort(
    port: number,
    host: string,
    timeoutMs: number = 800
  ): Promise<boolean> {
    // Detect by attempting an outbound TCP connection. The previous approach
    // (server.listen(port, "127.0.0.1")) silently succeeded on macOS even when
    // an IPv6 wildcard listener (*:9420 / [::]:9420) already held the port,
    // because IPv4-specific listen() and IPv6 wildcard listen() don't always
    // conflict. Treating "listen() succeeded" as "port free" returned false
    // negatives, so waitForPortListening burned its budget against a port that
    // was actually open. A successful connect is the only reliable signal.
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: boolean) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(result);
      };
      const sock = net.createConnection({ port, host });
      const timer = setTimeout(() => finish(false), timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        finish(true);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
    });
  }

  private getConfiguredPort(config: WeappConnectionConfig): number {
    if (config.mode === "connect" && config.wsEndpoint) {
      return getWsEndpointPort(config.wsEndpoint) ??
        (typeof config.port === "number" ? config.port : 9420);
    }
    return typeof config.port === "number" ? config.port : 9420;
  }

  private getConfiguredHost(config: WeappConnectionConfig): string {
    if (!config.wsEndpoint) {
      return "127.0.0.1";
    }
    try {
      return normalizeUrlHostname(new URL(config.wsEndpoint).hostname) || "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }

  private async isValidWeappProject(projectPath: string): Promise<boolean> {
    const configPath = path.join(projectPath, "project.config.json");
    
    try {
      const config = await this.readJsonFileWithinLimit(
        configPath,
        WeappAutomatorManager.MAX_PROJECT_CONFIG_BYTES
      ) as Record<string, unknown>;
      return !!(config.appid || config.projectname);
    } catch {
      return false;
    }
  }

  private async readJsonFileWithinLimit(
    filePath: string,
    maxBytes: number
  ): Promise<unknown> {
    const info = await fs.promises.stat(filePath);
    if (!info.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    if (info.size > maxBytes) {
      throw new Error(
        `JSON file exceeds ${maxBytes} byte limit (${info.size} bytes): ${filePath}`
      );
    }
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
  }

  private normalizeRecentProjectCandidate(
    value: unknown,
    fallbackPath?: string
  ): { path: string; name: string } | null {
    let projectPath: string | null = null;
    let projectName: string | null = null;

    if (typeof value === "string") {
      projectPath = value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const configuredPath =
        typeof record.path === "string"
          ? record.path
          : typeof record.projectPath === "string"
            ? record.projectPath
            : null;
      const configuredName =
        typeof record.name === "string"
          ? record.name
          : typeof record.projectName === "string"
            ? record.projectName
            : typeof record.appName === "string"
              ? record.appName
              : null;
      projectPath =
        configuredPath ??
        (typeof fallbackPath === "string" ? fallbackPath : null);
      projectName = configuredName;
    }

    const normalizedPath = projectPath?.trim();
    if (!normalizedPath) {
      return null;
    }
    const normalizedName = projectName?.trim();
    return {
      path: normalizedPath,
      name: normalizedName || path.basename(normalizedPath) || normalizedPath,
    };
  }
  
  /**
   * 从 WeappLocalData/*.json 读取项目（PRD要求的新路径）
   * 支持 Windows 和 macOS 平台
   */
  private async listProjectsFromWeappLocalData(
    isTimeout: () => boolean
  ): Promise<{ path: string; name: string }[]> {
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
        if (isTimeout()) break;
        if (entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)) {
          weappLocalDataPaths.push(path.join(userDataBasePath, entry.name, "WeappLocalData"));
        }
      }
    } catch (error) {
      console.warn(`[MpListProjects] 读取 User Data 目录失败: ${(error as Error).message}`);
    }
    
    // 遍历所有 WeappLocalData 目录收集项目
    for (const weappLocalDataPath of weappLocalDataPaths) {
      if (
        isTimeout() ||
        projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
      ) break;
      try {
        const files = await fs.promises.readdir(weappLocalDataPath);
        const localStorageFiles = files
          .filter(f => f.startsWith('localstorage_') && f.endsWith('.json'))
          .slice(0, WeappAutomatorManager.MAX_RECENT_PROJECT_STATE_FILES);
        
        for (const file of localStorageFiles) {
          if (
            isTimeout() ||
            projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
          ) break;
          try {
            const filePath = path.join(weappLocalDataPath, file);
            const data = await this.readJsonFileWithinLimit(
              filePath,
              WeappAutomatorManager.MAX_RECENT_PROJECT_STATE_BYTES
            ) as Record<string, unknown>;
            
            // 遍历 JSON 对象，查找项目信息
            for (const [key, value] of Object.entries(data)) {
              if (
                isTimeout() ||
                projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
              ) break;
              // 跳过明显不是项目路径的键（如数字时间戳）
              if (/^\d+$/.test(key)) continue;
              
              const project = this.normalizeRecentProjectCandidate(value, key);
              if (
                project &&
                await this.isValidWeappProject(project.path) &&
                !projects.find(p => p.path === project.path)
              ) {
                projects.push(project);
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
    const startTime = Date.now();
    const SCAN_TIMEOUT_MS = 5000;
    const isTimeout = () => Date.now() - startTime > SCAN_TIMEOUT_MS;

    // 1. 尝试从 WeappLocalData 读取
    const weappLocalDataProjects = await this.listProjectsFromWeappLocalData(isTimeout);
    if (weappLocalDataProjects.length > 0) {
      return weappLocalDataProjects.slice(
        0,
        WeappAutomatorManager.MAX_RECENT_PROJECTS
      );
    }
    
    // 2. Fallback 到原有逻辑
    const projects: { path: string; name: string }[] = [];
    const MAX_DEPTH = 2;
    
    const scanDir = async (dir: string, depth = 0): Promise<void> => {
      if (
        depth > MAX_DEPTH ||
        isTimeout() ||
        projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
      ) return;
      
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            isTimeout() ||
            projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
          ) return;
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
    const userDataPath =
      process.platform === "darwin"
        ? path.join(
            os.homedir(),
            "Library",
            "Application Support",
            WeappAutomatorManager.WECHAT_DEVTOOLS_DIR
          )
        : path.join(
            os.homedir(),
            "AppData",
            "Local",
            WeappAutomatorManager.WECHAT_DEVTOOLS_DIR,
            "User Data"
          );
    
    let userDataDir = userDataPath;
    try {
      const exists = await fs.promises.access(userDataPath).then(() => true).catch(() => false);
      if (exists) {
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
      if (
        isTimeout() ||
        projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
      ) break;
      try {
        const exists = await fs.promises.access(statePath).then(() => true).catch(() => false);
        if (exists) {
          const data = await this.readJsonFileWithinLimit(
            statePath,
            WeappAutomatorManager.MAX_RECENT_PROJECT_STATE_BYTES
          ) as Record<string, unknown>;
          
          if (data.recentProjects || data.recent || data.projects) {
            const recentList = data.recentProjects || data.recent || data.projects;
            if (Array.isArray(recentList)) {
              for (const item of recentList) {
                if (
                  isTimeout() ||
                  projects.length >= WeappAutomatorManager.MAX_RECENT_PROJECTS
                ) break;
                const project = this.normalizeRecentProjectCandidate(item);
                if (
                  project &&
                  await this.isValidWeappProject(project.path) &&
                  !projects.find(p => p.path === project.path)
                ) {
                  projects.push(project);
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
    
    return projects.slice(0, WeappAutomatorManager.MAX_RECENT_PROJECTS);
  }
  
  /**
   * 获取默认项目路径
   */
  async getDefaultProject(): Promise<string | null> {
    const projectPath = await this.loadProjectPath();
    const normalizedPath = normalizeProjectPath(projectPath);
    return normalizedPath && await this.isValidWeappProject(normalizedPath)
      ? normalizedPath
      : null;
  }
  
  /**
   * 设置默认项目路径
   */
  async setDefaultProject(projectPath: string): Promise<boolean> {
    const normalizedPath = normalizeProjectPath(projectPath);
    if (!normalizedPath || !(await this.isValidWeappProject(normalizedPath))) {
      return false;
    }
    if (!(await this.saveDefaultProjectPath(normalizedPath))) {
      throw new UserError(
        `项目路径有效，但无法写入默认项目配置: ${normalizedPath}`
      );
    }
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

Next step：把 projectSelection 设为 "1"、"${projects[0].name}" 或完整路径后重试 mp_ensureConnection。`;
    }

    // Case 2: 有默认项目配置
    if (defaultProject) {
      return `[DEFAULT_PROJECT_CONFIGURED]
您已配置默认项目：
📁 ${path.basename(defaultProject)}
   ${defaultProject}

Next step：把该完整路径作为 connection.projectPath 传给 mp_ensureConnection；如需改默认项目，先调用 mp_listProjects / mp_setDefaultProject。`;
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

Next step：
• 在 connection.projectPath 或 WEAPP_PROJECT_PATH 中提供有效项目目录，再重试 mp_ensureConnection
• 或在包含 project.config.json 的小程序项目根目录启动 MCP server 后重试
• 不要原样重试，也不要自行运行 cli open / cli auto`;
  }

  private getDefaultCliPath(): string | undefined {
    if (process.platform === 'darwin') {
      return '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
    } else if (process.platform === 'win32') {
      return 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
    }
    return undefined;
  }

  private async resolveAutoLaunchProjectPath(
    config: WeappConnectionConfig
  ): Promise<{ path: string; source: "config" | "persisted" | "cwd" } | null> {
    if (config.projectPath) {
      return { path: config.projectPath, source: "config" };
    }
    const persisted = await this.getDefaultProject();
    if (persisted && await this.isValidWeappProject(persisted)) {
      return { path: persisted, source: "persisted" };
    }
    const cwd = process.cwd();
    if (await this.isValidWeappProject(cwd)) {
      return { path: cwd, source: "cwd" };
    }
    return null;
  }

  private async waitForPortListening(
    port: number,
    timeoutMs: number,
    log?: { info: (msg: string) => void }
  ): Promise<boolean> {
    const startedAt = Date.now();
    let halfwayLogged = false;
    while (true) {
      const remainingBeforeProbe = timeoutMs - (Date.now() - startedAt);
      if (remainingBeforeProbe <= 0) {
        break;
      }
      if (await this.isPortInUse(port, "127.0.0.1", remainingBeforeProbe)) {
        return true;
      }
      const elapsed = Date.now() - startedAt;
      if (!halfwayLogged && elapsed >= timeoutMs / 2) {
        halfwayLogged = true;
        log?.info(
          `still waiting for port ${port} to listen (${Math.round(elapsed / 1000)}s elapsed of ${Math.round(timeoutMs / 1000)}s budget)`
        );
      }
      const remainingBeforeSleep = timeoutMs - (Date.now() - startedAt);
      if (remainingBeforeSleep > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(300, remainingBeforeSleep))
        );
      }
    }
    return false;
  }

  private async launchDevTools(config: WeappConnectionConfig, log: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
    const cliPath = config.cliPath || this.getDefaultCliPath();
    if (!cliPath) {
      throw new Error("cliPath not configured and no default path for this platform, cannot auto launch DevTools");
    }
    if (!config.projectPath) {
      throw new Error("projectPath not configured, cannot auto launch DevTools");
    }

    try {
      await fs.promises.access(cliPath, fs.constants.X_OK);
    } catch {
      throw new Error(`CLI path not found or not executable: ${cliPath}`);
    }

    const { spawn } = await import("child_process");

    const isWindows = process.platform === "win32";
    // --auto-port is an undocumented flag (cli --help omits it) but the official
    // miniprogram-automator SDK uses exactly this form in Launcher.js. Without
    // it, IDE picks a random HTTP port and the websocket automation port we
    // expect at config.port is never opened.
    const autoPort = String(config.port ?? 9420);
    const autoArgs = [
      "auto",
      "--project", config.projectPath,
      "--auto-port", autoPort,
    ];

    if (config.account) {
      autoArgs.push("--auto-account", config.account);
    } else if (config.ticket) {
      autoArgs.push("--ticket", config.ticket);
    }
    if (config.trustProject) {
      autoArgs.push("--trust-project");
    }
    if (config.args) {
      autoArgs.push(...config.args);
    }

    let command: string;
    let commandArgs: string[];
    if (isWindows) {
      command = "cmd.exe";
      commandArgs = ["/c", cliPath, ...autoArgs];
    } else {
      command = cliPath;
      commandArgs = autoArgs;
    }

    const logCommand = `${cliPath} ${redactCliArgsForLog(autoArgs).join(" ")}`;
    log.info(`Launching: ${logCommand}`);

    const proc = spawn(command, commandArgs, {
      cwd: config.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const capCap = 8192;
    const totalBytes = (chunks: Buffer[]): number =>
      chunks.reduce((sum, c) => sum + c.length, 0);
    const pushCappedChunk = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = capCap - totalBytes(chunks);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
      }
    };
    proc.stdout?.on("data", (chunk: Buffer) => {
      pushCappedChunk(stdoutChunks, chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      pushCappedChunk(stderrChunks, chunk);
    });
    const unrefPipe = (stream: unknown): void => {
      const candidate = stream as { unref?: () => void } | null | undefined;
      candidate?.unref?.();
    };
    unrefPipe(proc.stdout);
    unrefPipe(proc.stderr);

    let earlyExitCode: number | null = null;
    let earlyExitSignal: NodeJS.Signals | null = null;
    let exited = false;
    const spawnState: { error: Error | null } = { error: null };
    let notifySpawnError!: () => void;
    let notifyExit!: () => void;
    const spawnErrorPromise = new Promise<void>((resolve) => {
      notifySpawnError = resolve;
    });
    const exitPromise = new Promise<void>((resolve) => {
      notifyExit = resolve;
    });
    proc.on("exit", (code, signal) => {
      exited = true;
      earlyExitCode = code;
      earlyExitSignal = signal;
      notifyExit();
    });
    proc.on("error", (err) => {
      spawnState.error = err;
      log.warn(`Failed to spawn DevTools cli: ${redactCliTextForLog(err.message, autoArgs)}`);
      notifySpawnError();
    });

    proc.unref();

    // Watch a short window. If cli exits non-zero in this window, surface the
    // stderr immediately so the caller doesn't sit through 30s of port polling.
    let spawnWatchTimer: NodeJS.Timeout | null = null;
    await Promise.race([
      spawnErrorPromise,
      exitPromise,
      new Promise<void>((resolve) => {
        spawnWatchTimer = setTimeout(resolve, 2000);
      }),
    ]);
    if (spawnWatchTimer) {
      clearTimeout(spawnWatchTimer);
    }

    if (spawnState.error) {
      throw new Error(
        `Failed to spawn DevTools cli: ${redactCliTextForLog(
          spawnState.error.message,
          autoArgs
        )}`
      );
    }

    const stderr = redactCliTextForLog(
      Buffer.concat(stderrChunks).toString("utf8").trim(),
      autoArgs
    );
    const stdout = redactCliTextForLog(
      Buffer.concat(stdoutChunks).toString("utf8").trim(),
      autoArgs
    );

    // 观察窗已结束、stdout/stderr 已捕获：解除监听并排空管道，避免 detached 子进程的
    // data/exit/error 监听器与 8KB 缓冲区闭包一直被引用（每次 auto-launch 滞留一份，
    // 直到 server 退出）。用 resume() 持续丢弃后续输出而非 destroy()，以免向仍存活的
    // IDE 写端发 SIGPIPE。
    const drainStream = (stream: unknown): void => {
      const s = stream as
        | { removeAllListeners?: (event: string) => void; resume?: () => void }
        | null
        | undefined;
      if (!s) return;
      if (typeof s.removeAllListeners === "function") s.removeAllListeners("data");
      if (typeof s.resume === "function") s.resume();
    };
    drainStream(proc.stdout);
    drainStream(proc.stderr);
    proc.removeAllListeners("exit");
    proc.removeAllListeners("error");

    if (exited && earlyExitCode !== 0) {
      const reason =
        earlyExitSignal != null
          ? `signal ${earlyExitSignal}`
          : `exit code ${earlyExitCode}`;
      const detail = [
        stderr ? `stderr: ${stderr.slice(0, 1000)}` : null,
        stdout ? `stdout: ${stdout.slice(0, 1000)}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      throw new Error(
        `cli auto failed (${reason}). command: ${logCommand}${detail ? "\n" + detail : ""}`
      );
    }

    if (stderr) {
      log.warn(`cli stderr: ${stderr.slice(0, 500)}`);
    }
    if (stdout) {
      log.info(`cli stdout: ${stdout.slice(0, 500)}`);
    }

    log.info(`DevTools launched with PID: ${proc.pid}`);
  }

  async getConnectionSnapshot(overrides?: ConnectionOverrides): Promise<ConnectionSnapshot> {
    const config = resolveConfig(overrides, this.config, {
      allowIncompleteConnect: true,
      allowIncompleteLaunch: true,
    });
    const wsEndpoint = config?.wsEndpoint || null;
    const automatorConnected = Boolean(
      this.config &&
      config &&
      isSameConfig(this.config, config) &&
      (await this.isConnectionAlive())
    );
    const diagnosis = config
      ? await this.diagnoseConnection(toConnectionOverrides(config), {
          strictMode: false,
          activeSessionKnownAlive: automatorConnected,
        })
      : null;
    const projectPath = config?.projectPath ?? diagnosis?.projectPath ?? null;
    const defaultProjectPath = diagnosis?.defaultProjectPath ?? null;
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
      defaultProjectPath,
      wsEndpoint,
      port,
      sessionId: automatorConnected ? this.sessionId : null,
    };
  }

  async getActivePageSnapshot(
    overrides?: ConnectionOverrides
  ): Promise<{ path: string; query: unknown } | null> {
    if (!this.miniProgram || !this.config) {
      return null;
    }
    const requestedConfig = resolveConfig(overrides, this.config, {
      allowIncompleteConnect: true,
      allowIncompleteLaunch: true,
    });
    if (!isSameConfig(this.config, requestedConfig)) {
      return null;
    }
    const page = await this.withRequestTimeout(
      () => this.miniProgram!.currentPage(),
      {
        timeoutMs: 3000,
        description: "读取活动页面快照",
      }
    ).catch(() => null);
    return page ? { path: page.path, query: page.query } : null;
  }

  async recoverConnection(log: ToolLogger, options?: UseOptions): Promise<{
    actions: string[];
    before: ConnectionSnapshot & { listenerAttached: boolean; lastLogAt: number | null };
    after: ConnectionSnapshot & { listenerAttached: boolean; lastLogAt: number | null };
  }> {
    const beforeConnection = await this.getConnectionSnapshot(options?.overrides);
    const beforeLog = await this.getLogStatus(options?.overrides);
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

    const afterConnection = await this.getConnectionSnapshot(options?.overrides);
    const afterLog = await this.getLogStatus(options?.overrides);

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

  private async attachLogging(
    miniProgram: MiniProgramInstance,
    log: ToolLogger
  ): Promise<void> {
    if (this.loggingAttachedProgram === miniProgram) {
      this.listenerAttached = true;
      return;
    }

    try {
      const addListener =
        typeof miniProgram.addListener === "function"
          ? miniProgram.addListener.bind(miniProgram)
          : miniProgram.on.bind(miniProgram);
      addListener("console", (event: unknown) => {
        const serialized = toSerializableValue(event);
        const args = (event as any)?.args;
        const logEntry: ConsoleLogEntry = {
          type: typeof (event as any)?.type === "string" ? (event as any).type : "log",
          message: Array.isArray(args)
            ? args
                .map((arg) =>
                  typeof arg === "string"
                    ? arg
                    : JSON.stringify(toSerializableValue(arg)) ?? String(arg)
                )
                .join(" ")
            : String(serialized),
          timestamp: Date.now(),
          data: serialized,
          sourceTarget: this.getLogTargetKeyForConfig(this.config) ?? undefined,
        };

        this.appendConsoleLog(logEntry);

        log.debug("Mini Program console event", {
          event: normalizeConsoleLogEntry(logEntry, this.maxLogEntryBytes)?.data ?? null,
        });
      });
      addListener("exception", (event: unknown) => {
        const serialized = toSerializableValue(event);
        const logEntry: ConsoleLogEntry = {
          type: "exception",
          message: typeof (event as any)?.message === "string" ? (event as any).message : String(serialized),
          timestamp: Date.now(),
          data: serialized,
          sourceTarget: this.getLogTargetKeyForConfig(this.config) ?? undefined,
        };

        this.appendConsoleLog(logEntry);

        log.error("Mini Program exception", {
          event: normalizeConsoleLogEntry(logEntry, this.maxLogEntryBytes)?.data ?? null,
        });
      });
      const send = (miniProgram as unknown as {
        send?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      }).send;
      if (typeof send === "function") {
        await this.withRequestTimeout(
          () => send.call(miniProgram, "App.enableLog"),
          {
            timeoutMs: 5000,
            description: "启用小程序控制台日志",
          }
        );
      }
    } catch (error) {
      try {
        miniProgram.removeAllListeners();
      } catch {
        // Keep the original binding failure.
      }
      this.loggingAttachedProgram = undefined;
      this.listenerAttached = false;
      this.lastListenerBindAt = null;
      this.sessionId = null;
      throw error;
    }

    this.loggingAttachedProgram = miniProgram;
    this.listenerAttached = true;
    this.lastListenerBindAt = Date.now();
    this.sessionId = this.createSessionId();
    void this.persistStateMeta();
  }

  private createSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

type MiniProgramInstance = Awaited<ReturnType<typeof automator.launch>>;
type PageInstance = NonNullable<
  Awaited<ReturnType<MiniProgramInstance["currentPage"]>>
>;

function normalizeProjectEntry(
  value: unknown
): { path: string; name: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) {
    return null;
  }
  const projectPath = record.path;
  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name
      : path.basename(projectPath);
  return { path: projectPath, name };
}

function normalizeConsoleLogEntry(
  value: unknown,
  maxDataBytes: number
): ConsoleLogEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.message !== "string" ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp)
  ) {
    return null;
  }

  const entry: ConsoleLogEntry = {
    type: truncateUtf8(record.type, 256),
    message: truncateUtf8(record.message, Math.max(1024, Math.floor(maxDataBytes / 2))),
    timestamp: record.timestamp,
  };
  if (typeof record.sourceTarget === "string" && record.sourceTarget) {
    entry.sourceTarget =
      normalizeLogTargetKey(truncateUtf8(record.sourceTarget, 4096)) ?? undefined;
  }
  if (Object.prototype.hasOwnProperty.call(record, "data")) {
    const data = toSerializableValue(record.data);
    const clamped = clampJsonByBytes(data, maxDataBytes);
    entry.data = toSerializableValue(clamped.value);
  }
  return entry;
}

function normalizePersistedSessions(
  value: unknown
): Record<string, PersistedSessionState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const sessions: Array<[string, PersistedSessionState]> = [];
  for (const [id, rawSession] of Object.entries(value)) {
    if (
      !rawSession ||
      typeof rawSession !== "object" ||
      Array.isArray(rawSession)
    ) {
      continue;
    }
    const session = rawSession as Record<string, unknown>;
    if (
      typeof session.listenerAttached !== "boolean" ||
      typeof session.updatedAt !== "number" ||
      !Number.isFinite(session.updatedAt)
    ) {
      continue;
    }
    sessions.push([
      id,
      {
        listenerAttached: session.listenerAttached,
        lastLogAt:
          typeof session.lastLogAt === "number" && Number.isFinite(session.lastLogAt)
            ? session.lastLogAt
            : null,
        lastListenerBindAt:
          typeof session.lastListenerBindAt === "number" &&
          Number.isFinite(session.lastListenerBindAt)
            ? session.lastListenerBindAt
            : null,
        sourceProjectPath:
          typeof session.sourceProjectPath === "string"
            ? session.sourceProjectPath
            : null,
        sourceTarget:
          typeof session.sourceTarget === "string"
            ? normalizeLogTargetKey(session.sourceTarget)
            : null,
        processId:
          typeof session.processId === "number" &&
          Number.isInteger(session.processId) &&
          session.processId > 0
            ? session.processId
            : null,
        updatedAt: session.updatedAt,
      },
    ]);
  }
  sessions.sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
  return Object.fromEntries(sessions.slice(0, 1000));
}

function isPersistedSessionProcessAlive(processId: number | null | undefined): boolean {
  // Legacy persisted sessions did not include a PID. Keep them readable during
  // upgrades; all sessions written by this version can be checked precisely.
  if (processId == null) {
    return true;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const marker = "...[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const head = Buffer.from(value, "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/�+$/, "");
  return `${head}${marker}`;
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
    projectPath: diagnosis.projectPath,
    defaultProjectPath: diagnosis.defaultProjectPath,
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

function classifyWsEndpoint(
  endpoint: string | undefined
): "local" | "remote" | "invalid" {
  if (!endpoint) {
    return "local";
  }
  const parsed = parseWsEndpoint(endpoint);
  if (!parsed) {
    return "invalid";
  }
  const host = normalizeUrlHostname(parsed.hostname);
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^::ffff:127\./.test(host)
  ) {
    return "local";
  }
  return "remote";
}

function normalizeUrlHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseWsEndpoint(endpoint: string): URL | null {
  try {
    const parsed = new URL(endpoint);
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
      !parsed.hostname
    ) {
      return null;
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function getWsEndpointPort(endpoint: string): number | null {
  const parsed = parseWsEndpoint(endpoint);
  if (!parsed) {
    return null;
  }
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "wss:" ? 443 : 80;
}

export function redactCliArgsForLog(args: string[]): string[] {
  const result = [...args];
  const sensitiveFlags = new Set(["--ticket", "--auto-account"]);
  for (let index = 0; index < result.length; index += 1) {
    if (sensitiveFlags.has(result[index]) && index + 1 < result.length) {
      result[index + 1] = "<redacted>";
      index += 1;
    } else {
      const flag = [...sensitiveFlags].find((item) =>
        result[index].startsWith(`${item}=`)
      );
      if (flag) {
        result[index] = `${flag}=<redacted>`;
      }
    }
  }
  return result;
}

export function redactCliTextForLog(text: string, args: string[]): string {
  let result = text;
  const sensitiveFlags = new Set(["--ticket", "--auto-account"]);
  for (let index = 0; index < args.length; index += 1) {
    let sensitiveValue: string | undefined;
    if (sensitiveFlags.has(args[index]) && index + 1 < args.length) {
      sensitiveValue = args[index + 1];
      index += 1;
    } else {
      const flag = [...sensitiveFlags].find((item) =>
        args[index].startsWith(`${item}=`)
      );
      if (flag) {
        sensitiveValue = args[index].slice(flag.length + 1);
      }
    }
    if (sensitiveValue) {
      result = result.split(sensitiveValue).join("<redacted>");
    }
  }
  return result;
}

function isSameConfig(
  a: WeappConnectionConfig,
  b: WeappConnectionConfig
): boolean {
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === "connect") {
    return (
      normalizeWsEndpointForIdentity(a.wsEndpoint) ===
      normalizeWsEndpointForIdentity(b.wsEndpoint)
    );
  }
  return (
    a.cliPath === b.cliPath &&
    normalizeProjectPath(a.projectPath) === normalizeProjectPath(b.projectPath) &&
    (a.port ?? 9420) === (b.port ?? 9420) &&
    a.account === b.account &&
    a.ticket === b.ticket &&
    a.trustProject === b.trustProject &&
    a.cwd === b.cwd &&
    areArgsEqual(a.args, b.args)
  );
}

function normalizeProjectPath(projectPath: string | null | undefined): string | null {
  return projectPath ? path.resolve(projectPath) : null;
}

function normalizeWsEndpointForIdentity(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  return parseWsEndpoint(endpoint)?.href ?? endpoint;
}

function normalizeLogTargetKey(target: unknown): string | null {
  if (typeof target !== "string" || !target) {
    return null;
  }
  if (!target.startsWith("connect:")) {
    return target;
  }
  const endpoint = target.slice("connect:".length);
  return `connect:${normalizeWsEndpointForIdentity(endpoint)}`;
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
