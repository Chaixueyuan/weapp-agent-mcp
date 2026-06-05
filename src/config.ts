import { z } from "zod";

export type AutomatorMode = "launch" | "connect";

export interface WeappConnectionConfig {
  mode: AutomatorMode;
  cliPath?: string;
  projectPath?: string;
  wsEndpoint?: string;
  timeout?: number;
  port?: number;
  account?: string;
  ticket?: string;
  trustProject?: boolean;
  args?: string[];
  cwd?: string;
  autoClose?: boolean;
  autoLaunch?: boolean;
  launchTimeout?: number;
  connectTimeout?: number;
}

export class ConfigError extends Error {}

/**
 * 字符串/布尔皆可的布尔解析器，修复 z.coerce.boolean() 的反转陷阱：
 * z.coerce.boolean() 走 Boolean(value) 语义，任何非空字符串都变 true，
 * 于是 env "false"/"0"/"no" 反而成了 true。env 永远是字符串，必中此坑。
 * 这里显式把常见真假串映射好，未知串交给 z.boolean() 报错（而非静默错值）。
 */
export const booleanish = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  // 数字 1/0 兼容旧 z.coerce.boolean() 行为；其余数字落到 z.boolean() 报错（而非静默真值）
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value !== "string") return value;
  const t = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off", ""].includes(t)) return false;
  return value;
}, z.boolean());

export const numberish = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  }, schema);

const argsSchema = z
  .union([z.string(), z.array(z.string()).max(100)])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    const list = Array.isArray(value) ? value : value.split(/\s+/);
    const normalized = list.map((item) => item.trim()).filter(Boolean);
    return normalized;
  })
  .refine((value) => !value || value.length <= 100, {
    message: "args must contain at most 100 entries",
  });

export const connectionOverridesSchema = z
  .object({
    mode: z.enum(["launch", "connect"]).optional(),
    cliPath: z.string().trim().min(1).optional(),
    projectPath: z.string().trim().min(1).optional(),
    wsEndpoint: z.string().trim().min(1).optional(),
    timeout: numberish(z.number().int().positive().max(600000)).optional(),
    port: numberish(z.number().int().positive().max(65535)).optional(),
    account: z.string().trim().min(1).optional(),
    ticket: z.string().trim().min(1).optional(),
    trustProject: booleanish.optional(),
    args: argsSchema,
    cwd: z.string().trim().min(1).optional(),
    autoClose: booleanish.optional(),
    autoLaunch: booleanish.optional(),
    launchTimeout: numberish(z.number().int().positive().max(600000)).optional(),
    connectTimeout: numberish(z.number().int().positive().max(600000)).optional(),
  })
  .strict();

export type ConnectionOverrides = z.infer<typeof connectionOverridesSchema>;

function mergeDefined<T extends Record<string, unknown>>(
  ...sources: T[]
): T {
  const result = {} as T;

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        result[key as keyof T] = value as T[keyof T];
      }
    }
  }

  return result;
}

function fromPrevious(
  previous?: WeappConnectionConfig
): ConnectionOverrides {
  const base: ConnectionOverrides = { args: undefined };
  if (!previous) {
    return base;
  }
  base.mode = previous.mode;
  if (previous.cliPath) base.cliPath = previous.cliPath;
  if (previous.projectPath) base.projectPath = previous.projectPath;
  if (previous.wsEndpoint) base.wsEndpoint = previous.wsEndpoint;
  if (typeof previous.timeout === "number") base.timeout = previous.timeout;
  if (typeof previous.port === "number") base.port = previous.port;
  if (previous.account) base.account = previous.account;
  if (previous.ticket) base.ticket = previous.ticket;
  if (typeof previous.trustProject === "boolean")
    base.trustProject = previous.trustProject;
  if (previous.args?.length) base.args = previous.args;
  if (previous.cwd) base.cwd = previous.cwd;
  if (typeof previous.autoClose === "boolean")
    base.autoClose = previous.autoClose;
  if (typeof previous.autoLaunch === "boolean")
    base.autoLaunch = previous.autoLaunch;
  if (typeof previous.launchTimeout === "number")
    base.launchTimeout = previous.launchTimeout;
  if (typeof previous.connectTimeout === "number")
    base.connectTimeout = previous.connectTimeout;
  return base;
}

