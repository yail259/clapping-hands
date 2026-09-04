import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  navigateForCompiledDomWorkflow,
  replayDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_ROUNDCUBE_ORIGIN ?? "http://127.0.0.1:18098";
const GREENMAIL_API = process.env.CLAPPING_HANDS_GREENMAIL_API ?? "http://127.0.0.1:18099";
const GREENMAIL_SMTP = process.env.CLAPPING_HANDS_GREENMAIL_SMTP ?? "smtp://127.0.0.1:18100";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USERNAME = "benchmark@example.test";
const INBOX_URL = `${ORIGIN}/?_task=mail&_mbox=INBOX`;
const OUTPUT_SELECTOR = "#messagelist";
const ROUNDCUBE_IMAGE = "roundcube/roundcubemail:1.6.13-apache";
const ROUNDCUBE_IMAGE_DIGEST = "sha256:f6c97d0d2c61b42aa9fc96b8c2b6e5e09182b4c03391302f650b77f58b324399";
const GREENMAIL_IMAGE = "greenmail/standalone:2.1.13";
const GREENMAIL_IMAGE_DIGEST = "sha256:3df66b7edd01c8a301343ca5e3601d8674760d4708655573560c24745e624fb2";

if (!process.argv.includes("--local")) {
  throw new Error("Roundcube local traffic is disabled. Pass --local for the loopback-only fixture.");
}
for (const endpoint of [ORIGIN, GREENMAIL_API, GREENMAIL_SMTP]) {
  if (!new Set(["127.0.0.1", "localhost"]).has(new URL(endpoint).hostname)) {
    throw new Error("The Roundcube benchmark only permits loopback endpoints.");
  }
}

type SearchInput = DomInput & { query: string };
type MailSnapshot = Array<{ uid: string; messageId: string; subject: string }>;

const seededMail = [
  {
    from: "alerts@example.test",
    subject: "CH seeded invoice alpha",
    messageId: "ch-alpha@example.test",
    body: "Synthetic invoice alpha.",
  },
  {
    from: "notices@example.test",
    subject: "CH seeded schedule beta",
    messageId: "ch-beta@example.test",
    body: "Synthetic schedule beta.",
  },
  {
    from: "alerts@example.test",
    subject: "CH seeded invoice gamma",
    messageId: "ch-gamma@example.test",
    body: "Synthetic invoice gamma.",
  },
];

