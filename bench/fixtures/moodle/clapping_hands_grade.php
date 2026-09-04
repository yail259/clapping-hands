<?php
define('CLI_SCRIPT', true);
require_once(__DIR__ . '/config.php');
require_once($CFG->libdir . '/gradelib.php');

$options = getopt('', ['itemid:', 'set::', 'clear']);
$itemid = isset($options['itemid']) ? (int) $options['itemid'] : 0;
if (!$itemid) {
    throw new coding_exception('A grade item ID is required.');
}
$item = grade_item::fetch(['id' => $itemid]);
if (!$item) {
    throw new coding_exception('Grade item not found.');
}
$userid = (int) $DB->get_field('user', 'id', ['username' => 'benchmark-student'], MUST_EXIST);
if (array_key_exists('clear', $options)) {
    $item->update_final_grade($userid, null, 'clapping-hands-fixture');
} else if (array_key_exists('set', $options)) {
    $item->update_final_grade($userid, (float) $options['set'], 'clapping-hands-fixture');
}
$grade = grade_grade::fetch(['itemid' => $itemid, 'userid' => $userid]);
echo json_encode([
    'itemid' => $itemid,
    'userid' => $userid,
    'finalgrade' => $grade && $grade->finalgrade !== null ? (float) $grade->finalgrade : null,
], JSON_UNESCAPED_SLASHES) . PHP_EOL;
