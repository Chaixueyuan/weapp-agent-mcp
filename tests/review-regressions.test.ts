import { strict as assert } from "node:assert";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import automator from "miniprogram-automator";

import { ConfigError } from "../src/config.js";
import { createApplicationTools } from "../src/tools/application.js";
import {
  areSerializableValuesEqual,
  runFunctionSourceInAppService,
  toSerializableValue,
  waitOnPage,
  withUserErrorResult,
} from "../src/tools/common.js";
import { createElementTools } from "../src/tools/element.js";
import { createPageTools } from "../src/tools/page.js";
import {
  WeappAutomatorManager,
  redactCliArgsForLog,
  redactCliTextForLog,
} from "../src/weappClient.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const context = { log: logger } as any;

function toolByName(tools: any[], name: string): any {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function parseTextResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

test("tool wrappers return ConfigError as an MCP error result", async () => {
  const result = await withUserErrorResult(async () => {
    throw new ConfigError("invalid connection environment");
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid connection environment/);
});

test("mp_evaluate never evaluates caller source in the MCP host", async () => {
  delete (globalThis as any).__weappHostProbe;
  let evaluateArgs: unknown[] | null = null;
  const miniProgram = {
    evaluate: async (...args: unknown[]) => {
      evaluateArgs = args;
      return true;
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_evaluate");
  const source =
    "(()=>{ globalThis.__weappHostProbe = 42; return function(){ return true; }; })()";

  const result = await tool.execute({ functionSource: source }, context);

  assert.equal(result.isError, undefined);
  assert.equal((globalThis as any).__weappHostProbe, undefined);
  assert.equal(evaluateArgs?.[0], runFunctionSourceInAppService);
  assert.equal(evaluateArgs?.[1], source);
});

test("mp_ensureConnection uses the selected project for the current connection", async () => {
  const selected = { name: "selected", path: "/projects/selected" };
  let persistedPath: string | null = null;
  let connectionOverrides: any;
  let diagnosisOverrides: any;
  const manager = {
    consumePendingProject: async () => selected,
    setDefaultProject: async (projectPath: string) => {
      persistedPath = projectPath;
      return true;
    },
    withMiniProgram: async (_log: unknown, options: any, handler: any) => {
      connectionOverrides = options.overrides;
      return handler(
        {
          currentPage: async () => ({ path: "pages/index/index", query: {} }),
          systemInfo: async () => ({}),
        },
        { mode: "launch", projectPath: selected.path }
      );
    },
    diagnoseConnection: async (overrides: any) => {
      diagnosisOverrides = overrides;
      return {
        mode: "launch",
        projectPath: selected.path,
        port: 9420,
      };
    },
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_ensureConnection");

  const result = await tool.execute({ projectSelection: "1" }, context);

  assert.equal(result.isError, undefined);
  assert.equal(persistedPath, selected.path);
  assert.equal(connectionOverrides.projectPath, selected.path);
  assert.equal(diagnosisOverrides.projectPath, selected.path);
});

test("mp_ensureConnection rejects a connected session without an active page", async () => {
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(
        {
          currentPage: async () => null,
          systemInfo: async () => ({}),
        },
        { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" }
      ),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_ensureConnection"
  ).execute({}, context);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\[NO_ACTIVE_PAGE\]/);
});

test("withPage bounds the currentPage SDK read", async () => {
  const manager = new WeappAutomatorManager();
  let timeoutDescription: string | undefined;
  let handlerCalled = false;
  (manager as any).withMiniProgram = async (
    _log: unknown,
    _options: unknown,
    handler: any
  ) => handler({ currentPage: async () => new Promise(() => {}) }, { mode: "connect" });
  (manager as any).withRequestTimeout = async (
    _operation: () => Promise<unknown>,
    options: { description?: string }
  ) => {
    timeoutDescription = options.description;
    throw new Error("bounded currentPage read");
  };

  await assert.rejects(
    manager.withPage(logger, {}, async () => {
      handlerCalled = true;
      return null;
    }),
    /bounded currentPage read/
  );
  assert.equal(timeoutDescription, "读取当前页面");
  assert.equal(handlerCalled, false);
});

test("standalone currentPage failures are returned as MCP errors", async () => {
  const miniProgram = {
    currentPage: async () => {
      throw new Error("current page exploded");
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const results = [
    await toolByName(createApplicationTools(manager as any), "mp_ensureConnection").execute(
      {},
      context
    ),
    await toolByName(createApplicationTools(manager as any), "mp_currentPage").execute(
      {},
      context
    ),
    await toolByName(createPageTools(manager as any), "page_expectRoute").execute(
      { path: "pages/a" },
      context
    ),
    await toolByName(createPageTools(manager as any), "page_snapshot").execute(
      {},
      context
    ),
  ];

  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /current page exploded/);
  }
});

test("mp_pollUntil marks a requested action failure as an MCP error", async () => {
  const miniProgram = {
    evaluate: async (_runner: unknown, source: string) => {
      if (source === "predicate") return true;
      throw new Error("action exploded");
    },
    currentPage: async () => null,
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_pollUntil");

  const result = await tool.execute(
    { predicate: "predicate", action: "action", timeoutMs: 100 },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(result.isError, true);
  assert.equal(payload.matched, true);
  assert.equal(payload.actionRan, false);
  assert.equal(payload.actionError, "action exploded");
});

test("mp_pollUntil marks an unmatched timeout as an MCP error", async () => {
  let currentPageCalls = 0;
  const miniProgram = {
    evaluate: async () => false,
    currentPage: async () => {
      currentPageCalls += 1;
      return new Promise(() => {});
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_pollUntil");

  const result = await tool.execute(
    { predicate: "predicate", timeoutMs: 5, pollIntervalMs: 1 },
    context
  );

  assert.equal(result.isError, true);
  assert.equal(parseTextResult(result).matched, false);
  assert.equal(currentPageCalls, 0);
});

test("mp_pollUntil reads the active page again for an after-action snapshot", async () => {
  const pages = [
    { data: async () => ({ value: "before" }) },
    { data: async () => ({ value: "after" }) },
  ];
  let pageIndex = 0;
  const miniProgram = {
    evaluate: async () => true,
    currentPage: async () => pages[Math.min(pageIndex++, pages.length - 1)],
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_pollUntil");

  const result = await tool.execute(
    {
      predicate: "predicate",
      action: "action",
      snapshotPaths: ["value"],
      timeoutMs: 100,
    },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(payload.before.value, "before");
  assert.equal(payload.after.value, "after");
});

test("mp_pollUntil reports requested snapshot failures", async () => {
  const miniProgram = {
    evaluate: async () => true,
    currentPage: async () => ({
      data: async () => {
        throw new Error("snapshot exploded");
      },
    }),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_pollUntil");

  const result = await tool.execute(
    { predicate: "predicate", snapshotPaths: ["ready"], timeoutMs: 100 },
    context
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /snapshot exploded/);
});

test("mp_pollUntil keeps action execution inside the overall timeout budget", async () => {
  const manager = new WeappAutomatorManager();
  const miniProgram = {
    evaluate: async (_runner: unknown, source: string) => {
      if (source === "predicate") {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      return true;
    },
  };
  (manager as any).withMiniProgram = async (
    _log: unknown,
    _options: unknown,
    handler: any
  ) => handler(miniProgram, { mode: "connect" });
  const tool = toolByName(createApplicationTools(manager), "mp_pollUntil");
  const startedAt = Date.now();

  const result = await tool.execute(
    {
      predicate: "predicate",
      action: "action",
      timeoutMs: 10,
      pollIntervalMs: 1,
    },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(result.isError, true);
  assert.equal(payload.matched, true);
  assert.equal(payload.actionRan, false);
  assert.match(payload.actionError, /REQUEST_TIMEOUT/);
  // 核心契约由 actionRan===false + REQUEST_TIMEOUT 证明；墙钟上界放宽以免重载 CI 抖动误判。
  assert.ok(Date.now() - startedAt < 200);
});

test("mp_pollUntil rejects snapshotAfterMs without snapshotPaths", async () => {
  const tool = toolByName(createApplicationTools({} as any), "mp_pollUntil");

  const result = await tool.execute(
    {
      predicate: "predicate",
      snapshotAfterMs: 10,
    },
    context
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /snapshotAfterMs requires/);
});

test("page assertions and snapshots do not turn query failures into empty success", async () => {
  let page: any = { $$: async () => null };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const tools = createPageTools(manager as any);

  const count = await toolByName(tools, "page_expectCount").execute(
    { selector: "#x", expected: 0 },
    context
  );
  const gone = await toolByName(tools, "page_waitElementGone").execute(
    { selector: "#x", timeout: 100, retryInterval: 10 },
    context
  );

  page = {
    path: "pages/a",
    query: {},
    $$: async () => {
      throw new Error("query failed");
    },
  };
  const snapshot = await toolByName(tools, "page_snapshot").execute(
    { selectors: ["#x"] },
    context
  );

  assert.equal(count.isError, true);
  assert.equal(gone.isError, true);
  assert.equal(snapshot.isError, true);
});

test("page and scenario snapshots reject missing element-query capability", async () => {
  const page = { path: "pages/a", query: {} };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_snapshot"
  ).execute({ selectors: ["#x"] }, context);
  const scenarioResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute({ steps: [{ type: "snapshot", selectors: ["#x"] }] }, context);

  assert.equal(pageResult.isError, true);
  assert.equal(parseTextResult(scenarioResult).ok, false);
});

test("text assertion propagates element.text failures", async () => {
  const page = {
    $: async () => ({
      text: async () => {
        throw new Error("read failed");
      },
    }),
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
  };
  const tool = toolByName(createPageTools(manager as any), "page_expectElementText");

  const result = await tool.execute(
    { selector: "#x", expected: "" },
    context
  );

  assert.equal(result.isError, true);
});

test("element resolution reports SDK query failures as MCP errors", async () => {
  let page: any = {
    $: async () => {
      throw new Error("page query exploded");
    },
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
  };

  const direct = await toolByName(
    createPageTools(manager as any),
    "page_getElement"
  ).execute({ selector: "#x" }, context);

  page = {
    $: async () => null,
    $$: async () => null,
  };
  const indexed = await toolByName(
    createPageTools(manager as any),
    "page_getElement"
  ).execute({ selector: "#x[index=0]" }, context);

  page = {
    $: async () => ({
      $: async () => {
        throw new Error("inner query exploded");
      },
    }),
  };
  const inner = await toolByName(
    createElementTools(manager as any),
    "element_getStyles"
  ).execute(
    { selector: "#component", innerSelector: ".item", names: ["color"] },
    context
  );

  for (const result of [direct, indexed, inner]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /查询/);
  }
});

test("element summaries and named reads reject total SDK read failures", async () => {
  const element = {
    text: async () => {
      throw new Error("connection closed");
    },
    value: async () => {
      throw new Error("connection closed");
    },
    style: async () => {
      throw new Error("connection closed");
    },
    attribute: async () => {
      throw new Error("connection closed");
    },
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ $: async () => element }),
  };

  const summary = await toolByName(
    createPageTools(manager as any),
    "page_getElement"
  ).execute({ selector: "#x" }, context);
  const styles = await toolByName(
    createElementTools(manager as any),
    "element_getStyles"
  ).execute({ selector: "#x", names: ["color", "fontSize"] }, context);
  const attributes = await toolByName(
    createElementTools(manager as any),
    "element_getAttributes"
  ).execute({ selector: "#x", names: ["class", "id"] }, context);

  assert.equal(summary.isError, true);
  assert.equal(styles.isError, true);
  assert.equal(attributes.isError, true);
});

test("scenario assertions and snapshots fail instead of accepting query errors", async () => {
  const page = {
    path: "pages/a",
    query: {},
    $: async () => ({
      text: async () => {
        throw new Error("read failed");
      },
    }),
    $$: async () => null,
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_runScenario");

  const result = await tool.execute(
    {
      stopOnFailure: false,
      steps: [
        { type: "expectCount", selector: "#x", expected: 0 },
        { type: "expectText", selector: "#x", expected: "" },
        { type: "snapshot", selectors: ["#x"] },
      ],
    },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(payload.ok, false);
  assert.equal(payload.failedSteps, 3);
});

test("scenario assertions support innerSelector inside components", async () => {
  const label = { text: async () => "ready" };
  const items = [{}, {}];
  const component = {
    $: async (selector: string) => selector === ".label" ? label : null,
    $$: async (selector: string) => selector === ".item" ? items : [],
  };
  const page = {
    $: async (selector: string) => selector === "#component" ? component : null,
    $$: async () => [],
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute(
    {
      steps: [
        {
          type: "expectVisible",
          selector: "#component",
          innerSelector: ".item",
        },
        {
          type: "expectCount",
          selector: "#component",
          innerSelector: ".item",
          expected: 2,
        },
        {
          type: "expectText",
          selector: "#component",
          innerSelector: ".label",
          expected: "ready",
        },
      ],
    },
    context
  );

  const payload = parseTextResult(result);
  assert.equal(payload.ok, true);
  assert.equal(payload.passedSteps, 3);
});

test("setData tools reject oversized update batches before opening a page", async () => {
  let pageCalls = 0;
  const manager = {
    withPage: async () => {
      pageCalls += 1;
      throw new Error("must not open a page");
    },
  };
  const data = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`key${index}`, index])
  );

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_setData"
  ).execute({ data }, context);
  const elementResult = await toolByName(
    createElementTools(manager as any),
    "element_setData"
  ).execute({ selector: "#component", data }, context);

  assert.equal(pageResult.isError, true);
  assert.equal(elementResult.isError, true);
  assert.equal(pageCalls, 0);
});

test("standalone tools return SDK operation failures as MCP errors", async () => {
  const element = {
    $: async () => {
      throw new Error("inner query exploded");
    },
    $$: async () => {
      throw new Error("inner array query exploded");
    },
    wxml: async () => {
      throw new Error("wxml exploded");
    },
    scrollTo: async () => {
      throw new Error("scroll exploded");
    },
    data: async () => {
      throw new Error("element data exploded");
    },
  };
  const page = {
    path: "pages/a",
    query: {},
    $: async () => element,
    $$: async () => {
      throw new Error("page query exploded");
    },
    setData: async () => {
      throw new Error("page setData exploded");
    },
    data: async () => {
      throw new Error("page data exploded");
    },
  };
  const pageManager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const appManager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        callWxMethod: async () => {
          throw new Error("wx call exploded");
        },
      }),
  };

  const results = [
    await toolByName(createPageTools(pageManager as any), "page_getElements").execute(
      { selector: "#x" },
      context
    ),
    await toolByName(createPageTools(pageManager as any), "page_setData").execute(
      { data: { ready: true } },
      context
    ),
    await toolByName(createPageTools(pageManager as any), "page_getData").execute(
      {},
      context
    ),
    await toolByName(createPageTools(pageManager as any), "page_expectData").execute(
      { path: "ready", expected: true },
      context
    ),
    await toolByName(createPageTools(pageManager as any), "page_snapshot").execute(
      { withData: true },
      context
    ),
    await toolByName(
      createElementTools(pageManager as any),
      "element_getInnerElement"
    ).execute({ selector: "#x", targetSelector: ".item" }, context),
    await toolByName(
      createElementTools(pageManager as any),
      "element_getInnerElements"
    ).execute({ selector: "#x", targetSelector: ".item" }, context),
    await toolByName(createElementTools(pageManager as any), "element_getWxml").execute(
      { selector: "#x" },
      context
    ),
    await toolByName(createElementTools(pageManager as any), "element_scrollTo").execute(
      { selector: "#x", x: 0, y: 100 },
      context
    ),
    await toolByName(createElementTools(pageManager as any), "element_getData").execute(
      { selector: "#x" },
      context
    ),
    await toolByName(createApplicationTools(appManager as any), "mp_callWx").execute(
      { method: "getSystemInfo" },
      context
    ),
  ];

  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exploded/);
  }
});

test("scenario stops after the overall budget expires even when stopOnFailure=false", async () => {
  let attempts = 0;
  const manager = {
    withRequestTimeout: async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 8));
      throw new Error("scenario step timed out");
    },
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_runScenario");

  const result = await tool.execute(
    {
      stopOnFailure: false,
      scenarioTimeoutMs: 5,
      steps: [
        { type: "expectRoute", path: "pages/a" },
        { type: "expectRoute", path: "pages/b" },
        { type: "expectRoute", path: "pages/c" },
      ],
    },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(attempts, 1);
  assert.equal(payload.executedSteps, 1);
  assert.equal(payload.failedSteps, 1);
});

test("scenario navigateBack does not require a dummy path", async () => {
  const manager = {
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        navigateBack: async () => ({ path: "pages/previous", query: {} }),
      }),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_runScenario");

  const result = await tool.execute(
    { steps: [{ type: "navigate", transition: "navigateBack" }] },
    context
  );

  assert.equal(parseTextResult(result).ok, true);
});

test("switchTab rejects query parameters before opening a session", async () => {
  let openedSessions = 0;
  const manager = {
    withMiniProgram: async () => {
      openedSessions += 1;
      throw new Error("should not open a session");
    },
  };
  const tools = createApplicationTools(manager as any);

  const direct = await toolByName(tools, "mp_navigate").execute(
    {
      path: "pages/tab/index",
      transition: "switchTab",
      query: { id: "1" },
    },
    context
  );
  const scenario = await toolByName(tools, "mp_runScenario").execute(
    {
      steps: [
        {
          type: "navigate",
          path: "pages/tab/index",
          transition: "switchTab",
          query: { id: "1" },
        },
      ],
    },
    context
  );

  assert.equal(direct.isError, true);
  assert.equal(scenario.isError, true);
  assert.match(direct.content[0].text, /switchTab does not support query/);
  assert.match(scenario.content[0].text, /switchTab does not support query/);
  assert.equal(openedSessions, 0);
});

test("mp_currentPage reports requested data read failures", async () => {
  const page = {
    path: "pages/a",
    query: {},
    size: async () => ({ width: 100, height: 100 }),
    scrollTop: async () => 0,
    data: async () => {
      throw new Error("data read failed");
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_currentPage");

  const result = await tool.execute({ withData: true }, context);

  assert.equal(result.isError, true);
});

test("serialization handles cycles and deep equality ignores object key order", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  assert.deepEqual(toSerializableValue(cyclic), { self: "[Circular]" });
  assert.equal(
    areSerializableValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }),
    true
  );
});

