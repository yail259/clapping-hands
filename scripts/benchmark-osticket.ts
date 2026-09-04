import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  executeCompiledDomAction,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  compileFormWorkflow,
  demonstrateFormWorkflow,
  inspectFormCandidates,
  replayFormWorkflow,
  type FormWorkflowAnswers,
  type FormWorkflowDemonstration,
} from "../src/form-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";

const ORIGIN = process.env.CLAPPING_HANDS_OSTICKET_ORIGIN ?? "http://127.0.0.1:18089";
const HOLDOUT_COMPILER_COMMIT = "31245cc2ab72cb3b4ec1830e20d96801badf9159";
const APP_IMAGE_DIGEST = "sha256:2900dc6d032b13548e9f15194c298f464d5a0ee70441c0c592fcb7f87e009400";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const username = process.env.CLAPPING_HANDS_OSTICKET_USERNAME;
const password = process.env.CLAPPING_HANDS_OSTICKET_PASSWORD;

if (!process.argv.includes("--local")) {
  throw new Error("osTicket holdout traffic is disabled. Pass --local for the loopback-only disposable deployment.");
}
if (new URL(ORIGIN).hostname !== "127.0.0.1" && new URL(ORIGIN).hostname !== "localhost") {
  throw new Error("The osTicket holdout runner only permits a loopback origin.");
}
if (!username || !password) {
  throw new Error("Set CLAPPING_HANDS_OSTICKET_USERNAME and CLAPPING_HANDS_OSTICKET_PASSWORD for the local fixture.");
}

function learnerResult(
  actions: Array<{ selector: string; description: string; method: string; arguments?: string[] }>,
) {
  return {
    success: true,
    message: "guided local holdout action",
    actions,
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function login(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/scp/login.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#name").isVisible().catch(() => false)) {
    await page.locator("#name").fill(username!);
    await page.locator("#pass").fill(password!);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/scp\/(?:index|tickets)\.php/, { timeout: 15_000 });
  }
  if (!await page.locator("#pjax-container").isVisible().catch(() => false)) {
    throw new Error("The local osTicket staff session did not authenticate.");
  }
}

async function waitForRichTextSource(page: Page, selector: string, text: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await page.locator(selector).inputValue().catch(() => "")).includes(text)) return;
    await page.waitForTimeout(25);
  }
  throw new Error(`The local rich-text editor did not synchronize ${selector}.`);
}

async function demonstrateSearch(page: Page, query: string): Promise<FormWorkflowDemonstration> {
  const startUrl = `${ORIGIN}/scp/index.php`;
  await page.goto(startUrl, { waitUntil: "load", timeout: 30_000 });
  const candidate = inspectFormCandidates(await page.content(), page.url()).find((form) =>
    form.method === "GET" && form.actionPath === "/scp/tickets.php" &&
    form.controls.some((control) => control.name === "query"));
  if (!candidate) throw new Error("The local osTicket ticket-search form was not found.");
  const answers: FormWorkflowAnswers = { [candidate.questionKey]: { query } };
  return demonstrateFormWorkflow(page, startUrl, answers);
}

async function findTicketIdBySubject(page: Page, subject: string): Promise<string> {
  const search = new URL("/scp/tickets.php", ORIGIN);
  search.searchParams.set("a", "search");
  search.searchParams.set("search-type", "");
  search.searchParams.set("query", subject);
  await page.goto(search.href, { waitUntil: "load", timeout: 30_000 });
  const link = page.locator('a[href^="/scp/tickets.php?id="]').filter({ hasText: subject }).first();
  await link.waitFor({ state: "visible", timeout: 10_000 });
  const href = await link.getAttribute("href");
  const ticketId = href ? new URL(href, ORIGIN).searchParams.get("id") : null;
  if (!ticketId || !/^\d+$/.test(ticketId)) throw new Error(`Could not resolve the synthetic ticket ${subject}.`);
  return ticketId;
}

type TicketInput = DomInput & {
  email: string;
  name: string;
  subject: string;
  body: string;
};

