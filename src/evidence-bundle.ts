import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { load } from 'cheerio';
import { regularFileContents } from './workflow-file-lock.js';

// Evidence is private local data, never a publishable benchmark artifact.
// Unknown binary/opaque payloads are omitted instead of guessed safe.
const sensitive = /authorization|cookie|password|passwd|secret|token|csrf|xsrf|api.?key|credential|session|fb_dtsg|jazoest|lsd/i;
const maxTextBytes = 8_000_000;
export type EvidenceOmission = { path: string; reason: string };
export function sanitizeEvidence(value: unknown, secrets: string[] = []) {
  const omissions: EvidenceOmission[] = [];
  const omit = (path: string, reason: string) => { omissions.push({ path, reason }); return '[OMITTED]'; };
  function text(raw: string, path: string): string {
    if (Buffer.byteLength(raw) > maxTextBytes) return omit(path, 'size-limit');
    let result = raw;
    for (const secret of secrets.filter(s => s.length > 3)) {
      for (const variant of new Set([secret, encodeURIComponent(secret)])) {
        if (result.includes(variant)) { result = result.split(variant).join('[REDACTED]'); omissions.push({ path, reason: 'known-secret' }); }
      }
    }
    result = result.replace(/\b(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, () => omit(path, 'credential-pattern'));
    if (/^https?:\/\//i.test(result) || result.startsWith('/')) {
      try {
        const relative=result.startsWith('/')&&!result.startsWith('//');
        const url = new URL(result,'https://evidence.invalid');
        let changed=false;
        if (url.username || url.password) { changed=true;url.username = ''; url.password = ''; omissions.push({ path, reason: 'url-credentials' }); }
        for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) { changed=true;url.searchParams.set(key, '[REDACTED]'); omissions.push({ path, reason: 'sensitive-query' }); }
        if (url.hash) { changed=true;url.hash = ''; omissions.push({ path, reason: 'url-fragment' }); }
        if(!changed)return result;
        return relative ? url.pathname+url.search : url.href;
      } catch { return omit(path, 'invalid-url'); }
    }
    return result;
  }
  function walk(v: unknown, path: string, depth = 0): unknown {
    if (depth > 60) return omit(path, 'depth-limit');
    if (typeof v === 'string') return text(v, path);
    if (v === null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, item]) => [key,
      sensitive.test(key) ? omit(`${path}.${key}`, 'sensitive-field') : walk(item, `${path}.${key}`, depth + 1)]));
    return omit(path, 'unsupported-value');
  }
  function body(raw: string, path: string): unknown {
    // Empty is observed data, not an opaque payload. Preserve it so offline
    // consumers can distinguish a bodyless request from a redacted body.
    if (raw === '') return '';
    if (Buffer.byteLength(raw) > maxTextBytes) return omit(path, 'size-limit');
    const json=raw.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    try { return { format: 'json', data: walk(JSON.parse(json), path) }; } catch { /* Try JSON lines or HTML. */ }
    const lines=json.split(/\r?\n/).filter(line=>line.trim());
    if(lines.length>1)try { return {format:'json-lines',data:walk(lines.map(line=>JSON.parse(line)),path)}; }catch{ /* Not JSON lines. */ }
    if (/^\s*(?:<!doctype html|<html|<div|<main|<section)/i.test(raw)) {
      const $ = load(raw);
      const removed = $('script, input[type="hidden"], input[type="password"], meta').length;
      $('script, input[type="hidden"], input[type="password"], meta').remove();
      if (removed) omissions.push({ path, reason: 'scripts-hidden-fields-and-metadata' });
      $('*').each((_i, element) => {
        if (!('attribs' in element)) return;
        for (const [key, attr] of Object.entries(element.attribs)) {
          const publicReadOnlyValue = key === 'value' && element.name === 'input'
            && ('readonly' in element.attribs || 'disabled' in element.attribs)
            && !sensitive.test((element.attribs.name ?? '')+' '+(element.attribs.id ?? ''));
          if (sensitive.test(key) || key.startsWith('on') || key.startsWith('data-') || (key === 'value' && !publicReadOnlyValue)) {
            $(element).removeAttr(key); omissions.push({ path, reason: 'potentially-sensitive-html-attribute' });
          } else $(element).attr(key, text(attr, path));
        }
      });
      return { format: 'html', data: text($.html(), path) };
    }
    if (/^[^\s=&<>]+=[\s\S]*$/.test(raw)) {
      const fields: Record<string, unknown[]> = Object.create(null);
      for (const [key, value] of new URLSearchParams(raw)) {
        let decoded: unknown = value;
        try { decoded = JSON.parse(value); } catch { /* Ordinary form text. */ }
        (fields[key] ??= []).push(decoded);
      }
      return { format: 'form', data: walk(fields, path) };
    }
    return omit(path, 'opaque-body-not-persisted');
  }
  // Decode bodies before recursive redaction; treating JSON as an opaque string
  // would leave sensitive JSON fields inside responseBody untouched.
  function prepare(v: unknown, path: string): unknown {
    if (Array.isArray(v)) return v.map((item, i) => prepare(item, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      let authenticationEndpoint=false;
      try { authenticationEndpoint=/(?:^|\/)(?:token|tokens|auth|oauth|login|session)(?:\/|$)/i.test(new URL(String((v as any).url)).pathname); }catch { /* Not an exchange. */ }
      return Object.fromEntries(Object.entries(v).map(([key, item]) => [key,
      authenticationEndpoint && ['requestBody','responseBody'].includes(key) ? omit(`${path}.${key}`,'authentication-endpoint-body') :
      typeof item === 'string' && ['requestBody', 'responseBody', 'dom'].includes(key)
        ? body(item, `${path}.${key}`) : prepare(item, `${path}.${key}`)]));
    }
    return v;
  }
  const data = walk(prepare(value, '$'), '$');
  return { data, omissions };
}