function normalizeWsEndpointForComparison(
  endpoint: string | undefined
): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    return new URL(endpoint).href;
  } catch {
    return endpoint;
  }
}

export interface ResolveConfigOptions {
  allowIncompleteConnect?: boolean;
  allowIncompleteLaunch?: boolean;
}

function parseConnectionOverrides(
  value: unknown,
  source: "environment" | "overrides"
): ConnectionOverrides {
  try {
    return connectionOverridesSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConfigError(
        `Invalid connection ${source}: ${error.issues
          .map((issue) => `${issue.path.join(".") || "connection"}: ${issue.message}`)
          .join("; ")}`
      );
    }
    throw error;
  }
}

export function resolveConfig(
  overrides?: ConnectionOverrides,
  previous?: WeappConnectionConfig,
  options?: ResolveConfigOptions
): WeappConnectionConfig {
  const envInput = parseConnectionOverrides({
    mode: process.env.WEAPP_AUTOMATOR_MODE,
    cliPath: process.env.WECHAT_DEVTOOLS_CLI_PATH,
    projectPath: process.env.WEAPP_PROJECT_PATH,
    wsEndpoint: process.env.WEAPP_WS_ENDPOINT,
    timeout: process.env.WEAPP_DEVTOOLS_TIMEOUT,
    port: process.env.WEAPP_DEVTOOLS_PORT,
    account: process.env.WEAPP_AUTO_ACCOUNT,
    ticket: process.env.WEAPP_DEVTOOLS_TICKET,
    trustProject: process.env.WEAPP_TRUST_PROJECT,
    args: process.env.WEAPP_DEVTOOLS_ARGS,
    cwd: process.env.WEAPP_DEVTOOLS_CWD,
    autoClose: process.env.WEAPP_AUTOCLOSE,
    autoLaunch: process.env.WEAPP_AUTOLAUNCH,
    launchTimeout: process.env.WEAPP_LAUNCH_TIMEOUT,
    connectTimeout: process.env.WEAPP_CONNECT_TIMEOUT,
  }, "environment");

  const base = fromPrevious(previous);

  const overrideConfig: ConnectionOverrides = overrides
    ? parseConnectionOverrides(overrides, "overrides")
    : { args: undefined };

  const merged = mergeDefined(base, envInput, overrideConfig);

  const mode: AutomatorMode =
    overrideConfig.mode ??
    envInput.mode ??
    (overrideConfig.wsEndpoint
      ? "connect"
      : envInput.wsEndpoint
        ? "connect"
      : previous?.mode ?? "launch");

  const connectTargetChanged =
    mode === "connect" &&
    previous !== undefined &&
    (previous.mode !== "connect" ||
      normalizeWsEndpointForComparison(previous.wsEndpoint) !==
        normalizeWsEndpointForComparison(merged.wsEndpoint));
  const projectPath =
    connectTargetChanged &&
    overrideConfig.projectPath === undefined &&
    envInput.projectPath === undefined
      ? undefined
      : merged.projectPath;

  const config: WeappConnectionConfig = {
    mode,
    cliPath: merged.cliPath,
    projectPath,
    // wsEndpoint 只属于 connect 模式。显式切回 launch 时不能继续拿上一条
    // connect 会话的 endpoint 做诊断，否则会探错目标甚至阻止正确 launch。
    wsEndpoint: mode === "connect" ? merged.wsEndpoint : undefined,
    timeout: merged.timeout,
    port: merged.port,
    account: merged.account,
    ticket: merged.ticket,
    trustProject: merged.trustProject,
    args: merged.args,
    cwd: merged.cwd,
    autoClose: merged.autoClose,
    autoLaunch: merged.autoLaunch,
    launchTimeout: merged.launchTimeout,
    connectTimeout: merged.connectTimeout,
  };

  if (config.mode === "connect") {
    if (!config.wsEndpoint && !options?.allowIncompleteConnect) {
      throw new ConfigError(
        "WeChat DevTools websocket endpoint is required. Provide connection.wsEndpoint."
      );
    }
  } else if (!config.projectPath && !options?.allowIncompleteLaunch) {
    throw new ConfigError(
      "Mini Program project path is required. Provide connection.projectPath."
    );
  }

  return config;
}

export const globalTimeoutMs = 15000;