test("waitOnPage falls back to a real delay when page.waitFor is unavailable", async () => {
  const startedAt = Date.now();
  await waitOnPage({}, 20);
  assert.ok(Date.now() - startedAt >= 10);
});

test("serialization degrades invalid dates and throwing getters instead of crashing", () => {
  const throwing = {};
  Object.defineProperty(throwing, "value", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });

  assert.equal(toSerializableValue(new Date(Number.NaN)), "Invalid Date");
  assert.match(String(toSerializableValue(throwing)), /Unserializable: getter exploded/);
});

test("serialization normalizes non-JSON numbers consistently", () => {
  assert.deepEqual(toSerializableValue({
    nan: Number.NaN,
    positiveInfinity: Number.POSITIVE_INFINITY,
    negativeInfinity: Number.NEGATIVE_INFINITY,
    negativeZero: -0,
  }), {
    nan: "NaN",
    positiveInfinity: "Infinity",
    negativeInfinity: "-Infinity",
    negativeZero: 0,
  });
  assert.equal(areSerializableValuesEqual(Number.NaN, null), false);
  assert.equal(areSerializableValuesEqual(-0, 0), true);
});

test("page and scenario data assertions ignore object key insertion order", async () => {
  const page = {
    data: async () => ({ b: 2, a: 1 }),
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const expected = { a: 1, b: 2 };
  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_expectData"
  ).execute({ path: "value", expected }, context);
  const scenarioResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute(
    { steps: [{ type: "expectData", path: "value", expected }] },
    context
  );

  assert.equal(parseTextResult(pageResult).pass, true);
  assert.equal(parseTextResult(scenarioResult).ok, true);
});

test("page and scenario data assertions reject a missing expected value", async () => {
  const page = {
    data: async () => 123,
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_expectData"
  ).execute({ path: "value" }, context);
  const scenarioResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute({ steps: [{ type: "expectData", path: "value" }] }, context);

  assert.equal(pageResult.isError, true);
  assert.equal(scenarioResult.isError, true);
  assert.match(pageResult.content[0].text, /expected is required/);
});

test("input tools reject booleans instead of coercing them to 0 or 1", async () => {
  const elementResult = await toolByName(
    createElementTools({} as any),
    "element_input"
  ).execute({ selector: "#input", value: false }, context);
  const scenarioResult = await toolByName(
    createApplicationTools({} as any),
    "mp_runScenario"
  ).execute(
    { steps: [{ type: "input", selector: "#input", value: false }] },
    context
  );

  assert.equal(elementResult.isError, true);
  assert.equal(scenarioResult.isError, true);
});

test("numeric tool parameters reject booleans, null, and blank strings", async () => {
  const results = [
    await toolByName(createPageTools({} as any), "page_waitTimeout").execute(
      { milliseconds: false },
      context
    ),
    await toolByName(createPageTools({} as any), "page_expectCount").execute(
      { selector: "#x", expected: null },
      context
    ),
    await toolByName(createElementTools({} as any), "element_scrollTo").execute(
      { selector: "#x", x: "", y: 10 },
      context
    ),
    await toolByName(createApplicationTools({} as any), "mp_screenshot").execute(
      { timeoutMs: true },
      context
    ),
    await toolByName(createApplicationTools({} as any), "mp_runScenario").execute(
      {
        scenarioTimeoutMs: " ",
        steps: [{ type: "expectRoute", path: "pages/a" }],
      },
      context
    ),
  ];

  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid parameters/);
  }
});

test("tools reject unknown or ignored parameters before opening a session", async () => {
  let sessionCalls = 0;
  let projectScans = 0;
  const manager = {
    withMiniProgram: async () => {
      sessionCalls += 1;
      throw new Error("must not open a session");
    },
    withPage: async () => {
      sessionCalls += 1;
      throw new Error("must not open a page");
    },
    listRecentProjects: async () => {
      projectScans += 1;
      return [];
    },
  };
  const applicationTools = createApplicationTools(manager as any);
  const pageTools = createPageTools(manager as any);

  const results = [
    await toolByName(pageTools, "page_waitTimeout").execute(
      { milliseconds: 1, millisecond: 1 },
      context
    ),
    await toolByName(applicationTools, "mp_navigate").execute({}, context),
    await toolByName(applicationTools, "mp_navigate").execute(
      { transition: "navigateBack", path: "pages/ignored" },
      context
    ),
    await toolByName(applicationTools, "mp_pollUntil").execute(
      { predicate: "predicate", actionArgs: [] },
      context
    ),
    await toolByName(pageTools, "page_snapshot").execute(
      { selectors: [".item"], withElements: false },
      context
    ),
    await toolByName(applicationTools, "mp_runScenario").execute(
      {
        steps: [
          {
            type: "snapshot",
            selectors: [".item"],
            withElements: false,
            ignored: true,
          },
        ],
      },
      context
    ),
    await toolByName(applicationTools, "mp_listProjects").execute(
      { ignored: true },
      context
    ),
  ];

  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid parameters/);
  }
  assert.equal(sessionCalls, 0);
  assert.equal(projectScans, 0);
});

test("navigation caps query entries before opening a session", async () => {
  const query = Object.fromEntries(
    Array.from({ length: 101 }, (_, index) => [`key-${index}`, String(index)])
  );
  const result = await toolByName(
    createApplicationTools({} as any),
    "mp_navigate"
  ).execute({ path: "pages/a", query }, context);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /query must contain at most 100 entries/);
});

test("navigation and page timeout honor waits without page.waitFor", async () => {
  const miniProgram = {
    navigateTo: async () => undefined,
    currentPage: async () => ({ path: "pages/a", query: {} }),
  };
  const navigateManager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const pageManager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({}),
  };

  let startedAt = Date.now();
  const navigateResult = await toolByName(
    createApplicationTools(navigateManager as any),
    "mp_navigate"
  ).execute({ path: "pages/a", waitMs: 20 }, context);
  assert.ok(Date.now() - startedAt >= 10);
  assert.equal(navigateResult.isError, undefined);

  startedAt = Date.now();
  const waitResult = await toolByName(
    createPageTools(pageManager as any),
    "page_waitTimeout"
  ).execute({ milliseconds: 20 }, context);
  assert.ok(Date.now() - startedAt >= 10);
  assert.equal(waitResult.isError, undefined);
});

