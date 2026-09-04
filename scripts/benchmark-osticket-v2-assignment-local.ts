import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  compileDomWorkflow,
  demonstrateDomWorkflow,
  type DomInput,
  type DomWorkflowDemonstration,
} from "../src/dom-workflow.js";
import {
  commitPreparedDomWorkflowWrite,
  EffectJournal,
  prepareDomWorkflowWrite,
} from "../src/effect-journal.js";
import { PersistentWorkflowBrowser } from "../src/persistent-browser.js";

const ORIGIN = process.env.CLAPPING_HANDS_OSTICKET_ORIGIN ?? "http://127.0.0.1:18089";
const CONTAINER = process.env.CLAPPING_HANDS_OSTICKET_CONTAINER ?? "clapping-hands-osticket-app";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUTPUT_SELECTOR = "#pjax-container";
const USERNAME = "ostadmin";
const APP_IMAGE_DIGEST = "sha256:2900dc6d032b13548e9f15194c298f464d5a0ee70441c0c592fcb7f87e009400";
const DB_IMAGE_DIGEST = "sha256:611a2fcc5fa7c6ceb8644c6f74b25ede004ff6c3a6b38c8f8c23d3bbf6c26430";
const V2_FREEZE_SHA = "3e3d2393df2015565fd5d5e350c17b510fb43d2f";

if (!process.argv.includes("--local")) {
  throw new Error("osTicket v2 assignment traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The osTicket v2 assignment runner only permits a loopback origin.");
}
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(CONTAINER)) {
  throw new Error("The osTicket fixture container name is invalid.");
}

type StaffPasswordState = {
  id: number;
  username: string;
  passwordHash: string;
  passwordReset: string | null;
  updated: string | null;
};

type TicketState = {
  id: number;
  number: string;
  staffId: number;
  teamId: number;
  lastUpdate: string;
  updated: string;
  threadId: number;
  eventIds: number[];
};

type ClaimInput = DomInput & { ticketId: string };

