<?php
define('CLI_SCRIPT', true);
require_once(__DIR__ . '/config.php');

$options = getopt('', ['assignmentid:', 'clear']);
$assignmentid = isset($options['assignmentid']) ? (int) $options['assignmentid'] : 0;
if ($assignmentid <= 0) {
    throw new coding_exception('An assignment ID is required.');
}

$assignment = $DB->get_record('assign', ['id' => $assignmentid], '*', MUST_EXIST);
$studentid = (int) $DB->get_field('user', 'id', ['username' => 'benchmark-student'], MUST_EXIST);
$submission = $DB->get_record('assign_submission', [
    'assignment' => $assignmentid,
    'userid' => $studentid,
    'latest' => 1,
]);

if (isset($options['clear']) && $submission) {
    $DB->delete_records('assignsubmission_onlinetext', ['submission' => $submission->id]);
    $DB->delete_records('assign_submission', ['id' => $submission->id]);
    $submission = false;
}

$online = $submission ? $DB->get_record('assignsubmission_onlinetext', [
    'assignment' => $assignmentid,
    'submission' => $submission->id,
]) : false;

echo json_encode([
    'assignmentid' => $assignment->id,
    'userid' => $studentid,
    'submissionid' => $submission ? (int) $submission->id : null,
    'status' => $submission ? $submission->status : null,
    'attemptnumber' => $submission ? (int) $submission->attemptnumber : null,
    'text' => $online ? $online->onlinetext : null,
    'format' => $online ? (int) $online->onlineformat : null,
], JSON_UNESCAPED_SLASHES) . PHP_EOL;
