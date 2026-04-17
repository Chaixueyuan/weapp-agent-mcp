#!/usr/bin/env node

import { FastMCP } from "fastmcp";

import { createPrompts } from "./prompts.js";
import { createTools } from "./tools.js";
import { WeappAutomatorManager } from "./weappClient.js";
import { globalTimeoutMs } from "./config.js";

const manager = new WeappAutomatorManager();

const server = new FastMCP({
  name: "weapp-agent-mcp",
  version: "0.3.0",
  instructions:
    "Controls WeChat Mini Program projects through WeChat DevTools using miniprogram-automator. Prefer mp_diagnoseConnection before mp_ensureConnection, then run mp_healthCheck before mp_screenshot, page_*, or element_* tools. If the user already opened WeChat DevTools, do not instruct cli open, cli auto, or cli quit, and do not switch ports automatically after a failed connection. If healthCheck shows recovery is needed, prefer mp_recoverConnection instead of blindly retrying page actions. If the server asks for project selection, call mp_listProjects or retry mp_ensureConnection with projectSelection instead of blindly repeating the same call. Treat mp_screenshot as a serialized single-lane capability rather than a parallel-safe one. Prefer shorter, segmented scenarios instead of one long high-pressure scenario, and after repeated screenshot/snapshot failures run mp_healthCheck and then mp_recoverConnection if needed.",
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
