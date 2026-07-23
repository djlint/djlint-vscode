import { expect, test } from "vitest";
import { createEnvironmentChangeCache } from "../environment-cache.js";

test("record() reports a change the first time a scope is seen", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  expect(cache.record("uri-a", "env-a")).toBe(true);
});

test("record() reports no change when the value is identical", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  cache.record("uri-a", "env-a");
  expect(cache.record("uri-a", "env-a")).toBe(false);
});

test("record() reports a change when the value differs", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  cache.record("uri-a", "env-a");
  expect(cache.record("uri-a", "env-b")).toBe(true);
});

test("record() uses deep equality, not reference equality", () => {
  const cache = createEnvironmentChangeCache<{ sysPrefix: string }>();
  cache.record("uri-a", { sysPrefix: "/env" });
  expect(cache.record("uri-a", { sysPrefix: "/env" })).toBe(false);
});

test("scopes are tracked independently", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  cache.record("uri-a", "env-a");
  expect(cache.record("uri-b", "env-a")).toBe(true);
});

test("undefined key is treated as the shared workspace scope", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  cache.record(void 0, "env-a");
  expect(cache.record(void 0, "env-a")).toBe(false);
  expect(cache.record(void 0, "env-b")).toBe(true);
});

test("remember() stores a value without reporting a change", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  cache.remember("uri-a", "env-a");
  // A subsequent record() with the same value now reports "no change".
  expect(cache.record("uri-a", "env-a")).toBe(false);
});

test("null is a distinct value from never having recorded anything", () => {
  const cache = createEnvironmentChangeCache<string | null>();
  expect(cache.record("uri-a", null)).toBe(true);
  expect(cache.record("uri-a", null)).toBe(false);
});
