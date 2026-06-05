import {
  UserError,
  type ContentResult,
  type Context,
  type SerializableValue,
  type Tool,
} from "fastmcp";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  booleanish,
  ConfigError,
  connectionOverridesSchema,
  numberish,
} from "../config.js";
import type { WeappAutomatorManager } from "../weappClient.js";

export { booleanish, numberish };

export type ToolContext = Context<Record<string, unknown> | undefined>;
export type AnyTool = Tool<Record<string, unknown> | undefined>;

// connection 覆盖字段：对外 emit 成不透明 object（省去每个工具内联 15 字段 ~800B 的重复
// schema，44 工具合计 ~35KB/tools-list），但在 parse 时仍用严格的 connectionOverridesSchema
// 校验——保留"开 session 前就拒绝未知/非法 connection 字段"的既有契约。
const connectionOverrideField = z
  .record(z.string(), z.unknown())
  .transform((value, ctx) => {
    const parsed = connectionOverridesSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return z.NEVER;
    }
    return parsed.data;
  })
  .describe(
    "可选连接覆盖（不传则用默认会话）。可用字段：mode(launch|connect)、cliPath、projectPath、wsEndpoint、timeout、port、account、ticket、trustProject、args、cwd、autoClose、autoLaunch、launchTimeout、connectTimeout。"
  )
  .optional();

export const connectionContainerSchema = z.object({
  connection: connectionOverrideField,
}).strict();

export const connectionOnlyParameters = connectionContainerSchema;

export const ensureConnectionParameters = connectionContainerSchema
  .extend({
    reconnect: booleanish.optional().default(false),
    projectSelection: z.string().optional(),
  });

export const querySchema = z
  .record(z.string(), z.string())
  .refine((value) => Object.keys(value).length <= 100, {
    message: "query must contain at most 100 entries",
  })
  .optional();

export const maxBytesSchema = numberish(
  z.number().int().min(64).max(1_000_000)
);

export const MAX_SNAPSHOT_ELEMENT_SUMMARIES = 100;

// z.unknown() accepts a missing object property in Zod 4. MCP inputs are JSON,
// so undefined is not a meaningful explicit value; reject it to keep fields
// such as assertion `expected` genuinely required.
export const requiredJsonValueSchema = z
  .unknown()
  .refine((value) => value !== undefined, {
    message: "expected is required",
  });

export const stringListSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (!value) {
      return undefined;
    }
    const list = Array.isArray(value) ? value : value.split(/\s+/);
    const normalized = list.map((item) => item.trim()).filter(Boolean);
    return normalized.length ? normalized : undefined;
  });

export function buildUrl(
  path: string,
  query?: Record<string, string>
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!query || Object.keys(query).length === 0) {
    return normalizedPath;
  }
  const searchParams = new URLSearchParams(query);
  const separator = normalizedPath.includes("?") ? "&" : "?";
  const search = searchParams.toString();
  return search ? `${normalizedPath}${separator}${search}` : normalizedPath;
}

export function formatJson(value: unknown): string {
  const serialized = JSON.stringify(toSerializableValue(value), null, 2);
  return serialized ?? String(value);
}

export function toTextResult(text: string): ContentResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export function toErrorResult(text: string): ContentResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export async function withUserErrorResult<T extends ContentResult>(
  execute: () => Promise<T>
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof UserError) {
      return toErrorResult(error.message) as T;
    }
    if (error instanceof z.ZodError) {
      return toErrorResult(`Invalid parameters: ${error.issues.map((issue) => issue.message).join("; ")}`) as T;
    }
    if (error instanceof ConfigError) {
      return toErrorResult(error.message) as T;
    }
    throw error;
  }
}

