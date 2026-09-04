import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type { Page } from "playwright-core";
import {
  captureDomOutput,
  compileDomWorkflow,
  demonstrateDomWorkflow,
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

const ORIGIN = process.env.CLAPPING_HANDS_NEXTCLOUD_ORIGIN ?? "http://127.0.0.1:18091";
const APP_IMAGE_DIGEST = "sha256:9ed3924f92f651aab622b23557b3f3dbcf04f7678567f50a41dbace2463c0a52";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const username = process.env.CLAPPING_HANDS_NEXTCLOUD_USERNAME ?? "benchmark-admin";
const password = process.env.CLAPPING_HANDS_NEXTCLOUD_PASSWORD;
const uploadRoot = resolve(process.env.CLAPPING_HANDS_UPLOAD_ROOT ?? ".data/uploads");
const uploadFiles = ["nextcloud-alpha.txt", "nextcloud-beta.txt", "nextcloud-gamma.txt"]
  .map((name) => resolve(uploadRoot, name));
const START_URL = `${ORIGIN}/apps/files/files`;
const OUTPUT_SELECTOR = "#app-content-vue";

if (!process.argv.includes("--local")) {
  throw new Error("Nextcloud local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Nextcloud local runner only permits a loopback origin.");
}
if (!password) throw new Error("Set CLAPPING_HANDS_NEXTCLOUD_PASSWORD for the local synthetic fixture.");

type FolderInput = DomInput & { folderName: string };
type UploadInput = DomInput & { file: string };
type StoredFileInput = DomInput & { filename: string };
type PublicShare = { id: string; shareType: number; path: string };

type OcsResponse<T> = {
  ocs?: {
    meta?: { statuscode?: number };
    data?: T;
  };
};

function basicAuthorization(): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function webDav(filename: string, method: "HEAD" | "DELETE"): Promise<Response> {
  return fetch(`${ORIGIN}/remote.php/dav/files/${encodeURIComponent(username)}/${encodeURIComponent(filename)}`, {
    method,
    headers: { authorization: basicAuthorization() },
    redirect: "manual",
  });
}

async function removeFixture(filename: string): Promise<void> {
  const response = await webDav(filename, "DELETE");
  if (![204, 404].includes(response.status)) {
    throw new Error(`Could not reset synthetic Nextcloud fixture ${filename}: HTTP ${response.status}.`);
  }
}

async function fileMetadata(filename: string): Promise<{ exists: boolean; etag: string | null; size: number | null }> {
  const response = await webDav(filename, "HEAD");
  if (response.status === 404) return { exists: false, etag: null, size: null };
  if (!response.ok) throw new Error(`Nextcloud WebDAV oracle returned HTTP ${response.status}.`);
  const length = response.headers.get("content-length");
  return {
    exists: true,
    etag: response.headers.get("etag"),
    size: length === null ? null : Number.parseInt(length, 10),
  };
}

async function waitForFile(filename: string): Promise<{ exists: boolean; etag: string | null; size: number | null }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const metadata = await fileMetadata(filename);
    if (metadata.exists) return metadata;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The synthetic Nextcloud upload ${filename} did not become observable.`);
}

function ocsHeaders(): Record<string, string> {
  return {
    authorization: basicAuthorization(),
    "ocs-apirequest": "true",
    accept: "application/json",
  };
}

async function publicShares(filename: string): Promise<PublicShare[]> {
  const endpoint = new URL(`${ORIGIN}/ocs/v2.php/apps/files_sharing/api/v1/shares`);
  endpoint.searchParams.set("path", `/${filename}`);
  endpoint.searchParams.set("reshares", "true");
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { headers: ocsHeaders(), redirect: "manual" });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Nextcloud OCS share oracle returned HTTP ${response.status}.`);
  const payload = await response.json() as OcsResponse<Array<{
    id: string | number;
    share_type: string | number;
    path: string;
  }>>;
  if (![100, 200].includes(Number(payload.ocs?.meta?.statuscode)) || !Array.isArray(payload.ocs?.data)) {
    throw new Error("Nextcloud OCS share oracle returned an invalid response.");
  }
  return payload.ocs.data
    .map((share) => ({ id: String(share.id), shareType: Number(share.share_type), path: share.path }))
    .filter((share) => share.shareType === 3 && share.path === `/${filename}`);
}