test("route waiters tolerate transient currentPage failures", async () => {
  let pageCalls = 0;
  const miniProgram = {
    currentPage: async () => {
      pageCalls += 1;
      if (pageCalls === 1 || pageCalls === 3) {
        throw new Error("transient route read failure");
      }
      return { path: "pages/ready", query: { ok: "1" } };
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_waitRoute"
  ).execute(
    { path: "pages/ready", timeout: 100, retryInterval: 1 },
    context
  );
  const scenarioResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute(
    {
      steps: [
        {
          type: "waitRoute",
          path: "pages/ready",
          timeout: 100,
          retryInterval: 1,
        },
      ],
    },
    context
  );

  assert.equal(parseTextResult(pageResult).matched, true);
  assert.equal(parseTextResult(scenarioResult).ok, true);
});

test("waiters do not sleep past their remaining timeout budget", async () => {
  const page = {
    $$: async () => [],
  };
  const miniProgram = {
    currentPage: async () => ({ path: "pages/not-ready", query: {} }),
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const startedAt = Date.now();

  const elementResult = await toolByName(
    createPageTools(manager as any),
    "page_waitElement"
  ).execute(
    { selector: "#ready", timeout: 5, retryInterval: 60000 },
    context
  );
  const routeResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute(
    {
      steps: [
        {
          type: "waitRoute",
          path: "pages/ready",
          timeout: 5,
          retryInterval: 60000,
        },
      ],
    },
    context
  );

  assert.equal(elementResult.isError, true);
  assert.equal(parseTextResult(routeResult).ok, false);
  assert.ok(Date.now() - startedAt < 500);
});

test("waiters bound hung SDK reads by their remaining timeout budget", async () => {
  const never = () => new Promise<never>(() => {});
  const manager = new WeappAutomatorManager();
  (manager as any).withPage = async (
    _log: unknown,
    _options: unknown,
    handler: any
  ) => handler({ $$: never });
  (manager as any).withMiniProgram = async (
    _log: unknown,
    _options: unknown,
    handler: any
  ) => handler({ currentPage: never }, { mode: "connect" });
  const startedAt = Date.now();

  const elementResult = await toolByName(
    createPageTools(manager),
    "page_waitElement"
  ).execute(
    { selector: "#ready", timeout: 5, retryInterval: 1 },
    context
  );
  const routeResult = await toolByName(
    createApplicationTools(manager),
    "mp_runScenario"
  ).execute(
    {
      steps: [
        {
          type: "waitRoute",
          path: "pages/ready",
          timeout: 5,
          retryInterval: 1,
        },
      ],
    },
    context
  );

  assert.equal(elementResult.isError, true);
  assert.equal(parseTextResult(routeResult).ok, false);
  assert.ok(Date.now() - startedAt < 500);
});

test("reachable remote websocket is not rejected by a localhost port probe", async () => {
  const manager = new WeappAutomatorManager();
  let probedHost: string | null = null;
  (manager as any).isPortInUse = async (_port: number, host: string) => {
    probedHost = host;
    return false;
  };
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: true, error: null });
  (manager as any).isDevToolsProcessRunning = async () => false;

  const diagnosis = await manager.diagnoseConnection(
    { mode: "connect", wsEndpoint: "ws://10.0.0.8:9420", args: undefined },
    { strictMode: false }
  );

  assert.equal(probedHost, "10.0.0.8");
  assert.equal(diagnosis.websocketReachable, true);
  assert.equal(diagnosis.portListening, true);
  assert.equal(diagnosis.reasonCode, null);
});

test("an invalid websocket URL is rejected without probing a fallback port", async () => {
  const manager = new WeappAutomatorManager();
  let portProbes = 0;
  let websocketProbes = 0;
  (manager as any).isPortInUse = async () => {
    portProbes += 1;
    return false;
  };
  (manager as any).probeWebSocketEndpoint = async () => {
    websocketProbes += 1;
    return { ok: false, error: "invalid" };
  };
  (manager as any).isDevToolsProcessRunning = async () => false;

  const diagnosis = await manager.diagnoseConnection(
    { mode: "connect", wsEndpoint: "not-a-url", args: undefined },
    { strictMode: false }
  );

  assert.equal(diagnosis.reasonCode, "INVALID_WS_ENDPOINT");
  assert.equal(diagnosis.port, null);
  assert.equal(portProbes, 0);
  assert.equal(websocketProbes, 0);
});

test("IPv6 loopback websocket is treated as local and probed without brackets", async () => {
  const manager = new WeappAutomatorManager();
  let probedHost: string | null = null;
  (manager as any).isPortInUse = async (_port: number, host: string) => {
    probedHost = host;
    return false;
  };
  (manager as any).probeWebSocketEndpoint = async () => ({
    ok: false,
    error: "ECONNREFUSED",
  });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;

  const diagnosis = await manager.diagnoseConnection(
    { mode: "connect", wsEndpoint: "ws://[::1]:9420", args: undefined },
    { strictMode: false }
  );

  assert.equal(probedHost, "::1");
  assert.equal(diagnosis.recoverableByEnsure, true);
});

test("diagnostic probes cap the real connection timeout to five seconds", async () => {
  const manager = new WeappAutomatorManager();
  const probeTimeouts: number[] = [];
  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async (_endpoint: string, timeout: number) => {
    probeTimeouts.push(timeout);
    return { ok: false, error: "ECONNREFUSED" };
  };
  (manager as any).probeHttpEndpoint = async (_endpoint: string, timeout: number) => {
    probeTimeouts.push(timeout);
    return {
      ok: false,
      statusCode: null,
      bodySnippet: null,
      error: "ECONNREFUSED",
    };
  };
  (manager as any).isDevToolsProcessRunning = async () => false;

  await manager.diagnoseConnection(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      connectTimeout: 600000,
      autoLaunch: false,
      args: undefined,
    },
    { strictMode: false }
  );

  assert.deepEqual(probeTimeouts, [5000, 5000]);
});

test("HTTP diagnostic probe has an absolute deadline for streaming responses", async () => {
  const originalRequest = http.request;
  let streamTimer: NodeJS.Timeout | null = null;
  (http as any).request = (
    _options: unknown,
    onResponse: (response: EventEmitter & { statusCode: number }) => void
  ) => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      end: () => void;
    };
    request.destroy = () => {
      if (streamTimer) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
    };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200 });
      onResponse(response);
      streamTimer = setInterval(() => response.emit("data", Buffer.from("x")), 5);
    };
    return request;
  };
  syncBuiltinESMExports();
  const manager = new WeappAutomatorManager();
  const startedAt = Date.now();

  try {
    const result = await (manager as any).probeHttpEndpoint(
      "ws://127.0.0.1:9420",
      30
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP probe timeout/);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    if (streamTimer) {
      clearInterval(streamTimer);
    }
    (http as any).request = originalRequest;
    syncBuiltinESMExports();
  }
});

test("port startup waits do not run past their remaining budget", async () => {
  const manager = new WeappAutomatorManager();
  const probeBudgets: number[] = [];
  (manager as any).tryConnectPort = async (
    _port: number,
    _host: string,
    timeoutMs: number
  ) => {
    probeBudgets.push(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return false;
  };
  const startedAt = Date.now();

  const listening = await (manager as any).waitForPortListening(9420, 20);

  assert.equal(listening, false);
  assert.ok(probeBudgets.length >= 1);
  assert.ok(probeBudgets.every((budget) => budget > 0 && budget <= 20));
  assert.ok(Date.now() - startedAt < 150);
});

test("autoLaunch=false prevents local connect-mode cli auto", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => ({
    ok: false,
    error: "ECONNREFUSED",
  });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;
  (manager as any).launchDevTools = async () => {
    throw new Error("must not launch");
  };

  await assert.rejects(
    () =>
      manager.withMiniProgram(
        logger,
        {
          overrides: {
            mode: "connect",
            wsEndpoint: "ws://127.0.0.1:9420",
            autoLaunch: false,
            args: undefined,
          },
        },
        async () => null
      ),
    /PORT_NOT_LISTENING_AUTOLAUNCH_DISABLED/
  );
});

test("auto-launch skips a stale persisted project and falls back to a valid cwd", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).getDefaultProject = async () => "/stale/project";
  (manager as any).isValidWeappProject = async (candidate: string) =>
    candidate === process.cwd();

  const resolved = await (manager as any).resolveAutoLaunchProjectPath({
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  });

  assert.deepEqual(resolved, { path: process.cwd(), source: "cwd" });
});

test("launch mode resolves a valid current working directory before project selection", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).diagnoseConnection = async () => ({
    reasonCode: "PROJECT_NOT_OPENED",
  });
  (manager as any).getDefaultProject = async () => null;
  (manager as any).isValidWeappProject = async (candidate: string) =>
    candidate === process.cwd();
  (manager as any).listRecentProjects = async () => {
    throw new Error("must not scan recent projects when cwd is valid");
  };
  (manager as any).isConnectionAlive = async () => false;
  (manager as any).close = async () => {};
  (manager as any).attachLogging = () => {};
  (manager as any).connect = async () => ({ currentPage: async () => null });

  const projectPath = await manager.withMiniProgram(
    logger,
    { overrides: { mode: "launch", args: undefined } },
    async (_program, config) => config.projectPath
  );

  assert.equal(projectPath, process.cwd());
});

test("empty project selection guidance only recommends supported recovery inputs", () => {
  const manager = new WeappAutomatorManager();
  const message = (manager as any).formatProjectSelectionResponse([], null);
  const oneProject = (manager as any).formatProjectSelectionResponse(
    [{ path: "/projects/one", name: "one" }],
    null
  );
  const defaultProject = (manager as any).formatProjectSelectionResponse(
    [],
    "/projects/default"
  );

  assert.match(message, /PROJECT_LIST_EMPTY/);
  assert.match(message, /connection\.projectPath/);
  assert.match(message, /WEAPP_PROJECT_PATH/);
  for (const guidance of [message, oneProject, defaultProject]) {
    assert.doesNotMatch(guidance, /帮我打开开发者工具|请选择操作：|A\./);
  }
});

test("recent project parsing skips malformed candidates without throwing", () => {
  const manager = new WeappAutomatorManager();
  const normalize = (value: unknown, fallbackPath?: string) =>
    (manager as any).normalizeRecentProjectCandidate(value, fallbackPath);

  assert.equal(normalize({ projectPath: 123, projectName: 456 }), null);
  assert.equal(normalize(null), null);
  assert.deepEqual(normalize("/projects/string"), {
    path: "/projects/string",
    name: "string",
  });
  assert.deepEqual(
    normalize({ projectName: "Fallback Name" }, "/projects/fallback"),
    {
      path: "/projects/fallback",
      name: "Fallback Name",
    }
  );
  assert.deepEqual(
    normalize({ appid: "wx-test" }, "/projects/key-only"),
    {
      path: "/projects/key-only",
      name: "key-only",
    }
  );
  assert.deepEqual(
    normalize({ path: "/projects/object", name: "Object Name" }),
    {
      path: "/projects/object",
      name: "Object Name",
    }
  );
});

test("project discovery rejects oversized project config files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-large-project-config-"));
  const manager = new WeappAutomatorManager();

  try {
    await writeFile(
      join(tempDir, "project.config.json"),
      JSON.stringify({ appid: "wx-test", padding: "x".repeat(1024 * 1024) })
    );

    assert.equal(await (manager as any).isValidWeappProject(tempDir), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("concurrent first-use calls share one automator connection setup", async () => {
  const manager = new WeappAutomatorManager();
  let connects = 0;
  const fakeMiniProgram = { id: 1 };
  (manager as any).diagnoseConnection = async () => ({ reasonCode: null });
  (manager as any).isConnectionAlive = async () => Boolean((manager as any).miniProgram);
  (manager as any).close = async () => {};
  (manager as any).attachLogging = () => {};
  (manager as any).connectWithTimeout = async () => {
    connects += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return fakeMiniProgram;
  };
  const options = {
    overrides: {
      mode: "connect" as const,
      wsEndpoint: "ws://127.0.0.1:9420",
      args: undefined,
    },
  };

  const values = await Promise.all([
    manager.withMiniProgram(logger, options, async (program: any) => program.id),
    manager.withMiniProgram(logger, options, async (program: any) => program.id),
  ]);

  assert.equal(connects, 1);
  assert.deepEqual(values, [1, 1]);
});

test("connect session reuse ignores non-identity runtime options", async () => {
  const manager = new WeappAutomatorManager();
  const fakeMiniProgram = { id: 1 };
  (manager as any).miniProgram = fakeMiniProgram;
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
    projectPath: "/projects/old",
    autoClose: false,
    timeout: 1000,
  };
  (manager as any).isConnectionAlive = async () => true;
  (manager as any).attachLogging = () => {};
  (manager as any).diagnoseConnection = async () => {
    throw new Error("must reuse the active endpoint");
  };

  const result = await manager.withMiniProgram(
    logger,
    {
      overrides: {
        mode: "connect",
        wsEndpoint: "ws://127.0.0.1:9420",
        projectPath: "/projects/current",
        autoClose: false,
        timeout: 2000,
        args: undefined,
      },
    },
    async (program: any) => program.id
  );

  assert.equal(result, 1);
  assert.equal((manager as any).config.projectPath, "/projects/current");
  assert.equal((manager as any).config.timeout, 2000);
});

test("connection failure diagnosis uses the resolved effective project", async () => {
  const manager = new WeappAutomatorManager();
  const diagnosisOverrides: any[] = [];
  (manager as any).diagnoseConnection = async (overrides: any) => {
    diagnosisOverrides.push(overrides);
    return diagnosisOverrides.length === 1
      ? { reasonCode: "PROJECT_NOT_OPENED" }
      : { reasonCode: null };
  };
  (manager as any).getDefaultProject = async () => "/projects/resolved";
  (manager as any).isValidWeappProject = async () => true;
  (manager as any).isConnectionAlive = async () => false;
  (manager as any).close = async () => {};
  (manager as any).connect = async () => {
    throw new Error("launch failed");
  };

  await assert.rejects(
    () =>
      manager.withMiniProgram(
        logger,
        { overrides: { mode: "launch", args: undefined } },
        async () => null
      ),
    /LAUNCH_MODE_FAILED/
  );

  assert.equal(diagnosisOverrides.at(-1).projectPath, "/projects/resolved");
});

test("connect identity normalizes equivalent endpoint spellings", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = { id: 1 };
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).isConnectionAlive = async () => true;
  (manager as any).attachLogging = () => {};
  (manager as any).diagnoseConnection = async () => {
    throw new Error("must reuse the equivalent endpoint");
  };

  const result = await manager.withMiniProgram(
    logger,
    {
      overrides: {
        mode: "connect",
        wsEndpoint: "ws://127.0.0.1:9420/",
        args: undefined,
      },
    },
    async (program: any) => program.id
  );

  assert.equal(result, 1);
  assert.equal(
    (manager as any).getLogTargetKeyForConfig({
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
    }),
    (manager as any).getLogTargetKeyForConfig({
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420/",
    })
  );
});