export async function readNamedValues(
  names: string[] | undefined,
  reader: (name: string) => Promise<unknown>,
  kind: "attribute" | "property"
): Promise<Record<string, unknown> | undefined> {
  if (!names?.length) {
    return undefined;
  }

  const entries: [string, unknown][] = [];
  for (const name of names) {
    try {
      entries.push([name, await reader(name)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push([name, `Failed to read ${kind}: ${message}`]);
    }
  }
  return Object.fromEntries(entries);
}

export async function resolveElement(
  page: unknown,
  selector: string,
  innerSelector?: string
): Promise<any> {
  if (!page || typeof (page as { $?: unknown }).$ !== "function") {
    throw new UserError("Page instance is not available to resolve elements.");
  }

  const parsed = parseSelectorWithIndex(selector);
  let element: any;

  if (parsed) {
    const pageWithAll = page as { $$?: (s: string) => Promise<unknown[]> };
    if (typeof pageWithAll.$$ !== "function") {
      throw new UserError("Page instance does not support indexed selectors (page.$$ missing).");
    }
    let elements: unknown[];
    try {
      const result = await pageWithAll.$$(parsed.baseSelector);
      if (!Array.isArray(result)) {
        throw new UserError(`查询选择器 "${parsed.baseSelector}" 失败。`);
      }
      elements = result;
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`查询选择器 "${parsed.baseSelector}" 失败: ${message}`);
    }
    if (elements.length === 0) {
      throw new UserError(notFoundMessage(parsed.baseSelector));
    }
    if (parsed.index < 0 || parsed.index >= elements.length) {
      throw new UserError(
        `Index ${parsed.index} out of range (0-${elements.length - 1}) for selector "${parsed.baseSelector}".`
      );
    }
    element = elements[parsed.index];
  } else {
    try {
      element = await (page as { $: (s: string) => Promise<any> }).$(selector);
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(`查询选择器 "${selector}" 失败: ${message}`);
    }
    if (!element) {
      throw new UserError(notFoundMessage(selector));
    }
  }

  if (innerSelector) {
    if (typeof element.$ !== "function") {
      throw new UserError(
        `Element for selector "${selector}" does not support nested queries.`
      );
    }
    let inner;
    try {
      inner = await element.$(innerSelector);
    } catch (error) {
      if (error instanceof UserError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UserError(
        `查询元素 "${selector}" 内部选择器 "${innerSelector}" 失败: ${message}`
      );
    }
    if (!inner) {
      throw new UserError(
        `${notFoundMessage(innerSelector)} (查询范围: 元素 "${selector}" 内部)`
      );
    }
    element = inner;
  }
  return element;
}

function notFoundMessage(selector: string): string {
  const hints: string[] = [];
  if (/\{\{|\}\}/.test(selector)) {
    hints.push("selector 含 `{{}}` 模板插值 — 用渲染后的字面值或静态 class 部分");
  }
  hints.push("调 `page_snapshot(withElements=true)` 列出当前 DOM 摘要");
  hints.push("调 `page_snapshot(selectors=[...], withWxml=true)` 检查渲染后的合成 class");
  hints.push("自定义组件内部用 `element_getInnerElement(s)` 或 selector + innerSelector");
  return `元素未找到: "${selector}"。建议：${hints.map((h, i) => `${i + 1}) ${h}`).join("；")}。`;
}

export async function summarizeElement(
  element: any,
  options?: { withWxml?: boolean }
): Promise<Record<string, SerializableValue>> {
  const tagName = typeof element?.tagName === "string" ? element.tagName : null;
  const withWxml = options?.withWxml ?? false;

  const readField = async (
    name: string,
    enabled = true
  ): Promise<{ attempted: boolean; ok: boolean; value: unknown; error?: unknown }> => {
    if (!enabled || typeof element?.[name] !== "function") {
      return { attempted: false, ok: false, value: null };
    }
    try {
      return { attempted: true, ok: true, value: await element[name]() };
    } catch (error) {
      return { attempted: true, ok: false, value: null, error };
    }
  };

  const reads = await Promise.all([
    readField("text"),
    readField("value"),
    readField("outerWxml", withWxml),
    readField("size"),
    readField("offset"),
    readField("scrollWidth"),
    readField("scrollHeight"),
  ]);
  const attemptedReads = reads.filter((read) => read.attempted);
  if (attemptedReads.length > 0 && attemptedReads.every((read) => !read.ok)) {
    const firstError = attemptedReads.find((read) => read.error !== undefined)?.error;
    const message = firstError instanceof Error ? firstError.message : String(firstError);
    throw new UserError(`读取元素摘要失败: ${message}`);
  }

  const [text, value, outerWxml, size, offset, scrollWidth, scrollHeight] =
    reads.map((read) => read.value);

  const result: Record<string, SerializableValue> = {
    tagName: toSerializableValue(tagName),
    text: toSerializableValue(text),
    value: toSerializableValue(value),
    size: toSerializableValue(size),
    offset: toSerializableValue(offset),
  };

  // 当 withWxml 为 true 时，返回完整的 outerWxml
  if (withWxml && outerWxml !== null) {
    result.outerWxml = toSerializableValue(outerWxml);
  }

  // scroll-view 专用属性，仅在有值时添加
  if (scrollWidth !== null) {
    result.scrollWidth = toSerializableValue(scrollWidth);
  }
  if (scrollHeight !== null) {
    result.scrollHeight = toSerializableValue(scrollHeight);
  }

  return result;
}

export async function waitOnPage(page: unknown, waitMs?: number): Promise<void> {
  if (!waitMs) {
    return;
  }
  if (page && typeof (page as { waitFor?: unknown }).waitFor === "function") {
    await (page as { waitFor: (value: number) => Promise<void> }).waitFor(waitMs);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export async function readCurrentPage(
  manager: WeappAutomatorManager,
  miniProgram: { currentPage: () => Promise<unknown> },
  description: string,
  timeoutMs?: number
): Promise<any> {
  try {
    return await manager.withRequestTimeout(
      () => miniProgram.currentPage(),
      { description, timeoutMs }
    );
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`${description}失败: ${message}`);
  }
}

export function serializePageSummary(page: unknown): SerializableValue {
  if (!isPageLike(page)) {
    return toSerializableValue(page);
  }
  return serializePageSummaryInternal(page, new WeakSet<object>(), 0);
}

function serializePageSummaryInternal(
  page: { path: string; query?: unknown },
  seen: WeakSet<object>,
  depth: number
): SerializableValue {
  if (seen.has(page)) {
    return "[Circular]" as SerializableValue;
  }
  seen.add(page);
  const summary: Record<string, SerializableValue> = {
    path: page.path,
  };
  if (page.query !== undefined) {
    summary.query = toSerializableValueInternal(page.query, seen, depth + 1);
  }
  seen.delete(page);
  return summary as SerializableValue;
}

export function toSerializableValue(value: unknown): SerializableValue {
  try {
    return toSerializableValueInternal(value, new WeakSet<object>(), 0);
  } catch (error) {
    return formatUnserializableValue(error);
  }
}

function toSerializableValueInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): SerializableValue {
  if (value === null || value === undefined) {
    return value as SerializableValue;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return String(value) as SerializableValue;
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    return value.toString() as SerializableValue;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? String(value) as SerializableValue
      : value.toISOString() as SerializableValue;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("base64") as SerializableValue;
  }
  if (depth >= 50) {
    return "[MaxDepth]" as SerializableValue;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]" as SerializableValue;
    }
    seen.add(value);
    try {
      return value.map((item) =>
        toSerializableValueInternal(item, seen, depth + 1)
      ) as SerializableValue;
    } catch (error) {
      return formatUnserializableValue(error);
    } finally {
      seen.delete(value);
    }
  }
  try {
    if (isPageLike(value)) {
      return serializePageSummaryInternal(value, seen, depth);
    }
  } catch (error) {
    return formatUnserializableValue(error);
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]" as SerializableValue;
    }
    seen.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>).map(
        ([key, val]) => [
          key,
          toSerializableValueInternal(val, seen, depth + 1),
        ]
      );
      return Object.fromEntries(entries) as SerializableValue;
    } catch (error) {
      return formatUnserializableValue(error);
    } finally {
      seen.delete(value);
    }
  }
  try {
    return String(value) as SerializableValue;
  } catch (error) {
    return formatUnserializableValue(error);
  }
}

