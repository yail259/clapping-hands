import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreSavedJsonExchange, loadSavedJsonCapture } from '../src/saved-json-capture.js';
import { saveEvidenceBundle } from '../src/evidence-bundle.js';
import { browserDecodedResponseText } from '../src/captured-response.js';

const exchange={url:'https://fixture.invalid/search?q=chair',method:'GET',resourceType:'fetch',
  requestHeaders:{accept:'application/json',cookie:'private-cookie'},requestBody:'',responseStatus:200,
  responseHeaders:{'content-type':'application/json','set-cookie':'private-cookie'},responseBody:JSON.stringify({items:[{title:'Chair'}]})};

test('saved JSON capture restores after persistence without cookies or browser provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'saved-json-'));
  const saved=await saveEvidenceBundle(dir,{exchanges:[exchange]});
  const result=await loadSavedJsonCapture(dir,saved.id);
  assert.equal(result.exchanges.length,1);
  assert.deepEqual(JSON.parse(result.exchanges[0]!.responseBody),{items:[{title:'Chair'}]});
  assert.equal(result.exchanges[0]!.requestBody,'');
  assert.equal(browserDecodedResponseText(result.exchanges[0]!),undefined);
  assert.ok(!JSON.stringify(result.exchanges).includes('cookie'));
  await writeFile(join(dir,saved.id,'evidence.json'),'{}');
  await assert.rejects(loadSavedJsonCapture(dir,saved.id),/integrity/);
});

test('restoration refuses lost requests, HTML, removed inputs and invalid destinations',()=>{
  const base={...exchange,responseBody:{format:'json',data:{items:[1]}}};
  for(const patch of [{requestBody:'[OMITTED]'},{requestBody:{format:'form',data:{q:['chair']}}},
    {requestBody:{format:'json',data:{q:'[REDACTED]'}}},{responseBody:{format:'html',data:'<html></html>'}},
    {url:'https://user:password@fixture.invalid/'},{url:'https://fixture.invalid/?q=%5BREDACTED%5D'},
    {responseStatus:403},{responseBody:{format:'json',data:'x'.repeat(1_000_001)}}])
    assert.equal(restoreSavedJsonExchange({...base,...patch}).restored,false);
});

test('JSON requests and response frame boundaries remain explicit sanitized semantics',()=>{
  const result=restoreSavedJsonExchange({...exchange,method:'POST',requestBody:{format:'json',data:{q:'chair'}},
    responseBody:{format:'json-lines',data:[{items:[1]},{items:[2],token:'[OMITTED]'}]}});
  assert.ok(result.restored);
  assert.deepEqual(JSON.parse(result.exchange.requestBody),{q:'chair'});
  assert.deepEqual(result.exchange.responseBody.split('\n').map(x=>JSON.parse(x)),[{items:[1]},{items:[2],token:'[OMITTED]'}]);
});