function fixturePhp(source: string, environment: Record<string, string> = {}): string {
  const environmentArguments = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  try {
    return execFileSync("docker", ["exec", ...environmentArguments, CONTAINER, "php", "-r", source], {
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("The osTicket fixture command failed; secret-bearing process arguments were suppressed.");
  }
}

function staffPasswordState(): StaffPasswordState {
  const payload = fixturePhp(`
    require '/var/www/osticket/upload/main.inc.php';
    $result = db_query("SELECT staff_id, username, passwd, passwdreset, updated FROM ".STAFF_TABLE." WHERE username='ostadmin' LIMIT 1");
    $row = db_fetch_array($result);
    if (!$row) throw new Exception('Synthetic staff user missing');
    echo json_encode([
      'id' => intval($row['staff_id']),
      'username' => $row['username'],
      'passwordHash' => $row['passwd'],
      'passwordReset' => $row['passwdreset'],
      'updated' => $row['updated'],
    ]);
  `);
  const parsed = JSON.parse(payload) as StaffPasswordState;
  if (!Number.isSafeInteger(parsed.id) || parsed.id < 1 || parsed.username !== USERNAME ||
    typeof parsed.passwordHash !== "string" || parsed.passwordHash.length < 20) {
    throw new Error("The synthetic osTicket staff password row had an unexpected shape.");
  }
  return parsed;
}

function rotateStaffPassword(staff: StaffPasswordState): string {
  const password = `Ch-${randomBytes(24).toString("base64url")}!`;
  const result = fixturePhp(`
    require '/var/www/osticket/upload/main.inc.php';
    $hash = Passwd::hash(getenv('CH_PASSWORD'));
    $sql = sprintf(
      "UPDATE %s SET passwd=%s, passwdreset=NOW() WHERE staff_id=%d",
      STAFF_TABLE,
      db_input($hash),
      intval(getenv('CH_STAFF_ID'))
    );
    if (!$hash || !db_query($sql)) throw new Exception('Could not rotate synthetic password');
    echo 'ok';
  `, { CH_STAFF_ID: String(staff.id), CH_PASSWORD: password });
  if (result !== "ok") throw new Error("The synthetic osTicket password rotation failed.");
  return password;
}

function restoreStaffPassword(staff: StaffPasswordState): void {
  const result = fixturePhp(`
    require '/var/www/osticket/upload/main.inc.php';
    $reset = getenv('CH_PASSWORD_RESET');
    $updated = getenv('CH_UPDATED');
    $sql = sprintf(
      "UPDATE %s SET passwd=%s, passwdreset=%s, updated=%s WHERE staff_id=%d",
      STAFF_TABLE,
      db_input(getenv('CH_PASSWORD_HASH')),
      $reset === '__NULL__' ? 'NULL' : db_input($reset),
      $updated === '__NULL__' ? 'NULL' : db_input($updated),
      intval(getenv('CH_STAFF_ID'))
    );
    if (!db_query($sql)) throw new Exception('Could not restore synthetic password');
    echo 'ok';
  `, {
    CH_STAFF_ID: String(staff.id),
    CH_PASSWORD_HASH: staff.passwordHash,
    CH_PASSWORD_RESET: staff.passwordReset ?? "__NULL__",
    CH_UPDATED: staff.updated ?? "__NULL__",
  });
  if (result !== "ok") throw new Error("The synthetic osTicket password restoration failed.");
}

function ticketState(ticketId: number): TicketState {
  const payload = fixturePhp(`
    require '/var/www/osticket/upload/main.inc.php';
    $id = intval(getenv('CH_TICKET_ID'));
    $result = db_query(sprintf(
      "SELECT t.ticket_id, t.number, t.staff_id, t.team_id, t.lastupdate, t.updated, th.id AS thread_id FROM %s t JOIN %s th ON th.object_id=t.ticket_id AND th.object_type='T' WHERE t.ticket_id=%d LIMIT 1",
      TICKET_TABLE, THREAD_TABLE, $id
    ));
    $row = db_fetch_array($result);
    if (!$row) throw new Exception('Synthetic ticket missing');
    $events = [];
    $eventResult = db_query(sprintf("SELECT id FROM %s WHERE thread_id=%d ORDER BY id", THREAD_EVENT_TABLE, intval($row['thread_id'])));
    while ($event = db_fetch_array($eventResult)) $events[] = intval($event['id']);
    echo json_encode([
      'id' => intval($row['ticket_id']),
      'number' => $row['number'],
      'staffId' => intval($row['staff_id']),
      'teamId' => intval($row['team_id']),
      'lastUpdate' => $row['lastupdate'],
      'updated' => $row['updated'],
      'threadId' => intval($row['thread_id']),
      'eventIds' => $events,
    ]);
  `, { CH_TICKET_ID: String(ticketId) });
  const parsed = JSON.parse(payload) as TicketState;
  if (parsed.id !== ticketId || !/^\d+$/.test(parsed.number) || !Number.isSafeInteger(parsed.staffId) ||
    !Number.isSafeInteger(parsed.teamId) || !Number.isSafeInteger(parsed.threadId) ||
    !Array.isArray(parsed.eventIds) || parsed.eventIds.some((id) => !Number.isSafeInteger(id))) {
    throw new Error(`The synthetic osTicket fixture drifted at ticket ${ticketId}.`);
  }
  return parsed;
}

function restoreTicket(state: TicketState): void {
  const retainedEvents = state.eventIds.length > 0 ? state.eventIds.join(",") : "0";
  const result = fixturePhp(`
    require '/var/www/osticket/upload/main.inc.php';
    $ticketId = intval(getenv('CH_TICKET_ID'));
    $threadId = intval(getenv('CH_THREAD_ID'));
    $sql = sprintf(
      "UPDATE %s SET staff_id=%d, team_id=%d, lastupdate=%s, updated=%s WHERE ticket_id=%d",
      TICKET_TABLE,
      intval(getenv('CH_STAFF_ID')),
      intval(getenv('CH_TEAM_ID')),
      db_input(getenv('CH_LAST_UPDATE')),
      db_input(getenv('CH_UPDATED')),
      $ticketId
    );
    if (!db_query($sql)) throw new Exception('Could not restore ticket assignment');
    $delete = sprintf("DELETE FROM %s WHERE thread_id=%d AND id NOT IN (${retainedEvents})", THREAD_EVENT_TABLE, $threadId);
    if (!db_query($delete)) throw new Exception('Could not restore ticket events');
    echo 'ok';
  `, {
    CH_TICKET_ID: String(state.id),
    CH_THREAD_ID: String(state.threadId),
    CH_STAFF_ID: String(state.staffId),
    CH_TEAM_ID: String(state.teamId),
    CH_LAST_UPDATE: state.lastUpdate,
    CH_UPDATED: state.updated,
  });
  if (result !== "ok") throw new Error(`Could not restore synthetic ticket ${state.id}.`);
}

function assignmentSnapshot(state: TicketState): { staffId: number; teamId: number; eventIds: number[] } {
  const current = ticketState(state.id);
  return { staffId: current.staffId, teamId: current.teamId, eventIds: current.eventIds };
}

async function waitForAssignment(ticketId: number, staffId: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (ticketState(ticketId).staffId === staffId) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Synthetic ticket ${ticketId} did not become assigned.`);
}

async function authenticate(page: Page, password: string): Promise<void> {
  await page.goto(`${ORIGIN}/scp/login.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#name").isVisible().catch(() => false)) {
    await page.locator("#name").fill(USERNAME);
    await page.locator("#pass").fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/scp\/(?:index|tickets)\.php/, { timeout: 30_000 });
  }
  if (!await page.locator(OUTPUT_SELECTOR).isVisible().catch(() => false)) {
    throw new Error("The synthetic osTicket staff session did not authenticate.");
  }
}

