import { strict as assert } from "node:assert";
import test from "node:test";

import { ConfigError, resolveConfig } from "../src/config.js";
import { WeappAutomatorManager } from "../src/weappClient.js";

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

  let launchCalled = false;
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
  (manager as any).waitForPortListening = async () => true;
  (manager as any).saveProjectPath = async () => {};
  (manager as any).attachLogging = () => {};
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
          args: undefined,
        },
      },
      async () => "ok"
    );
    assert.equal(result, "ok");
    assert.equal(launchCalled, true);
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