test("launch session reuse treats an omitted port as the default port", async () => {
  const manager = new WeappAutomatorManager();
  const fakeMiniProgram = { id: 1 };
  (manager as any).miniProgram = fakeMiniProgram;
  (manager as any).config = {
    mode: "launch",
    projectPath: "/tmp/project",
  };
  (manager as any).isConnectionAlive = async () => true;
  (manager as any).attachLogging = () => {};
  (manager as any).diagnoseConnection = async () => {
    throw new Error("must reuse the active launch target");
  };

  const result = await manager.withMiniProgram(
    logger,
    {
      overrides: {
        mode: "launch",
        projectPath: "/tmp/project",
        port: 9420,
        args: undefined,
      },
    },
    async (program: any) => program.id
  );

  assert.equal(result, 1);
});

test("launch session reuse normalizes equivalent project paths", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = { id: 1 };
  (manager as any).config = {
    mode: "launch",
    projectPath: process.cwd(),
  };
  (manager as any).isConnectionAlive = async () => true;
  (manager as any).attachLogging = () => {};
  (manager as any).diagnoseConnection = async () => {
    throw new Error("must reuse the equivalent project path");
  };

  const result = await manager.withMiniProgram(
    logger,
    {
      overrides: {
        mode: "launch",
        projectPath: ".",
        args: undefined,
      },
    },
    async (program: any) => program.id
  );

  assert.equal(result, 1);
});

test("autoClose waits for concurrent session users before closing", async () => {
  const manager = new WeappAutomatorManager();
  const events: string[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  (manager as any).ensureMiniProgramSession = async () => ({
    miniProgram: {},
    config: { mode: "connect", autoClose: true },
  });
  (manager as any).close = async () => {
    events.push("close");
  };

  const first = manager.withMiniProgram(logger, {}, async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = manager.withMiniProgram(logger, {}, async () => {
    events.push("second-start");
    await secondGate;
    events.push("second-end");
  });
  await new Promise((resolve) => setTimeout(resolve, 5));

  releaseFirst();
  await first;
  assert.deepEqual(events, ["first-start", "second-start", "first-end"]);

  releaseSecond();
  await second;
  assert.deepEqual(events, [
    "first-start",
    "second-start",
    "first-end",
    "second-end",
    "close",
  ]);
});

test("reconnect does not close a session while another tool is using it", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = {};
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).activeSessionUsers = 1;

  await assert.rejects(
    manager.withMiniProgram(
      logger,
      {
        overrides: {
          mode: "connect",
          wsEndpoint: "ws://127.0.0.1:9420",
          args: undefined,
        },
        reconnect: true,
      },
      async () => null
    ),
    /\[CONNECTION_BUSY\]/
  );
});

test("a connection that arrives after timeout is disconnected", async () => {
  const manager = new WeappAutomatorManager();
  const originalConnect = automator.connect;
  let disconnected = 0;
  (automator as any).connect = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      disconnect: () => {
        disconnected += 1;
      },
    };
  };

  try {
    await assert.rejects(
      () =>
        (manager as any).connectWithTimeout(
          { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" },
          5
        ),
      /Connection timeout/
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disconnected, 1);
  } finally {
    (automator as any).connect = originalConnect;
  }
});

test("closing a stuck launch session is bounded and still clears local state", async () => {
  const manager = new WeappAutomatorManager();
  let removedListeners = 0;
  (manager as any).miniProgram = {
    close: async () => new Promise(() => {}),
    removeAllListeners: () => {
      removedListeners += 1;
    },
  };
  (manager as any).config = { mode: "launch", projectPath: "/tmp/project" };
  (manager as any).closeTimeoutMs = 5;
  (manager as any).persistStateMeta = async () => {};

  await manager.close(logger);

  assert.equal((manager as any).miniProgram, undefined);
  assert.equal(removedListeners, 1);
});

test("listener cleanup failures do not keep a closed session locally active", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = {
    disconnect: () => {},
    removeAllListeners: () => {
      throw new Error("listener cleanup failed");
    },
  };
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).persistStateMeta = async () => {};

  await manager.close(logger);

  assert.equal((manager as any).miniProgram, undefined);
  assert.equal((manager as any).config, undefined);
});

test("logging attachment failures do not report a listener online", async () => {
  const manager = new WeappAutomatorManager();
  let cleanupCalls = 0;
  const miniProgram = {
    on: () => {
      throw new Error("listener bind failed");
    },
    removeAllListeners: () => {
      cleanupCalls += 1;
    },
  };

  await assert.rejects(
    () => (manager as any).attachLogging(miniProgram, logger),
    /listener bind failed/
  );
  assert.equal((manager as any).listenerAttached, false);
  assert.equal((manager as any).sessionId, null);
  assert.equal((manager as any).loggingAttachedProgram, undefined);
  assert.equal(cleanupCalls, 1);
});

test("logging attachment explicitly waits for App.enableLog", async () => {
  const manager = new WeappAutomatorManager();
  const miniProgram = new EventEmitter() as EventEmitter & {
    on: () => never;
    send: (method: string) => Promise<void>;
  };
  const methods: string[] = [];
  miniProgram.on = () => {
    throw new Error("SDK on override must not be used");
  };
  miniProgram.send = async (method: string) => {
    methods.push(method);
  };
  (manager as any).persistStateMeta = async () => {};

  await (manager as any).attachLogging(miniProgram, logger);

  assert.deepEqual(methods, ["App.enableLog"]);
  assert.equal(miniProgram.listenerCount("console"), 1);
  assert.equal(miniProgram.listenerCount("exception"), 1);
  assert.equal((manager as any).listenerAttached, true);
});

test("new sessions are disconnected when logging attachment fails", async () => {
  const manager = new WeappAutomatorManager();
  let disconnectCalls = 0;
  const miniProgram = {
    on: () => {
      throw new Error("listener bind failed");
    },
    disconnect: () => {
      disconnectCalls++;
    },
    removeAllListeners: () => {},
  };
  (manager as any).diagnoseConnection = async () => ({ reasonCode: null });
  (manager as any).isConnectionAlive = async () => false;
  (manager as any).connectWithTimeout = async () => miniProgram;
  (manager as any).persistStateMeta = async () => {};

  await assert.rejects(
    () =>
      manager.withMiniProgram(
        logger,
        {
          overrides: {
            mode: "connect",
            wsEndpoint: "ws://127.0.0.1:9420",
            args: undefined,
          },
        },
        async () => null
      ),
    /CONNECT_MODE_FAILED.*listener bind failed/s
  );

  assert.equal(disconnectCalls, 1);
  assert.equal((manager as any).miniProgram, undefined);
  assert.equal((manager as any).config, undefined);
});

test("connection diagnosis reuses a healthy matching session without a probe connection", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = {
    currentPage: async () => ({ path: "pages/a" }),
  };
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).isPortInUse = async () => false;
  (manager as any).isDevToolsProcessRunning = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => {
    throw new Error("must not open a second automator connection");
  };
  (manager as any).probeHttpEndpoint = async () => {
    throw new Error("must not fall back to HTTP");
  };

  const diagnosis = await manager.diagnoseConnection({
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
    args: undefined,
  });

  assert.equal(diagnosis.websocketReachable, true);
  assert.equal(diagnosis.looksLikeAutomatorWs, true);
  assert.equal(diagnosis.portListening, true);
});

test("healthy launch sessions are not diagnosed as duplicate-launch failures", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).miniProgram = {
    currentPage: async () => ({ path: "pages/a" }),
  };
  (manager as any).config = {
    mode: "launch",
    projectPath: "/tmp/project",
    port: 9420,
  };
  (manager as any).isValidWeappProject = async () => true;
  (manager as any).isPortInUse = async () => true;
  (manager as any).isDevToolsProcessRunning = async () => true;
  (manager as any).getDefaultProject = async () => "/tmp/project";
  (manager as any).probeWebSocketEndpoint = async () => {
    throw new Error("must not open a second automator connection");
  };

  const diagnosis = await manager.diagnoseConnection({
    mode: "launch",
    projectPath: "/tmp/project",
    port: 9420,
    args: undefined,
  });

  assert.equal(diagnosis.reasonCode, null);
  assert.equal(diagnosis.websocketReachable, true);
  assert.equal(diagnosis.safeToLaunch, false);
});

test("websocket probe cleanup failures do not hide a reachable endpoint", async () => {
  const manager = new WeappAutomatorManager();
  const originalConnect = automator.connect;
  (automator as any).connect = async () => ({
    disconnect: () => {
      throw new Error("disconnect cleanup failed");
    },
  });

  try {
    const result = await (manager as any).probeWebSocketEndpoint(
      "ws://127.0.0.1:9420",
      100
    );
    assert.deepEqual(result, { ok: true, error: null });
  } finally {
    (automator as any).connect = originalConnect;
  }
});

