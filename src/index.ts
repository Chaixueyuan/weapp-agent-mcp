#!/usr/bin/env node

import { FastMCP } from "fastmcp";

import { createPrompts } from "./prompts.js";
import { createTools } from "./tools.js";
import { WeappAutomatorManager } from "./weappClient.js";
import { globalTimeoutMs } from "./config.js";
import { SERVER_VERSION } from "./version.js";

const manager = new WeappAutomatorManager();

const server = new FastMCP({
  name: "weapp-agent-mcp",
  version: SERVER_VERSION,
  instructions:
    "Controls WeChat Mini Program projects through WeChat DevTools using miniprogram-automator. Use mp_ensureConnection as the default connection entry point; use mp_diagnoseConnection only for a read-only diagnosis when requested or after ensure/recovery fails. When a local automation port is not listening, mp_ensureConnection auto-launches WeChat DevTools via cli auto unless autoLaunch=false, using projectPath / WEAPP_PROJECT_PATH / persisted last project / current working directory (must contain project.config.json). Do not run cli open or cli quit yourself, and do not switch ports automatically after a failed connection. Use mp_healthCheck after an operation fails or when status is requested; call mp_recoverConnection only when healthCheck reports needsRecovery=true. If the server asks for project selection, call mp_listProjects or retry mp_ensureConnection with projectSelection. Treat mp_screenshot as a serialized single-lane capability rather than a parallel-safe one. Prefer shorter, segmented scenarios.",
});

const tools = createTools(manager).map(tool => ({
  ...tool,
  timeoutMs: tool.timeoutMs ?? globalTimeoutMs
}));
server.addTools(tools);
server.addPrompts(createPrompts());

server.on("disconnect", async () => {
  await manager.close();
  process.exit(0);
});

await server.start({
  transportType: "stdio",
});
