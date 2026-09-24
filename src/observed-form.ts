import { load } from 'cheerio';

/** Experimental trusted broker helper, not model-generated code. The caller
 * must separately authorize the exact endpoint and allowed input overrides.
 * Returned fields may include ephemeral CSRF values: never persist them raw. */
export function observedFormFields(html:string,action:string,fieldSelector:string,overrides:Record<string,string>) {
  const $=load(html),forms=$('form').filter((_i,f)=>!!$(f).find(fieldSelector).length);
  if(forms.length!==1||forms.attr('action')!==action||forms.attr('method')?.toLowerCase()!=='post')throw new Error('Unexpected read form');
  const fields:Record<string,string>=Object.create(null);
  forms.find('input[name],select[name]').each((_i,el)=>{
    const control=$(el),name=control.attr('name')!,type=control.attr('type')??'';
    if(control.is('[disabled]')||['button','submit','reset','file'].includes(type)||(['checkbox','radio'].includes(type)&&!control.is('[checked]')))return;
    if(Object.hasOwn(fields,name))throw new Error('Repeated form field is unsupported');
    fields[name]=el.tagName==='select'?(control.find('option[selected]').first().attr('value')??control.find('option').first().attr('value')??''):(control.attr('value')??'');
  });
  const submitters=forms.find('button[name][type="submit"],button[name]:not([type]),input[name][type="submit"]').not('[disabled]');
  if(submitters.length!==1||Object.hasOwn(fields,submitters.attr('name')!))throw new Error('Ambiguous form submitter');
  fields[submitters.attr('name')!]=submitters.attr('value')??'';
  for(const [name,value]of Object.entries(overrides)) {
    if(!Object.hasOwn(fields,name))throw new Error('Unknown form override');fields[name]=value;
  }
  return fields;
}
