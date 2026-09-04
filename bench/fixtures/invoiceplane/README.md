# InvoicePlane local fixture

This fixture is only for a loopback InvoicePlane installation populated with
synthetic clients and invoices. Do not point the benchmark at a real business
or production financial records.

The published run used official InvoicePlane 1.7.2 source at commit
`aaeea1e4825785c6138fa84be49ac373bac4f0af`, built with its container entrypoint,
and MariaDB 11.4. The application was bound only to `127.0.0.1:18096`. Follow
the project's official container deployment instructions, generate new
database and encryption secrets, complete setup with the synthetic
`admin@clapping-hands.invalid` account, and name the containers:

- `clapping-hands-invoiceplane-app`
- `clapping-hands-invoiceplane-db`

The runner reads the database password from the application container's
environment in memory, rotates the disposable administrator password before
each run, and refuses a non-loopback origin. It seeds three fixture clients,
deletes every matching synthetic invoice before and after the run, and removes
the clients at cleanup. MariaDB is the independent oracle for prepare, commit,
calculated totals, duplicate prevention, and cleanup.

Run the frozen workflow with:

```sh
npm run benchmark:invoiceplane:local -- --local
```

Override the loopback origin or exact container names only when the fixture was
started under different local names:

```sh
export CLAPPING_HANDS_INVOICEPLANE_ORIGIN="http://127.0.0.1:18096"
export CLAPPING_HANDS_INVOICEPLANE_APP_CONTAINER="clapping-hands-invoiceplane-app"
export CLAPPING_HANDS_INVOICEPLANE_DB_CONTAINER="clapping-hands-invoiceplane-db"
npm run benchmark:invoiceplane:local -- --local
unset CLAPPING_HANDS_INVOICEPLANE_ORIGIN
unset CLAPPING_HANDS_INVOICEPLANE_APP_CONTAINER
unset CLAPPING_HANDS_INVOICEPLANE_DB_CONTAINER
```

The report contains image digests, source revision, browser version, result
oracles, and cleanup status. It contains no password, cookie, session ID, CSRF
token, invoice body, or client data beyond the fixed synthetic fixture labels.