test("cli spawn errors are surfaced without waiting for the launch timeout", async (t) => {
  if (process.platform === "win32") {
    t.skip("invalid shebang spawn behavior is POSIX-specific");
    return;
  }
  const manager = new WeappAutomatorManager();
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-broken-cli-"));
  const cliPath = join(tempDir, "cli");
  await writeFile(cliPath, "#!/definitely/missing/interpreter\n");
  await chmod(cliPath, 0o755);
  const startedAt = Date.now();

  try {
    await assert.rejects(
      () =>
        (manager as any).launchDevTools(
          {
            mode: "connect",
            cliPath,
            projectPath: tempDir,
            port: 9420,
          },
          logger
        ),
      /Failed to spawn DevTools cli/
    );
    assert.ok(Date.now() - startedAt < 1500);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cli launch detaches stdio and stops waiting when the cli exits", async () => {
  const originalSpawn = childProcess.spawn;
  let spawnOptions: Record<string, unknown> | undefined;
  let stdoutUnrefCount = 0;
  let stderrUnrefCount = 0;
  let childUnrefCount = 0;
  (childProcess as any).spawn = (
    _command: string,
    _args: string[],
    options: Record<string, unknown>
  ) => {
    spawnOptions = options;
    const stdout = Object.assign(new EventEmitter(), {
      unref: () => {
        stdoutUnrefCount++;
      },
    });
    const stderr = Object.assign(new EventEmitter(), {
      unref: () => {
        stderrUnrefCount++;
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdout,
      stderr,
      unref: () => {
        childUnrefCount++;
      },
    });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  syncBuiltinESMExports();

  try {
    const manager = new WeappAutomatorManager();
    const startedAt = Date.now();
    await (manager as any).launchDevTools(
      {
        mode: "connect",
        cliPath: process.execPath,
        projectPath: tmpdir(),
        port: 9420,
      },
      logger
    );

    assert.ok(Date.now() - startedAt < 500);
    assert.deepEqual(spawnOptions?.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(stdoutUnrefCount, 1);
    assert.equal(stderrUnrefCount, 1);
    assert.equal(childUnrefCount, 1);
  } finally {
    (childProcess as any).spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});

test("serialized evaluate lane waits for a timed-out evaluate to settle", async () => {
  const manager = new WeappAutomatorManager();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = manager.runSerializedEvaluate(
    async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    },
    { timeoutMs: 5, description: "first evaluate" }
  );

  await assert.rejects(first, /\[REQUEST_TIMEOUT\]/);
  const second = manager.runSerializedEvaluate(async () => {
    events.push("second-start");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  await second;
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("queued evaluate timeout includes time spent waiting for the lane", async () => {
  const manager = new WeappAutomatorManager();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = manager.runSerializedEvaluate(
    async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    },
    { timeoutMs: 5, description: "first evaluate" }
  );

  await assert.rejects(first, /\[REQUEST_TIMEOUT\]/);
  await assert.rejects(
    manager.runSerializedEvaluate(
      async () => {
        events.push("second-start");
      },
      { timeoutMs: 5, description: "second evaluate" }
    ),
    /\[REQUEST_TIMEOUT\]/
  );
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await manager.runSerializedEvaluate(async () => {
    events.push("third-start");
  });
  assert.deepEqual(events, ["first-start", "first-end", "third-start"]);
});

test("serialized screenshot lane is released when acquisition logging throws", async () => {
  const manager = new WeappAutomatorManager();
  const events: string[] = [];
  const throwingLogger = {
    ...logger,
    info: () => {
      throw new Error("logger exploded");
    },
  };

  await assert.rejects(
    manager.runSerializedScreenshot(throwingLogger, async () => {
      events.push("first-start");
    }),
    /logger exploded/
  );
  await manager.runSerializedScreenshot(logger, async () => {
    events.push("second-start");
  });

  assert.deepEqual(events, ["second-start"]);
});

test("cross-manager persisted-state updates preserve both fields", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-state-lock-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  await writeFile(
    configFile,
    JSON.stringify({
      lastProjectPath: null,
      pendingProjects: [],
      consoleLogs: [],
      sessionId: null,
      listenerAttached: false,
      lastLogAt: null,
      lastListenerBindAt: null,
      logStoreMode: "persisted",
      sourceProjectPath: null,
      sessions: {},
    })
  );
  const first = new WeappAutomatorManager();
  const second = new WeappAutomatorManager();
  const originalRead = (first as any).readPersistedState.bind(first);
  (first as any).readPersistedState = async () => {
    const state = await originalRead();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return state;
  };

  try {
    const firstUpdate = (first as any).updatePersistedState((state: any) => {
      state.lastProjectPath = "/project-a";
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondUpdate = (second as any).updatePersistedState((state: any) => {
      state.pendingProjects = [{ path: "/project-b", name: "B" }];
    });
    await Promise.all([firstUpdate, secondUpdate]);

    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(persisted.lastProjectPath, "/project-a");
    assert.deepEqual(persisted.pendingProjects, [{ path: "/project-b", name: "B" }]);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("closing one persisted session does not mark another listener offline", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-session-state-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  const first = new WeappAutomatorManager();
  const second = new WeappAutomatorManager();
  (first as any).sessionId = "session-a";
  (first as any).listenerAttached = true;
  (second as any).sessionId = "session-b";
  (second as any).listenerAttached = true;

  try {
    await (first as any).persistStateMeta();
    await (second as any).persistStateMeta();
    (first as any).listenerAttached = false;
    await (first as any).persistStateMeta();

    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(persisted.listenerAttached, true);
    assert.equal(persisted.sessionId, "session-b");
    assert.equal(persisted.sessions["session-a"], undefined);
    assert.equal(persisted.sessions["session-b"].listenerAttached, true);
    assert.equal(persisted.sessions["session-b"].processId, process.pid);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("another persisted session does not mask the current listener state", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).sessionId = "current-session";
  (manager as any).listenerAttached = false;
  (manager as any).readPersistedState = async () => ({
    consoleLogs: [],
    listenerAttached: true,
    lastLogAt: 20,
    lastListenerBindAt: 10,
    sessionId: "other-session",
    sourceProjectPath: "/other-project",
    sessions: {
      "current-session": {
        listenerAttached: true,
        lastLogAt: 99,
        lastListenerBindAt: 98,
        sourceProjectPath: "/stale-current-project",
        updatedAt: 99,
      },
      "other-session": {
        listenerAttached: true,
        lastLogAt: 20,
        lastListenerBindAt: 10,
        sourceProjectPath: "/other-project",
        updatedAt: 20,
      },
    },
  });

  const status = await manager.getLogStatus();

  assert.equal(status.listenerAttached, false);
  assert.equal(status.sessionId, "current-session");
  assert.equal(status.sourceProjectPath, null);
  assert.equal(status.lastLogAt, null);
  assert.equal(status.lastListenerBindAt, null);
});

test("persisted sessions from dead processes do not report an active listener", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).readPersistedState = async () => ({
    consoleLogs: [],
    listenerAttached: true,
    lastLogAt: null,
    lastListenerBindAt: 10,
    sessionId: "dead-session",
    sourceProjectPath: "/dead-project",
    sessions: {
      "dead-session": {
        listenerAttached: true,
        lastLogAt: null,
        lastListenerBindAt: 10,
        sourceProjectPath: "/dead-project",
        sourceTarget: "connect:ws://127.0.0.1:9420",
        processId: 2_147_483_647,
        updatedAt: Date.now(),
      },
    },
  });

  const status = await manager.getLogStatus();

  assert.equal(status.listenerAttached, false);
  assert.equal(status.sessionId, null);
  assert.equal(status.sourceProjectPath, null);
});

test("targeted log reads do not expose or clear another local target", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).sessionId = "current-session";
  (manager as any).listenerAttached = true;
  (manager as any).lastLogAt = 20;
  (manager as any).lastListenerBindAt = 10;
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (manager as any).persistStateMeta = async () => {};
  (manager as any).readPersistedState = async () => ({
    consoleLogs: [{ type: "log", message: "from-a", timestamp: 20 }],
    listenerAttached: true,
    lastLogAt: 20,
    lastListenerBindAt: 10,
    sessionId: "current-session",
    sourceProjectPath: "/project-a",
    sessions: {},
  });

  const target = {
    mode: "connect" as const,
    wsEndpoint: "ws://127.0.0.1:9520",
    args: undefined,
  };
  const logs = await manager.getConsoleLogs(target);
  const status = await manager.getLogStatus(target);

  assert.deepEqual(logs, []);
  assert.equal(status.listenerAttached, false);
  assert.equal(status.sessionId, null);
  assert.equal(status.sourceProjectPath, null);
  assert.equal(status.logCount, 0);
  await assert.rejects(
    manager.clearConsoleLogs(target),
    /CONNECTION_TARGET_MISMATCH/
  );
});

test("log reads and clears do not fall back to all targets", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).readPersistedState = async () => ({
    consoleLogs: [
      {
        type: "log",
        message: "other-target",
        timestamp: 10,
        sourceTarget: "connect:ws://127.0.0.1:9420",
      },
    ],
    listenerAttached: true,
    lastLogAt: 10,
    lastListenerBindAt: 5,
    sessionId: "other-session",
    sourceProjectPath: "/other-project",
    sessions: {
      "other-session": {
        listenerAttached: true,
        lastLogAt: 10,
        lastListenerBindAt: 5,
        sourceProjectPath: "/other-project",
        sourceTarget: "connect:ws://127.0.0.1:9420",
        updatedAt: 10,
      },
    },
  });

  assert.deepEqual(await manager.getConsoleLogs(), []);
  const status = await manager.getLogStatus();
  assert.equal(status.listenerAttached, false);
  assert.equal(status.logCount, 0);
  assert.equal(status.sessionId, null);
  await assert.rejects(manager.clearConsoleLogs(), /LOG_TARGET_REQUIRED/);
});

test("persisted logs are isolated and cleared by connection target", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-target-logs-"));
  const configFile = join(tempDir, "state.json");
  const targetA = "connect:ws://127.0.0.1:9420";
  const targetB = "connect:ws://127.0.0.1:9520";
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  await writeFile(
    configFile,
    JSON.stringify({
      lastProjectPath: null,
      pendingProjects: [],
      consoleLogs: [
        {
          type: "log",
          message: "from-a",
          timestamp: 10,
          sourceTarget: targetA,
        },
        {
          type: "warn",
          message: "from-b",
          timestamp: 20,
          sourceTarget: targetB,
        },
        {
          type: "error",
          message: "legacy-untagged",
          timestamp: 30,
        },
      ],
      sessionId: "session-b",
      listenerAttached: true,
      lastLogAt: 30,
      lastListenerBindAt: 15,
      logStoreMode: "persisted",
      sourceProjectPath: "/project-b",
      sourceTarget: targetB,
      sessions: {
        "session-a": {
          listenerAttached: true,
          lastLogAt: 10,
          lastListenerBindAt: 5,
          sourceProjectPath: "/project-a",
          sourceTarget: targetA,
          updatedAt: 10,
        },
        "session-b": {
          listenerAttached: true,
          lastLogAt: 20,
          lastListenerBindAt: 15,
          sourceProjectPath: "/project-b",
          sourceTarget: targetB,
          updatedAt: 20,
        },
      },
    })
  );
  const manager = new WeappAutomatorManager();
  (manager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9520",
  };

  try {
    const logs = await manager.getConsoleLogs();
    const status = await manager.getLogStatus();

    assert.deepEqual(logs.map((entry) => entry.message), ["from-b"]);
    assert.equal(status.logCount, 1);
    assert.equal(status.sessionId, "session-b");
    assert.equal(status.sourceProjectPath, "/project-b");

    await manager.clearConsoleLogs();
    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.deepEqual(
      persisted.consoleLogs.map((entry: { message: string }) => entry.message),
      ["from-a", "legacy-untagged"]
    );
    assert.equal(persisted.sessions["session-a"].lastLogAt, 10);
    assert.equal(persisted.sessions["session-b"].lastLogAt, null);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("console events are coalesced into one persisted-state update", async () => {
  const manager = new WeappAutomatorManager();
  let updates = 0;
  const state: any = {
    lastProjectPath: null,
    pendingProjects: [],
    consoleLogs: [],
    sessionId: null,
    listenerAttached: false,
    lastLogAt: null,
    lastListenerBindAt: null,
    logStoreMode: "persisted",
    sourceProjectPath: null,
    sessions: {},
  };
  (manager as any).updatePersistedState = async (update: (value: any) => void) => {
    updates += 1;
    update(state);
  };

  for (let index = 0; index < 3; index += 1) {
    (manager as any).appendConsoleLog({
      type: "log",
      message: `message-${index}`,
      timestamp: index + 1,
    });
  }
  await (manager as any).flushPendingConsoleLogs();

  assert.equal(updates, 1);
  assert.equal(state.consoleLogs.length, 3);
});

test("pending console logs remain bounded when persistence fails", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).maxLogs = 2;
  (manager as any).pendingConsoleLogs = [
    { type: "log", message: "one", timestamp: 1 },
    { type: "log", message: "two", timestamp: 2 },
  ];
  (manager as any).updatePersistedState = async () => {
    (manager as any).pendingConsoleLogs.push(
      { type: "log", message: "three", timestamp: 3 },
      { type: "log", message: "four", timestamp: 4 }
    );
    throw new Error("disk unavailable");
  };

  await (manager as any).flushPendingConsoleLogs();

  assert.deepEqual(
    (manager as any).pendingConsoleLogs.map((entry: any) => entry.message),
    ["three", "four"]
  );
});

test("persisted state drops malformed entries and clamps oversized logs", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-state-sanitize-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  await writeFile(
    configFile,
    JSON.stringify({
      pendingProjects: [
        null,
        { path: "/projects/valid", name: "Valid" },
        { name: "missing path" },
      ],
      consoleLogs: [
        null,
        { type: "log", message: "ok", timestamp: 1 },
        {
          type: "log",
          message: "m".repeat(100000),
          timestamp: 2,
          data: { text: "d".repeat(100000) },
        },
      ],
      sessions: {
        invalid: null,
        valid: {
          listenerAttached: true,
          lastLogAt: 2,
          lastListenerBindAt: 1,
          sourceProjectPath: "/projects/valid",
          updatedAt: 2,
        },
      },
    })
  );
  const manager = new WeappAutomatorManager();

  try {
    const state = await (manager as any).readPersistedState();
    assert.deepEqual(state.pendingProjects, [
      { path: "/projects/valid", name: "Valid" },
    ]);
    assert.equal(state.consoleLogs.length, 2);
    assert.ok(Buffer.byteLength(state.consoleLogs[1].message, "utf8") < 20000);
    assert.equal(typeof state.consoleLogs[1].data, "string");
    assert.deepEqual(Object.keys(state.sessions), ["valid"]);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("persisted state files are written with owner-only permissions", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-state-mode-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  const manager = new WeappAutomatorManager();

  try {
    await (manager as any).writePersistedState((manager as any).createDefaultState());
    const info = await stat(configFile);
    assert.equal(info.mode & 0o777, 0o600);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("default projects are persisted as absolute paths", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-default-project-"));
  const configFile = join(tempDir, "state.json");
  const relativeProjectPath = relative(process.cwd(), tempDir);
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  await writeFile(
    join(tempDir, "project.config.json"),
    JSON.stringify({ appid: "wx-test" })
  );
  const manager = new WeappAutomatorManager();

  try {
    assert.equal(await manager.setDefaultProject(relativeProjectPath), true);
    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(persisted.lastProjectPath, resolve(relativeProjectPath));
    assert.equal(persisted.defaultProjectPath, resolve(relativeProjectPath));
    assert.equal(await manager.getDefaultProject(), resolve(relativeProjectPath));
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("active session metadata does not overwrite an explicit default project", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-default-project-stability-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  await writeFile(
    configFile,
    JSON.stringify({
      lastProjectPath: "/projects/previous",
      defaultProjectPath: "/projects/default",
      pendingProjects: [],
      consoleLogs: [],
      sessionId: null,
      listenerAttached: false,
      lastLogAt: null,
      lastListenerBindAt: null,
      logStoreMode: "persisted",
      sourceProjectPath: null,
      sourceTarget: null,
      sessions: {},
    })
  );
  const manager = new WeappAutomatorManager();
  (manager as any).config = {
    mode: "launch",
    projectPath: "/projects/active",
  };

  try {
    await manager.setPendingProjects([{ path: "/projects/candidate", name: "candidate" }]);
    await (manager as any).persistStateMeta();
    (manager as any).appendConsoleLog({
      type: "log",
      message: "keep default",
      timestamp: Date.now(),
      sourceTarget: "launch:/projects/active:9420",
    });
    await (manager as any).flushPendingConsoleLogs();

    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(persisted.lastProjectPath, resolve("/projects/active"));
    assert.equal(persisted.defaultProjectPath, "/projects/default");
    assert.equal(persisted.sourceProjectPath, null);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("setting a default project reports persistence failures", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).isValidWeappProject = async () => true;
  (manager as any).saveDefaultProjectPath = async () => false;
  const tool = toolByName(
    createApplicationTools(manager as any),
    "mp_setDefaultProject"
  );

  const result = await tool.execute({ projectPath: "/valid/project" }, context);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /无法写入默认项目配置/);
});

test("connection snapshot does not report a stale persisted project", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).readPersistedState = async () => ({
    lastProjectPath: "/stale/project",
    sessionId: "stale-session",
  });
  (manager as any).diagnoseConnection = async () => ({
    projectPath: null,
    port: 9420,
    portListening: false,
    websocketReachable: false,
    ideProcessDetected: false,
  });

  const snapshot = await manager.getConnectionSnapshot({
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
    args: undefined,
  });

  assert.equal(snapshot.projectPath, null);
  assert.equal(snapshot.sessionId, null);
});

test("connection snapshot keeps a default project separate from the active connect target", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).diagnoseConnection = async () => ({
    projectPath: null,
    defaultProjectPath: "/projects/default",
    port: 9420,
    portListening: false,
    websocketReachable: false,
    ideProcessDetected: false,
  });

  const snapshot = await manager.getConnectionSnapshot({
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
    args: undefined,
  });

  assert.equal(snapshot.projectPath, null);
  assert.equal(snapshot.defaultProjectPath, "/projects/default");
});

test("targeted recovery uses the same connection overrides for before and after snapshots", async () => {
  const manager = new WeappAutomatorManager();
  const overrides = {
    mode: "connect" as const,
    wsEndpoint: "ws://127.0.0.1:9420",
    args: undefined,
  };
  const snapshotOverrides: unknown[] = [];
  const logOverrides: unknown[] = [];
  const snapshot = {
    devtoolsOnline: true,
    wsReachable: true,
    automatorConnected: true,
    connectionMode: "connect",
    projectPath: null,
    wsEndpoint: overrides.wsEndpoint,
    port: 9420,
    sessionId: "session",
  };
  (manager as any).getConnectionSnapshot = async (received: unknown) => {
    snapshotOverrides.push(received);
    return snapshot;
  };
  (manager as any).getLogStatus = async (received: unknown) => {
    logOverrides.push(received);
    return {
      listenerAttached: true,
      lastLogAt: null,
    };
  };
  (manager as any).withMiniProgram = async (
    _log: unknown,
    _options: unknown,
    handler: () => unknown
  ) => handler();

  await manager.recoverConnection(logger, { overrides, reconnect: true });

  assert.deepEqual(snapshotOverrides, [overrides, overrides]);
  assert.deepEqual(logOverrides, [overrides, overrides]);
});

test("screenshot degradation does not recommend connection recovery", async () => {
  const manager = {
    getConnectionSnapshot: async () => ({
      devtoolsOnline: true,
      wsReachable: true,
      automatorConnected: true,
      connectionMode: "connect",
      projectPath: "/project",
      wsEndpoint: "ws://127.0.0.1:9420",
      port: 9420,
      sessionId: "session",
    }),
    getLogStatus: async () => ({
      listenerAttached: true,
      lastLogAt: 1,
      lastListenerBindAt: 1,
      logStoreMode: "persisted",
      sessionId: "session",
      sourceProjectPath: "/project",
      logCount: 1,
      recentTypes: ["log"],
    }),
    getActivePageSnapshot: async () => ({ path: "pages/a", query: {} }),
    getScreenshotStatus: () => ({
      lastScreenshotAt: 1,
      lastScreenshotOk: false,
      lastScreenshotErrorCode: "UNKNOWN",
      failureStreak: 1,
    }),
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_healthCheck"
  ).execute({}, context);
  const payload = parseTextResult(result);

  assert.equal(payload.summary, "degraded");
  assert.equal(payload.needsRecovery, false);
});

test("read-only diagnosis and health tools have bounded outer timeouts", () => {
  const tools = createApplicationTools({} as any);
  assert.equal(toolByName(tools, "mp_diagnoseConnection").timeoutMs, 30000);
  assert.equal(toolByName(tools, "mp_healthCheck").timeoutMs, 30000);
  assert.equal(toolByName(tools, "mp_ensureConnection").timeoutMs, 1260000);
  assert.equal(toolByName(tools, "mp_recoverConnection").timeoutMs, 1260000);
});

test("active page snapshots bound SDK reads and large read tools clamp output", async () => {
  const snapshotManager = new WeappAutomatorManager();
  let snapshotTimeoutMs: number | undefined;
  (snapshotManager as any).miniProgram = {
    currentPage: async () => new Promise(() => {}),
  };
  (snapshotManager as any).config = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (snapshotManager as any).withRequestTimeout = async (
    _operation: () => Promise<unknown>,
    options: { timeoutMs?: number }
  ) => {
    snapshotTimeoutMs = options.timeoutMs;
    throw new Error("timed out");
  };

  assert.equal(
    await snapshotManager.getActivePageSnapshot({
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
    }),
    null
  );
  assert.equal(snapshotTimeoutMs, 3000);

  const large = "x".repeat(5000);
  const element = {
    text: async () => large,
    style: async () => large,
    attribute: async () => large,
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        $: async () => element,
        data: async () => ({ text: large }),
      }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const textResult = await toolByName(
    createPageTools(manager as any),
    "page_expectElementText"
  ).execute({ selector: "#x", expected: large, maxBytes: 100 }, context);
  const dataResult = await toolByName(
    createPageTools(manager as any),
    "page_expectData"
  ).execute({ path: "value", expected: { text: large }, maxBytes: 100 }, context);
  const stylesResult = await toolByName(
    createElementTools(manager as any),
    "element_getStyles"
  ).execute({ selector: "#x", names: ["color"], maxBytes: 100 }, context);
  const attributesResult = await toolByName(
    createElementTools(manager as any),
    "element_getAttributes"
  ).execute({ selector: "#x", names: ["data-value"], maxBytes: 100 }, context);

  for (const result of [textResult, dataResult, stylesResult, attributesResult]) {
    assert.equal(parseTextResult(result).truncated, true);
  }
  assert.equal(parseTextResult(textResult).pass, true);
  assert.equal(parseTextResult(dataResult).pass, true);
});

test("component data is clamped and gesture budgets are bounded", async () => {
  const element = {
    data: async () => ({ text: "x".repeat(5000) }),
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ $: async () => element }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const tools = createElementTools(manager as any);

  const dataResult = await toolByName(tools, "element_getData").execute(
    { selector: "#component", maxBytes: 100 },
    context
  );
  const swipeBudget = await toolByName(tools, "element_swipe").execute(
    {
      selector: "#component",
      direction: "up",
      durationMs: 400000,
      waitMs: 300000,
    },
    context
  );
  const touchBudget = await toolByName(tools, "element_touch").execute(
    {
      selector: "#component",
      phase: "sequence",
      holdMs: 400000,
      moves: [{ x: 1, y: 1, delayMs: 300000 }],
    },
    context
  );

  assert.equal(parseTextResult(dataResult).truncated, true);
  assert.equal(swipeBudget.isError, true);
  assert.equal(touchBudget.isError, true);
  assert.equal(toolByName(tools, "element_swipe").timeoutMs, 660000);
});

test("element touch rejects parameters that the selected phase would ignore", async () => {
  let pageCalls = 0;
  const manager = {
    withPage: async () => {
      pageCalls += 1;
      throw new Error("must not open a page");
    },
  };
  const touch = toolByName(createElementTools(manager as any), "element_touch");

  const ignoredMoves = await touch.execute(
    {
      selector: "#component",
      phase: "start",
      moves: [],
    },
    context
  );
  const ignoredHold = await touch.execute(
    {
      selector: "#component",
      phase: "move",
      holdMs: 0,
    },
    context
  );

  assert.equal(ignoredMoves.isError, true);
  assert.match(ignoredMoves.content[0].text, /moves is only supported/);
  assert.equal(ignoredHold.isError, true);
  assert.match(ignoredHold.content[0].text, /holdMs is only supported/);
  assert.equal(pageCalls, 0);
});

test("bounding rect rejects ambiguous indexed cross-component selectors", async () => {
  let sessionCalls = 0;
  const manager = {
    withMiniProgram: async () => {
      sessionCalls += 1;
      throw new Error("must not open a session");
    },
  };
  const tool = toolByName(
    createElementTools(manager as any),
    "element_getBoundingClientRect"
  );

  const result = await tool.execute(
    {
      selector: ".card[index=1]",
      innerSelector: ".button",
    },
    context
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot be combined with innerSelector/);
  assert.equal(sessionCalls, 0);
});

test("element list tools cap the amount of summary work", async () => {
  let summaryReads = 0;
  const elements = Array.from({ length: 5 }, () => ({
    tagName: "view",
    text: async () => {
      summaryReads += 1;
      return "item";
    },
  }));
  const parent = {
    $$: async () => elements,
  };
  const page = {
    $: async () => parent,
    $$: async () => elements,
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler(page),
  };

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_getElements"
  ).execute({ selector: ".item", limit: 2 }, context);
  const innerResult = await toolByName(
    createElementTools(manager as any),
    "element_getInnerElements"
  ).execute(
    { selector: "#parent", targetSelector: ".item", limit: 2 },
    context
  );

  assert.deepEqual(
    [
      parseTextResult(pageResult).count,
      parseTextResult(pageResult).totalCount,
      parseTextResult(innerResult).count,
      parseTextResult(innerResult).totalCount,
    ],
    [2, 5, 2, 5]
  );
  assert.equal(summaryReads, 4);
  assert.equal(toolByName(createPageTools(manager as any), "page_getElement").timeoutMs, undefined);
  assert.equal(toolByName(createPageTools(manager as any), "page_getElements").timeoutMs, undefined);
});

test("indexed page array queries use zero-or-one semantics", async () => {
  const elements = [{ tagName: "view" }, { tagName: "view" }];
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ $$: async () => elements }),
  };
  const tools = createPageTools(manager as any);

  const found = parseTextResult(
    await toolByName(tools, "page_getElements").execute(
      { selector: ".item[index=1]" },
      context
    )
  );
  const missing = parseTextResult(
    await toolByName(tools, "page_getElements").execute(
      { selector: ".item[index=2]" },
      context
    )
  );
  const countFound = parseTextResult(
    await toolByName(tools, "page_expectCount").execute(
      { selector: ".item[index=1]", expected: 1 },
      context
    )
  );
  const countMissing = parseTextResult(
    await toolByName(tools, "page_expectCount").execute(
      { selector: ".item[index=2]", expected: 0 },
      context
    )
  );

  assert.deepEqual(
    [found.count, found.totalCount, missing.count, missing.totalCount],
    [1, 2, 0, 2]
  );
  assert.equal(countFound.pass, true);
  assert.equal(countMissing.pass, true);
});

test("page and scenario snapshots cap total element summary work", async () => {
  let summaryReads = 0;
  let selectorQueries = 0;
  const elements = Array.from({ length: 60 }, () => ({
    tagName: "view",
    text: async () => {
      summaryReads += 1;
      return "item";
    },
  }));
  const page = {
    path: "pages/a",
    query: {},
    $$: async () => {
      selectorQueries += 1;
      return elements;
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ currentPage: async () => page }, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };
  const selectors = [".a", ".b", ".c"];

  const pageResult = await toolByName(
    createPageTools(manager as any),
    "page_snapshot"
  ).execute(
    { selectors, limit: 100, maxBytes: 1_000_000 },
    context
  );
  const pagePayload = parseTextResult(pageResult);
  assert.equal(pagePayload.elementCount, 100);
  assert.equal(pagePayload.elementsLimited, true);
  assert.equal(pagePayload.processedSelectorCount, 2);
  assert.equal(summaryReads, 100);
  assert.equal(selectorQueries, 2);

  summaryReads = 0;
  selectorQueries = 0;
  const scenarioResult = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute(
    {
      maxBytes: 1_000_000,
      steps: [
        {
          type: "snapshot",
          selectors,
          limit: 100,
          maxBytes: 1_000_000,
        },
      ],
    },
    context
  );
  const scenarioPayload = parseTextResult(scenarioResult);
  const snapshot = scenarioPayload.results[0].result;
  assert.equal(snapshot.elementCount, 100);
  assert.equal(snapshot.elementsLimited, true);
  assert.equal(snapshot.processedSelectorCount, 2);
  assert.equal(summaryReads, 100);
  assert.equal(selectorQueries, 2);
});

test("arbitrary evaluate and log outputs are clamped", async () => {
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        evaluate: async () => ({ text: "x".repeat(5000) }),
        currentPage: async () => ({
          path: "pages/a",
          query: {},
          size: async () => ({ width: 100, height: 100 }),
          scrollTop: async () => 0,
          data: async () => ({ text: "x".repeat(5000) }),
        }),
      }, { mode: "connect" }),
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        data: async () => ({ text: "x".repeat(5000) }),
      }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
    getConsoleLogs: async () => [
      {
        type: "log",
        message: "m".repeat(5000),
        timestamp: 1,
        data: { text: "d".repeat(5000) },
      },
    ],
    getLogStatus: async () => ({
      listenerAttached: true,
      lastLogAt: 1,
      lastListenerBindAt: 1,
      logStoreMode: "persisted",
      sessionId: "session",
      sourceProjectPath: "/project",
      logCount: 1,
      recentTypes: ["log"],
    }),
  };
  const tools = createApplicationTools(manager as any);

  const evaluateResult = await toolByName(tools, "mp_evaluate").execute(
    { functionSource: "() => true", maxBytes: 100 },
    context
  );
  const logResult = await toolByName(tools, "mp_getLogs").execute(
    { maxBytes: 100 },
    context
  );
  const pollResult = await toolByName(tools, "mp_pollUntil").execute(
    { predicate: "() => true", maxBytes: 100 },
    context
  );
  const scenarioResult = await toolByName(tools, "mp_runScenario").execute(
    {
      maxBytes: 100,
      steps: [{ type: "getLogs", limit: 1 }],
    },
    context
  );
  const currentPageResult = await toolByName(tools, "mp_currentPage").execute(
    { withData: true, maxBytes: 100 },
    context
  );
  const pageDataResult = await toolByName(
    createPageTools(manager as any),
    "page_getData"
  ).execute({ maxBytes: 100 }, context);

  for (const result of [
    evaluateResult,
    logResult,
    pollResult,
    scenarioResult,
    currentPageResult,
    pageDataResult,
  ]) {
    assert.equal(parseTextResult(result).truncated, true);
    assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 100);
  }
});

