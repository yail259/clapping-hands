import assert from "node:assert/strict";
import test from "node:test";
import { RequestContextVault, requestOperationFingerprint, type RequestContextScope } from "../src/request-context.js";

test("runtime secrets stay out of tickets and serialization, and use is reserved once", () => {
  const vault = new RequestContextVault(() => 100);
  const scope: RequestContextScope = { profile: {}, epoch: "browser-1", origin: "https://fixture.invalid", operation: requestOperationFingerprint({ method: "POST", path: "/read", fields: ["nonce"] }) };
  const ticket = vault.issue(scope, ["fixture-secret"], { ttlMs: 1000, maximumUses: 1 });
  assert.doesNotMatch(JSON.stringify({ vault, ticket }), /fixture-secret/);
  assert.deepEqual(vault.consume(ticket, scope), ["fixture-secret"]);
  assert.throws(() => vault.consume(ticket, scope), /unavailable/);
});

test("context cannot cross profiles, browser epochs, operations, origins or expiry", () => {
  let now = 100;
  const vault = new RequestContextVault(() => now);
  const scope: RequestContextScope = { profile: {}, epoch: "browser-1", origin: "https://fixture.invalid", operation: requestOperationFingerprint({ path: "/read" }) };
  const ticket = vault.issue(scope, ["fixture-secret"], { ttlMs: 1000, maximumUses: 2 });
  for (const other of [{ ...scope, profile: {} }, { ...scope, epoch: "browser-2" },
    { ...scope, operation: requestOperationFingerprint({ path: "/write" }) }, { ...scope, origin: "https://other.invalid" }]) {
    assert.throws(() => vault.consume(ticket, other), /out of scope/);
  }
  assert.deepEqual(vault.consume(ticket, scope), ["fixture-secret"]);
  now = 1100;
  assert.throws(() => vault.consume(ticket, scope), /stale/);
  const refreshed = vault.issue({ ...scope, epoch: "browser-2" }, ["fresh-fixture-secret"], { ttlMs: 1000, maximumUses: 1 });
  assert.throws(() => new RequestContextVault().consume(refreshed, scope), /unavailable/);
  vault.invalidate(scope.profile);
  assert.throws(() => vault.consume(refreshed, { ...scope, epoch: "browser-2" }), /unavailable/);
});
