# Local WordPress fixture

The WordPress regressions use the official `wordpress:7.1.0-php8.3-apache`
image with a MariaDB 11.4 database on loopback. All credentials remain in the
container environment or benchmark process environment and are never written
to reports.

The response-header pagination runner reads the documented public posts REST
resource with `per_page=1`, learns `X-WP-TotalPages` from two independent
traces, publishes one synthetic post through WordPress's own PHP API, and
requires compiled replay to return that unseen post exactly once before it is
permanently removed. This is a protocol regression and API-first negative
control, not a claim that UI compilation is preferable to WordPress's API.