async function requireOk(response: Response, operation: string): Promise<Response> {
  if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}.`);
  return response;
}

async function waitForServices(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const [roundcube, greenmail] = await Promise.all([
        fetch(ORIGIN, { signal: AbortSignal.timeout(3_000) }),
        fetch(`${GREENMAIL_API}/api/service/readiness`, { signal: AbortSignal.timeout(3_000) }),
      ]);
      await Promise.all([roundcube.body?.cancel(), greenmail.body?.cancel()]);
      if (roundcube.ok && greenmail.ok) return;
    } catch {
      // Keep the bounded readiness probe quiet until the deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("The loopback Roundcube and GreenMail fixtures did not become ready.");
}

async function purgeMail(): Promise<void> {
  await requireOk(await fetch(`${GREENMAIL_API}/api/mail/purge`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  }), "GreenMail purge");
}

function smtpMessage(mail: typeof seededMail[number], ordinal: number): string {
  const minute = String(ordinal).padStart(2, "0");
  return [
    `From: ${mail.from}`,
    `To: ${USERNAME}`,
    `Subject: ${mail.subject}`,
    `Date: Fri, 5 Sep 2026 09:${minute}:00 +1000`,
    `Message-ID: <${mail.messageId}>`,
    "",
    mail.body,
    "",
  ].join("\r\n");
}

function deliverMail(mail: typeof seededMail[number], ordinal: number): void {
  try {
    execFileSync("curl", [
      "-fsS",
      "--url", GREENMAIL_SMTP,
      "--mail-from", mail.from,
      "--mail-rcpt", USERNAME,
      "--upload-file", "-",
    ], {
      input: smtpMessage(mail, ordinal),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("The sandboxed SMTP fixture delivery failed; process arguments were suppressed.");
  }
}

async function seedMailbox(): Promise<MailSnapshot> {
  await purgeMail();
  for (const [index, mail] of seededMail.entries()) deliverMail(mail, index);
  const snapshot = await mailboxSnapshot();
  if (snapshot.length !== seededMail.length || !seededMail.every((mail) =>
    snapshot.some((candidate) => candidate.messageId === mail.messageId && candidate.subject === mail.subject))) {
    throw new Error("The GreenMail inbox did not contain the exact seeded message set.");
  }
  return snapshot;
}

async function mailboxSnapshot(): Promise<MailSnapshot> {
  const response = await requireOk(await fetch(
    `${GREENMAIL_API}/api/user/${encodeURIComponent(USERNAME)}/messages/INBOX`,
    { signal: AbortSignal.timeout(5_000) },
  ), "GreenMail inbox oracle");
  const messages = await response.json() as Array<Record<string, unknown>>;
  return messages.map((message) => ({
    uid: String(message.uid),
    messageId: String(message["Message-ID"] ?? "").replace(/^<|>$/g, ""),
    subject: String(message.subject),
  })).sort((left, right) => left.uid.localeCompare(right.uid, undefined, { numeric: true }));
}

async function waitForRoundcubeIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const application = (globalThis as typeof globalThis & { rcmail?: { busy?: boolean } }).rcmail;
    return application && application.busy === false;
  }, undefined, { timeout: 15_000 });
}

async function authenticate(page: Page, password: string): Promise<void> {
  await navigateForCompiledDomWorkflow(page, INBOX_URL);
  if (await page.locator("input[name=_user]").isVisible().catch(() => false)) {
    await page.locator("input[name=_user]").fill(USERNAME);
    await page.locator("input[name=_pass]").fill(password);
    await page.locator("button[type=submit],input[type=submit]").click();
  }
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  await waitForRoundcubeIdle(page);
}

function guidedAction(action: { selector: string; description: string; method: string; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local Roundcube action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateSearch(
  page: Page,
  input: SearchInput,
  expectedSubject: string,
): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      const selector = "#mailsearchform";
      if (step === 1) {
        await page.locator(selector).fill(input.query);
        return guidedAction({
          selector,
          description: `Enter mail search ${input.query}`,
          method: "fill",
          arguments: [input.query],
        });
      }
      await waitForRoundcubeIdle(page);
      await page.locator(selector).press("Enter");
      await page.waitForFunction((expectedSubject) => {
        const application = (globalThis as typeof globalThis & { rcmail?: { busy?: boolean; env?: { messagecount?: number } } }).rcmail;
        const rows = Array.from(document.querySelectorAll("#messagelist tbody tr"));
        return application?.busy === false && application.env?.messagecount === 1 && rows.length === 1 &&
          rows[0]?.textContent?.includes(String(expectedSubject));
      }, expectedSubject, { timeout: 15_000 });
      return guidedAction({
        selector,
        description: `Search mail for ${input.query}`,
        method: "press",
        arguments: ["Enter"],
      });
    },
  }, page, INBOX_URL, input, [
    `Enter mail search ${input.query}`,
    `Search mail for ${input.query}`,
  ], OUTPUT_SELECTOR);
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-roundcube-"));
const password = randomBytes(24).toString("base64url");
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;

try {
  await waitForServices();
  const before = await seedMailbox();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, password);

  const demonstrationInputs: Array<{ input: SearchInput; expectedSubject: string }> = [
    { input: { query: "invoice alpha" }, expectedSubject: "CH seeded invoice alpha" },
    { input: { query: "schedule beta" }, expectedSubject: "CH seeded schedule beta" },
  ];
  const demonstrations: DomWorkflowDemonstration[] = [];
  for (const demonstration of demonstrationInputs) {
    demonstrations.push(await demonstrateSearch(page, demonstration.input, demonstration.expectedSubject));
  }
  const compileStartedAt = performance.now();
  const plan = compileDomWorkflow("roundcube_search_seeded_mail", INBOX_URL, demonstrations);
  const compileMs = performance.now() - compileStartedAt;

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await navigateForCompiledDomWorkflow(page, INBOX_URL);
  const authSurvivedBrowserRestart = new URL(page.url()).searchParams.get("_task") === "mail";
  const unseenInput: SearchInput = { query: "invoice gamma" };
  const unseenExpectedSubject = "CH seeded invoice gamma";
  let replayRequests = 0;
  const countReplayRequest = (): void => { replayRequests += 1; };
  page.on("request", countReplayRequest);
  const replay = await replayDomWorkflow(page, plan, unseenInput);
  page.off("request", countReplayRequest);
  const after = await mailboxSnapshot();
  const exactResult = replay.modelCalls === 0 && replay.text.includes(unseenExpectedSubject) &&
    !replay.text.includes("CH seeded invoice alpha") && !replay.text.includes("CH seeded schedule beta") &&
    JSON.stringify(after) === JSON.stringify(before);

  await purgeMail();
  cleanupVerified = (await mailboxSnapshot()).length === 0;
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Roundcube Webmail with sandboxed GreenMail",
    origin: ORIGIN,
    containerImages: {
      roundcube: { image: ROUNDCUBE_IMAGE, digest: ROUNDCUBE_IMAGE_DIGEST },
      greenmail: { image: GREENMAIL_IMAGE, digest: GREENMAIL_IMAGE_DIGEST },
    },
    intervention: "guided demonstrations",
    policyBasis: "Loopback-only official containers with synthetic mail; GreenMail is non-forwarding and sandboxed",
    credentialHandling: "Generated a synthetic password in process memory; GreenMail authentication was disabled and no credential or session value was persisted in the report or plan",
    claimScope: "One post-v2 capability regression; not an untouched holdout or latency distribution",
    authSurvivedBrowserRestart,
    compileMs: Number(compileMs.toFixed(2)),
    task: {
      id: "search-synthetic-inbox-by-subject",
      effect: "read",
      engine: plan.engine,
      exactResult,
      mailboxUnchanged: JSON.stringify(after) === JSON.stringify(before),
      cleanupVerified,
      requests: replayRequests,
      navigations: replay.navigations,
      modelCalls: replay.modelCalls,
      compiledDurationMs: Number(replay.durationMs.toFixed(2)),
      oracle: {
        expectedSubjectFound: replay.text.includes(unseenExpectedSubject),
        seededDecoysExcluded: !replay.text.includes("CH seeded invoice alpha") &&
          !replay.text.includes("CH seeded schedule beta"),
      },
    },
    summary: {
      passed: exactResult ? 1 : 0,
      total: 1,
      falseSuccesses: exactResult ? 0 : 1,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "roundcube-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!authSurvivedBrowserRestart || !exactResult || !cleanupVerified) {
    throw new Error(`Roundcube local capability failed: ${JSON.stringify({
      authSurvivedBrowserRestart,
      exactResult,
      cleanupVerified,
    })}`);
  }
  console.log(JSON.stringify({
    reportPath,
    exactResult,
    mailboxUnchanged: report.task.mailboxUnchanged,
    authSurvivedBrowserRestart,
    cleanupVerified,
    compileMs: report.compileMs,
    compiledDurationMs: report.task.compiledDurationMs,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await purgeMail().then(() => { cleanupVerified = true; }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
