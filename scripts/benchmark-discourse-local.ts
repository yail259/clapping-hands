import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  navigateForCompiledDomWorkflow,
  replayDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_DISCOURSE_ORIGIN ?? "http://127.0.0.1:18121";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const password = process.env.CLAPPING_HANDS_DISCOURSE_PASSWORD;
const container = process.env.CLAPPING_HANDS_DISCOURSE_CONTAINER ?? "clapping-hands-discourse-dev";
const SOURCE_COMMIT = "4cefc8c471e4fb40aa1ce5710198bed2f1706474";
const IMAGE = "discourse/discourse_dev:20260812-0036";
const IMAGE_DIGEST = "sha256:ed44e808f7430432712745da7245d6e256c0c417d4c874772ca5b1b3d311242";
const LATEST_URL = `${ORIGIN}/latest`;
const SEARCH_URL = `${ORIGIN}/search`;
const fixturePath = resolve("bench/fixtures/discourse/clapping_hands_fixture.rb");

if (!process.argv.includes("--local")) {
  throw new Error("Discourse local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Discourse local runner only permits a loopback origin.");
}
if (!password) throw new Error("Set the rotated synthetic Discourse administrator password.");

type FixtureTopic = { id: number; title: string; raw: string; categoryId: number };
type SeedResult = { userId: number; topics: FixtureTopic[] };
type TopicSnapshot = {
  count: number;
  topics: Array<{ id: number; title: string; slug: string; deleted: boolean; raw: string; postVersion: number }>;
};
type DraftSnapshot = { count: number; keys?: string[] };
type SearchInput = DomInput & { query: string };
type CreateTopicInput = DomInput & { title: string; body: string };
type EditTopicInput = DomInput & { topicId: number; topicSlug: string; body: string };

function parseFixtureJson<T>(output: string): T {
  const line = output.trim().split(/\r?\n/).reverse().find((candidate) => candidate.startsWith("CH_JSON="));
  if (!line) throw new Error("The Discourse fixture command did not return JSON.");
  return JSON.parse(line.slice("CH_JSON=".length)) as T;
}

function fixture<T>(command: string, environment: Record<string, string> = {}): T {
  const environmentArguments = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  const output = execFileSync("docker", [
    "exec", "-u", "discourse:discourse", "-w", "/src", "-e", `CH_DISCOURSE_COMMAND=${command}`,
    ...environmentArguments, container, "bin/rails", "runner", "/tmp/clapping_hands_fixture.rb",
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
  return parseFixtureJson<T>(output);
}

function database(sql: string): string {
  return execFileSync("docker", [
    "exec", "-u", "postgres", container, "psql", "-v", "ON_ERROR_STOP=1", "-d", "discourse_development", "-Atc", sql,
  ], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }).trim();
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function topic(title: string): TopicSnapshot {
  const output = database(`
    select row_to_json(snapshot) from (
      select t.id, t.title, t.slug, t.deleted_at is not null as deleted,
             p.raw, p.version as "postVersion"
      from topics t
      left join posts p on p.topic_id = t.id and p.post_number = 1
      where t.title = ${sqlLiteral(title)}
      order by t.id
    ) snapshot;
  `);
  const topics = output ? output.split(/\r?\n/).map((line) => JSON.parse(line) as TopicSnapshot["topics"][number]) : [];
  return { count: topics.filter((candidate) => !candidate.deleted).length, topics };
}

function removeTopic(title: string): TopicSnapshot {
  return fixture<TopicSnapshot>("remove-topic", { CH_DISCOURSE_TOPIC_TITLE: title });
}

function resetTopic(title: string, body: string): TopicSnapshot {
  return fixture<TopicSnapshot>("reset-topic", {
    CH_DISCOURSE_TOPIC_TITLE: title,
    CH_DISCOURSE_TOPIC_BODY: body,
  });
}

function drafts(): DraftSnapshot {
  const count = Number(database(`
    select count(*) from drafts d join users u on u.id = d.user_id where u.username = 'benchmark-admin';
  `));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("The Discourse draft oracle returned an invalid count.");
  return { count };
}

function clearDrafts(): DraftSnapshot {
  database(`delete from drafts where user_id = (select id from users where username = 'benchmark-admin');`);
  return drafts();
}

async function waitForOriginStable(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let consecutiveSuccesses = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(5_000) });
      consecutiveSuccesses = response.ok ? consecutiveSuccesses + 1 : 0;
      await response.body?.cancel();
      if (consecutiveSuccesses >= 3) return;
    } catch {
      consecutiveSuccesses = 0;
    }
    await delay(500);
  }
  throw new Error("The loopback Discourse fixture did not produce three consecutive healthy responses.");
}

