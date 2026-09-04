# PrestaShop benchmark fixture

The capability runner targets an operator-controlled, loopback-only installation
of PrestaShop 9.1.5 created from the official `prestashop/prestashop:9` image
and MariaDB 11.4. The application is installed with its bundled sample catalog
and orders and a synthetic administrator email of
`benchmark-admin@example.invalid`.

The runner deliberately does not accept an administrator password. It snapshots
the synthetic employee's password hash, generates and applies a temporary
password in process memory, uses a disposable persistent browser profile, then
restores the exact prior hash. It discovers PrestaShop's randomized back-office
directory locally and never persists that directory, route tokens, cookies, or
credentials in the result.

The three workflows use bundled products and orders whose IDs and initial state
are checked before execution. The runner creates an inert synthetic order status
with email, invoicing, payment, shipping, and delivery behavior disabled. It
restores all stock columns and order states, deletes benchmark-created stock
movements and order-history rows, removes the synthetic status, and verifies the
credential hash after every successful or failed run.

Run only against the isolated fixture:

```sh
npm run benchmark:prestashop:local -- --local
```

The expected loopback origin is `http://127.0.0.1:18103`. Container names and
the origin can be overridden with the `CLAPPING_HANDS_PRESTASHOP_*` environment
variables declared at the top of the runner. The script fails closed if the
sample-data shape or installed version has drifted; do not point it at a real
shop.
