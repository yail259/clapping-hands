import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeEvidence, saveEvidenceBundle, loadEvidenceBundle } from '../src/evidence-bundle.js';

test('non-secret origins and encoded request URLs survive sanitization byte-for-byte',()=>{
  const value={origin:'https://fixture.invalid',url:'https://fixture.invalid/search?q=a%20b',endpointPath:'/search'};
  assert.deepEqual(sanitizeEvidence(value).data,value);
});

test('empty bodies survive persistence distinctly from redacted or opaque bodies', async () => {
  const root=await mkdtemp(join(tmpdir(),'evidence-empty-'));
  const capture={url:'https://fixture.invalid/search',method:'GET',requestBody:'',responseBody:''};
  const safe=sanitizeEvidence(capture);
  assert.deepEqual(safe,{data:capture,omissions:[]});
  const saved=await saveEvidenceBundle(root,capture);
  assert.deepEqual(await loadEvidenceBundle(root,saved.id),capture);
  assert.equal((sanitizeEvidence({requestBody:'opaque-private'}).data as any).requestBody,'[OMITTED]');
  assert.equal((sanitizeEvidence({url:'https://fixture.invalid/auth',requestBody:''}).data as any).requestBody,'[OMITTED]');
});

test('bundle loader refuses symlinked payloads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'evidence-symlink-'));
  const saved=await saveEvidenceBundle(root,{data:'public fixture'});
  const path=join(root,saved.id,'evidence.json');
  await rename(path,join(root,'original.json'));
  await symlink(join(root,'original.json'),path);
  await assert.rejects(loadEvidenceBundle(root,saved.id));
});

test('evidence decodes structured bodies and removes credentials and opaque payloads', () => {
  const result = sanitizeEvidence({
    url: 'https://example.org/search?q=chairs&token=URLSECRET#private',
    requestHeaders: { authorization: 'HEADERSECRET', accept: 'application/json' },
    responseBody: JSON.stringify({ items: [{ title: 'Chair', price: 20 }], csrf_token: 'BODYSECRET' }),
    requestBody: 'password=FORMSECRET', note: 'key PROVIDERSECRET',
    dom: '<html><script>INLINESECRET</script><input type="hidden" value="HIDDENSECRET"><div data-auth="ATTRSECRET">Chair</div></html>',
  }, ['PROVIDERSECRET']);
  const encoded = JSON.stringify(result);
  for (const secret of ['URLSECRET', 'HEADERSECRET', 'BODYSECRET', 'FORMSECRET', 'PROVIDERSECRET', 'INLINESECRET', 'HIDDENSECRET', 'ATTRSECRET']) assert.ok(!encoded.includes(secret), secret);
  assert.ok(encoded.includes('Chair'));
  assert.ok(encoded.includes('chairs'));
  assert.ok(result.omissions.length >= 6);
});

test('bundle has private permissions, integrity hash and explicit omissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clappinghands-evidence-test-'));
  const saved = await saveEvidenceBundle(root, { input: { query: 'chairs' }, outcome: { data: [1, 2] } });
  const dir = join(root, saved.id);
  const raw = await readFile(join(dir, 'evidence.json'), 'utf8');
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'evidence.json'))).mode & 0o777, 0o600);
  assert.ok(manifest.limitations.length);
  assert.deepEqual(JSON.parse(raw).input, { query: 'chairs' });
  assert.deepEqual(await loadEvidenceBundle(root, saved.id), JSON.parse(raw));
  await writeFile(join(dir,'evidence.json'), '{}');
  await assert.rejects(loadEvidenceBundle(root,saved.id), /integrity/);
  await assert.rejects(loadEvidenceBundle(root,'../../private'), /Invalid/);
});
test('form evidence retains repeated fields and nested variables without credentials', () => {
  const result=sanitizeEvidence({requestBody:new URLSearchParams([['query','chairs'],['tag','a'],['tag','b'],['token','hidden-credential'],['variables',JSON.stringify({query:'chairs',password:'another-credential'})]]).toString(),
    dom:'<html><input readonly name="adjustedAmount" value="123.45"><input readonly name="accessToken" value="private-credential"></html>'});
  const encoded=JSON.stringify(result.data);
  assert.ok(encoded.includes('chairs'));assert.ok(encoded.includes('123.45'));
  for(const secret of ['hidden-credential','another-credential','private-credential'])assert.ok(!encoded.includes(secret));
});
test('credential endpoint opaque tokens and relative URL credentials are excluded', () => {
  const result=sanitizeEvidence({exchange:{url:'https://service.invalid/guest/token',responseBody:'"opaque-secret"'},link:'/read?q=chairs&token=relative-secret'});
  const encoded=JSON.stringify(result);
  assert.ok(!encoded.includes('opaque-secret'));assert.ok(!encoded.includes('relative-secret'));assert.ok(encoded.includes('chairs'));
});
test('prefixed JSON and JSON lines remain useful with sensitive fields removed', () => {
  const result=sanitizeEvidence({responseBody:'for (;;);{"items":[1],"token":"private-a"}\n{"items":[2],"secret":"private-b"}'});
  assert.equal((result.data as any).responseBody.format,'json-lines');
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.deepEqual((result.data as any).responseBody.data.map((x:any)=>x.items),[[1],[2]]);
});