function formatUnserializableValue(error: unknown): SerializableValue {
  let message = "unknown serialization error";
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    // Keep the stable fallback when even the thrown value cannot be stringified.
  }
  return `[Unserializable: ${message}]` as SerializableValue;
}

function isPageLike(value: unknown): value is { path: string; query?: unknown } {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { path?: unknown }).path !== "string"
  ) {
    return false;
  }
  const candidate = value as {
    data?: unknown;
    waitFor?: unknown;
    $?: unknown;
  };
  return (
    typeof candidate.data === "function" ||
    typeof candidate.waitFor === "function" ||
    typeof candidate.$ === "function"
  );
}

export function runFunctionSourceInAppService(
  source: string,
  args: unknown[]
): unknown {
  // This fixed runner is serialized by miniprogram-automator and executes in
  // AppService. Never evaluate caller-provided source in the MCP host process.
  const fn = new Function(`return (${source});`)();
  if (typeof fn !== "function") {
    throw new Error("Source did not evaluate to a function.");
  }
  return fn(...args);
}

export function areSerializableValuesEqual(
  left: unknown,
  right: unknown
): boolean {
  return isDeepStrictEqual(
    toSerializableValue(left),
    toSerializableValue(right)
  );
}

export function setOwnEnumerableValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function getByPath(target: unknown, path: string): unknown {
  if (target == null || !path) {
    return target;
  }
  const segments = path
    .replace(/\[(-?\d+)\]/g, ".$1")
    .replace(/\[\*\]/g, ".*")
    .split(".")
    .filter((seg) => seg.length > 0);
  return walkSegments(target, segments);
}

function walkSegments(current: unknown, segments: string[]): unknown {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (current == null) {
      return undefined;
    }
    if (seg === "*") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      const rest = segments.slice(i + 1);
      if (rest.length === 0) {
        return current;
      }
      return (current as unknown[]).map((item) => walkSegments(item, rest));
    }
    if (Array.isArray(current)) {
      if (/^-?\d+$/.test(seg)) {
        const idx = Number(seg);
        const arr = current as unknown[];
        current = idx < 0 ? arr[arr.length + idx] : arr[idx];
        continue;
      }
      if (seg === "length") {
        current = (current as unknown[]).length;
        continue;
      }
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    const obj = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, seg)) {
      return undefined;
    }
    current = obj[seg];
  }
  return current;
}

