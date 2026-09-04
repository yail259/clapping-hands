import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Page } from "playwright-core";
import {
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

const ORIGIN = process.env.CLAPPING_HANDS_MOODLE_ORIGIN ?? "http://127.0.0.1:18092";
const CHROME = process.env.CLAPPING_HANDS_CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const teacherPassword = process.env.CLAPPING_HANDS_MOODLE_TEACHER_PASSWORD;
const studentPassword = process.env.CLAPPING_HANDS_MOODLE_STUDENT_PASSWORD;
const compose = resolve(process.env.CLAPPING_HANDS_MOODLE_COMPOSE ??
  ".data/moodle-local/moodle-docker/bin/moodle-docker-compose");
const COURSE_INDEX = `${ORIGIN}/course/index.php`;
const OUTPUT_SELECTOR = "#page-content";
const APP_IMAGE_DIGEST = "sha256:7fd5f3356a71889fc6eda2a7cca2b44ed1e3f90556f5c3bcd9f2091789739af2";
const DB_IMAGE_DIGEST = "sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675";
const MOODLE_SOURCE_COMMIT = "8ad9354efae75c49a23ca63ec1c5e071f9fefc57";
const MOODLE_DOCKER_COMMIT = "f4c2324d32fb74d7753264381f0a9b418b6034b2";

if (!process.argv.includes("--local")) {
  throw new Error("Moodle local traffic is disabled. Pass --local for the loopback-only fixture.");
}
if (!new Set(["127.0.0.1", "localhost"]).has(new URL(ORIGIN).hostname)) {
  throw new Error("The Moodle local runner only permits a loopback origin.");
}
if (!teacherPassword || !studentPassword) {
  throw new Error("Set rotated synthetic Moodle teacher and student passwords in the process environment.");
}

type Course = {
  id: number;
  fullname: string;
  shortname: string;
  gradeitemid: number;
  gradeitem: string;
  assignmentid: number;
  assignmentcmid: number;
  assignment: string;
};

type SeedResult = {
  teacherid: number;
  studentid: number;
  courses: Course[];
};

type GradeResult = {
  itemid: number;
  userid: number;
  finalgrade: number | null;
};

type SubmissionResult = {
  assignmentid: number;
  userid: number;
  submissionid: number | null;
  status: string | null;
  attemptnumber: number | null;
  text: string | null;
  format: number | null;
};

type CourseTabInput = DomInput & { courseName: string; tabName: string };
type GradeInput = DomInput & { courseId: number; gradeItemId: number; grade: number };
type SubmissionInput = DomInput & { assignmentCmid: number; responseText: string };

const composeEnvironment = {
  ...process.env,
  MOODLE_DOCKER_WWWROOT: process.env.MOODLE_DOCKER_WWWROOT ?? resolve(".data/moodle-local/wwwroot"),
  MOODLE_DOCKER_DB: process.env.MOODLE_DOCKER_DB ?? "pgsql",
  MOODLE_DOCKER_DB_VERSION: process.env.MOODLE_DOCKER_DB_VERSION ?? "17",
  MOODLE_DOCKER_WEB_HOST: process.env.MOODLE_DOCKER_WEB_HOST ?? "127.0.0.1",
  MOODLE_DOCKER_WEB_PORT: process.env.MOODLE_DOCKER_WEB_PORT ?? "127.0.0.1:18092",
  MOODLE_DOCKER_PHP_VERSION: process.env.MOODLE_DOCKER_PHP_VERSION ?? "8.3",
  COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "clapping-hands-moodle",
};

function parseLastJson<T>(output: string): T {
  const lines = output.trim().split(/\r?\n/).reverse();
  const line = lines.find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error("The Moodle fixture command did not return JSON.");
  return JSON.parse(line) as T;
}

function phpFixture(script: string, arguments_: string[] = [], environment: Record<string, string> = {}): string {
  const environmentArguments = Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
  try {
    return execFileSync(compose, [
      "exec", "-T", ...environmentArguments, "webserver", "php", script, ...arguments_,
    ], {
      cwd: process.cwd(),
      env: composeEnvironment,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("The Moodle fixture command failed; secret-bearing process arguments were suppressed.");
  }
}

function seedFixture(): SeedResult {
  const raw = parseLastJson<SeedResult>(phpFixture("clapping_hands_seed.php", [], {
    CH_MOODLE_TEACHER_PASS: teacherPassword!,
    CH_MOODLE_STUDENT_PASS: studentPassword!,
  }));
  const result: SeedResult = {
    teacherid: Number(raw.teacherid),
    studentid: Number(raw.studentid),
    courses: raw.courses.map((course) => ({
      ...course,
      id: Number(course.id),
      gradeitemid: Number(course.gradeitemid),
      assignmentid: Number(course.assignmentid),
      assignmentcmid: Number(course.assignmentcmid),
    })),
  };
  if (result.courses.length < 3) throw new Error("The synthetic Moodle fixture requires three courses.");
  return result;
}

function grade(itemId: number, operation?: "clear", value?: number): GradeResult {
  const arguments_ = [`--itemid=${itemId}`];
  if (operation === "clear") arguments_.push("--clear");
  if (value !== undefined) arguments_.push(`--set=${value}`);
  return parseLastJson<GradeResult>(phpFixture("clapping_hands_grade.php", arguments_));
}

function submission(assignmentId: number, operation?: "clear"): SubmissionResult {
  const arguments_ = [`--assignmentid=${assignmentId}`];
  if (operation === "clear") arguments_.push("--clear");
  const raw = parseLastJson<SubmissionResult>(phpFixture("clapping_hands_submission.php", arguments_));
  return {
    ...raw,
    assignmentid: Number(raw.assignmentid),
    userid: Number(raw.userid),
    submissionid: raw.submissionid === null ? null : Number(raw.submissionid),
    attemptnumber: raw.attemptnumber === null ? null : Number(raw.attemptnumber),
    format: raw.format === null ? null : Number(raw.format),
  };
}

async function authenticate(
  page: Page,
  username: "benchmark-teacher" | "benchmark-student",
  password: string,
  courseNames: string[],
): Promise<void> {
  await page.goto(COURSE_INDEX, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (await page.locator("#username").isVisible().catch(() => false)) {
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#loginbtn").click();
    await page.waitForURL((url) => !url.pathname.includes("/login/"), { timeout: 30_000 });
    await page.goto(COURSE_INDEX, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  await page.locator(OUTPUT_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  const body = await page.locator("body").innerText();
  if (!courseNames.every((courseName) => body.includes(courseName))) {
    throw new Error(`The synthetic Moodle ${username} session did not expose all seeded courses.`);
  }
}

function guidedAction(action: { selector: string; description: string; method: string; arguments?: string[] }) {
  return {
    success: true,
    message: "guided local Moodle action",
    actions: [{ ...action, arguments: action.arguments ?? [] }],
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

async function demonstrateCourseTab(page: Page, input: CourseTabInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = `a[href*="/course/view.php"]:has-text(${JSON.stringify(input.courseName)})`;
        await page.locator(selector).click();
        await page.waitForURL((url) => url.pathname === "/course/view.php", { timeout: 15_000 });
        await page.locator("#page").filter({ hasText: input.courseName }).waitFor({ state: "visible", timeout: 15_000 });
        return guidedAction({ selector, description: `Open course ${input.courseName}`, method: "click" });
      }
      const selector = `a.nav-link:has-text(${JSON.stringify(input.tabName)})`;
      await page.locator(selector).click();
      await page.waitForURL((url) => url.pathname !== "/course/view.php", { timeout: 15_000 });
      await page.locator("#page").filter({ hasText: input.tabName }).waitFor({ state: "visible", timeout: 15_000 });
      return guidedAction({ selector, description: `Open ${input.tabName} for ${input.courseName}`, method: "click" });
    },
  }, page, COURSE_INDEX, input, [
    `Open course ${input.courseName}`,
    `Open ${input.tabName} for ${input.courseName}`,
  ], "#page");
}

function gradeStartUrl(input: GradeInput): string {
  return `${ORIGIN}/grade/report/singleview/index.php?id=${input.courseId}&item=grade&itemid=${input.gradeItemId}`;
}

async function demonstrateGrade(page: Page, input: GradeInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  const gradeInput = 'tr:has-text("Benchmark Student") input[name^="finalgrade_"]';
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = 'input[name="setmode"]';
        await page.locator(selector).check();
        await page.locator(gradeInput).waitFor({ state: "visible", timeout: 15_000 });
        return guidedAction({ selector, description: "Ensure grade edit mode is enabled", method: "check" });
      }
      if (step === 2) {
        await page.locator(gradeInput).fill(String(input.grade));
        return guidedAction({
          selector: gradeInput,
          description: `Enter synthetic grade ${input.grade}`,
          method: "fill",
          arguments: [String(input.grade)],
        });
      }
      const selector = 'input[type="submit"][value="Save"]';
      await page.locator(selector).click();
      await page.locator(gradeInput).waitFor({ state: "visible", timeout: 15_000 });
      if (Number.parseFloat(await page.locator(gradeInput).inputValue()) !== input.grade) {
        throw new Error("Moodle did not retain the demonstrated synthetic grade in the UI.");
      }
      return guidedAction({ selector, description: "Save synthetic grade", method: "click" });
    },
  }, page, gradeStartUrl(input), input, [
    "Ensure grade edit mode is enabled",
    `Enter synthetic grade ${input.grade}`,
    "Save synthetic grade",
  ], OUTPUT_SELECTOR);
}

function assignmentStartUrl(input: SubmissionInput): string {
  return `${ORIGIN}/mod/assign/view.php?id=${input.assignmentCmid}`;
}

async function demonstrateSubmission(page: Page, input: SubmissionInput): Promise<DomWorkflowDemonstration> {
  let step = 0;
  const responseInput = 'textarea[name="onlinetext_editor[text]"]';
  return demonstrateDomWorkflow({
    act: async () => {
      step += 1;
      if (step === 1) {
        const selector = 'button:has-text("Add submission")';
        await Promise.all([
          page.waitForURL((url) => url.pathname === "/mod/assign/view.php" &&
            url.searchParams.get("id") === String(input.assignmentCmid) &&
            url.searchParams.get("action") === "editsubmission", { timeout: 30_000 }),
          page.locator(selector).click(),
        ]);
        await page.locator(responseInput).waitFor({ state: "visible", timeout: 15_000 });
        return guidedAction({ selector, description: "Add a synthetic assignment submission", method: "click" });
      }
      if (step === 2) {
        await page.locator(responseInput).fill(input.responseText);
        return guidedAction({
          selector: responseInput,
          description: "Enter the requested synthetic response",
          method: "fill",
          arguments: [input.responseText],
        });
      }
      const selector = "#id_submitbutton";
      await Promise.all([
        page.waitForURL((url) => url.pathname === "/mod/assign/view.php" &&
          url.searchParams.get("id") === String(input.assignmentCmid) &&
          url.searchParams.get("action") === "view", { timeout: 30_000 }),
        page.locator(selector).click(),
      ]);
      await page.locator(OUTPUT_SELECTOR).filter({ hasText: input.responseText }).waitFor({
        state: "visible",
        timeout: 15_000,
      });
      return guidedAction({ selector, description: "Save the synthetic assignment submission", method: "click" });
    },
  }, page, assignmentStartUrl(input), input, [
    "Add a synthetic assignment submission",
    "Enter the requested synthetic response",
    "Save the synthetic assignment submission",
  ], OUTPUT_SELECTOR);
}

const fixture = seedFixture();
const allCourseNames = fixture.courses.map((course) => course.fullname);
const directory = await mkdtemp(resolve(tmpdir(), "clapping-hands-moodle-local-"));
const journal = new EffectJournal(resolve(directory, "effect-journal.json"));
let browser: PersistentWorkflowBrowser | null = null;
let cleanupVerified = false;
try {
  for (const course of fixture.courses) {
    grade(course.gradeitemid, "clear");
    submission(course.assignmentid, "clear");
  }
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  let page = await browser.page();
  await authenticate(page, "benchmark-teacher", teacherPassword, allCourseNames);

  const readDemonstrations = [
    await demonstrateCourseTab(page, { courseName: fixture.courses[0]!.fullname, tabName: "Participants" }),
    await demonstrateCourseTab(page, { courseName: fixture.courses[1]!.fullname, tabName: "Grades" }),
  ];
  const readPlan = compileDomWorkflow("moodle_open_course_tab", COURSE_INDEX, readDemonstrations);

  const writeDemoInputs: GradeInput[] = [
    { courseId: fixture.courses[1]!.id, gradeItemId: fixture.courses[1]!.gradeitemid, grade: 72 },
    { courseId: fixture.courses[2]!.id, gradeItemId: fixture.courses[2]!.gradeitemid, grade: 83 },
  ];
  const writeDemonstrations: DomWorkflowDemonstration[] = [];
  const demonstrationOracles: Array<{ gradeItemId: number; expected: number; observed: number | null }> = [];
  for (const input of writeDemoInputs) {
    grade(input.gradeItemId, "clear");
    writeDemonstrations.push(await demonstrateGrade(page, input));
    const observed = grade(input.gradeItemId).finalgrade;
    demonstrationOracles.push({ gradeItemId: input.gradeItemId, expected: input.grade, observed });
    if (observed !== input.grade) throw new Error("A guided Moodle grade demonstration failed its server-side oracle.");
    grade(input.gradeItemId, "clear");
  }
  const writePlan = compileDomWorkflow("moodle_set_synthetic_grade", gradeStartUrl(writeDemoInputs[0]!), writeDemonstrations, {
    effect: "write",
    confirmation: "Change one synthetic student's grade in the loopback-only Moodle fixture",
  });
  if (writePlan.effect.commitActionIndex !== 0 || writePlan.actions[0]?.method !== "check") {
    throw new Error("The Moodle write plan did not conservatively retain the idempotent edit-mode precondition in its commit suffix.");
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredTeacherCookies = (await (await browser.context()).cookies([ORIGIN])).length;

  const readReplayInput: CourseTabInput = {
    courseName: fixture.courses[2]!.fullname,
    tabName: "Participants",
  };
  const readReplay = await replayDomWorkflow(page, readPlan, readReplayInput);
  const readUrl = new URL(readReplay.url);
  const readExact = readUrl.pathname === "/user/index.php" &&
    readUrl.searchParams.get("id") === String(fixture.courses[2]!.id) &&
    readReplay.text.includes(readReplayInput.courseName) && readReplay.text.includes(readReplayInput.tabName) &&
    readReplay.modelCalls === 0;

  const writeReplayInput: GradeInput = {
    courseId: fixture.courses[0]!.id,
    gradeItemId: fixture.courses[0]!.gradeitemid,
    grade: 61,
  };
  grade(writeReplayInput.gradeItemId, "clear");
  const beforeWrite = grade(writeReplayInput.gradeItemId);
  const receipt = await prepareDomWorkflowWrite(page, journal, writePlan, writeReplayInput);
  const afterPrepare = grade(writeReplayInput.gradeItemId);
  const committed = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, writePlan, writeReplayInput);
  const afterCommit = grade(writeReplayInput.gradeItemId);
  const repeatedCommitRejected = await commitPreparedDomWorkflowWrite(page, journal, receipt.id, writePlan, writeReplayInput)
    .then(() => false, () => true);
  const afterRejectedRepeat = grade(writeReplayInput.gradeItemId);
  const writeExact = beforeWrite.finalgrade === null && afterPrepare.finalgrade === null &&
    afterCommit.finalgrade === writeReplayInput.grade &&
    afterRejectedRepeat.finalgrade === writeReplayInput.grade &&
    committed.receipt.status === "committed" && committed.result.modelCalls === 0 && repeatedCommitRejected;

  for (const course of fixture.courses) grade(course.gradeitemid, "clear");

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "student-profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  await authenticate(page, "benchmark-student", studentPassword, allCourseNames);

  const submissionDemoInputs: SubmissionInput[] = [
    {
      assignmentCmid: fixture.courses[1]!.assignmentcmid,
      responseText: "Clapping Hands reliability observation alpha.",
    },
    {
      assignmentCmid: fixture.courses[2]!.assignmentcmid,
      responseText: "Clapping Hands effect observation beta.",
    },
  ];
  const submissionDemonstrations: DomWorkflowDemonstration[] = [];
  const submissionDemonstrationOracles: Array<{
    assignmentId: number;
    expected: string;
    observed: string | null;
    status: string | null;
  }> = [];
  for (let index = 0; index < submissionDemoInputs.length; index += 1) {
    const input = submissionDemoInputs[index]!;
    const course = fixture.courses[index + 1]!;
    submission(course.assignmentid, "clear");
    submissionDemonstrations.push(await demonstrateSubmission(page, input));
    const observed = submission(course.assignmentid);
    submissionDemonstrationOracles.push({
      assignmentId: course.assignmentid,
      expected: input.responseText,
      observed: observed.text,
      status: observed.status,
    });
    if (observed.text !== input.responseText || observed.status !== "submitted") {
      throw new Error("A guided Moodle submission demonstration failed its server-side oracle.");
    }
    submission(course.assignmentid, "clear");
  }
  const submissionPlan = compileDomWorkflow(
    "moodle_submit_synthetic_assignment",
    assignmentStartUrl(submissionDemoInputs[0]!),
    submissionDemonstrations,
    {
      effect: "write",
      confirmation: "Submit one synthetic response in the loopback-only Moodle fixture",
    },
  );
  const submissionPlanContract = {
    actionCount: submissionPlan.actions.length,
    commitActionIndex: submissionPlan.effect.commitActionIndex,
    inputEvidenceNames: submissionPlan.validation.inputEvidenceNames ?? [],
    retainedDemonstratedResponse: submissionDemoInputs.some((input) =>
      JSON.stringify(submissionPlan).includes(input.responseText)
    ),
  };
  if (submissionPlanContract.actionCount !== 3 || submissionPlanContract.commitActionIndex !== 1 ||
    !submissionPlanContract.inputEvidenceNames.includes("responseText") ||
    submissionPlanContract.retainedDemonstratedResponse) {
    throw new Error(`The Moodle submission plan did not retain the frozen contract: ${JSON.stringify(submissionPlanContract)}.`);
  }

  await browser.close();
  browser = new PersistentWorkflowBrowser({
    allowedOrigins: [ORIGIN],
    profileDirectory: resolve(directory, "student-profile"),
    executablePath: CHROME,
    headless: true,
  });
  page = await browser.page();
  const restoredStudentCookies = (await (await browser.context()).cookies([ORIGIN])).length;
  const submissionReplayCourse = fixture.courses[0]!;
  const submissionReplayInput: SubmissionInput = {
    assignmentCmid: submissionReplayCourse.assignmentcmid,
    responseText: "Clapping Hands compiler observation gamma.",
  };
  submission(submissionReplayCourse.assignmentid, "clear");
  const beforeSubmission = submission(submissionReplayCourse.assignmentid);
  const submissionPrepareUrl = page.url();
  const submissionReceipt = await prepareDomWorkflowWrite(
    page,
    journal,
    submissionPlan,
    submissionReplayInput,
  );
  const afterSubmissionPrepare = submission(submissionReplayCourse.assignmentid);
  const submissionPrepareLeftBrowserUntouched = page.url() === submissionPrepareUrl;
  const committedSubmission = await commitPreparedDomWorkflowWrite(
    page,
    journal,
    submissionReceipt.id,
    submissionPlan,
    submissionReplayInput,
  );
  const afterSubmissionCommit = submission(submissionReplayCourse.assignmentid);
  const repeatedSubmissionCommitRejected = await commitPreparedDomWorkflowWrite(
    page,
    journal,
    submissionReceipt.id,
    submissionPlan,
    submissionReplayInput,
  ).then(() => false, () => true);
  const afterRejectedSubmissionRepeat = submission(submissionReplayCourse.assignmentid);
  const submissionExact = beforeSubmission.submissionid === null &&
    afterSubmissionPrepare.submissionid === null && submissionPrepareLeftBrowserUntouched &&
    afterSubmissionCommit.submissionid !== null &&
    afterSubmissionCommit.status === "submitted" &&
    afterSubmissionCommit.text === submissionReplayInput.responseText &&
    afterRejectedSubmissionRepeat.submissionid === afterSubmissionCommit.submissionid &&
    afterRejectedSubmissionRepeat.text === submissionReplayInput.responseText &&
    committedSubmission.receipt.status === "committed" &&
    committedSubmission.result.modelCalls === 0 && repeatedSubmissionCommitRejected &&
    committedSubmission.result.text.includes(submissionReplayInput.responseText) &&
    committedSubmission.result.text.includes("Submitted for grading");

  for (const course of fixture.courses) {
    grade(course.gradeitemid, "clear");
    submission(course.assignmentid, "clear");
  }
  cleanupVerified = fixture.courses.every((course) =>
    grade(course.gradeitemid).finalgrade === null && submission(course.assignmentid).submissionid === null
  );

  const rows = [
    {
      task: "open-unseen-course-tab",
      effect: "read",
      mechanism: "authenticated-server-navigation",
      exactResult: readExact,
      compiledModelCalls: readReplay.modelCalls,
      compiledDurationMs: readReplay.durationMs,
      navigations: readReplay.navigations,
    },
    {
      task: "change-unseen-course-grade",
      effect: "write",
      mechanism: "idempotent-mode-precondition-plus-prepare-commit",
      exactResult: writeExact,
      preparedWithoutEffect: afterPrepare.finalgrade === null,
      repeatedCommitRejected,
      compiledModelCalls: committed.result.modelCalls,
      compiledDurationMs: committed.result.durationMs,
      oracle: {
        expectedGrade: writeReplayInput.grade,
        gradeAfterCommit: afterCommit.finalgrade,
        gradeAfterRejectedRepeat: afterRejectedRepeat.finalgrade,
      },
    },
    {
      task: "submit-unseen-student-assignment",
      effect: "write",
      mechanism: "role-separated-input-bound-activity-plus-prepare-commit",
      exactResult: submissionExact,
      preparedWithoutEffect: afterSubmissionPrepare.submissionid === null,
      prepareLeftBrowserUntouched: submissionPrepareLeftBrowserUntouched,
      repeatedCommitRejected: repeatedSubmissionCommitRejected,
      compiledModelCalls: committedSubmission.result.modelCalls,
      compiledDurationMs: committedSubmission.result.durationMs,
      oracle: {
        expectedStatus: "submitted",
        statusAfterCommit: afterSubmissionCommit.status,
        exactTextAfterCommit: afterSubmissionCommit.text === submissionReplayInput.responseText,
        unchangedAfterRejectedRepeat: afterRejectedSubmissionRepeat.submissionid ===
          afterSubmissionCommit.submissionid &&
          afterRejectedSubmissionRepeat.text === submissionReplayInput.responseText,
        renderedResultMatched: committedSubmission.result.text.includes(submissionReplayInput.responseText) &&
          committedSubmission.result.text.includes("Submitted for grading"),
      },
    },
  ];
  const report = {
    schemaVersion: 1,
    kind: "self-hosted-application-capability-regression",
    generatedAt: new Date().toISOString(),
    compilerCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    application: "Self-hosted Moodle 5.2.2",
    origin: ORIGIN,
    sources: { moodle: MOODLE_SOURCE_COMMIT, moodleDocker: MOODLE_DOCKER_COMMIT },
    containerImages: { application: APP_IMAGE_DIGEST, database: DB_IMAGE_DIGEST },
    intervention: "guided",
    policyBasis: "Loopback-only official Moodle developer environment with synthetic users, courses, grades, assignments, and responses",
    credentialHandling: "Read rotated synthetic credentials from the process environment; persisted no credential or Moodle session key in plans or reports",
    claimScope: "Capability regression on one pinned self-hosted application; not a speed or untouched-holdout result",
    developmentHistory: [{
      stage: "stateful-mode-control",
      result: "corrected-before-compiled-run",
      reason: "Moodle edit mode is a persistent toggle, so a literal click could disable it on a later run.",
      correction: "Demonstrate an idempotent check action that ensures edit mode is enabled regardless of prior session state.",
      compilerChanged: false,
    }, {
      stage: "grade-format-assertion",
      result: "failed-closed-then-corrected",
      reason: "Moodle formats numeric grades with decimal places, while the first harness assertion required the unformatted input string.",
      correction: "Compare the rendered grade numerically and continue to require the independent server-side gradebook oracle.",
      compilerChanged: false,
    }, {
      stage: "fixture-email-debugging",
      result: "corrected-before-compiled-run",
      reason: "Moodle developer debugging disables an automatic post-submission redirect when a synthetic .invalid email address triggers a notification warning.",
      correction: "Use example.com fixture addresses with delivery contained by the local Mailpit service, then clear the discovery submission.",
      compilerChanged: false,
    }, {
      stage: "submission-effect-assertion",
      result: "failed-closed-then-corrected",
      reason: "The first submission action opens a read-only form, so the compiler conservatively placed the effect boundary at the following fill rather than the initial click required by the first harness assertion.",
      correction: "Require commitActionIndex 1 while continuing to prove that prepare performs no browser action or database mutation and commit replays the entire workflow only once.",
      compilerChanged: false,
    }],
    demonstrationOracles,
    submissionDemonstrationOracles,
    environment: {
      browserVersion: await page.context().browser()?.version(),
      platform: process.platform,
      architecture: process.arch,
    },
    authSurvivedBrowserRestart: restoredTeacherCookies > 0 && restoredStudentCookies > 0,
    roleAuth: {
      teacherSurvivedBrowserRestart: restoredTeacherCookies > 0,
      studentSurvivedBrowserRestart: restoredStudentCookies > 0,
    },
    fixtureCleanupVerified: cleanupVerified,
    rows,
    summary: {
      passed: rows.filter((row) => row.exactResult && row.compiledModelCalls === 0).length,
      total: rows.length,
      falseSuccesses: rows.filter((row) => !row.exactResult).length,
      duplicateCommits: (repeatedCommitRejected ? 0 : 1) +
        (repeatedSubmissionCommitRejected ? 0 : 1),
    },
  };
  if (report.summary.passed !== report.summary.total || report.summary.duplicateCommits !== 0 ||
    !report.authSurvivedBrowserRestart || !cleanupVerified) {
    throw new Error(`Moodle local capability run failed: ${JSON.stringify(report.summary)}.`);
  }
  const reportDirectory = resolve(process.cwd(), "bench/runs/2026-09-05");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = resolve(reportDirectory, "moodle-local-expanded-capability.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report.summary }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  if (!cleanupVerified) {
    for (const course of fixture.courses) {
      grade(course.gradeitemid, "clear");
      submission(course.assignmentid, "clear");
    }
  }
  await rm(directory, { recursive: true, force: true });
}
