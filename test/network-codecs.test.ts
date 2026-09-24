import assert from "node:assert/strict";
import test from "node:test";
import { decodeJsonResponse, inferJsonResponse, decodeRelativeUrl, encodeRelativeUrl } from "../src/network-codecs.js";

test("bounded JSON-line codec preserves frames and rejects incomplete or executable input", () => {
  const source = 'for (;;);{"items":[1]}\r\nfor (;;);{"items":[2]}';
  assert.deepEqual(inferJsonResponse(source), { codec: "json-lines", value: [{ items: [1] }, { items: [2] }] });
  assert.throws(() => decodeJsonResponse(source, "json"), /declared codec/);
  assert.throws(() => decodeJsonResponse('{"items":[1]}', "json-lines"), /declared codec/);
  for (const bad of ['{}\n{"unfinished":', '{}\nalert(1)', Array(129).fill('{}').join('\n')]) {
    assert.throws(() => decodeJsonResponse(bad, "json-lines"), /declared codec/);
  }
  assert.deepEqual(inferJsonResponse('[1,2]'), { codec: "json", value: [1, 2] });
});

test("nested URL form value round-trips punctuation without changing URL structure", () => {
  const parsed = decodeRelativeUrl('/search?q=sofa%20beds&sort=new&tag=a&tag=b')!;
  parsed.query.q = ['A&B + # /? = café'];
  const outer = new URLSearchParams({ target: encodeRelativeUrl(parsed) });
  const restored = decodeRelativeUrl(new URLSearchParams(outer.toString()).get('target')!)!;
  assert.equal(restored.query.q![0], 'A&B + # /? = café');
  assert.deepEqual(restored.query.tag, ['a', 'b']);
  for (const bad of ['//evil.test/search?q=a', '/\\evil.test/search?q=a', '/search?q=a#fragment', 'https://evil.test/?q=a']) {
    assert.equal(decodeRelativeUrl(bad), null);
  }
  assert.throws(() => encodeRelativeUrl({ pathname: '//evil.test', query: { q: ['a'] } }), /Unsafe/);
});
