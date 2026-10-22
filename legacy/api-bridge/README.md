# Local Floreant POS ordering API

A backend API for a future voice assistant. A table's **tab** is a native Floreant
ticket; it is not a browser tab. The bridge runs in the **same Java process as
the POS**, uses its configured database and logged-in staff account, and creates
normal tickets visible in Floreant.

The voice UI and speech/AI provider are not included in this first stage.

## Start

Requires a JDK with `java`, `javac` and `jar` (JDK 23 was tested). No additional
packages are needed: the bridge uses the libraries bundled with this POS release.
The supplied scripts target macOS/Linux, not the packaged Windows JRE.

From the project root:

```sh
sh api-bridge/build.sh
export POS_API_TOKEN="$(openssl rand -hex 32)"
sh api-bridge/run.sh
```

**Close the existing POS normally before starting this launcher.** Do not start
another embedded-Derby POS process against the same database. The bridge does not
attach to an already-running POS. Starting the launcher starts the normal POS and
adds the API; the original POS JAR, plugins and configuration are not replaced.
Builds and tests do not start or modify the live POS.

Log in to the launched POS with an active shift and Create Ticket permission.
For shared tabs, use an account permitted to view the other server's tickets.
Keep this account logged in while using the API. Use one API ordering terminal;
concurrent writes to the same tab from other terminals are not supported.

The default address is `http://127.0.0.1:8787/v1`. `POS_API_PORT` overrides the
port; `POS_HOME` overrides the directory containing `floreantpos.jar`.
`POS_API_TOKEN` must have at least 32 letters, digits, underscores or hyphens.
Keep the token in protected environment/secret storage. Do not commit it, put it
in URLs, send it to an AI provider, or expose it in browser code.

```sh
curl -H "Authorization: Bearer $POS_API_TOKEN" \
  http://127.0.0.1:8787/v1/health
```

Health returns `{"status":"ready","loggedIn":true}` when ordering is available.
A running API with an uninitialized or logged-out POS returns `not_ready`.
Other endpoints return HTTP 503 until a logged-in user, terminal and shift exist.

## Endpoints

All requests require `Authorization: Bearer <token>`. All POST requests require
`Content-Type: application/json` and a fresh UUID `Idempotency-Key`.
Unknown fields, duplicate JSON keys and trailing JSON are rejected. Maximum
request body size: 64 KiB. No query parameters or browser/CORS access are accepted.

| Method | Path under `/v1` | Purpose |
| --- | --- | --- |
| GET | `/health` | Process/login readiness |
| GET | `/capabilities` | Supported and explicitly unsupported features |
| GET | `/order-types` | Native order type IDs and table/seat/kitchen flags |
| GET | `/tables` | Table numbers, availability and accessible open ticket IDs |
| GET | `/menu` | Visible menu IDs and supported item flags |
| GET | `/menu/{id}` | Per-order-type prices and modifier group constraints |
| POST | `/tables/{number}/tab` | Open a tab or reuse the single existing open tab |
| GET | `/tickets/{id}` |  Read the tab, totals, items and review revision |
| GET | `/tickets/{id}/kitchen` | Read persisted native kitchen tickets and their instructions |
| POST | `/tickets/{id}/items` | Append an atomic batch of order lines |
| POST | `/tickets/{id}/send` | Explicitly send new kitchen-eligible items |
| POST | `/tickets/{id}/kitchen/reconcile` | Manager-only uncertain-delivery recovery |

### 1. Discover IDs and open/reuse a table tab

Use `/order-types`, `/tables` and `/menu` to resolve spoken names to real IDs.
Do not let a language model invent menu IDs, prices or modifier selections.

Example body for `POST /tables/7/tab`:

```json
{
  "orderTypeId": 1,
  "guestCount": 4
}
```

The numbers are illustrative; use IDs and table numbers returned by your POS.
`guestCount` must be 1-100. The order type must use table selection and must not
require customer data. Unavailable tables are rejected. An existing tab is
reused, not overwritten; different order type/guest details return a conflict.
If multiple tabs belong to the table, select an explicit ticket ID instead.

