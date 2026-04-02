#!/usr/bin/env node

import { FastMCP } from "fastmcp";

import { createPrompts } from "./prompts.js";
import { createTools } from "./tools.js";
import { WeappAutomatorManager } from "./weappClient.js";
import { globalTimeoutMs } from "./config.js";

const manager = new WeappAutomatorManager();

const server = new FastMCP({
  name: "weapp-dev-mcp",
  version: "0.2.2",
  instructions:
    "Controls WeChat Mini Program projects through WeChat DevTools using miniprogram-automator. Call mp_ensureConnection before mp_screenshot, page_*, or element_* tools. If connection fails, prefer one guided retry with reconnect=true. If the server asks for project selection, call mp_listProjects or retry mp_ensureConnection with projectSelection instead of blindly repeating the same call.",
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