test("failed gesture sequences still send touchend cleanup", async () => {
  let touchEnds = 0;
  const payloads: any[] = [];
  const element = {
    size: async () => ({ width: 100, height: 100 }),
    offset: async () => ({ left: 0, top: 0 }),
    touchstart: async (payload: unknown) => {
      payloads.push(payload);
    },
    touchmove: async (payload: unknown) => {
      payloads.push(payload);
      throw new Error("move failed");
    },
    touchend: async (payload: unknown) => {
      payloads.push(payload);
      touchEnds += 1;
    },
  };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ $: async () => element }),
  };

  const result = await toolByName(
    createElementTools(manager as any),
    "element_swipe"
  ).execute(
    { selector: "#target", direction: "up", durationMs: 6 },
    context
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /move failed/);
  assert.equal(touchEnds, 1);
  assert.equal(payloads.length, 3);
  for (const payload of payloads) {
    assert.equal(Array.isArray(payload.changedTouches), true);
    assert.deepEqual(payload.changedTouches, payload.changeTouches);
    assert.equal("clientX" in payload.changedTouches[0], false);
    assert.equal("clientY" in payload.changedTouches[0], false);
  }
});

test("screenshot falls back to private_captureScreen data when the public API fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-shot-fallback-"));
  const screenshotPath = join(tempDir, "shot.png");
  const recorded: Array<[boolean, string | null | undefined]> = [];
  let currentPageCalls = 0;
  const miniProgram = {
    currentPage: async () => {
      currentPageCalls += 1;
      return new Promise(() => {});
    },
    screenshot: async () => {
      throw new Error("fail to capture screenshot");
    },
    evaluate: async () => ({
      data: Buffer.from("fallback-png").toString("base64"),
    }),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };

  try {
    const result = await toolByName(
      createApplicationTools(manager as any),
      "mp_screenshot"
    ).execute({ path: screenshotPath, timeoutMs: 100 }, context);
    const payload = parseTextResult(result);

    assert.equal(payload.captureMethod, "direct-temp-file");
    assert.equal(await readFile(screenshotPath, "utf8"), "fallback-png");
    assert.deepEqual(recorded, [[true, undefined]]);
    assert.equal(currentPageCalls, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("screenshot rejects empty inline image data without resetting failure health", async () => {
  const recorded: Array<[boolean, string | null | undefined]> = [];
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({ screenshot: async () => "" }, { mode: "connect" }),
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_screenshot"
  ).execute({ timeoutMs: 100 }, context);

  assert.equal(result.isError, true);
  assert.deepEqual(recorded, [[false, "EMPTY_OUTPUT"]]);
});

test("screenshot short-circuit is checked after the requested target is connected", async () => {
  let targetReady = false;
  let screenshotCalls = 0;
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) => {
      targetReady = true;
      return handler(
        {
          screenshot: async () => {
            screenshotCalls += 1;
            return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZ7WkAAAAASUVORK5CYII=";
          },
        },
        { mode: "connect", wsEndpoint: "ws://127.0.0.1:9520" }
      );
    },
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: targetReady ? 0 : 2,
      lastScreenshotErrorCode: targetReady ? null : "UNKNOWN",
    }),
    recordScreenshotResult: () => {},
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_screenshot"
  ).execute(
    {
      connection: {
        mode: "connect",
        wsEndpoint: "ws://127.0.0.1:9520",
      },
    },
    context
  );

  assert.equal(result.isError, undefined);
  assert.equal(screenshotCalls, 1);
});