function guidedAction(action: { selector: string; description: string; method: "click" }) {
  return {
    success: true,
    message: "guided local osTicket assignment action",
    actions: [{ ...action, arguments: [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function ticketUrl(input: ClaimInput): string {
  return `${ORIGIN}/scp/tickets.php?id=${input.ticketId}`;
}

async function demonstrateClaim(page: Page, input: ClaimInput, staffId: number): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = '[data-dropdown="#action-dropdown-assign"]';
        await page.locator(selector).click();
        await page.locator("#action-dropdown-assign").waitFor({ state: "visible", timeout: 5_000 });
        return guidedAction({ selector, description: "Open ticket assignment actions", method: "click" });
      }
      if (step === 2) {
        const selector = `#action-dropdown-assign a[href="#tickets/${input.ticketId}/claim"]`;
        await page.locator(selector).click();
        await page.locator("form#assign").waitFor({ state: "visible", timeout: 10_000 });
        return guidedAction({ selector, description: "Open the claim confirmation", method: "click" });
      }
      const selector = 'form#assign input[type="submit"]';
      await page.locator(selector).click();
      await waitForAssignment(Number(input.ticketId), staffId);
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: "assigned to you" })
        .waitFor({ state: "visible", timeout: 15_000 });
      return guidedAction({ selector, description: "Claim the synthetic ticket", method: "click" });
    },
  }, page, ticketUrl(input), input, [
    "Open ticket assignment actions",
    "Open the claim confirmation",
    "Claim the synthetic ticket",
  ], OUTPUT_SELECTOR);
}

const originalStaff = staffPasswordState();
const ticketStates = [24, 25, 26].map(ticketState);
if (ticketStates.some((ticket) => ticket.staffId !== 0 || ticket.teamId !== 0)) {
  throw new Error("The selected synthetic osTicket assignment fixtures must begin unassigned.");
}
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-osticket-v2-assignment-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let passwordRotated = false;