The response contains `ticket`, `replayed`, `kitchenDeliveryUncertain` and
`created`. `ticket` contains its native `id`, `tableNumbers`, `orderTypeId`,
`guestCount`, status flags, totals, `items` and a `revision`.

### 2. Collect items and instructions

Example body for `POST /tickets/123/items`:

```json
{
  "expectedRevision": "<revision from the latest ticket response>",
  "items": [
    {
      "menuItemId": 12,
      "quantity": 2,
      "seatNumber": 1,
      "modifiers": [
        {
          "groupId": 5,
          "modifierId": 8,
          "quantity": 1,
          "type": "extra"
        }
      ],
      "instructions": ["No onions", "Nut allergy - notify chef"]
    }
  ]
}
```

- Batch size: 1-50 lines. The entire batch succeeds or rolls back.
- `quantity`: greater than zero, at most 100. Fractional quantities are only
  accepted for native fractional/weighted items.
- `seatNumber`: optional, between 1 and guest count; the order type must enable
  seat-based ordering.
- `modifiers`: optional, at most 50 selections per line. Group and modifier IDs
  must belong to the menu item. Required/minimum/maximum/exclusive group rules
  apply. Each selection requires `quantity` (1-20) and `type` (`normal` or `extra`).
  Modifier quantities are selections **per ordered item** for whole-number
  items, and per order line for weighted items. The bridge expands whole-number
  selections to native total counts, so two meals with one extra each are charged
  for two extras. Responses include the total modifier `quantity` and
  `quantityPerItem`. Use separate lines for differently customized meals.
- `instructions`: optional, at most 10 nonempty strings per line, maximum 200
  characters each, no control characters.

Floreant calculates item prices, automatic item discounts, modifier prices,
taxes, charges and totals. Clients cannot submit price overrides. Monetary
responses are JSON numbers rounded to two decimal places in the POS currency.
The line response exposes `kitchenEligible` and `sentToKitchen`; native
non-kitchen items such as beverages are not forced onto kitchen receipts.

Appending persists the ticket but **does not send it to the kitchen**. Review
the returned items, customizations, table number and totals with the customer
before dispatch. Allergy instructions are carried as text, not interpreted as
a guarantee of allergen safety.

### 3. Explicitly send the reviewed order

Example body for `POST /tickets/123/send`:

```json
{
  "expectedRevision": "<revision after adding the latest items>",
  "confirmed": true,
  "deliveryMode": "printer"
}
```

This generates native station kitchen tickets and native kitchen receipt
layouts, submits them to the configured printer devices, and persists kitchen
tickets for Floreant's kitchen display. It includes the table, items, printable
modifiers and cooking instructions. Only new kitchen-eligible items are sent;
later additions can be dispatched without reprinting earlier items.

Success also includes `kitchenTicketIds` and
`delivery: "submitted_to_configured_printers"`. This means the local print system
accepted submission, **not that paper physically emerged or a chef acknowledged
the order**. Hardware delivery cannot be made exactly-once by an HTTP API.
Missing routes are rejected rather than silently marking items as sent.
At most 64 station tickets may be produced in one dispatch.

For a kitchen-screen-only setup, explicitly use `"deliveryMode":"kitchen_display"`.
This uses the same native station routing and creates the kitchen tickets,
sent-item flags, audit record and retry result in **one database transaction**.
It never checks physical printer queues, renders a paper receipt, or submits
print jobs. A configured native virtual station route is still required; its
device name need not correspond to an installed operating-system printer.

Display-mode success reports `delivery: "persisted_to_kitchen_display"`.
Read `/tickets/{id}/kitchen` to verify the native kitchen ticket IDs, `WAITING`
status, tables, dishes, modifiers and instructions. These are the records used
by Floreant's Kitchen Display; station filters and refresh settings still
control which records appear on a particular screen. Persistence does not mean
a chef has acknowledged the order.

Omitting `deliveryMode` retains paper-printer behavior. Invalid modes are
rejected; there is no automatic print-to-display fallback. For printer mode,
all device queues are validated before recording a pending dispatch or printing.
Switching the delivery mode on a retry requires a new operation key, after any
pending print operation has been reconciled.