test("mp_screenshot retries only renderer-not-ready failures", async () => {
  let attempts = 0;
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(
        { currentPage: async () => ({ path: "pages/a" }) },
        { mode: "connect" }
      ),
    runSerializedScreenshot: async () => {
      attempts += 1;
      throw new Error("EACCES permission denied");
    },
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: () => {},
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_screenshot"
  ).execute({ timeoutMs: 100 }, context);

  assert.equal(result.isError, true);
  assert.equal(attempts, 1);
});

test("missing bounding rect is reported as an error instead of hidden success", async () => {
  const originalWx = (globalThis as any).wx;
  (globalThis as any).wx = {
    createSelectorQuery: () => {
      const query = {
        select: () => query,
        selectAll: () => query,
        boundingClientRect: () => query,
        exec: (callback: (result: unknown[]) => void) => callback([null]),
      };
      return query;
    },
  };
  const miniProgram = {
    evaluate: async (fn: (...args: any[]) => unknown, ...args: any[]) =>
      fn(...args),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };

  try {
    const result = await toolByName(
      createElementTools(manager as any),
      "element_getBoundingClientRect"
    ).execute({ selector: "#missing" }, context);
    assert.equal(result.isError, true);
  } finally {
    (globalThis as any).wx = originalWx;
  }
});