async function demonstrateCreateTicket(page: Page, input: TicketInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator('input[type="email"]').fill(input.email);
        return learnerResult([{
          selector: 'input[type="email"]',
          description: `Enter requester email ${input.email}`,
          method: "fill",
          arguments: [input.email],
        }]);
      }
      if (step === 2) {
        await page.locator('input[type="text"][maxlength="64"]').fill(input.name);
        return learnerResult([{
          selector: 'input[type="text"][maxlength="64"]',
          description: `Enter requester name ${input.name}`,
          method: "fill",
          arguments: [input.name],
        }]);
      }
      if (step === 3) {
        await page.locator("#topicId").selectOption("1");
        return learnerResult([{
          selector: "#topicId",
          description: "Select General Inquiry",
          method: "selectOptionFromDropdown",
          arguments: ["1"],
        }]);
      }
      if (step === 4) {
        const subject = page.locator('input[type="text"][maxlength="50"]');
        await subject.waitFor({ state: "visible", timeout: 10_000 });
        await subject.fill(input.subject);
        return learnerResult([{
          selector: 'input[type="text"][maxlength="50"]',
          description: `Enter issue summary ${input.subject}`,
          method: "fill",
          arguments: [input.subject],
        }]);
      }
      if (step === 5) {
        const selector = '[contenteditable="true"][placeholder^="Details on"]';
        await executeCompiledDomAction(page, { selector, description: "Focus issue details", method: "click" });
        await executeCompiledDomAction(page, {
          selector,
          description: `Type issue details ${input.body}`,
          method: "type",
          arguments: [input.body],
        });
        await executeCompiledDomAction(page, { selector, description: "Finish editing issue details", method: "blur" });
        await waitForRichTextSource(page, "textarea.redactor-source", input.body);
        return learnerResult([
          { selector, description: "Focus issue details", method: "click" },
          { selector, description: `Type issue details ${input.body}`, method: "type", arguments: [input.body] },
          { selector, description: "Finish editing issue details", method: "blur" },
        ]);
      }
      const selector = 'input[type="submit"][value="Create Ticket"]';
      await page.locator(selector).click();
      await page.locator("#content").filter({ hasText: "Support ticket request created" })
        .waitFor({ state: "visible", timeout: 15_000 });
      return learnerResult([{
        selector,
        description: "Create the synthetic test ticket",
        method: "click",
      }]);
    },
  }, page, `${ORIGIN}/open.php`, input, [
    `Enter requester email ${input.email}`,
    `Enter requester name ${input.name}`,
    "Select the General Inquiry help topic",
    `Enter issue summary ${input.subject}`,
    `Enter issue details ${input.body} and finish editing`,
    "Create the synthetic test ticket",
  ], "#content");
}

type NoteInput = DomInput & { ticketId: string; title: string; body: string };