### Revisions and retries

Use the latest `ticket.revision` for every new append/send. A stale revision
returns HTTP 409 `stale_ticket`; reload and review the order again.
Paid, voided or closed tabs cannot be changed. API mutations are rejected while
the same ticket/table is open in the native POS order editor.

Retry a request after a connection failure with the **same UUID key, method,
path and JSON body**. Persisted operation markers prevent duplicate additions
and dispatches, including after restarting the bridge. Changed request content
with an old key is rejected. JSON property ordering must remain the same for a
retry. Successful replay returns the **current** ticket snapshot with
`replayed: true`, plus the original `created` or kitchen delivery metadata where
applicable. Successful operations return HTTP 200, including new tabs.

Each ticket supports 256 API operations; retries do not consume additional
slots. Recovery is still permitted at that limit. Continue in the POS UI after
reaching the limit rather than deleting operation history.

### Uncertain kitchen delivery

Print submission and database persistence cannot share one atomic transaction.
Before any printing, the bridge durably records a pending dispatch. A printing
failure, post-print save failure or process interruption leaves the tab blocked
for further API mutations. A retry never automatically reprints pending work.
Errors include `kitchen_delivery_uncertain` or `operation_not_completed`.

Do not edit or resend this tab in the POS UI while delivery is uncertain.
A manager must check **every** station and then POST:

```json
{"outcome":"delivered","confirmed":true}
```

to `/tickets/{id}/kitchen/reconcile` with a new key after verifying all affected
station tickets were delivered (manually deliver any missing station first).
This records native kitchen tickets and marks the dispatch complete without
printing again. A replay of the original send then reports
`delivery: "manager_confirmed_delivered"`.

Alternatively, use `{"outcome":"not_delivered","confirmed":true}` **only after
verifying no station received the dispatch**. This cancels the old operation;
reload/review the ticket and send with a new key. Never use this outcome for
partial delivery. If the POS changed the order during uncertain delivery, the
bridge refuses reconciliation until the original reviewed order is restored.

## Implementation boundaries

This adapter targets the installed Floreant 2.0.1 beta binaries. It does not
claim to expose every POS feature. Pizza sizes/crusts/sections, modifier
multipliers, miscellaneous/open-price items, item editing/removal/voiding,
ticket-wide notes, customer-required order types, transfers, payments,
manual discounts and refunds remain native-UI operations. Both paper and
display-only dispatch require native station routes. Check
`/capabilities` before offering a voice operation.

Writes run on the Swing event thread and use Hibernate transactions, native
ticket save/inventory/table hooks and audit records. No direct SQL or schema
changes are introduced; API operation history is stored in native ticket
properties. Stock is reserved atomically under menu row locks: this adapter
works around this build's native stock loop stopping at the first previously
adjusted line. The other native save hooks still run.

Kitchen receipt generation uses native layouts. Print submission uses
Jasper's exporter directly with an explicitly selected device because both
native print wrappers can swallow failures. Slow printers can temporarily block
the POS event thread. The bearer token controls access but does not replace
the logged-in user's permissions. Run this trusted-backend bridge locally;
LAN/remote exposure requires a separate authenticated transport design.

## Validation

```sh
sh api-bridge/test.sh
```

Tests use synthetic fixtures in `jdbc:derby:memory:voice_api_tests`, with their
working directory under `build/test-working`. They do not connect to the
restaurant database or submit physical print jobs. They cover HTTP validation,
the production Swing-thread adapter, native tab creation/reuse and persistence,
batch rollback, modifier and seat/instruction persistence, exact fractional
pricing/taxes/stock, receipt rendering, kitchen content, send retries, later
additions, printer failure and both manager reconciliation outcomes.
They also verify explicit display-only dispatch, native Kitchen Display DAO
readback, instructions, no physical printer calls, later additions, replay safety
and printer preflight without a pending dispatch.

Before production use, perform an operator-supervised acceptance order on a
test table with the restaurant's actual printers, modifiers, taxes and plugins.
