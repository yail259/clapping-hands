<?php
define('CLI_SCRIPT', true);
require_once(__DIR__ . '/config.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->libdir . '/gradelib.php');

$teacherpass = getenv('CH_MOODLE_TEACHER_PASS');
$studentpass = getenv('CH_MOODLE_STUDENT_PASS');
if (!$teacherpass || !$studentpass) {
    throw new coding_exception('Synthetic fixture passwords are required.');
}

function ensure_user(string $username, string $firstname, string $lastname, string $password): stdClass {
    global $DB, $CFG;
    $user = $DB->get_record('user', ['username' => $username, 'deleted' => 0]);
    if (!$user) {
        $record = (object) [
            'auth' => 'manual',
            'confirmed' => 1,
            'mnethostid' => $CFG->mnet_localhost_id,
            'username' => $username,
            'firstname' => $firstname,
            'lastname' => $lastname,
            'email' => $username . '@example.invalid',
            'city' => 'Sydney',
            'country' => 'AU',
        ];
        $record->id = user_create_user($record, false, false);
        $user = $DB->get_record('user', ['id' => $record->id], '*', MUST_EXIST);
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
$category = core_course_category::get_default();
$coursefixtures = [
    ['shortname' => 'CH-COMPILER', 'fullname' => 'Compiler Fundamentals', 'idnumber' => 'ch-compiler', 'gradeitem' => 'Compiler exercise'],
    ['shortname' => 'CH-RELIABILITY', 'fullname' => 'Workflow Reliability', 'idnumber' => 'ch-reliability', 'gradeitem' => 'Reliability exercise'],
    ['shortname' => 'CH-EFFECTS', 'fullname' => 'Effect Safety', 'idnumber' => 'ch-effects', 'gradeitem' => 'Effect exercise'],
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
    $result['courses'][] = [
        'id' => $course->id,
        'fullname' => $course->fullname,
        'shortname' => $course->shortname,
        'gradeitemid' => $gradeitem->id,
        'gradeitem' => $gradeitem->itemname,
    ];
    grade_regrade_final_grades($course->id);
}

echo json_encode($result, JSON_UNESCAPED_SLASHES) . PHP_EOL;
