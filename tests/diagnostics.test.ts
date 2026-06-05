import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, resolveConfig } from "../src/config.js";
import { createApplicationTools } from "../src/tools/application.js";
import { WeappAutomatorManager } from "../src/weappClient.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

test("resolveConfig requires wsEndpoint for strict connect mode", () => {
  assert.throws(
    () => resolveConfig({ mode: "connect", args: undefined }),
    (error: unknown) => error instanceof ConfigError
  );
});

test("resolveConfig allows incomplete connect for diagnostics", () => {
  const config = resolveConfig(
    { mode: "connect", args: undefined },
    undefined,
    { allowIncompleteConnect: true }
  );

  assert.equal(config.mode, "connect");
  assert.equal(config.wsEndpoint, undefined);
});

test("diagnoseConnection reports missing ws endpoint in connect mode", async () => {
  const manager = new WeappAutomatorManager();
  const diagnosis = await manager.diagnoseConnection(
    {
      mode: "connect",
      args: undefined,
    },
    { strictMode: false }
  );

  assert.equal(diagnosis.reasonCode, "INVALID_WS_ENDPOINT");
  assert.equal(diagnosis.allowAutoLaunch, false);
});

test("invalid config diagnosis still reports the persisted default project", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).getDefaultProject = async () => "/projects/default";
  (manager as any).isDevToolsProcessRunning = async () => false;

  const diagnosis = await manager.diagnoseConnection(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      port: 0,
      args: undefined,
    } as any,
    { strictMode: false }
  );

  assert.equal(diagnosis.reasonCode, "INVALID_CONNECTION_CONFIG");
  assert.equal(diagnosis.projectPath, null);
  assert.equal(diagnosis.defaultProjectPath, "/projects/default");
  assert.equal(diagnosis.projectConfigured, true);
});

test("diagnoseConnection reports invalid ws endpoint without switching port", async () => {
  const manager = new WeappAutomatorManager();
  const diagnosis = await manager.diagnoseConnection(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      args: undefined,
    },
    { strictMode: false }
  );

  assert.equal(diagnosis.target, "ws://127.0.0.1:9420");
  assert.equal(diagnosis.port, 9420);
  assert.notEqual(diagnosis.port, 9421);
});

test("diagnoseConnection identifies HTTP-like endpoint as non-launch-safe", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;

  (manager as any).isPortInUse = async () => true;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: false, error: "Unexpected server response: 200" });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: true,
    statusCode: 200,
    bodySnippet: "Cannot GET /",
    error: null,
  });
  (manager as any).isDevToolsProcessRunning = async () => true;

  try {
    const diagnosis = await manager.diagnoseConnection(
      {
        mode: "connect",
        wsEndpoint: "ws://127.0.0.1:9420",
        args: undefined,
      },
      { strictMode: false }
    );

    assert.equal(diagnosis.looksLikeIdeHttp, true);
    assert.equal(diagnosis.reasonCode, "IDE_HTTP_PORT_NOT_WS");
    assert.equal(diagnosis.allowAutoLaunch, false);
    // 提示要点明"传错了端口（应是自动化端口，默认 9420）"，而不只是泛泛说"确认自动化端口"。
    assert.match(diagnosis.suggestion, /auto-port|9420/);
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
  }
});

test("diagnoseConnection keeps explicit connect target without port fallback", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;

  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: false, error: "ECONNREFUSED" });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "connect ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;

  try {
    const diagnosis = await manager.diagnoseConnection(
      {
        mode: "connect",
        wsEndpoint: "ws://127.0.0.1:9420",
        autoLaunch: true,
        projectPath: "/tmp/demo-project",
        args: undefined,
      },
      { strictMode: false }
    );

    assert.equal(diagnosis.target, "ws://127.0.0.1:9420");
    assert.equal(diagnosis.port, 9420);
    assert.equal(diagnosis.reasonCode, "PORT_NOT_LISTENING");
    assert.equal(diagnosis.allowAutoLaunch, true);
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
  }
});

test("diagnoseConnection treats an explicit wsEndpoint as authoritative over port", async () => {
  const manager = new WeappAutomatorManager();
  const probedPorts: number[] = [];
  (manager as any).isPortInUse = async (port: number) => {
    probedPorts.push(port);
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
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      port: 9421,
      args: undefined,
    },
    { strictMode: false }
  );

  assert.deepEqual(probedPorts, [9420]);
  assert.equal(diagnosis.port, 9420);
  assert.equal(diagnosis.launchPort, 9420);
});