export async function saveEvidenceBundle(directory: string, evidence: unknown, secrets: string[] = []) {
  const id = `${Date.now()}-${randomUUID()}`;
  const path = resolve(directory, id);
  const sanitized = sanitizeEvidence(evidence, secrets);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(sanitized.data, null, 2);
  await writeFile(resolve(path, 'evidence.json'), payload, { flag: 'wx', mode: 0o600 });
  // Manifest is the commit marker: incomplete bundles have no manifest.
  await writeFile(resolve(path, 'manifest.json'), JSON.stringify({
    formatVersion: 'clapping-hands/evidence-v1', id, createdAt: new Date().toISOString(),
    file: 'evidence.json', sha256: createHash('sha256').update(payload).digest('hex'),
    privacy: 'private-local-redacted-not-for-publication', omissions: sanitized.omissions,
    limitations: ['Recorder origin, response count and size limits still apply.',
      'Sanitized evidence cannot restore authentication; replay uses the live local session.',
      'Agent action events are included only when supplied; screenshots and external client bundles are not captured.'],
  }, null, 2), { flag: 'wx', mode: 0o600 });
  return { status: 'saved' as const, id };
}

/** Incomplete, modified or path-traversing bundles are never replay evidence. */
export async function loadEvidenceBundle(directory: string, id: string): Promise<unknown> {
  if (!/^[0-9]+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid evidence ID');
  const path = resolve(directory, id);
  if(!(await lstat(path)).isDirectory())throw new Error('Evidence bundle is not a regular directory.');
  const metadata=await regularFileContents(resolve(path,'manifest.json'),1_000_000);
  const payload=await regularFileContents(resolve(path,'evidence.json'),64_000_000);
  if(metadata===null || payload===null)throw new Error('Evidence bundle is incomplete.');
  const manifest = JSON.parse(metadata);
  if (manifest.formatVersion !== 'clapping-hands/evidence-v1' || manifest.id !== id || manifest.file !== 'evidence.json'
    || manifest.sha256 !== createHash('sha256').update(payload).digest('hex')) throw new Error('Evidence integrity check failed');
  return JSON.parse(payload);
}