async function authenticate(page: Page): Promise<void> {
  await navigateForCompiledDomWorkflow(page, LATEST_URL);
  if (await page.locator("#current-user").isVisible().catch(() => false)) return;
  await navigateForCompiledDomWorkflow(page, `${ORIGIN}/login`);
  await page.locator("#login-account-name").waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#login-account-name").fill("benchmark-admin");
  await page.locator("#login-account-password").fill(password!);
  await page.locator("#login-button").click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
  await navigateForCompiledDomWorkflow(page, LATEST_URL);
  await page.locator("#current-user").waitFor({ state: "visible", timeout: 30_000 });
}

function guidedAction(action: { selector: string; description: string; method: string; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local Discourse action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateSearch(page: Page, input: SearchInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      const selector = "input.search-query";
      if (step === 1) {
        await page.locator(selector).fill(input.query);
        return guidedAction({ selector, description: `Enter search query ${input.query}`, method: "fill", arguments: [input.query] });
      }
      await page.locator(selector).press("Enter");
      await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") === input.query, { timeout: 30_000 });
      await page.locator("#main-outlet").filter({ hasText: input.query }).waitFor({ state: "visible", timeout: 30_000 });
      return guidedAction({ selector, description: `Search for ${input.query}`, method: "press", arguments: ["Enter"] });
    },
  }, page, SEARCH_URL, input, [
    `Enter search query ${input.query}`,
    `Search for ${input.query}`,
  ], "#main-outlet");
}

async function demonstrateCreateTopic(page: Page, input: CreateTopicInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = "#create-topic";
        await page.locator(selector).click();
        await page.locator("#reply-title").waitFor({ state: "visible", timeout: 15_000 });
        return guidedAction({ selector, description: "Open the new topic composer", method: "click" });
      }
      if (step === 2) {
        const selector = "#reply-title";
        await page.locator(selector).fill(input.title);
        return guidedAction({ selector, description: `Enter topic title ${input.title}`, method: "fill", arguments: [input.title] });
      }
      if (step === 3) {
        const selector = "#reply-control .d-editor-input";
        await page.locator(selector).fill(input.body);
        return guidedAction({ selector, description: `Enter topic body ${input.body}`, method: "fill", arguments: [input.body] });
      }
      const selector = "#reply-control button.create";
      await page.locator(selector).click();
      await page.waitForURL((url) => url.pathname.startsWith("/t/"), { timeout: 30_000 });
      await page.locator("#main-outlet").filter({ hasText: input.title }).filter({ hasText: input.body })
        .waitFor({ state: "visible", timeout: 30_000 });
      return guidedAction({ selector, description: "Create synthetic topic", method: "click" });
    },
  }, page, LATEST_URL, input, [
    "Open the new topic composer",
    `Enter topic title ${input.title}`,
    `Enter topic body ${input.body}`,
    "Create synthetic topic",
  ], "#main-outlet");
}

function topicUrl(input: EditTopicInput): string {
  return `${ORIGIN}/t/${input.topicSlug}/${input.topicId}`;
}

async function demonstrateEditTopic(page: Page, input: EditTopicInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  const article = ".topic-post[data-post-number='1']";
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        await page.locator(article).hover();
        return guidedAction({ selector: article, description: "Reveal the first post controls", method: "hover" });
      }
      if (step === 2) {
        const selector = `${article} button.edit`;
        await page.locator(selector).click();
        await page.locator("#reply-control .d-editor-input").waitFor({ state: "visible", timeout: 15_000 });
        return guidedAction({ selector, description: "Edit the first post", method: "click" });
      }
      if (step === 3) {
        const selector = "#reply-control .d-editor-input";
        await page.locator(selector).fill(input.body);
        return guidedAction({ selector, description: `Enter revised topic body ${input.body}`, method: "fill", arguments: [input.body] });
      }
      const selector = "#reply-control button.create";
      await page.locator(selector).click();
      await page.locator("#main-outlet").filter({ hasText: input.body }).waitFor({ state: "visible", timeout: 30_000 });
      return guidedAction({ selector, description: "Save synthetic topic edit", method: "click" });
    },
  }, page, topicUrl(input), input, [
    "Reveal the first post controls",
    "Edit the first post",
    `Enter revised topic body ${input.body}`,
    "Save synthetic topic edit",
  ], "#main-outlet");
}

