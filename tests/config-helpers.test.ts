import { strict as assert } from "node:assert";
import test from "node:test";

import {
  booleanish,
  ConfigError,
  connectionOverridesSchema,
  resolveConfig,
} from "../src/config.js";

// 回归：旧实现 z.coerce.boolean() 走 Boolean() 语义，env "false"/"0"/"no" 全变 true。
test("booleanish maps falsy strings to false (the z.coerce.boolean bug)", () => {
  for (const v of ["false", "0", "no", "off", "FALSE", " off ", ""]) {
    assert.equal(booleanish.parse(v), false, `${JSON.stringify(v)} should be false`);
  }
});

test("booleanish maps truthy strings to true", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
    assert.equal(booleanish.parse(v), true, `${JSON.stringify(v)} should be true`);
  }
});

test("booleanish passes real booleans through unchanged", () => {
  assert.equal(booleanish.parse(true), true);
  assert.equal(booleanish.parse(false), false);
});

test("booleanish maps numeric 1/0 (backward-compat with z.coerce.boolean)", () => {
  assert.equal(booleanish.parse(1), true);
  assert.equal(booleanish.parse(0), false);
});

test("booleanish rejects other numbers instead of silently coercing to true", () => {
  assert.throws(() => booleanish.parse(2));
  assert.throws(() => booleanish.parse(-1));
});

test("booleanish rejects unknown strings instead of silently coercing", () => {
  assert.throws(() => booleanish.parse("maybe"));
  assert.throws(() => booleanish.parse("2"));
});

test("booleanish.optional() yields undefined for undefined (env not set)", () => {
  assert.equal(booleanish.optional().parse(undefined), undefined);
});

test("booleanish.optional().default(false) applies default when omitted", () => {
  assert.equal(booleanish.optional().default(false).parse(undefined), false);
  assert.equal(booleanish.optional().default(true).parse(undefined), true);
});

// 端到端：env 字符串 "false" 不能再把 trustProject/autoClose/autoLaunch 读成 true。
test("connectionOverridesSchema parses env-style 'false' as false", () => {
  const parsed = connectionOverridesSchema.parse({
    trustProject: "false",
    autoClose: "false",
    autoLaunch: "0",
  });
  assert.equal(parsed.trustProject, false);
  assert.equal(parsed.autoClose, false);
  assert.equal(parsed.autoLaunch, false);
});

test("connectionOverridesSchema parses env-style 'true' as true", () => {
  const parsed = connectionOverridesSchema.parse({
    trustProject: "true",
    autoClose: "1",
  });
  assert.equal(parsed.trustProject, true);
  assert.equal(parsed.autoClose, true);
});

test("connection config rejects ports outside the TCP range", () => {
  assert.throws(() => connectionOverridesSchema.parse({ port: 65536 }));
});

test("numeric connection values accept numeric strings but reject non-numeric JSON values", () => {
  assert.equal(connectionOverridesSchema.parse({ port: "9420" }).port, 9420);
  for (const value of [true, false, null, "", "   "]) {
    assert.throws(
      () => connectionOverridesSchema.parse({ port: value }),
      `${JSON.stringify(value)} should not be coerced to a port`
    );
  }
});

test("connection config caps custom CLI arguments", () => {
  assert.throws(() =>
    connectionOverridesSchema.parse({
      args: Array.from({ length: 101 }, (_, index) => `--arg-${index}`),
    })
  );
  assert.throws(() =>
    connectionOverridesSchema.parse({
      args: Array.from({ length: 101 }, (_, index) => `--arg-${index}`).join(" "),
    })
  );
});

test("resolveConfig wraps schema failures as ConfigError", () => {
  assert.throws(
    () => resolveConfig({ port: 0 } as any),
    (error: unknown) =>
      error instanceof ConfigError &&
      /Invalid connection overrides.*port/.test(error.message)
  );
});

test("an explicit wsEndpoint switches a previous launch config to connect mode", () => {
  const config = resolveConfig(
    { wsEndpoint: "ws://127.0.0.1:9420", args: undefined },
    { mode: "launch", projectPath: "/tmp/project" }
  );

  assert.equal(config.mode, "connect");
  assert.equal(config.wsEndpoint, "ws://127.0.0.1:9420");
});

test("switching to launch mode clears a previous connect endpoint", () => {
  const config = resolveConfig(
    { mode: "launch", projectPath: "/tmp/project", args: undefined },
    { mode: "connect", wsEndpoint: "ws://127.0.0.1:9420" }
  );

  assert.equal(config.mode, "launch");
  assert.equal(config.wsEndpoint, undefined);
});

test("switching connect endpoints does not inherit stale project metadata", () => {
  const config = resolveConfig(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9520",
      args: undefined,
    },
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      projectPath: "/projects/old",
    }
  );

  assert.equal(config.projectPath, undefined);
});

test("equivalent connect endpoints retain current project metadata", () => {
  const config = resolveConfig(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420/",
      args: undefined,
    },
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      projectPath: "/projects/current",
    }
  );

  assert.equal(config.projectPath, "/projects/current");
});

test("an explicit project path is retained when switching connect endpoints", () => {
  const config = resolveConfig(
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9520",
      projectPath: "/projects/new",
      args: undefined,
    },
    {
      mode: "connect",
      wsEndpoint: "ws://127.0.0.1:9420",
      projectPath: "/projects/old",
    }
  );

  assert.equal(config.projectPath, "/projects/new");
});

test("switching from launch to connect does not inherit stale project metadata", () => {
  const config = resolveConfig(
    {
      wsEndpoint: "ws://127.0.0.1:9420",
      args: undefined,
    },
    {
      mode: "launch",
      projectPath: "/projects/old-launch",
    }
  );

  assert.equal(config.mode, "connect");
  assert.equal(config.projectPath, undefined);
});

test("an explicit empty args list clears previous CLI arguments", () => {
  const config = resolveConfig(
    {
      mode: "launch",
      projectPath: "/projects/current",
      args: [],
    },
    {
      mode: "launch",
      projectPath: "/projects/current",
      args: ["--old-flag"],
    }
  );

  assert.deepEqual(config.args, []);
});
