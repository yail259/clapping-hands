# Moodle local fixture

This fixture is only for a loopback Moodle development installation populated
with synthetic users, courses, and grades. It must not be pointed at a real
school or production gradebook.

The published run used Moodle 5.2.2 at commit
`8ad9354efae75c49a23ca63ec1c5e071f9fefc57` with the official
[`moodle-docker`](https://github.com/moodlehq/moodle-docker) development
environment at commit `f4c2324d32fb74d7753264381f0a9b418b6034b2`, PHP 8.3,
and PostgreSQL 17. Follow that project's installation instructions, bind the
web server to loopback port `18092`, and install Moodle before running this
fixture.

Copy `clapping_hands_seed.php` and `clapping_hands_grade.php` into the root of
the local Moodle checkout. The benchmark calls them inside the web container:
the first creates or resets three synthetic courses, one teacher, one student,
and three manual grade items; the second is the independent grade oracle and
cleanup path.

Run with newly generated local-only credentials:

```sh
export CLAPPING_HANDS_MOODLE_TEACHER_PASSWORD="$(openssl rand -hex 24)"
export CLAPPING_HANDS_MOODLE_STUDENT_PASSWORD="$(openssl rand -hex 24)"
npm run benchmark:moodle:local -- --local
unset CLAPPING_HANDS_MOODLE_TEACHER_PASSWORD
unset CLAPPING_HANDS_MOODLE_STUDENT_PASSWORD
```

The runner refuses non-loopback origins. It clears every synthetic grade before
and after the run and does not place credentials, session keys, plans, or page
bodies in the report.
