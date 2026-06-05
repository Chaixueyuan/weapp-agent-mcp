import { strict as assert } from "node:assert";
import test from "node:test";

import { WeappAutomatorManager } from "../src/weappClient.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// 截图连败计数：>=2 时 mp_screenshot 会短路跳过（环境截图通道不通时不再白等超时）。
test("screenshot failure streak accumulates across capture failures", () => {
  const m = new WeappAutomatorManager();
  assert.equal(m.getScreenshotStatus().failureStreak, 0);
  m.recordScreenshotResult(false, "SCREENSHOT_TIMEOUT");
  assert.equal(m.getScreenshotStatus().failureStreak, 1);
  m.recordScreenshotResult(false, "UNKNOWN");
  // 用户复现：UNKNOWN×2 + TIMEOUT×1 同源——到 2 即触发短路阈值
  assert.equal(m.getScreenshotStatus().failureStreak, 2);
});

test("a successful screenshot resets the failure streak", () => {
  const m = new WeappAutomatorManager();
  m.recordScreenshotResult(false, "UNKNOWN");
  m.recordScreenshotResult(false, "SCREENSHOT_TIMEOUT");
  assert.equal(m.getScreenshotStatus().failureStreak, 2);
  m.recordScreenshotResult(true);
  assert.equal(m.getScreenshotStatus().failureStreak, 0);
});

test("SIMULATOR_HIDDEN does not count toward the streak (it is user-fixable)", () => {
  const m = new WeappAutomatorManager();
  m.recordScreenshotResult(false, "SIMULATOR_HIDDEN");
  m.recordScreenshotResult(false, "SIMULATOR_HIDDEN");
  assert.equal(m.getScreenshotStatus().failureStreak, 0);
});

test("LOCAL_OUTPUT_ERROR does not count toward the screenshot-channel streak", () => {
  const m = new WeappAutomatorManager();
  m.recordScreenshotResult(false, "LOCAL_OUTPUT_ERROR");
  m.recordScreenshotResult(false, "LOCAL_OUTPUT_ERROR");
  assert.equal(m.getScreenshotStatus().failureStreak, 0);
});

test("screenshot status resets when the connection target changes", () => {
  const m = new WeappAutomatorManager();
  const first = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  const second = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9520",
  };

  (m as any).syncScreenshotTarget(first);
  m.recordScreenshotResult(false, "UNKNOWN");
  m.recordScreenshotResult(false, "SCREENSHOT_TIMEOUT");
  (m as any).syncScreenshotTarget(first);
  assert.equal(m.getScreenshotStatus().failureStreak, 2);

  (m as any).syncScreenshotTarget(second);
  assert.deepEqual(m.getScreenshotStatus(), {
    lastScreenshotAt: null,
    lastScreenshotOk: null,
    lastScreenshotErrorCode: null,
    failureStreak: 0,
  });
});

test("targeted screenshot status does not expose another target", () => {
  const m = new WeappAutomatorManager();
  const first = {
    mode: "connect",
    wsEndpoint: "ws://127.0.0.1:9420",
  };
  (m as any).config = first;
  (m as any).syncScreenshotTarget(first);
  m.recordScreenshotResult(false, "UNKNOWN");

  assert.equal(
    m.getScreenshotStatus({
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9520",
    }).lastScreenshotAt,
    null
  );
  assert.equal(m.getScreenshotStatus(first).failureStreak, 1);
});

test("serialized screenshot lane stays occupied until a timed-out capture settles", async () => {
  const m = new WeappAutomatorManager();
  (m as any).screenshotCooldownMs = 0;
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = m.runSerializedScreenshot(
    logger,
    async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return "first";
    },
    { timeoutMs: 10, description: "first screenshot" }
  );

  await assert.rejects(first, /\[REQUEST_TIMEOUT\]/);
  const second = m.runSerializedScreenshot(logger, async () => {
    events.push("second-start");
    return "second";
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  assert.equal(await second, "second");
  assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
});

test("queued screenshot timeout includes time spent waiting for the lane", async () => {
  const m = new WeappAutomatorManager();
  (m as any).screenshotCooldownMs = 0;
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = m.runSerializedScreenshot(
    logger,
    async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    },
    { timeoutMs: 5, description: "first screenshot" }
  );

  await assert.rejects(first, /\[REQUEST_TIMEOUT\]/);
  await assert.rejects(
    m.runSerializedScreenshot(
      logger,
      async () => {
        events.push("second-start");
      },
      { timeoutMs: 5, description: "second screenshot" }
    ),
    /\[REQUEST_TIMEOUT\]/
  );
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await m.runSerializedScreenshot(logger, async () => {
    events.push("third-start");
  });
  assert.deepEqual(events, ["first-start", "first-end", "third-start"]);
});