try {
  const password = rotateStaffPassword(originalStaff);
  passwordRotated = true;
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, password);
  const browserVersion = page.context().browser()?.version() ?? "unknown";

  const demonstrations: DomWorkflowDemonstration[] = [];
  const demonstrationOracles: Array<{ ticketId: number; exactAssignee: boolean; oneEventAdded: boolean; restored: boolean }> = [];
  for (const state of ticketStates.slice(0, 2)) {
    restoreTicket(state);
    demonstrations.push(await demonstrateClaim(page, { ticketId: String(state.id) }, originalStaff.id));
    const after = assignmentSnapshot(state);
    const exactAssignee = after.staffId === originalStaff.id && after.teamId === 0;
    const oneEventAdded = after.eventIds.length === state.eventIds.length + 1;
    restoreTicket(state);
    const restored = JSON.stringify(assignmentSnapshot(state)) === JSON.stringify({
      staffId: state.staffId,
      teamId: state.teamId,
      eventIds: state.eventIds,
    });
    demonstrationOracles.push({ ticketId: state.id, exactAssignee, oneEventAdded, restored });
    if (!exactAssignee || !oneEventAdded || !restored) {
      throw new Error(`The osTicket assignment demonstration failed its oracle at ticket ${state.id}.`);
    }
  }

  const compileStartedAt = performance.now();
  const plan = compileDomWorkflow("osticket_assign_ticket_to_synthetic_agent", ticketUrl({ ticketId: String(ticketStates[0]!.id) }), demonstrations, {
    effect: "write",
    confirmation: "Assign one synthetic local ticket to the synthetic benchmark agent",
  });
  const compileMs = performance.now() - compileStartedAt;

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await page.goto(`${ORIGIN}/scp/index.php`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const authSurvivedBrowserRestart = new URL(page.url()).pathname.startsWith("/scp/") &&
    await page.locator(OUTPUT_SELECTOR).isVisible().catch(() => false);

  const unseenState = ticketStates[2]!;
  const unseenInput: ClaimInput = { ticketId: String(unseenState.id) };
  restoreTicket(unseenState);
  const before = assignmentSnapshot(unseenState);
  const prepareUrl = page.url();
  const receipt = await prepareDomWorkflowWrite(page, journal, plan, unseenInput);
  const afterPrepare = assignmentSnapshot(unseenState);
  const prepareLeftBrowserUntouched = page.url() === prepareUrl;
  let commitRequests = 0;
  const countRequest = (): void => { commitRequests += 1; };
  page.on("request", countRequest);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput);
  page.off("request", countRequest);
  const afterCommit = assignmentSnapshot(unseenState);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, plan, unseenInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = assignmentSnapshot(unseenState);

  const freshPage = await page.context().newPage();
  await freshPage.goto(ticketUrl(unseenInput), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const freshUiExact = !/Unassigned/i.test(await freshPage.locator("#field_assign").innerText()) &&
    (await freshPage.locator("#field_assign").innerText()).trim().length > 0;
  await freshPage.close();

  const preparedWithoutEffect = JSON.stringify(before) === JSON.stringify(afterPrepare) && prepareLeftBrowserUntouched;
  const exactResult = preparedWithoutEffect && afterCommit.staffId === originalStaff.id && afterCommit.teamId === 0 &&
    afterCommit.eventIds.length === before.eventIds.length + 1 && freshUiExact && repeatedCommitRejected &&
    JSON.stringify(afterRejectedRepeat) === JSON.stringify(afterCommit) && committed.receipt.status === "committed" &&
    committed.result.modelCalls === 0;

  for (const state of ticketStates) restoreTicket(state);
  const cleanupVerified = ticketStates.every((state) => JSON.stringify(assignmentSnapshot(state)) === JSON.stringify({
    staffId: state.staffId,
    teamId: state.teamId,
    eventIds: state.eventIds,
  }));
  const regressionCompilerCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const passed = authSurvivedBrowserRestart && exactResult && cleanupVerified && repeatedCommitRejected;
  const falseSuccess = !exactResult;
  const compiledDurationMs = Number(committed.result.durationMs.toFixed(2));
  const report = {
    schemaVersion: 2,
    kind: "post-v2-freeze-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: regressionCompilerCommit,
    corpus: { path: "bench/corpus-v2.json", freezeSha: V2_FREEZE_SHA },
    claimEligible: false,
    reasonExcluded: "Executed after v2 compiler fixes; retained as cross-application regression evidence rather than an untouched v2 pass",
    application: {
      id: "osticket-local-v2",
      name: "Self-hosted osTicket",
      environment: `Loopback pinned containers; ${process.platform}/${process.arch}; Chrome ${browserVersion}`,
      policyReviewDate: "2026-09-05",
      trafficBudget: "Local installation; restore ticket assignments, events, timestamps, and synthetic staff password state",
    },
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    environment: { browserVersion, platform: process.platform, architecture: process.arch },
    intervention: "guided demonstrations",
    policyBasis: "Disposable loopback-only deployment with synthetic tickets and one synthetic staff account",
    credentialHandling: "Rotated the synthetic staff password in memory and restored the prior hash and timestamps; no credential or session value was persisted",
    compileMs: Number(compileMs.toFixed(2)),
    authSurvivedBrowserRestart,
    demonstrationOracles,
    tasks: [
      {
        id: "assign-ticket-to-synthetic-agent",
        effect: "write",
        status: passed ? "passed" : "failed",
        unseen: true,
        authoringMode: "demonstrated",
        engine: plan.engine,
        exactResult,
        falseSuccess,
        duplicateCommits: repeatedCommitRejected ? 0 : 1,
        cleanupVerified,
        requests: commitRequests,
        navigations: committed.result.navigations,
        modelCalls: committed.result.modelCalls,
        ...(passed ? {} : { failureClassification: "compiler-defect" }),
        timing: { compiledDurationMs },
        oracleEvidence: {
          ticketId: unseenState.id,
          exactStaffId: afterCommit.staffId === originalStaff.id,
          teamUnchanged: afterCommit.teamId === 0,
          oneEventAdded: afterCommit.eventIds.length === before.eventIds.length + 1,
          freshUiExact,
          preparedWithoutEffect,
          repeatedCommitRejected,
          afterRejectedRepeatUnchanged: JSON.stringify(afterRejectedRepeat) === JSON.stringify(afterCommit),
        },
        resetEvidence: {
          ticketsRestored: cleanupVerified,
          syntheticStaffPasswordRestored: true,
        },
      },
    ],
    summary: {
      passed: passed ? 1 : 0,
      total: 1,
      successRate: passed ? 1 : 0,
      falseSuccesses: falseSuccess ? 1 : 0,
      duplicateCommits: repeatedCommitRejected ? 0 : 1,
    },
  };
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "osticket-v2-assignment-regression.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!passed || report.summary.duplicateCommits !== 0) {
    throw new Error(`osTicket assignment regression failed: ${JSON.stringify({ authSurvivedBrowserRestart, exactResult, cleanupVerified, duplicateCommits: report.summary.duplicateCommits })}`);
  }
  console.log(JSON.stringify({
    reportPath,
    exactResult,
    preparedWithoutEffect,
    repeatedCommitRejected,
    cleanupVerified,
    compileMs: report.compileMs,
    compiledDurationMs,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  let restorationError: unknown;
  try {
    for (const state of ticketStates) restoreTicket(state);
  } catch (error) {
    restorationError = error;
  }
  try {
    if (passwordRotated) restoreStaffPassword(originalStaff);
  } catch (error) {
    restorationError ??= error;
  }
  await rm(directory, { recursive: true, force: true });
  if (restorationError) throw restorationError;
}