async function demonstrateInternalNote(page: Page, input: NoteInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator("#post-note-tab").click();
        await page.locator("form#note").waitFor({ state: "visible", timeout: 5_000 });
        return learnerResult([{
          selector: "#post-note-tab",
          description: "Open the internal note tab",
          method: "click",
        }]);
      }
      if (step === 2) {
        await page.locator("form#note #title").fill(input.title);
        return learnerResult([{
          selector: "form#note #title",
          description: `Enter internal note title ${input.title}`,
          method: "fill",
          arguments: [input.title],
        }]);
      }
      if (step === 3) {
        const selector = 'form#note [contenteditable="true"][placeholder="Note details"]';
        await executeCompiledDomAction(page, { selector, description: "Focus internal note body", method: "click" });
        await executeCompiledDomAction(page, {
          selector,
          description: `Type internal note body ${input.body}`,
          method: "type",
          arguments: [input.body],
        });
        await executeCompiledDomAction(page, { selector, description: "Finish editing internal note", method: "blur" });
        await waitForRichTextSource(page, "form#note textarea.redactor-source", input.body);
        return learnerResult([
          { selector, description: "Focus internal note body", method: "click" },
          { selector, description: `Type internal note body ${input.body}`, method: "type", arguments: [input.body] },
          { selector, description: "Finish editing internal note", method: "blur" },
        ]);
      }
      const selector = 'form#note input[type="submit"][value="Post Note"]';
      await page.locator(selector).click();
      await page.locator("#thread-items").filter({ hasText: input.title }).waitFor({ state: "visible", timeout: 15_000 });
      return learnerResult([{
        selector,
        description: "Post the synthetic internal note",
        method: "click",
      }]);
    },
  }, page, `${ORIGIN}/scp/tickets.php?id=${input.ticketId}`, input, [
    "Open the internal note tab",
    `Enter internal note title ${input.title}`,
    `Enter internal note body ${input.body} and finish editing`,
    "Post the synthetic internal note",
  ], "#thread-items");
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-osticket-"));
let staffContext: BrowserContext | null = null;
let requesterContext: BrowserContext | null = null;
try {
  staffContext = await chromium.launchPersistentContext(resolve(directory, "staff-profile"), {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1_440, height: 1_000 },
  });
  requesterContext = await chromium.launchPersistentContext(resolve(directory, "requester-profile"), {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1_440, height: 1_000 },
  });
  const staffPage = staffContext.pages()[0] ?? await staffContext.newPage();
  const requesterPage = requesterContext.pages()[0] ?? await requesterContext.newPage();
  await login(staffPage);

  const searchDemonstrations = [
    await demonstrateSearch(staffPage, "Printer"),
    await demonstrateSearch(staffPage, "VPN"),
  ];
  const searchPlan = compileFormWorkflow("osticket_search_ticket", `${ORIGIN}/scp/index.php`, searchDemonstrations);
  const searchAnswers: FormWorkflowAnswers = { [searchPlan.steps[0]!.questionKey]: { query: "Invoice" } };
  const searchResult = await replayFormWorkflow(staffContext, searchPlan, searchAnswers);
  const searchExact = searchResult.mainText.includes("Invoice export fixture") &&
    !searchResult.mainText.includes("Printer calibration fixture") && !searchResult.mainText.includes("VPN access fixture");

  const runMarker = Date.now().toString(36);
  const firstCreateInput: TicketInput = {
    email: "demo-one@example.com",
    name: "Demo One",
    subject: `Compiled creation demonstration one ${runMarker}`,
    body: "First synthetic creation body",
  };
  const secondCreateInput: TicketInput = {
    email: "demo-two@example.com",
    name: "Demo Two",
    subject: `Compiled creation demonstration two ${runMarker}`,
    body: "Second synthetic creation body",
  };
  const createDemonstrations = [
    await demonstrateCreateTicket(requesterPage, firstCreateInput),
    await demonstrateCreateTicket(requesterPage, secondCreateInput),
  ];
  const createPlan = compileDomWorkflow("osticket_create_test_ticket", `${ORIGIN}/open.php`, createDemonstrations, {
    effect: "write",
    confirmation: "Create one synthetic ticket in the disposable local osTicket deployment",
  });
  const createInput: TicketInput = {
    email: "compiled-replay@example.com",
    name: "Compiled Replay",
    subject: `Compiled creation replay ${runMarker}`,
    body: "Unseen synthetic creation body",
  };
  const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
  const createReceipt = await prepareDomWorkflowWrite(requesterPage, journal, createPlan, createInput);
  const createPreparedWithoutEffect = !await requesterPage.locator("#content")
    .filter({ hasText: "Support ticket request created" }).isVisible().catch(() => false);
  const createCommitted = await commitPreparedDomWorkflowWrite(requesterPage, journal, createReceipt.id, createPlan, createInput);
  const createExact = createPreparedWithoutEffect && createCommitted.receipt.status === "committed" &&
    createCommitted.result.text.includes("Support ticket request created") &&
    createCommitted.result.text.includes(createInput.name);

  const notePage = await staffContext.newPage();
  await login(notePage);
  const firstCreatedTicketId = await findTicketIdBySubject(notePage, firstCreateInput.subject);
  const secondCreatedTicketId = await findTicketIdBySubject(notePage, secondCreateInput.subject);
  const replayCreatedTicketId = await findTicketIdBySubject(notePage, createInput.subject);
  const noteDemonstrations = [
    await demonstrateInternalNote(notePage, {
      ticketId: firstCreatedTicketId,
      title: "Calibration observation",
      body: "First private fixture note",
    }),
    await demonstrateInternalNote(notePage, {
      ticketId: secondCreatedTicketId,
      title: "Access observation",
      body: "Second private fixture note",
    }),
  ];
  const notePlan = compileDomWorkflow(
    "osticket_add_internal_test_note",
    `${ORIGIN}/scp/tickets.php?id=${firstCreatedTicketId}`,
    noteDemonstrations,
    {
      effect: "write",
      confirmation: "Add one synthetic internal note to a synthetic ticket in the disposable local deployment",
    },
  );
  const noteInput: NoteInput = {
    ticketId: replayCreatedTicketId,
    title: "Export observation",
    body: "Unseen private fixture note",
  };
  const noteReceipt = await prepareDomWorkflowWrite(notePage, journal, notePlan, noteInput);
  const notePreparedWithoutEffect = !await notePage.locator("#thread-items")
    .filter({ hasText: noteInput.title }).isVisible().catch(() => false);
  const noteCommitted = await commitPreparedDomWorkflowWrite(notePage, journal, noteReceipt.id, notePlan, noteInput);
  const noteExact = notePreparedWithoutEffect && noteCommitted.receipt.status === "committed" &&
    noteCommitted.result.text.includes(noteInput.title) && noteCommitted.result.text.includes(noteInput.body);

  const rows = [
    {
      task: "search-ticket",
      effect: "read",
      path: "authenticated-html-form-direct",
      exactResult: searchExact,
      compiledModelCalls: 0,
      compiledDurationMs: searchResult.durationMs,
      requests: searchResult.requests,
      navigations: searchResult.navigations,
    },
    {
      task: "create-test-ticket",
      effect: "write",
      path: "prepare-commit",
      exactResult: createExact,
      preparedWithoutEffect: createPreparedWithoutEffect,
      receiptStatus: createCommitted.receipt.status,
      compiledModelCalls: createCommitted.result.modelCalls,
      compiledDurationMs: createCommitted.result.durationMs,
    },
    {
      task: "add-internal-test-note",
      effect: "write",
      path: "authenticated-prepare-commit",
      exactResult: noteExact,
      preparedWithoutEffect: notePreparedWithoutEffect,
      receiptStatus: noteCommitted.receipt.status,
      compiledModelCalls: noteCommitted.result.modelCalls,
      compiledDurationMs: noteCommitted.result.durationMs,
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "frozen-local-holdout-smoke",
    generatedAt: new Date().toISOString(),
    holdoutCompilerCommit: HOLDOUT_COMPILER_COMMIT,
    runnerBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted osTicket",
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    intervention: "guided",
    policyBasis: "Disposable loopback-only deployment with synthetic users, tickets, and notes",
    credentialHandling: "Read local fixture credentials from environment; did not persist them in plans or report them",
    claimScope: "Frozen-core capability holdout; n=1 compiled run per task, not a speed benchmark",
    claimEligibility: "Regression after holdout-discovered compiler fixes; excluded from the untouched-holdout success denominator",
    developmentHistory: [
      {
        stage: "authenticated-search",
        result: "failed-closed",
        reason: "A learned DOM search neither emitted the expected PJAX request nor proved fresh results.",
        fix: "Compile the persistent same-document GET search form and validate its direct HTML response; use native requestSubmit for browser fallback.",
      },
      {
        stage: "ticket-rich-editor",
        result: "failed-closed",
        reason: "The visible contenteditable accepted an action while its hidden form source remained empty, and a late requester lookup could reclaim focus.",
        fix: "Encode explicit blur, wait for source synchronization, wait for full demonstration readiness, and atomically recover only a type action that made no state change.",
      },
      {
        stage: "role-authentication",
        result: "failed-closed",
        reason: "The harness reused a staff-authenticated browser identity on the public requester portal, which osTicket silently rejected.",
        fix: "Use separate persistent requester and staff profiles and revalidate the staff login shell before privileged workflows.",
      },
      {
        stage: "internal-note-target",
        result: "failed-closed",
        reason: "Hard-coded old tickets were eventually paginated off a cached dashboard during repeated development runs.",
        fix: "Discover the tickets created by the current run and compile their input-bound same-origin ticket URLs instead of depending on list order or cached UI state.",
      },
    ],
    infrastructureIncidents: [
      "Docker Desktop stopped once during development; the exact existing containers were restarted without resetting their data.",
    ],
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: rows.filter((row) => "receiptStatus" in row && row.receiptStatus !== "committed").length,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0) {
    throw new Error(`osTicket holdout failed: ${JSON.stringify(report.summary)}`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "osticket-local-holdout.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await requesterContext?.close().catch(() => {});
  await staffContext?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
