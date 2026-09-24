import test from 'node:test';
import assert from 'node:assert/strict';
import { observedFormFields } from '../src/observed-form.js';
const endpoint='https://example.invalid/search';
const html=`<form action="${endpoint}" method="post"><input id="keywords" name="keywords" value="previous"><input type="hidden" name="form_token" value="ephemeral-fixture"><input type="checkbox" name="unchecked" value="1"><input type="checkbox" checked name="checked" value="1"><input disabled name="disabled"><button type="button" name="reset">Reset</button><button name="adv_search">Update results</button></form>`;
test('form broker includes the clicked submitter and live hidden state',()=>{
  assert.deepEqual({...observedFormFields(html,endpoint,'#keywords',{keywords:'new'})},{keywords:'new',form_token:'ephemeral-fixture',checked:'1',adv_search:''});
});
test('form broker refuses changed endpoints, unknown overrides and ambiguous submitters',()=>{
  assert.throws(()=>observedFormFields(html,'https://other.invalid/search','#keywords',{}));
  assert.throws(()=>observedFormFields(html,endpoint,'#keywords',{unknown:'x'}));
  assert.throws(()=>observedFormFields(html.replace('</form>','<button name="other">Other</button></form>'),endpoint,'#keywords',{}));
});
