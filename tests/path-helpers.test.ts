import { strict as assert } from "node:assert";
import test from "node:test";

import {
  clampJsonByBytes,
  getByPath,
  pickByPaths,
} from "../src/tools/common.js";

test("getByPath handles dot path", () => {
  const target = { a: { b: { c: 42 } } };
  assert.equal(getByPath(target, "a.b.c"), 42);
});

test("getByPath handles array index in bracket form", () => {
  const target = { list: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  assert.equal(getByPath(target, "list[1].id"), 2);
});

test("getByPath supports negative array index for tail access", () => {
  const target = { history: [{ stage: "a" }, { stage: "b" }, { stage: "c" }] };
  assert.equal(getByPath(target, "history[-1].stage"), "c");
});

test("getByPath returns array length via `.length`", () => {
  const target = { items: [10, 20, 30] };
  assert.equal(getByPath(target, "items.length"), 3);
});

test("getByPath returns undefined for missing intermediate", () => {
  const target = { a: null };
  assert.equal(getByPath(target, "a.b.c"), undefined);
});

test("pickByPaths flattens chosen fields and reports misses", () => {
  const data = {
    isSearching: true,
    history: [{ id: 1 }, { id: 2 }],
  };
  const picked = pickByPaths(data, [
    "isSearching",
    "history.length",
    "userInfo.nick",
    "noSuchKey",
  ]);
  assert.equal(picked.values["isSearching"], true);
  assert.equal(picked.values["history.length"], 2);
  assert.deepEqual(picked.missing.sort(), ["noSuchKey", "userInfo.nick"]);
});

test("clampJsonByBytes returns truncated marker when payload exceeds maxBytes", () => {
  const big = { text: "a".repeat(2000) };
  const result = clampJsonByBytes(big, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.bytes > 100);
  assert.ok(typeof result.value === "string" && result.value.includes("[truncated"));
});

test("clampJsonByBytes leaves payload intact when below maxBytes", () => {
  const small = { ok: true };
  const result = clampJsonByBytes(small, 1024);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.value, small);
});

test("clampJsonByBytes leaves payload intact when maxBytes omitted", () => {
  const payload = { x: 1 };
  const result = clampJsonByBytes(payload);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.value, payload);
});

test("clampJsonByBytes truncates multibyte content without exceeding maxBytes head budget", () => {
  const payload = { text: "中文文本".repeat(500) + "🎉".repeat(100) };
  const maxBytes = 200;
  const result = clampJsonByBytes(payload, maxBytes);
  assert.equal(result.truncated, true);
  assert.equal(typeof result.value, "string");
  // head + suffix marker; head must not exceed (maxBytes - 32) bytes; total may add the suffix marker.
  const valueStr = result.value as string;
  assert.ok(valueStr.includes("[truncated"));
  // Ensure head portion (before "...[truncated") is byte-bounded by the budget.
  const headOnly = valueStr.split("...[truncated")[0];
  const headBytes = Buffer.byteLength(headOnly, "utf8");
  assert.ok(
    headBytes <= maxBytes - 32,
    `head bytes ${headBytes} exceeds budget ${maxBytes - 32}`
  );
  // Should not contain the U+FFFD replacement char from a partial multibyte cut.
  assert.ok(!valueStr.includes("�"), "must not contain U+FFFD replacement");
});

test("getByPath does not walk Object prototype", () => {
  const target: Record<string, unknown> = { a: 1 };
  assert.equal(getByPath(target, "toString"), undefined);
  assert.equal(getByPath(target, "hasOwnProperty"), undefined);
  assert.equal(getByPath(target, "__proto__"), undefined);
  assert.equal(getByPath(target, "constructor"), undefined);
});

test("getByPath returns own property values normally", () => {
  const target = { ok: true, nested: { v: 7 } };
  assert.equal(getByPath(target, "ok"), true);
  assert.equal(getByPath(target, "nested.v"), 7);
});

test("getByPath returns undefined for non-numeric segments on arrays except length", () => {
  const target = { list: [1, 2, 3] };
  assert.equal(getByPath(target, "list.length"), 3);
  assert.equal(getByPath(target, "list.foo"), undefined);
});

test("getByPath wildcard [*] maps over array elements", () => {
  const target = {
    conversationHistory: [
      { id: "a", aiStatus: "pending" },
      { id: "b", aiStatus: "completed" },
      { id: "c", aiStatus: "completed" },
    ],
  };
  assert.deepEqual(
    getByPath(target, "conversationHistory[*].aiStatus"),
    ["pending", "completed", "completed"]
  );
  assert.deepEqual(
    getByPath(target, "conversationHistory.*.id"),
    ["a", "b", "c"]
  );
});

test("getByPath wildcard returns the array itself when no rest segments", () => {
  const target = { items: [1, 2, 3] };
  assert.deepEqual(getByPath(target, "items[*]"), [1, 2, 3]);
});

test("getByPath wildcard on non-array returns undefined", () => {
  const target = { items: { a: 1, b: 2 } };
  assert.equal(getByPath(target, "items[*].a"), undefined);
});

test("getByPath wildcard yields undefined slots for missing inner fields", () => {
  const target = {
    list: [{ x: 1 }, { y: 2 }, { x: 3 }],
  };
  assert.deepEqual(getByPath(target, "list[*].x"), [1, undefined, 3]);
});

test("pickByPaths supports wildcard projection on large nested arrays", () => {
  const target = {
    history: [
      { id: 1, status: "ok", payload: { huge: "x".repeat(100) } },
      { id: 2, status: "fail", payload: { huge: "x".repeat(100) } },
    ],
  };
  const picked = pickByPaths(target, [
    "history[*].id",
    "history[*].status",
    "history.length",
  ]);
  assert.deepEqual(picked.values, {
    "history[*].id": [1, 2],
    "history[*].status": ["ok", "fail"],
    "history.length": 2,
  });
  assert.deepEqual(picked.missing, []);
});