async function removePublicShares(filename: string): Promise<void> {
  for (const share of await publicShares(filename)) {
    const endpoint = new URL(`${ORIGIN}/ocs/v2.php/apps/files_sharing/api/v1/shares/${encodeURIComponent(share.id)}`);
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint, {
      method: "DELETE",
      headers: ocsHeaders(),
      redirect: "manual",
    });
    if (!response.ok) throw new Error(`Could not reset synthetic Nextcloud share: HTTP ${response.status}.`);
    const payload = await response.json() as OcsResponse<unknown>;
    if (![100, 200].includes(Number(payload.ocs?.meta?.statuscode))) {
      throw new Error("Nextcloud OCS share cleanup failed.");
    }
  }
}

async function waitForPublicShare(filename: string): Promise<PublicShare[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shares = await publicShares(filename);
    if (shares.length > 0) return shares;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`The synthetic Nextcloud public share for ${filename} did not become observable.`);
}

async function login(page: Page): Promise<void> {
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#user").isVisible().catch(() => false)) {
    await page.locator("#user").fill(username);
    await page.locator("#password").fill(password!);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 30_000 });
  }
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
}

async function dismissOnboarding(page: Page): Promise<number> {
  let dismissed = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dialog = page.getByRole("dialog");
    if (!await dialog.isVisible().catch(() => false)) break;
    const dismiss = dialog.getByRole("button", { name: /^(skip|close)$/i });
    if (await dismiss.count()) await dismiss.first().click();
    else await page.keyboard.press("Escape");
    dismissed += 1;
    await page.waitForTimeout(500);
  }
  if (await page.getByRole("dialog").isVisible().catch(() => false)) {
    throw new Error("The explicit Nextcloud fixture onboarding precondition could not be completed.");
  }
  return dismissed;
}

function guidedClick(actions: Array<{ selector: string; description: string; method: "click" }>) {
  return {
    success: true,
    message: "guided local Nextcloud action",
    actions,
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateFolder(page: Page, input: FolderInput): Promise<DomWorkflowDemonstration> {
  return demonstrateDomWorkflow({
    act: async () => {
      const selector = `[aria-label=${JSON.stringify(`Open folder ${input.folderName}`)}]`;
      await page.locator(selector).click();
      await page.waitForURL((url) => /^\/apps\/files\/files\/\d+$/.test(url.pathname) &&
        url.searchParams.get("dir") === `/${input.folderName}`, {
        timeout: 15_000,
      });
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: input.folderName }).waitFor({ state: "visible", timeout: 15_000 });
      return guidedClick([{ selector, description: `Open folder ${input.folderName}`, method: "click" }]);
    },
  }, page, START_URL, input, [`Open folder ${input.folderName}`], OUTPUT_SELECTOR);
}

async function demonstrateUpload(page: Page, input: UploadInput): Promise<DomWorkflowDemonstration> {
  const filename = basename(input.file);
  const demonstration = await demonstrateDomWorkflow({
    act: async () => { throw new Error("Stagehand must not receive an operator file path."); },
  }, page, START_URL, input, [`Upload ${input.file}`], OUTPUT_SELECTOR);
  await waitForFile(filename);
  const extensionIndex = filename.lastIndexOf(".");
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await page.locator("button[data-cy-files-list-row-name-link]")
    .filter({ hasText: new RegExp(`^${escapeRegex(stem)}\\s*${escapeRegex(extension)}$`, "i") })
    .waitFor({ state: "visible", timeout: 15_000 });
  demonstration.output = await captureDomOutput(page, OUTPUT_SELECTOR);
  return demonstration;
}

async function demonstrateDownload(page: Page, input: StoredFileInput): Promise<DomWorkflowDemonstration> {
  return demonstrateDomWorkflow({
    act: async () => {
      const actionsSelector = `tr[data-cy-files-list-row-name=${JSON.stringify(input.filename)}] button[aria-label="Actions"]`;
      const downloadSelector = '[role="menu"]:visible button:has-text("Download")';
      await page.locator(actionsSelector).click();
      await page.locator(downloadSelector).waitFor({ state: "visible", timeout: 15_000 });
      await page.locator(downloadSelector).click();
      return guidedClick([
        { selector: actionsSelector, description: `Open actions for ${input.filename}`, method: "click" },
        { selector: downloadSelector, description: `Download ${input.filename}`, method: "click" },
      ]);
    },
  }, page, START_URL, input, [`Download ${input.filename}`], OUTPUT_SELECTOR);
}

