<?php
define('CLI_SCRIPT', true);
require_once(__DIR__ . '/config.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->libdir . '/gradelib.php');

$teacherpass = getenv('CH_MOODLE_TEACHER_PASS');
$studentpass = getenv('CH_MOODLE_STUDENT_PASS');
if (!$teacherpass || !$studentpass) {
    throw new coding_exception('Synthetic fixture passwords are required.');
}

function ensure_user(string $username, string $firstname, string $lastname, string $password): stdClass {
    global $DB, $CFG;
    $email = $username . '@example.com';
    $user = $DB->get_record('user', ['username' => $username, 'deleted' => 0]);
    if (!$user) {
        $record = (object) [
            'auth' => 'manual',
            'confirmed' => 1,
            'mnethostid' => $CFG->mnet_localhost_id,
            'username' => $username,
            'firstname' => $firstname,
            'lastname' => $lastname,
            'email' => $email,
            'city' => 'Sydney',
            'country' => 'AU',
        ];
        $record->id = user_create_user($record, false, false);
        $user = $DB->get_record('user', ['id' => $record->id], '*', MUST_EXIST);
    }
    if ($user->email !== $email) {
        $user->email = $email;
        user_update_user($user, false, false);
    }
    update_internal_user_password($user, $password);
    return $user;
}

function ensure_enrolment(stdClass $course, stdClass $user, string $roleshortname): void {
    global $DB;
    $roleid = $DB->get_field('role', 'id', ['shortname' => $roleshortname], MUST_EXIST);
    $manual = enrol_get_plugin('manual');
    foreach (enrol_get_instances($course->id, true) as $instance) {
        if ($instance->enrol === 'manual') {
            $manual->enrol_user($instance, $user->id, $roleid);
            return;
        }
    }
    throw new coding_exception('Manual enrolment instance missing.');
}

$teacher = ensure_user('benchmark-teacher', 'Benchmark', 'Teacher', $teacherpass);
$student = ensure_user('benchmark-student', 'Benchmark', 'Student', $studentpass);
set_user_preference('htmleditor', 'textarea', $student->id);
$admin = get_admin();
\core\session\manager::set_user($admin);
$category = core_course_category::get_default();
$coursefixtures = [
    [
        'shortname' => 'CH-COMPILER',
        'fullname' => 'Compiler Fundamentals',
        'idnumber' => 'ch-compiler',
        'gradeitem' => 'Compiler exercise',
        'assignment' => 'Compiler reflection',
        'assignmentidnumber' => 'ch-assignment-compiler',
    ],
    [
        'shortname' => 'CH-RELIABILITY',
        'fullname' => 'Workflow Reliability',
        'idnumber' => 'ch-reliability',
        'gradeitem' => 'Reliability exercise',
        'assignment' => 'Reliability reflection',
        'assignmentidnumber' => 'ch-assignment-reliability',
    ],
    [
        'shortname' => 'CH-EFFECTS',
        'fullname' => 'Effect Safety',
        'idnumber' => 'ch-effects',
        'gradeitem' => 'Effect exercise',
        'assignment' => 'Effect safety reflection',
        'assignmentidnumber' => 'ch-assignment-effects',
    ],
];
$result = ['teacherid' => $teacher->id, 'studentid' => $student->id, 'courses' => []];

foreach ($coursefixtures as $fixture) {
    $course = $DB->get_record('course', ['idnumber' => $fixture['idnumber']]);
    if (!$course) {
        $course = create_course((object) [
            'fullname' => $fixture['fullname'],
            'shortname' => $fixture['shortname'],
            'idnumber' => $fixture['idnumber'],
            'category' => $category->id,
            'visible' => 1,
            'format' => 'topics',
            'numsections' => 3,
        ]);
    }
    ensure_enrolment($course, $teacher, 'editingteacher');
    ensure_enrolment($course, $student, 'student');

    $gradeitem = grade_item::fetch([
        'courseid' => $course->id,
        'itemtype' => 'manual',
        'itemname' => $fixture['gradeitem'],
    ]);
    if (!$gradeitem) {
        $gradeitem = new grade_item((object) [
            'courseid' => $course->id,
            'categoryid' => null,
            'itemname' => $fixture['gradeitem'],
            'itemtype' => 'manual',
            'gradetype' => GRADE_TYPE_VALUE,
            'grademin' => 0,
            'grademax' => 100,
        ], false);
        $gradeitem->insert('clapping-hands-fixture');
    }
    $assignmoduleid = $DB->get_field('modules', 'id', ['name' => 'assign'], MUST_EXIST);
    $assignmentcm = $DB->get_record('course_modules', [
        'course' => $course->id,
        'module' => $assignmoduleid,
        'idnumber' => $fixture['assignmentidnumber'],
    ]);
    if (!$assignmentcm) {
        [, , , , $moduleinfo] = prepare_new_moduleinfo_data($course, 'assign', 1);
        $moduleinfo->name = $fixture['assignment'];
        $moduleinfo->cmidnumber = $fixture['assignmentidnumber'];
        $moduleinfo->introeditor['text'] = '<p>Synthetic benchmark response only.</p>';
        $moduleinfo->introeditor['format'] = FORMAT_HTML;
        $moduleinfo->alwaysshowdescription = 1;
        $moduleinfo->submissiondrafts = 0;
        $moduleinfo->requiresubmissionstatement = 0;
        $moduleinfo->sendnotifications = 0;
        $moduleinfo->sendstudentnotifications = 0;
        $moduleinfo->sendlatenotifications = 0;
        $moduleinfo->duedate = 0;
        $moduleinfo->cutoffdate = 0;
        $moduleinfo->gradingduedate = 0;
        $moduleinfo->allowsubmissionsfromdate = 0;
        $moduleinfo->grade = 100;
        $moduleinfo->teamsubmission = 0;
        $moduleinfo->requireallteammemberssubmit = 0;
        $moduleinfo->teamsubmissiongroupingid = 0;
        $moduleinfo->blindmarking = 0;
        $moduleinfo->hidegrader = 0;
        $moduleinfo->markingworkflow = 0;
        $moduleinfo->markingallocation = 0;
        $moduleinfo->maxattempts = 1;
        $moduleinfo->attemptreopenmethod = 'untilpass';
        $moduleinfo->assignsubmission_onlinetext_enabled = 1;
        $moduleinfo->assignsubmission_onlinetext_wordlimit_enabled = 0;
        $moduleinfo->assignsubmission_onlinetext_wordlimit = 0;
        $moduleinfo = add_moduleinfo($moduleinfo, $course);
        $assignmentcm = get_coursemodule_from_id('assign', $moduleinfo->coursemodule, 0, false, MUST_EXIST);
    }
    $assignment = $DB->get_record('assign', ['id' => $assignmentcm->instance], '*', MUST_EXIST);
    $result['courses'][] = [
        'id' => $course->id,
        'fullname' => $course->fullname,
        'shortname' => $course->shortname,
        'gradeitemid' => $gradeitem->id,
        'gradeitem' => $gradeitem->itemname,
        'assignmentid' => $assignment->id,
        'assignmentcmid' => $assignmentcm->id,
        'assignment' => $assignment->name,
    ];
    grade_regrade_final_grades($course->id);
}

echo json_encode($result, JSON_UNESCAPED_SLASHES) . PHP_EOL;
