import assert from "node:assert/strict";
import test from "node:test";
import { decodeJsonResponse, JsonResponseCodecError } from "../src/network-codecs.js";

test("codec failures distinguish single error envelopes without retaining their contents", () => {
  for (const [body, expected] of [
    ['for (;;);{"error":123,"errorDescription":"private-token"}', { lines: 1, singleJson: true, errorEnvelope: true, html: false }],
    ['{"items":["private-token"]}', { lines: 1, singleJson: true, errorEnvelope: false, html: false }],
    ['<html>private-token</html>', { lines: 1, singleJson: false, errorEnvelope: false, html: true }],
  ] as const) {
    assert.throws(() => decodeJsonResponse(body, "json-lines"), (error) => {
      assert.ok(error instanceof JsonResponseCodecError);
      assert.deepEqual(error.diagnostic, { ...expected, category: "unclassified", ...(expected.errorEnvelope ? { applicationErrorCode: 123 } : {}) });
      assert.doesNotMatch(JSON.stringify(error), /private-token/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
  }
});

test("wrapped error descriptions yield bounded categories and numeric application codes only", () => {
  const error = new JsonResponseCodecError('{"error":1234,"errorDescription":{"__html":"<b>Please log in</b> private-token"}}');
  assert.equal(error.diagnostic.category, "authentication");
  assert.equal(error.diagnostic.applicationErrorCode, 1234);
  assert.doesNotMatch(JSON.stringify(error), /private-token|Please|<b>/);
  const opaque = new JsonResponseCodecError('{"error":"private-token"}');
  assert.equal(opaque.diagnostic.applicationErrorCode, undefined);
});

test("server error categories are bounded hints, never raw text or success signals", () => {
  for (const [message, category] of [
    ["Please log in", "authentication"], ["Access denied", "access-restriction"],
    ["Too many requests", "throttling"], ["Invalid request token", "request-validation"],
    ["Something went wrong", "temporary-server-error"], ["Unrecognized error", "unclassified"],
  ]) {
    const error = new JsonResponseCodecError(JSON.stringify({ error: 1, errorDescription: message + " private-value" }));
    assert.equal(error.diagnostic.category, category);
    assert.doesNotMatch(JSON.stringify(error), /private-value/);
  }
});