test("diagnoseConnection does not report a stale persisted project as configured", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).loadProjectPath = async () => "/stale/project";
  (manager as any).isValidWeappProject = async () => false;
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

  const diagnosis = await manager.diagnoseConnection(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      args: undefined,
    },
    { strictMode: false }
  );

  assert.equal(diagnosis.projectPath, null);
  assert.equal(diagnosis.projectConfigured, false);
});

test("connect diagnosis does not report the persisted default as the active project", async () => {
  const manager = new WeappAutomatorManager();
  (manager as any).getDefaultProject = async () => "/projects/default";
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

  const diagnosis = await manager.diagnoseConnection(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      args: undefined,
    },
    { strictMode: false }
  );

  assert.equal(diagnosis.projectPath, null);
  assert.equal(diagnosis.defaultProjectPath, "/projects/default");
  assert.equal(diagnosis.projectConfigured, true);
});

test("withMiniProgram auto-launches via cli auto when port is not listening", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;
  const originalConnectWithTimeout = (manager as any).connectWithTimeout;
  const originalConnect = (manager as any).connect;
  const originalGetDefaultProject = (manager as any).getDefaultProject;
  const originalIsValidProject = (manager as any).isValidWeappProject;
  const originalLaunchDevTools = (manager as any).launchDevTools;
  const originalWaitForPort = (manager as any).waitForPortListening;

  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: false, error: "ECONNREFUSED" });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "connect ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;
  (manager as any).connectWithTimeout = async () => {
    throw new Error("should not reach connectWithTimeout in this test");
  };
  (manager as any).connect = async () => {
    throw new Error("must not fall back to SDK automator.launch");
  };
  (manager as any).getDefaultProject = async () => null;
  (manager as any).isValidWeappProject = async () => false;
  (manager as any).launchDevTools = async () => {
    throw new Error("launchDevTools must not run when project path cannot be resolved");
  };
  (manager as any).waitForPortListening = async () => false;

  try {
    await assert.rejects(
      () =>
        manager.withMiniProgram(
          {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
          },
          {
            overrides: {
              mode: "connect",
              wsEndpoint: "ws://127.0.0.1:9420",
              args: undefined,
            },
          },
          async () => null
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[PORT_NOT_LISTENING_AUTOLAUNCH_NO_PROJECT]")
    );
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
    (manager as any).connectWithTimeout = originalConnectWithTimeout;
    (manager as any).connect = originalConnect;
    (manager as any).getDefaultProject = originalGetDefaultProject;
    (manager as any).isValidWeappProject = originalIsValidProject;
    (manager as any).launchDevTools = originalLaunchDevTools;
    (manager as any).waitForPortListening = originalWaitForPort;
  }
});

test("withMiniProgram refuses to auto-launch when wsEndpoint points to a remote host", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;
  const originalConnectWithTimeout = (manager as any).connectWithTimeout;
  const originalConnect = (manager as any).connect;
  const originalLaunchDevTools = (manager as any).launchDevTools;
  const originalResolveAuto = (manager as any).resolveAutoLaunchProjectPath;

  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: false, error: "ECONNREFUSED" });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "connect ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;
  (manager as any).connectWithTimeout = async () => {
    throw new Error("must not connect when remote endpoint refused auto-launch");
  };
  (manager as any).connect = async () => {
    throw new Error("must not call connect()");
  };
  (manager as any).launchDevTools = async () => {
    throw new Error("must not spawn cli auto for remote endpoint");
  };
  (manager as any).resolveAutoLaunchProjectPath = async () => {
    throw new Error("must short-circuit before resolving project path");
  };

  try {
    await assert.rejects(
      () =>
        manager.withMiniProgram(
          {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
          },
          {
            overrides: {
              mode: "connect",
              wsEndpoint: "ws://10.0.0.5:9420",
              args: undefined,
            },
          },
          async () => null
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("[PORT_NOT_LISTENING_REMOTE_ENDPOINT]")
    );
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
    (manager as any).connectWithTimeout = originalConnectWithTimeout;
    (manager as any).connect = originalConnect;
    (manager as any).launchDevTools = originalLaunchDevTools;
    (manager as any).resolveAutoLaunchProjectPath = originalResolveAuto;
  }
});