export function pickByPaths(
  source: unknown,
  paths: string[]
): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const p of paths) {
    const v = getByPath(source, p);
    if (v === undefined) {
      missing.push(p);
    } else {
      setOwnEnumerableValue(values, p, toSerializableValue(v));
    }
  }
  return { values, missing };
}

/**
 * 统一的"按字节裁剪后的文本结果"包装：未超 maxBytes 原样返回 payload；
 * 超出时返回 { ...identity, truncated, bytes, maxBytes, note?, data } 的统一形状，
 * 在最终文本不超过 maxBytes 的前提下优先保留 identity 字段（如 selector/route）。
 */
export function clampedTextResult(
  payload: Record<string, unknown>,
  maxBytes: number | undefined,
  options?: { identity?: Record<string, unknown>; note?: string }
): ContentResult {
  const formatted = formatJson(payload);
  if (!maxBytes || Buffer.byteLength(formatted, "utf8") <= maxBytes) {
    return toTextResult(formatted);
  }

  const normalizedPayload = toSerializableValue(payload);
  const compactPayload = JSON.stringify(normalizedPayload) ?? "";
  const bytes = Buffer.byteLength(compactPayload, "utf8");
  if (bytes <= maxBytes) {
    return toTextResult(compactPayload);
  }
  const result: Record<string, unknown> = {
    truncated: true,
    bytes,
    maxBytes,
  };
  const reservedKeys = new Set(["truncated", "bytes", "maxBytes", "data", "note"]);
  const fits = (value: Record<string, unknown>): boolean =>
    Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
  const tryAdd = (key: string, value: unknown): boolean => {
    const candidate = { ...result };
    setOwnEnumerableValue(candidate, key, toSerializableValue(value));
    if (!fits(candidate)) {
      return false;
    }
    setOwnEnumerableValue(result, key, toSerializableValue(value));
    return true;
  };

  for (const [key, value] of Object.entries(options?.identity ?? {})) {
    if (!reservedKeys.has(key)) {
      tryAdd(key, value);
    }
  }

  let low = 1;
  let high = maxBytes;
  let bestData: unknown;
  while (low <= high) {
    const budget = Math.floor((low + high) / 2);
    const candidateData = clampJsonByBytes(normalizedPayload, budget).value;
    const candidate = { ...result };
    setOwnEnumerableValue(candidate, "data", candidateData);
    if (fits(candidate)) {
      bestData = candidateData;
      low = budget + 1;
    } else {
      high = budget - 1;
    }
  }
  if (bestData !== undefined) {
    setOwnEnumerableValue(result, "data", bestData);
  }
  if (options?.note) {
    tryAdd("note", options.note);
  }

  const compactResult = JSON.stringify(result);
  if (Buffer.byteLength(compactResult, "utf8") > maxBytes) {
    // Tool schemas require maxBytes >= 64; keep a defensive fallback for
    // direct helper callers that bypass schema validation.
    return toTextResult("0");
  }
  return toTextResult(
    compactResult
  );
}

export function clampJsonByBytes(
  value: unknown,
  maxBytes?: number
): { value: unknown; truncated: boolean; bytes: number } {
  const serialized = JSON.stringify(value) ?? "";
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (!maxBytes || bytes <= maxBytes) {
    return { value, truncated: false, bytes };
  }
  const buf = Buffer.from(serialized, "utf8");

  let low = 0;
  let high = Math.min(bytes, maxBytes);
  let best: string | null = null;
  while (low <= high) {
    const candidateBytes = Math.floor((low + high) / 2);
    const head = buf
      .subarray(0, candidateBytes)
      .toString("utf8")
      .replace(/�+$/, "");
    const keptBytes = Buffer.byteLength(head, "utf8");
    const candidate = `${head}...[truncated ${bytes - keptBytes}B]`;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) {
      best = candidate;
      low = candidateBytes + 1;
    } else {
      high = candidateBytes - 1;
    }
  }

  // Extremely small budgets cannot fit a useful marker. Keep the returned
  // JSON value inside the requested budget; `truncated: true` remains the
  // authoritative signal for callers.
  const truncatedValue: unknown =
    best ?? (maxBytes >= 2 ? "" : 0);
  return {
    value: truncatedValue,
    truncated: true,
    bytes,
  };
}

export function parseSelectorWithIndex(selector: string): { baseSelector: string; index: number } | null {
  // 匹配 selector[index=N] 语法
  const match = selector.match(/^(.+?)\[index=(\d+)\]$/);
  if (match) {
    return {
      baseSelector: match[1],
      index: parseInt(match[2], 10),
    };
  }
  return null;
}