execFileSync("docker", ["cp", fixturePath, `${container}:/tmp/clapping_hands_fixture.rb`]);
const fixtureSeed = fixture<SeedResult>("seed");
if (fixtureSeed.topics.length !== 3) throw new Error("The synthetic Discourse fixture requires three topics.");

const createInputs: CreateTopicInput[] = [
  { title: "Clapping Hands Created Alpha Topic", body: "Synthetic created alpha body." },
  { title: "Clapping Hands Created Beta Topic", body: "Synthetic created beta body." },
  { title: "Clapping Hands Created Gamma Topic", body: "Synthetic created gamma body." },
];
const editBodies = [
  "Synthetic revised alpha body.",
  "Synthetic revised beta body.",
  "Synthetic revised gamma body.",
];
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-discourse-local-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;

try {
  for (const input of createInputs) removeTopic(input.title);
  clearDrafts();
  await waitForOriginStable();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page);

  const readDemonstrations = [
    await demonstrateSearch(page, { query: "Alpha Router" }),
    await demonstrateSearch(page, { query: "Beta Cache" }),
  ];
  const readPlan = compileDomWorkflow("discourse_search_topics", SEARCH_URL, readDemonstrations);

  const createDemonstrations: DomWorkflowDemonstration[] = [];
  const createDemonstrationOracles: Array<{ title: string; count: number; raw: string | undefined }> = [];
  for (const input of createInputs.slice(0, 2)) {
    removeTopic(input.title);
    clearDrafts();
    await waitForOriginStable();
    createDemonstrations.push(await demonstrateCreateTopic(page, input));
    const observed = topic(input.title);
    createDemonstrationOracles.push({ title: input.title, count: observed.count, raw: observed.topics[0]?.raw });
    if (observed.count !== 1 || observed.topics[0]?.raw !== input.body) {
      throw new Error("A guided Discourse topic demonstration failed its database oracle.");
    }
    removeTopic(input.title);
    clearDrafts();
  }
  const createPlan = compileDomWorkflow("discourse_create_topic", LATEST_URL, createDemonstrations, {
    effect: "write",
    confirmation: "Publish one synthetic topic in the loopback-only Discourse fixture",
  });
  if (createPlan.effect.commitActionIndex !== 1 || createPlan.actions[1]?.method !== "fill") {
    throw new Error("The Discourse create plan did not conservatively include reactive composer fills in the commit suffix.");
  }

  const seededSnapshots = fixtureSeed.topics.map((fixtureTopic) => {
    const snapshot = topic(fixtureTopic.title);
    const active = snapshot.topics.find((candidate) => !candidate.deleted);
    if (!active) throw new Error(`Seeded Discourse topic is missing: ${fixtureTopic.title}`);
    return { ...fixtureTopic, slug: active.slug };
  });
  const editDemonstrations: DomWorkflowDemonstration[] = [];
  const editDemonstrationOracles: Array<{ title: string; raw: string | undefined }> = [];
  for (const [index, fixtureTopic] of seededSnapshots.slice(0, 2).entries()) {
    resetTopic(fixtureTopic.title, fixtureTopic.raw);
    clearDrafts();
    await waitForOriginStable();
    const input: EditTopicInput = { topicId: fixtureTopic.id, topicSlug: fixtureTopic.slug, body: editBodies[index]! };
    editDemonstrations.push(await demonstrateEditTopic(page, input));
    const observed = topic(fixtureTopic.title);
    editDemonstrationOracles.push({ title: fixtureTopic.title, raw: observed.topics[0]?.raw });
    if (observed.topics[0]?.raw !== input.body) {
      throw new Error("A guided Discourse edit demonstration failed its database oracle.");
    }
    resetTopic(fixtureTopic.title, fixtureTopic.raw);
    clearDrafts();
  }
  const firstEditInput: EditTopicInput = {
    topicId: seededSnapshots[0]!.id,
    topicSlug: seededSnapshots[0]!.slug,
    body: editBodies[0]!,
  };
  const editPlan = compileDomWorkflow("discourse_edit_topic", topicUrl(firstEditInput), editDemonstrations, {
    effect: "write",
    confirmation: "Edit one synthetic topic in the loopback-only Discourse fixture",
  });
  if (editPlan.effect.commitActionIndex !== 2 || editPlan.actions[2]?.method !== "fill") {
    throw new Error("The Discourse edit plan did not conservatively include reactive composer fills in the commit suffix.");
  }
  await waitForOriginStable();

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredCookies = (await (await browser.context()).cookies([ORIGIN])).length;

  const readInput: SearchInput = { query: "Gamma Compiler" };
  const readReplay = await replayDomWorkflow(page, readPlan, readInput);
  const readExact = new URL(readReplay.url).pathname === "/search" &&
    new URL(readReplay.url).searchParams.get("q") === readInput.query &&
    readReplay.text.includes(fixtureSeed.topics[2]!.title) && readReplay.modelCalls === 0;

  const createInput = createInputs[2]!;
  removeTopic(createInput.title);
  clearDrafts();
  await waitForOriginStable();
  const beforeCreate = topic(createInput.title);
  const draftsBeforeCreate = drafts();
  const pageUrlBeforeCreatePrepare = page.url();
  const createReceipt = await prepareDomWorkflowWrite(page, journal, createPlan, createInput);
  const afterCreatePrepare = topic(createInput.title);
  const draftsAfterCreatePrepare = drafts();
  const createPrepareLeftBrowserUntouched = page.url() === pageUrlBeforeCreatePrepare;
  const created = await commitPreparedDomWorkflowWrite(page, journal, createReceipt.id, createPlan, createInput);
  const afterCreateCommit = topic(createInput.title);
  const repeatedCreateRejected = await commitPreparedDomWorkflowWrite(page, journal, createReceipt.id, createPlan, createInput)
    .then(() => false, () => true);
  const afterRejectedCreate = topic(createInput.title);
  const createExact = beforeCreate.count === 0 && afterCreatePrepare.count === 0 &&
    draftsBeforeCreate.count === 0 && draftsAfterCreatePrepare.count === 0 && createPrepareLeftBrowserUntouched &&
    afterCreateCommit.count === 1 && afterCreateCommit.topics[0]?.raw === createInput.body &&
    afterRejectedCreate.count === 1 && afterRejectedCreate.topics[0]?.id === afterCreateCommit.topics[0]?.id &&
    created.receipt.status === "committed" && created.result.modelCalls === 0 && repeatedCreateRejected;

  const editFixture = seededSnapshots[2]!;
  resetTopic(editFixture.title, editFixture.raw);
  clearDrafts();
  await waitForOriginStable();
  const editInput: EditTopicInput = {
    topicId: editFixture.id,
    topicSlug: editFixture.slug,
    body: editBodies[2]!,
  };
  const beforeEdit = topic(editFixture.title);
  const draftsBeforeEdit = drafts();
  const pageUrlBeforeEditPrepare = page.url();
  const editReceipt = await prepareDomWorkflowWrite(page, journal, editPlan, editInput);
  const afterEditPrepare = topic(editFixture.title);
  const draftsAfterEditPrepare = drafts();
  const editPrepareLeftBrowserUntouched = page.url() === pageUrlBeforeEditPrepare;
  const edited = await commitPreparedDomWorkflowWrite(page, journal, editReceipt.id, editPlan, editInput);
  const afterEditCommit = topic(editFixture.title);
  const repeatedEditRejected = await commitPreparedDomWorkflowWrite(page, journal, editReceipt.id, editPlan, editInput)
    .then(() => false, () => true);
  const afterRejectedEdit = topic(editFixture.title);
  const editExact = beforeEdit.topics[0]?.raw === editFixture.raw &&
    afterEditPrepare.topics[0]?.raw === editFixture.raw &&
    draftsBeforeEdit.count === 0 && draftsAfterEditPrepare.count === 0 && editPrepareLeftBrowserUntouched &&
    afterEditCommit.topics[0]?.raw === editInput.body &&
    afterRejectedEdit.topics[0]?.raw === editInput.body &&
    afterRejectedEdit.topics[0]?.postVersion === afterEditCommit.topics[0]?.postVersion &&
    edited.receipt.status === "committed" && edited.result.modelCalls === 0 && repeatedEditRejected;

  removeTopic(createInput.title);
  resetTopic(editFixture.title, editFixture.raw);
  clearDrafts();
  cleanupVerified = createInputs.every((input) => topic(input.title).count === 0) &&
    fixtureSeed.topics.every((fixtureTopic) => topic(fixtureTopic.title).topics[0]?.raw === fixtureTopic.raw) &&
    drafts().count === 0;

  const rows = [
    {
      task: "search-unseen-topic",
      effect: "read",
      mechanism: "ember-spa-json-search",
      exactResult: readExact,
      compiledModelCalls: readReplay.modelCalls,
      compiledDurationMs: readReplay.durationMs,
      navigations: readReplay.navigations,
    },
    {
      task: "create-unseen-topic",
      effect: "write",
      mechanism: "rich-composer-autosave-plus-prepare-commit",
      exactResult: createExact,
      preparedWithoutPublishedTopic: afterCreatePrepare.count === 0,
      preparedWithoutDraft: draftsAfterCreatePrepare.count === 0,
      prepareLeftBrowserUntouched: createPrepareLeftBrowserUntouched,
      repeatedCommitRejected: repeatedCreateRejected,
      compiledModelCalls: created.result.modelCalls,
      compiledDurationMs: created.result.durationMs,
      oracle: {
        topicCountAfterCommit: afterCreateCommit.count,
        unchangedAfterRejectedRepeat: afterRejectedCreate.topics[0]?.id === afterCreateCommit.topics[0]?.id,
      },
    },
    {
      task: "edit-unseen-topic",
      effect: "write",
      mechanism: "input-bound-topic-route-plus-rich-composer",
      exactResult: editExact,
      preparedWithoutContentChange: afterEditPrepare.topics[0]?.raw === editFixture.raw,
      preparedWithoutDraft: draftsAfterEditPrepare.count === 0,
      prepareLeftBrowserUntouched: editPrepareLeftBrowserUntouched,
      repeatedCommitRejected: repeatedEditRejected,
      compiledModelCalls: edited.result.modelCalls,
      compiledDurationMs: edited.result.durationMs,
      oracle: {
        postVersionAfterCommit: afterEditCommit.topics[0]?.postVersion,
        unchangedAfterRejectedRepeat: afterRejectedEdit.topics[0]?.postVersion === afterEditCommit.topics[0]?.postVersion,
      },
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted Discourse development fixture",
    origin: ORIGIN,
    sources: { discourse: SOURCE_COMMIT },
    containerImages: { application: IMAGE, digest: IMAGE_DIGEST },
    intervention: "guided",
    policyBasis: "Loopback-only official Discourse source and developer image with one synthetic user and synthetic topics",
    credentialHandling: "Read a rotated synthetic credential from the process environment; persisted no credential, cookie, or draft body in plans or reports",
    claimScope: "Capability regression on one pinned self-hosted application; not a speed or untouched-holdout result",
    apiDisposition: "Prefer Discourse's first-party API when an operator has configured API credentials; this regression covers the authenticated UI fallback and rich-composer behavior",
    developmentHistory: [{
      stage: "reactive-composer-preparation",
      result: "hidden-mutation-found-and-runtime-corrected",
      reason: "Filling Discourse's composer produced POST /drafts.json before the visible Create Topic action.",
      fix: "Prepare now creates a durable receipt without browser activity; the complete UI replay begins only after the receipt enters the one-shot committing state.",
    }],
    runnerCorrections: [
      "Require confirmation before the first rich-composer fill, not merely before the visible publish button, because a reactive fill can autosave.",
    ],
    createDemonstrationOracles,
    editDemonstrationOracles,
    environment: {
      browserVersion: await page.context().browser()?.version(),
      platform: process.platform,
      architecture: process.arch,
    },
    authSurvivedBrowserRestart: restoredCookies > 0,
    fixtureCleanupVerified: cleanupVerified,
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: repeatedCreateRejected && repeatedEditRejected ? 0 : 1,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0 ||
    !report.authSurvivedBrowserRestart || !cleanupVerified) {
    throw new Error(`Discourse local capability run failed: ${JSON.stringify({
      summary: report.summary,
      authSurvivedBrowserRestart: report.authSurvivedBrowserRestart,
      fixtureCleanupVerified: cleanupVerified,
      rows,
    })}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "discourse-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  for (const input of createInputs) removeTopic(input.title);
  for (const fixtureTopic of fixtureSeed.topics) resetTopic(fixtureTopic.title, fixtureTopic.raw);
  clearDrafts();
  await rm(directory, { recursive: true, force: true });
}