test("withMiniProgram triggers cli auto and proceeds to connect when port becomes ready", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;
  const originalConnectWithTimeout = (manager as any).connectWithTimeout;
  const originalGetDefaultProject = (manager as any).getDefaultProject;
  const originalIsValidProject = (manager as any).isValidWeappProject;
  const originalLaunchDevTools = (manager as any).launchDevTools;
  const originalWaitForPort = (manager as any).waitForPortListening;
  const originalSaveProjectPath = (manager as any).saveProjectPath;
  const originalAttachLogging = (manager as any).attachLogging;
  const originalPersistStateMeta = (manager as any).persistStateMeta;

  let launchCalled = false;
  let launchWaitTimeout: number | null = null;
  let connectedProjectPath: string | undefined;
  (manager as any).isPortInUse = async () => false;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: false, error: "ECONNREFUSED" });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "connect ECONNREFUSED",
  });
  (manager as any).isDevToolsProcessRunning = async () => false;
  (manager as any).getDefaultProject = async () => "/tmp/fake-mp";
  (manager as any).isValidWeappProject = async () => true;
  (manager as any).launchDevTools = async () => {
    launchCalled = true;
  };
  (manager as any).waitForPortListening = async (_port: number, timeoutMs: number) => {
    launchWaitTimeout = timeoutMs;
    return true;
  };
  (manager as any).saveProjectPath = async () => {};
  (manager as any).attachLogging = () => {};
  (manager as any).persistStateMeta = async () => {};
  const fakeMiniProgram = {
    on: () => {},
    removeAllListeners: () => {},
    disconnect: () => {},
    close: async () => {},
    currentPage: async () => null,
  };
  (manager as any).connectWithTimeout = async () => fakeMiniProgram;

  try {
    const result = await manager.withMiniProgram(
      {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      {
        overrides: {
          mode: "connect",
          wsEndpoint: "ws://127.0.0.1:9420",
          launchTimeout: 12345,
          args: undefined,
        },
      },
      async (_miniProgram, config) => {
        connectedProjectPath = config.projectPath;
        return "ok";
      }
    );
    assert.equal(result, "ok");
    assert.equal(launchCalled, true);
    assert.equal(launchWaitTimeout, 12345);
    assert.equal(connectedProjectPath, "/tmp/fake-mp");
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
    (manager as any).connectWithTimeout = originalConnectWithTimeout;
    (manager as any).getDefaultProject = originalGetDefaultProject;
    (manager as any).isValidWeappProject = originalIsValidProject;
    (manager as any).launchDevTools = originalLaunchDevTools;
    (manager as any).waitForPortListening = originalWaitForPort;
    (manager as any).saveProjectPath = originalSaveProjectPath;
    (manager as any).attachLogging = originalAttachLogging;
    await manager.close();
    (manager as any).persistStateMeta = originalPersistStateMeta;
  }
});

test("diagnoseConnection blocks launch when DevTools process is already running", async () => {
  const manager = new WeappAutomatorManager();
  const originalPortInUse = (manager as any).isPortInUse;
  const originalProbeWs = (manager as any).probeWebSocketEndpoint;
  const originalProbeHttp = (manager as any).probeHttpEndpoint;
  const originalProcess = (manager as any).isDevToolsProcessRunning;

  (manager as any).isPortInUse = async () => true;
  (manager as any).probeWebSocketEndpoint = async () => ({ ok: true, error: null });
  (manager as any).probeHttpEndpoint = async () => ({
    ok: false,
    statusCode: null,
    bodySnippet: null,
    error: "skipped",
  });
  (manager as any).isDevToolsProcessRunning = async () => true;

  try {
    const diagnosis = await manager.diagnoseConnection(
      {
        mode: "launch",
        projectPath: "/tmp/demo-project",
        port: 9420,
        args: undefined,
      },
      { strictMode: false }
    );

    assert.equal(diagnosis.reasonCode, "IDE_ALREADY_RUNNING");
    assert.equal(diagnosis.safeToLaunch, false);
  } finally {
    (manager as any).isPortInUse = originalPortInUse;
    (manager as any).probeWebSocketEndpoint = originalProbeWs;
    (manager as any).probeHttpEndpoint = originalProbeHttp;
    (manager as any).isDevToolsProcessRunning = originalProcess;
  }
});

test("project selection uses 1-based indices and keeps candidates after invalid input", async () => {
  const manager = new WeappAutomatorManager();
  const projects = [
    { name: "A", path: "/projects/a" },
    { name: "B", path: "/projects/b" },
  ];
  (manager as any).pendingProjects = projects;
  (manager as any).savePendingProjects = async () => {};

  assert.equal(await manager.consumePendingProject("0"), null);
  assert.deepEqual(manager.getPendingProjects(), projects);
  assert.deepEqual(await manager.consumePendingProject("1"), projects[0]);
});