test("scenario screenshot creates its parent directory and scenario length is capped", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-scenario-shot-"));
  const screenshotPath = join(tempDir, "nested", "shot.png");
  const miniProgram = {
    currentPage: async () => ({ path: "pages/a" }),
    screenshot: async ({ path }: { path: string }) => {
      await writeFile(path, "png");
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: () => {},
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_runScenario");

  try {
    const result = await tool.execute(
      { steps: [{ type: "screenshot", path: screenshotPath }] },
      context
    );
    assert.equal(parseTextResult(result).ok, true);
    assert.equal((await stat(join(tempDir, "nested"))).isDirectory(), true);

    const tooMany = await tool.execute(
      {
        steps: Array.from({ length: 26 }, () => ({
          type: "expectRoute",
          path: "pages/a",
        })),
      },
      context
    );
    assert.equal(tooMany.isError, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scenario inline screenshot rejects empty SDK results", async () => {
  for (const output of [undefined, ""]) {
    const recorded: Array<[boolean, string | null | undefined]> = [];
    const manager = {
      withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
        handler({ screenshot: async () => output }, { mode: "connect" }),
      withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
      runSerializedScreenshot: async (
        _log: unknown,
        operation: () => Promise<unknown>
      ) => operation(),
      getScreenshotStatus: () => ({
        failureStreak: 0,
        lastScreenshotErrorCode: null,
      }),
      recordScreenshotResult: (ok: boolean, code?: string | null) => {
        recorded.push([ok, code]);
      },
    };

    const result = await toolByName(
      createApplicationTools(manager as any),
      "mp_runScenario"
    ).execute({ steps: [{ type: "screenshot", timeoutMs: 100 }] }, context);

    const payload = parseTextResult(result);
    assert.equal(payload.ok, false);
    assert.deepEqual(recorded, [[false, "EMPTY_OUTPUT"]]);
  }
});

test("scenario inline screenshot reports decoded image bytes", async () => {
  const imageBytes = Buffer.from("png-bytes");
  const miniProgram = {
    currentPage: async () => ({ path: "pages/a" }),
    screenshot: async () => imageBytes.toString("base64"),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: () => {},
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_runScenario"
  ).execute({ steps: [{ type: "screenshot" }] }, context);
  const payload = parseTextResult(result);

  assert.equal(payload.results[0].result.bytes, imageBytes.byteLength);
});

test("scenario reports return their effective title and surface write failures", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-report-write-"));
  const manager = {
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(
        {
          currentPage: async () => ({ path: "pages/a", query: {} }),
        },
        { mode: "connect" }
      ),
    withPage: async (_log: unknown, _options: unknown, handler: any) =>
      handler({
        $: async () => ({
          tap: async () => {
            throw new Error("tap failed\n```\ninside error");
          },
        }),
      }),
  };
  const tool = toolByName(
    createApplicationTools(manager as any),
    "mp_generateScenarioReport"
  );

  try {
    const result = await tool.execute(
      { steps: [{ type: "expectRoute", path: "pages/a" }] },
      context
    );
    const payload = parseTextResult(result);
    assert.equal(payload.title, "Scenario Report");
    assert.match(payload.report, /^# Scenario Report/);

    const fencedResult = await tool.execute(
      {
        title: "Custom\nReport",
        steps: [{ type: "tap", selector: "#x" }],
      },
      context
    );
    const fencedPayload = parseTextResult(fencedResult);
    assert.equal(fencedPayload.title, "Custom Report");
    assert.match(fencedPayload.report, /^# Custom Report/);
    assert.ok(
      fencedPayload.report.includes("````\ntap failed\n```\ninside error\n````")
    );

    const writeFailure = await tool.execute(
      {
        outputPath: tempDir,
        steps: [{ type: "expectRoute", path: "pages/a" }],
      },
      context
    );
    assert.equal(writeFailure.isError, true);
    assert.match(writeFailure.content[0].text, /写入 scenario 报告失败/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scenario screenshot failures update screenshot-channel health", async () => {
  const recorded: Array<[boolean, string | null | undefined]> = [];
  const miniProgram = {
    currentPage: async () => ({ path: "pages/a" }),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
    runSerializedScreenshot: async () => {
      throw new Error("[REQUEST_TIMEOUT] capture timed out");
    },
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_runScenario");

  const result = await tool.execute(
    { steps: [{ type: "screenshot", timeoutMs: 10 }] },
    context
  );

  assert.equal(parseTextResult(result).ok, false);
  assert.deepEqual(recorded, [[false, "SCREENSHOT_TIMEOUT"]]);
});

test("screenshot filesystem error codes are classified as local output failures", async () => {
  const recorded: Array<[boolean, string | null | undefined]> = [];
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler({}, { mode: "connect" }),
    runSerializedScreenshot: async () => {
      throw new Error("EISDIR: illegal operation on a directory, open '/tmp'");
    },
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_screenshot");

  const result = await tool.execute(
    { path: "/tmp/weapp-output.png", timeoutMs: 10 },
    context
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /LOCAL_OUTPUT_ERROR/);
  assert.deepEqual(recorded, [[false, "LOCAL_OUTPUT_ERROR"]]);
});

test("file screenshots only report success for non-empty output files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-empty-screenshot-"));
  const outputPath = join(tempDir, "empty.png");
  const recorded: Array<[boolean, string | null | undefined]> = [];
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(
        {
          screenshot: async ({ path }: { path: string }) => {
            await writeFile(path, "");
          },
        },
        { mode: "connect" }
      ),
    runSerializedScreenshot: async (
      _log: unknown,
      operation: () => Promise<unknown>
    ) => operation(),
    getScreenshotStatus: () => ({
      failureStreak: 0,
      lastScreenshotErrorCode: null,
    }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };
  const tool = toolByName(createApplicationTools(manager as any), "mp_screenshot");

  try {
    const result = await tool.execute(
      { path: outputPath, timeoutMs: 10 },
      context
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /EMPTY_OUTPUT/);
    assert.equal((await stat(outputPath)).size, 0);
    assert.deepEqual(recorded, [[false, "EMPTY_OUTPUT"]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("screenshot timeout is bounded below the tool-level timeout", async () => {
  const tool = toolByName(createApplicationTools({} as any), "mp_screenshot");

  assert.equal(tool.timeoutMs, 660000);
  const result = await tool.execute({ timeoutMs: 600001 }, context);
  assert.equal(result.isError, true);
});

test("CLI ticket and account values are redacted from log arguments", () => {
  assert.deepEqual(
    redactCliArgsForLog([
      "auto",
      "--ticket",
      "secret-ticket",
      "--ticket=another-secret",
      "--auto-account",
      "private-account",
      "--auto-account=another-account",
      "--trust-project",
    ]),
    [
      "auto",
      "--ticket",
      "<redacted>",
      "--ticket=<redacted>",
      "--auto-account",
      "<redacted>",
      "--auto-account=<redacted>",
      "--trust-project",
    ]
  );
  assert.equal(
    redactCliTextForLog(
      "cli failed: secret-ticket and another-secret for private-account and another-account",
      [
        "auto",
        "--ticket",
        "secret-ticket",
        "--ticket=another-secret",
        "--auto-account",
        "private-account",
        "--auto-account=another-account",
      ]
    ),
    "cli failed: <redacted> and <redacted> for <redacted> and <redacted>"
  );
});

test("a stale persisted-state lock is stolen instead of blocking writes", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-stale-lock-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  const lockPath = `${configFile}.lock`;
  // 残留一把"陈旧"锁（mtime 远早于 30s 阈值），模拟持锁进程崩溃。
  await writeFile(lockPath, "");
  const staleTime = new Date(Date.now() - 60000);
  await utimes(lockPath, staleTime, staleTime);

  // 监听 rename：锁定 fix #1 走的是"原子 rename 抢占"而非裸 unlink（baseline 行为，
  // 在单进程下两者结果相同，只有 rename 调用本身能区分修复前后）。
  const renameCalls: Array<[string, string]> = [];
  const originalRename = fsPromises.rename;
  (fsPromises as any).rename = async (from: unknown, to: unknown) => {
    renameCalls.push([String(from), String(to)]);
    return (originalRename as any)(from, to);
  };

  try {
    const manager = new WeappAutomatorManager();
    await (manager as any).updatePersistedState((state: any) => {
      state.lastProjectPath = "/stolen";
    });

    const persisted = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(persisted.lastProjectPath, "/stolen");
    // 陈旧锁被原子 rename 到 .stolen 抢占（而非基线的裸 unlink）。
    assert.ok(
      renameCalls.some(([from, to]) => from === lockPath && to.endsWith(".stolen")),
      "expected the stale lock to be stolen via an atomic rename to a .stolen path"
    );
    // 锁在 operation 结束后被释放（finally unlink）。
    await assert.rejects(stat(lockPath));
  } finally {
    (fsPromises as any).rename = originalRename;
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("an old orphan state temp file is cleaned up while holding the lock", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-orphan-tmp-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  // 模拟某进程 kill -9 留下的孤儿临时文件。
  const orphan = `${configFile}.999999.deadbeef.tmp`;
  await writeFile(orphan, "leftover");
  const oldTime = new Date(Date.now() - 60000);
  await utimes(orphan, oldTime, oldTime);

  try {
    const manager = new WeappAutomatorManager();
    await (manager as any).updatePersistedState((state: any) => {
      state.lastProjectPath = "/x";
    });
    await assert.rejects(stat(orphan));
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("screenshot fallback executes the injected private_captureScreen bridge", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-shot-bridge-"));
  const screenshotPath = join(tempDir, "shot.png");
  const frameBase64 = Buffer.from("real-frame").toString("base64");
  const savedBridge = (globalThis as any).WeixinJSBridge;
  const savedWx = (globalThis as any).wx;
  let invokedName: string | null = null;
  let readEncoding: string | null = null;
  (globalThis as any).WeixinJSBridge = {
    invoke: (name: string, _args: unknown, cb: (capture: unknown) => void) => {
      invokedName = name;
      cb({ errMsg: "private_captureScreen:ok", tempFilePath: "/tmp/frame.png" });
    },
  };
  (globalThis as any).wx = {
    getFileSystemManager: () => ({
      readFile: (opts: any) => {
        readEncoding = opts.encoding;
        opts.success({ data: frameBase64 });
      },
    }),
  };

  const recorded: Array<[boolean, string | null | undefined]> = [];
  let evaluateTimeoutMs: number | undefined;
  const miniProgram = {
    screenshot: async () => {
      // 制造可测量的 elapsed，使内层 fallback 预算严格小于外层 timeoutMs。
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("fail to capture screenshot");
    },
    // 真正执行注入的函数体（生产里 miniProgram.evaluate(fn)）。
    evaluate: async (fn: () => Promise<unknown>) => fn(),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    runSerializedScreenshot: async (_log: unknown, operation: () => Promise<unknown>) =>
      operation(),
    // 捕获第二个 options 参数，断言 fix #4 的剩余预算确实被透传（baseline 会原样传 100）。
    runSerializedEvaluate: async (
      operation: () => Promise<unknown>,
      options?: { timeoutMs?: number }
    ) => {
      evaluateTimeoutMs = options?.timeoutMs;
      return operation();
    },
    getScreenshotStatus: () => ({ failureStreak: 0, lastScreenshotErrorCode: null }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };

  try {
    const result = await toolByName(
      createApplicationTools(manager as any),
      "mp_screenshot"
    ).execute({ path: screenshotPath, timeoutMs: 100 }, context);
    const payload = parseTextResult(result);

    assert.equal(invokedName, "private_captureScreen");
    assert.equal(readEncoding, "base64");
    assert.equal(payload.captureMethod, "direct-temp-file");
    assert.equal(await readFile(screenshotPath, "utf8"), "real-frame");
    assert.deepEqual(recorded, [[true, undefined]]);
    // fix #4：内层 evaluate 拿到的是「外层预算 - 已耗时」，必 >=1 且 < 外层 100。
    assert.ok(
      evaluateTimeoutMs !== undefined &&
        evaluateTimeoutMs >= 1 &&
        evaluateTimeoutMs < 100,
      `expected fallback evaluate budget in [1,100), got ${evaluateTimeoutMs}`
    );
  } finally {
    (globalThis as any).WeixinJSBridge = savedBridge;
    (globalThis as any).wx = savedWx;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("screenshot fallback surfaces an unavailable private screenshot bridge as an error", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-shot-nobridge-"));
  const screenshotPath = join(tempDir, "shot.png");
  const savedBridge = (globalThis as any).WeixinJSBridge;
  const savedWx = (globalThis as any).wx;
  (globalThis as any).WeixinJSBridge = undefined;
  (globalThis as any).wx = undefined;

  const recorded: Array<[boolean, string | null | undefined]> = [];
  const miniProgram = {
    screenshot: async () => {
      throw new Error("fail to capture screenshot");
    },
    evaluate: async (fn: () => Promise<unknown>) => fn(),
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    runSerializedScreenshot: async (_log: unknown, operation: () => Promise<unknown>) =>
      operation(),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
    getScreenshotStatus: () => ({ failureStreak: 0, lastScreenshotErrorCode: null }),
    recordScreenshotResult: (ok: boolean, code?: string | null) => {
      recorded.push([ok, code]);
    },
  };

  try {
    const result = await toolByName(
      createApplicationTools(manager as any),
      "mp_screenshot"
    ).execute({ path: screenshotPath, timeoutMs: 100 }, context);

    assert.equal(result.isError, true);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], false);
    await assert.rejects(stat(screenshotPath));
  } finally {
    (globalThis as any).WeixinJSBridge = savedBridge;
    (globalThis as any).wx = savedWx;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("page_getData keeps missingPaths after the result is truncated", async () => {
  const big = "x".repeat(5000);
  const page = { data: async () => ({ big, other: 1 }) };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) => handler(page),
    withRequestTimeout: async (operation: () => Promise<unknown>) => operation(),
  };

  const result = await toolByName(
    createPageTools(manager as any),
    "page_getData"
  ).execute({ paths: ["big", "does.not.exist"], maxBytes: 200 }, context);
  const payload = parseTextResult(result);

  assert.equal(payload.truncated, true);
  assert.deepEqual(payload.missingPaths, ["does.not.exist"]);
});

test("page_expectElementText treats null element text as an empty string", async () => {
  const page = { $: async () => ({ text: async () => null }) };
  const manager = {
    withPage: async (_log: unknown, _options: unknown, handler: any) => handler(page),
  };

  const result = await toolByName(
    createPageTools(manager as any),
    "page_expectElementText"
  ).execute({ selector: "#x", expected: "", mode: "equals" }, context);
  const payload = parseTextResult(result);

  assert.equal(payload.pass, true);
  assert.equal(payload.actual, "");
});

test("mp_evaluate channel-level failures append a fallback hint", async () => {
  const miniProgram = {
    evaluate: async () => {
      throw new Error("(intermediate value) is not a function");
    },
  };
  const manager = {
    withMiniProgram: async (_log: unknown, _options: unknown, handler: any) =>
      handler(miniProgram, { mode: "connect" }),
    runSerializedEvaluate: async (operation: () => Promise<unknown>) => operation(),
  };

  const result = await toolByName(
    createApplicationTools(manager as any),
    "mp_evaluate"
  ).execute({ functionSource: "() => 1", timeoutMs: 100 }, context);

  assert.equal(result.isError, true);
  const text = result.content[0].text as string;
  assert.match(text, /evaluate 注入通道/);
  assert.match(text, /mp_callWx/);
});

test("mp_pollUntil short-circuits on a repeated deterministic predicate error", async () => {
  const manager = new WeappAutomatorManager();
  let evalCalls = 0;
  const miniProgram = {
    evaluate: async () => {
      evalCalls += 1;
      throw new Error("(intermediate value) is not a function");
    },
  };
  (manager as any).withMiniProgram = async (
    _log: unknown,
    _options: unknown,
    handler: any
  ) => handler(miniProgram, { mode: "connect" });

  const result = await toolByName(createApplicationTools(manager), "mp_pollUntil").execute(
    { predicate: "() => true", timeoutMs: 5000, pollIntervalMs: 1 },
    context
  );
  const payload = parseTextResult(result);

  assert.equal(result.isError, true);
  assert.equal(payload.matched, false);
  // 连续 2 次相同错误即短路，不空转到 5000ms timeout。
  assert.equal(payload.iterations, 2);
  assert.equal(evalCalls, 2);
  assert.match(payload.lastPredicateError, /提前结束轮询/);
});
