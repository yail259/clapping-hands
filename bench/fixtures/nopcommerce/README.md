# nopCommerce local fixture

The published run used the official `nopcommerceteam/nopcommerce:4.90.6`
container (`sha256:d5234d39ca3649b41b106729e55122298206cecf88f509553d8a7633447e9591`)
with PostgreSQL 17 on a private/default Docker bridge. The storefront was bound
only to `127.0.0.1:18120` and populated through the vendor installer with its
sample catalogue and a synthetic administrator.

Create the PostgreSQL `citext` extension before starting nopCommerce. The .NET
process loads PostgreSQL type metadata at startup; adding the extension after
the process has already connected can leave the installer seeing `citext` as an
unknown type. The application intentionally exits once after installation and
must then be started again with its generated configuration.

Run the benchmark with the synthetic administrator password:

```sh
export CLAPPING_HANDS_NOPCOMMERCE_PASSWORD="<rotated local fixture password>"
npm run benchmark:nopcommerce:local -- --local
unset CLAPPING_HANDS_NOPCOMMERCE_PASSWORD
```

The separate admin-write benchmark creates and rotates its own random synthetic
administrator password in memory, then restores the previous hash and salt:

```sh
npm run benchmark:nopcommerce:admin:local -- --local
```

It compiles two varied product-description edits, closes and reopens the
persistent browser profile, and applies a third unseen edit through the durable
prepare/commit path. PostgreSQL and the public product page are independent
oracles. The script restores every description, its original update timestamp,
and the prior administrator credential even when the run fails.

The runner refuses non-loopback origins. It verifies the three sample products
in PostgreSQL, removes every cart row for the synthetic account before and
after the run, and uses the database rather than the rendered notification as
the cart oracle. It does not persist credentials, anti-forgery tokens, plans,
or page bodies in the report.

The official Web API plugin is separately licensed and must be configured with
a signing key. The benchmarks probe the documented Swagger and token routes;
if a task-complete API is configured, it should be preferred over UI
compilation. The pinned fixture has the frontend plugin installed, but no
backend/admin API provider, so a protected catalogue edit remains an eligible
UI-compilation task.