test("project selection rejects ambiguous names without consuming candidates", async () => {
  const manager = new WeappAutomatorManager();
  const projects = [
    { name: "demo", path: "/projects/a/demo" },
    { name: "demo", path: "/projects/b/demo" },
  ];
  (manager as any).pendingProjects = projects;
  (manager as any).savePendingProjects = async () => {};

  assert.equal(await manager.consumePendingProject("demo"), null);
  assert.deepEqual(manager.getPendingProjects(), projects);
  assert.deepEqual(await manager.consumePendingProject("/projects/b/demo"), projects[1]);
});

test("mp_listProjects returns 1-based indices and seeds project selection", async () => {
  const manager = new WeappAutomatorManager();
  const projects = [
    { name: "A", path: "/projects/a" },
    { name: "B", path: "/projects/b" },
  ];
  let pendingProjects: typeof projects | null = null;
  (manager as any).listRecentProjects = async () => projects;
  (manager as any).getDefaultProject = async () => null;
  (manager as any).setPendingProjects = async (pending: typeof projects) => {
    pendingProjects = pending;
  };

  const tool = createApplicationTools(manager).find((candidate) => candidate.name === "mp_listProjects");
  const result = await (tool as any).execute({}, { log: logger });
  const payload = JSON.parse(result.content[0].text);

  assert.deepEqual(payload.projects.map((project: { index: number }) => project.index), [1, 2]);
  assert.deepEqual(pendingProjects, projects);
});

test("mp_healthCheck reports disconnected state without calling withMiniProgram", async () => {
  const manager = new WeappAutomatorManager();
  let withMiniProgramCalled = false;
  let activePageSnapshotCalled = false;
  (manager as any).withMiniProgram = async () => {
    withMiniProgramCalled = true;
    throw new Error("healthCheck must not establish a session");
  };
  (manager as any).getConnectionSnapshot = async () => ({
    devtoolsOnline: false,
    wsReachable: false,
    automatorConnected: false,
    connectionMode: "connect",
    projectPath: null,
    wsEndpoint: "ws://127.0.0.1:9420",
    port: 9420,
    sessionId: null,
  });
  (manager as any).getLogStatus = async () => ({
    listenerAttached: false,
    lastLogAt: null,
    lastListenerBindAt: null,
    logStoreMode: "persisted",
    sessionId: null,
    sourceProjectPath: null,
    logCount: 0,
    recentTypes: [],
  });
  (manager as any).getActivePageSnapshot = async () => {
    activePageSnapshotCalled = true;
    return null;
  };

  const tool = createApplicationTools(manager).find((candidate) => candidate.name === "mp_healthCheck");
  const result = await (tool as any).execute({}, { log: logger });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(withMiniProgramCalled, false);
  assert.equal(activePageSnapshotCalled, false);
  assert.equal(payload.summary, "disconnected");
  assert.equal(payload.needsRecovery, true);
});

test("persisted state writes are serialized and use independent temp files", async () => {
  const originalConfigFile = (WeappAutomatorManager as any).CONFIG_FILE;
  const tempDir = await mkdtemp(join(tmpdir(), "weapp-mcp-state-"));
  const configFile = join(tempDir, "state.json");
  (WeappAutomatorManager as any).CONFIG_FILE = configFile;
  const managers = [new WeappAutomatorManager(), new WeappAutomatorManager()];
  const baseState = {
    lastProjectPath: null,
    pendingProjects: [],
    consoleLogs: [],
    sessionId: null,
    listenerAttached: false,
    lastLogAt: null,
    lastListenerBindAt: null,
    logStoreMode: "persisted",
    sourceProjectPath: null,
  };

  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (managers[index % managers.length] as any).writePersistedState({
          ...baseState,
          lastProjectPath: `/projects/${index}`,
        })
      )
    );
    assert.equal(results.filter((result) => result.status === "rejected").length, 0);
    const persisted = await readFile(configFile, "utf-8");
    assert.doesNotThrow(() => JSON.parse(persisted));
    assert.deepEqual(await readdir(tempDir), ["state.json"]);
  } finally {
    (WeappAutomatorManager as any).CONFIG_FILE = originalConfigFile;
    await rm(tempDir, { recursive: true, force: true });
  }
});