async function demonstratePublicShare(page: Page, input: StoredFileInput): Promise<DomWorkflowDemonstration> {
  const demonstration = await demonstrateDomWorkflow({
    act: async () => {
      const sharingSelector = `tr[data-cy-files-list-row-name=${JSON.stringify(input.filename)}] button[aria-label="Sharing options"]`;
      const createSelector = '#app-sidebar-vue button[aria-label="Create a new share link"]';
      await page.locator(sharingSelector).click();
      await page.locator("#app-sidebar-vue").filter({ hasText: input.filename })
        .waitFor({ state: "visible", timeout: 15_000 });
      await page.locator(createSelector).click();
      await waitForPublicShare(input.filename);
      return guidedClick([
        { selector: sharingSelector, description: `Open sharing options for ${input.filename}`, method: "click" },
        { selector: createSelector, description: `Create a public link for ${input.filename}`, method: "click" },
      ]);
    },
  }, page, START_URL, input, [`Create a public link for ${input.filename}`], "#app-sidebar-vue");
  const shares = await publicShares(input.filename);
  if (shares.length !== 1) throw new Error("A guided Nextcloud public-share demonstration failed its OCS oracle.");
  return demonstration;
}

const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-nextcloud-local-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
const previousArtifactRoot = process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
process.env.CLAPPING_HANDS_ARTIFACT_ROOT = resolve(directory, "artifacts");
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
try {
  for (const file of uploadFiles) {
    await removePublicShares(basename(file));
    await removeFixture(basename(file));
  }
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await login(page);
  const onboardingDialogsDismissed = await dismissOnboarding(page);

  const folderDemonstrations = [
    await demonstrateFolder(page, { folderName: "Documents" }),
    await demonstrateFolder(page, { folderName: "Photos" }),
  ];
  const folderPlan = compileDomWorkflow("nextcloud_open_folder", START_URL, folderDemonstrations);

  const uploadDemonstrations = [
    await demonstrateUpload(page, { file: uploadFiles[0]! }),
    await demonstrateUpload(page, { file: uploadFiles[1]! }),
  ];
  const uploadPlan = compileDomWorkflow("nextcloud_upload_synthetic_file", START_URL, uploadDemonstrations, {
    effect: "write",
    confirmation: "Upload one allowlisted synthetic file to the loopback-only Nextcloud fixture",
  });
  const serializedUploadPlan = JSON.stringify(uploadPlan);
  if (serializedUploadPlan.includes(basename(uploadFiles[0]!)) || serializedUploadPlan.includes(basename(uploadFiles[1]!))) {
    throw new Error("The compiled Nextcloud plan retained a demonstrated local filename.");
  }

  const storedFiles = uploadFiles.map((file) => basename(file));
  const downloadDemonstrations = [
    await demonstrateDownload(page, { filename: storedFiles[0]! }),
    await demonstrateDownload(page, { filename: storedFiles[1]! }),
  ];
  const downloadPlan = compileDomWorkflow("nextcloud_download_synthetic_file", START_URL, downloadDemonstrations);

  const shareDemonstrations: DomWorkflowDemonstration[] = [];
  for (const filename of storedFiles.slice(0, 2)) {
    await removePublicShares(filename);
    shareDemonstrations.push(await demonstratePublicShare(page, { filename }));
    await removePublicShares(filename);
  }
  const sharePlan = compileDomWorkflow("nextcloud_create_public_share", START_URL, shareDemonstrations, {
    effect: "write",
    confirmation: "Create one public link for a synthetic file in the loopback-only Nextcloud fixture",
  });
  if (sharePlan.effect.commitActionIndex !== 1 || sharePlan.actions[1]?.method !== "click") {
    throw new Error("The Nextcloud share plan did not identify the public-link creation control as its effect boundary.");
  }
  for (const [name, plan] of [["download", downloadPlan], ["share", sharePlan]] as const) {
    const serialized = JSON.stringify(plan);
    if (storedFiles.slice(0, 2).some((filename) => serialized.includes(filename))) {
      throw new Error(`The compiled Nextcloud ${name} plan retained a demonstrated filename.`);
    }
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredCookies = (await (await browser.context()).cookies([ORIGIN])).length;
  const folderReplay = await replayDomWorkflow(page, folderPlan, { folderName: "Templates" });
  const folderReplayUrl = new URL(folderReplay.url);
  const folderExact = /^\/apps\/files\/files\/\d+$/.test(folderReplayUrl.pathname) &&
    folderReplayUrl.searchParams.get("dir") === "/Templates" && folderReplay.text.includes("Templates") &&
    folderReplay.modelCalls === 0;

  const replayInput: UploadInput = { file: uploadFiles[2]! };
  const beforeUpload = await fileMetadata(basename(replayInput.file));
  const receipt = await prepareDomWorkflowWrite(page, journal, uploadPlan, replayInput);
  const afterPrepare = await fileMetadata(basename(replayInput.file));
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, uploadPlan, replayInput);
  const afterCommit = await waitForFile(basename(replayInput.file));
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, uploadPlan, replayInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = await fileMetadata(basename(replayInput.file));
  const uploadExact = !beforeUpload.exists && !afterPrepare.exists && afterCommit.exists &&
    committed.receipt.status === "committed" && committed.result.modelCalls === 0 &&
    repeatedCommitRejected && afterRejectedRepeat.etag === afterCommit.etag && afterRejectedRepeat.size === afterCommit.size;

  const storedFileInput: StoredFileInput = { filename: basename(replayInput.file) };
  const downloadReplay = await replayDomWorkflow(page, downloadPlan, storedFileInput);
  const downloadedArtifact = downloadReplay.downloads?.[0];
  const expectedDownload = await readFile(replayInput.file);
  const expectedDownloadHash = createHash("sha256").update(expectedDownload).digest("hex");
  const downloadExact = downloadReplay.modelCalls === 0 && downloadReplay.downloads?.length === 1 &&
    downloadedArtifact?.suggestedFilename === storedFileInput.filename &&
    downloadedArtifact.size === expectedDownload.byteLength && downloadedArtifact.sha256 === expectedDownloadHash;

  await removePublicShares(storedFileInput.filename);
  const sharesBeforePrepare = await publicShares(storedFileInput.filename);
  const sharePrepareUrl = page.url();
  const shareReceipt = await prepareDomWorkflowWrite(page, journal, sharePlan, storedFileInput);
  const sharesAfterPrepare = await publicShares(storedFileInput.filename);
  const sharePrepareLeftBrowserUntouched = page.url() === sharePrepareUrl;
  const shared = await commitPreparedDomWorkflowWrite(page, journal, shareReceipt.id, sharePlan, storedFileInput);
  const sharesAfterCommit = await waitForPublicShare(storedFileInput.filename);
  const repeatedShareRejected = await commitPreparedDomWorkflowWrite(page, journal, shareReceipt.id, sharePlan, storedFileInput)
    .then(() => false, () => true);
  const sharesAfterRejectedRepeat = await publicShares(storedFileInput.filename);
  const shareExact = sharesBeforePrepare.length === 0 && sharesAfterPrepare.length === 0 &&
    sharePrepareLeftBrowserUntouched && sharesAfterCommit.length === 1 &&
    sharesAfterCommit[0]?.shareType === 3 && sharesAfterCommit[0]?.path === `/${storedFileInput.filename}` &&
    sharesAfterRejectedRepeat.length === 1 && sharesAfterRejectedRepeat[0]?.id === sharesAfterCommit[0]?.id &&
    shared.receipt.status === "committed" && shared.result.modelCalls === 0 && repeatedShareRejected;

  for (const filename of storedFiles) await removePublicShares(filename);
  for (const file of uploadFiles) await removeFixture(basename(file));
  const filesRemoved = (await Promise.all(uploadFiles.map((file) => fileMetadata(basename(file)))))
    .every((metadata) => !metadata.exists);
  const sharesRemoved = (await Promise.all(storedFiles.map((filename) => publicShares(filename))))
    .every((shares) => shares.length === 0);
  cleanupVerified = filesRemoved && sharesRemoved;

  const rows = [
    {
      task: "open-unseen-folder",
      effect: "read",
      path: "compiled-dom",
      exactResult: folderExact,
      compiledModelCalls: folderReplay.modelCalls,
      compiledDurationMs: folderReplay.durationMs,
      navigations: folderReplay.navigations,
    },
    {
      task: "upload-allowlisted-file",
      effect: "write",
      path: "prepare-commit",
      exactResult: uploadExact,
      preparedWithoutEffect: !afterPrepare.exists,
      receiptStatus: committed.receipt.status,
      repeatedCommitRejected,
      oracle: {
        afterCommitExists: afterCommit.exists,
        size: afterCommit.size,
        unchangedAfterRejectedRepeat: afterRejectedRepeat.etag === afterCommit.etag &&
          afterRejectedRepeat.size === afterCommit.size,
      },
      compiledModelCalls: committed.result.modelCalls,
      compiledDurationMs: committed.result.durationMs,
    },
    {
      task: "download-unseen-file",
      effect: "read",
      path: "compiled-dom-download",
      exactResult: downloadExact,
      compiledModelCalls: downloadReplay.modelCalls,
      compiledDurationMs: downloadReplay.durationMs,
      artifact: {
        count: downloadReplay.downloads?.length ?? 0,
        suggestedFilenameMatched: downloadedArtifact?.suggestedFilename === storedFileInput.filename,
        sizeMatched: downloadedArtifact?.size === expectedDownload.byteLength,
        sha256Matched: downloadedArtifact?.sha256 === expectedDownloadHash,
      },
    },
    {
      task: "create-unseen-public-share",
      effect: "write",
      path: "prepare-commit",
      exactResult: shareExact,
      preparedWithoutEffect: sharesAfterPrepare.length === 0,
      prepareLeftBrowserUntouched: sharePrepareLeftBrowserUntouched,
      receiptStatus: shared.receipt.status,
      repeatedCommitRejected: repeatedShareRejected,
      oracle: {
        publicShareCountAfterCommit: sharesAfterCommit.length,
        publicShareType: sharesAfterCommit[0]?.shareType,
        unchangedAfterRejectedRepeat: sharesAfterRejectedRepeat[0]?.id === sharesAfterCommit[0]?.id,
      },
      compiledModelCalls: shared.result.modelCalls,
      compiledDurationMs: shared.result.durationMs,
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted Nextcloud 33.0.8",
    origin: ORIGIN,
    containerImages: { application: APP_IMAGE_DIGEST },
    intervention: "guided",
    policyBasis: "Loopback-only official container with one synthetic user and synthetic files",
    credentialHandling: "Read a rotated synthetic credential from the process environment; persisted no credential or file contents in plans or reports",
    claimScope: "Capability regression on one pinned self-hosted application; not a speed or untouched-holdout result",
    apiDisposition: "WebDAV and OCS are preferred for API-covered file/share operations; they were used only as independent oracles and cleanup paths for the UI fallback rows",
    developmentHistory: [
      {
        stage: "file-input-selection",
        result: "failed-closed",
        reason: "The file page exposed both a primary uploader and an editor attachment input.",
        fix: "Select only a uniquely scored semantic upload/attachment input and continue to reject anonymous or tied candidates.",
      },
      {
        stage: "artifact-and-permission-expansion",
        result: "four-workflow-regression",
        reason: "The original local row covered folder navigation and upload but not a returned artifact or independently verified share state.",
        fix: "Add input-bound download and public-share plans with SHA-256 and OCS oracles, receipt reuse rejection, and verified cleanup.",
      },
    ],
    runnerCorrections: [
      "Accept Nextcloud 33's numeric file-view route plus its explicit dir query instead of assuming the older path shape.",
      "Match split filename/extension row text rather than assuming a filename-specific accessible label.",
    ],
    environment: {
      browserVersion: await page.context().browser()?.version(),
      platform: process.platform,
      architecture: process.arch,
    },
    onboardingDialogsDismissed,
    authSurvivedBrowserRestart: restoredCookies > 0,
    uploadSelector: uploadPlan.actions[0]?.selector,
    fixtureCleanupVerified: cleanupVerified,
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: repeatedCommitRejected && repeatedShareRejected ? 0 : 1,
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0 ||
    !report.authSurvivedBrowserRestart || !cleanupVerified) {
    throw new Error(`Nextcloud local capability run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-04");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "nextcloud-local-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (!cleanupVerified) {
    await Promise.all(uploadFiles.map((file) => removePublicShares(basename(file)).catch(() => {})));
    await Promise.all(uploadFiles.map((file) => removeFixture(basename(file)).catch(() => {})));
  }
  if (previousArtifactRoot === undefined) delete process.env.CLAPPING_HANDS_ARTIFACT_ROOT;
  else process.env.CLAPPING_HANDS_ARTIFACT_ROOT = previousArtifactRoot;
  await rm(directory, { recursive: true, force: true });
}
