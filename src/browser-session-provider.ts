import type { BrowserContext } from 'playwright-core';
import { TaskSession } from './task-session.js';
import type { NetworkRecorder } from './network-recorder.js';
import type { TaskDefinition } from './task-store.js';

/** The runtime-facing contract for a browser session. A provider owns the
 * lifecycle it creates; callers must only invoke close() on that session. */
export interface BrowserSession {
  readonly origin: string;
  readonly profile: string;
  readonly headless: boolean;
  readonly allowedNetworkOrigins: string[];
  readonly network: NetworkRecorder;
  readonly evidenceNetwork: NetworkRecorder;
  context: BrowserContext;
  cdpUrl: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserSessionRequest {
  definition: TaskDefinition;
  profile: string;
  headless: boolean;
}

/** Providers used by caller-recording must explicitly declare whether they
 * support returning a caller attachment capability. Brokered company sessions
 * must set this false until an internal, non-CDP caller flow exists. */
export interface BrowserSessionProvider {
  readonly callerAttachment: 'cdp' | 'internal-only';
  createSession(request: BrowserSessionRequest): BrowserSession;
}

/** Owner-control loss is a hard non-success. In particular it must never
 * trigger fallback to a newly launched standalone browser. */
export class BrowserSessionProviderError extends Error {
  constructor(readonly code: 'owner-control-revoked' | 'broker-unavailable' | 'runtime-generation-changed') {
    super(code);
  }
}

/** Existing behavior: launch an owned local persistent browser and allow the
 * trusted caller to attach over its per-session CDP endpoint. */
export const standaloneBrowserSessionProvider: BrowserSessionProvider = {
  callerAttachment: 'cdp',
  createSession: ({ definition, profile, headless }) => new TaskSession(
    new URL(definition.startUrl).origin, profile, headless, definition.allowedNetworkOrigins,
  ),
};
