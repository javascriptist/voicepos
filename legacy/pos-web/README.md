# The Crown & Copper • Modern POS Web Interface

A sleek, responsive Point of Sale web application designed for **The Crown & Copper** pub in York, UK. It interfaces seamlessly with the local Floreant POS system via the native Java API bridge (`http://127.0.0.1:8787/v1`).

Built following **Emil Kowalski's Design Engineering Principles**:
- Tactile, snappy feedback (`scale(0.97)` on button press with 160ms transition).
- Natural transitions (modals starting from `scale(0.95)` with `opacity: 0`, never `scale(0)`).
- Custom easing curves (`cubic-bezier(0.23, 1, 0.32, 1)`).
- Fast, non-blocking toast notifications.
- Rich dark pub aesthetic with amber/brass highlights.

---

## Architecture

```
┌─────────────────────────────────┐
│     Browser (Web POS UI)        │
│  - Floor Plan / Tables          │
│  - Catalog / Ordering           │
│  - Customizations / Modifiers   │
│  - KDS Kitchen Screen           │
└───────────────┬─────────────────┘
                │ HTTP (localhost:3000)
┌───────────────▼─────────────────┐
│   Node.js Proxy Gateway         │
│  - Generates Idempotency UUIDs  │
│  - Adds Bearer Token auth       │
│  - Strips Origin (prevents 403) │
└───────────────┬─────────────────┘
                │ Local HTTP (localhost:8787/v1)
┌───────────────▼─────────────────┐
│   Floreant POS API Bridge       │
│  (local.pos.api.Main)           │
│  - Swing Event Thread safe      │
│  - Native Hibernate / Derby DB  │
│  - CrownCopper-KDS Virtual Disp.│
└─────────────────────────────────┘
```

---

## Features

1. **Floor Plan & Table Management**:
   - Visual grid of all 50 pub tables with capacities (2, 4, 6 seats).
   - Filter by Available, Occupied, Dirty, or search by table number.
   - One-tap tab opening with order type (Dine In, Takeaway, Bar Tab) and guest count.

2. **Register & Menu Catalog**:
   - Instant search across all food, cask ales, wines, and puddings.
   - Category filtering (Pub Classics, Starters, Brunch, Cask & Cider, Wines, Puddings, Sides).
   - Customization modal supporting seat assignments, modifier groups (min/max selection constraints, normal and extra prices), and custom cooking instructions.

3. **Active Tab & Cart**:
   - Real-time pricing with UK 20% VAT (tax inclusive).
   - Quick allergy and cooking instruction tags (*No onions*, *Nut allergy alert*, *Well done*, etc.).
   - Visual distinction between items already sent to kitchen vs. new items pending dispatch.

4. **Printer-Free Kitchen Dispatch (KDS)**:
   - "Send to Kitchen" dispatches directly using `deliveryMode: "kitchen_display"`.
   - Never requires physical receipt or kitchen printers; orders route to the virtual KDS route.
   - Dedicated **Kitchen Display System (KDS)** tab in the web interface auto-syncs every 5s to show live cookable orders, table numbers, sequence numbers, and allergy alerts.

5. **Ticket Lookup & Audit**:
   - Browse and inspect open checks, ticket totals, and revision history.

---

## Quick Start

### 1. Launch the Floreant POS with the API Bridge

From the project root:

```sh
sh api-bridge/build.sh
sh api-bridge/run.sh
```

Log in on the POS desktop interface (e.g. Admin PIN `1111`) with an active shift.

### 2. Start the Web POS UI

In a new terminal:

```sh
sh pos-web/start.sh
```

Open [http://localhost:3000](http://localhost:3000) in any modern browser (or on a tablet/iPad).

---

## API Endpoints Used

| UI Action | Web Proxy Endpoint | Native POS Bridge Path |
| --- | --- | --- |
| Check Status | `GET /api/health` | `GET /v1/health` |
| Capabilities | `GET /api/capabilities` | `GET /v1/capabilities` |
| Load Tables | `GET /api/tables` | `GET /v1/tables` |
| Open / Reuse Tab | `POST /api/tables/:num/tab` | `POST /v1/tables/:num/tab` |
| Load Menu | `GET /api/menu` | `GET /v1/menu` |
| Item Modifiers | `GET /api/menu/:id` | `GET /v1/menu/:id` |
| View Tab | `GET /api/tickets/:id` | `GET /v1/tickets/:id` |
| Append Items | `POST /api/tickets/:id/items` | `POST /v1/tickets/:id/items` |
| Send to Kitchen | `POST /api/tickets/:id/send` | `POST /v1/tickets/:id/send` (`deliveryMode: "kitchen_display"`) |
| Read Kitchen Tickets | `GET /api/tickets/:id/kitchen` | `GET /v1/tickets/:id/kitchen` |
| KDS Aggregator | `GET /api/kds` | Combines `/v1/tables` + `/v1/tickets/*` |

---

## Sora Voice Assistant Integration (Agora Conversational AI Engine v2)

Waiters can operate the entire POS hands-free through a headset or AirPods using the **Sora** voice agent powered by Agora Conversational AI Engine v2 (`deepgram nova-3` + `gpt-4.1-mini` + `minimax speech-2.8-turbo`).

### Voice Tool Endpoints (`/api/voice/*`)

| Tool Name | Method | Voice Bridge Endpoint | Function & Spoken Behavior |
| --- | --- | --- | --- |
| `getTables` | `GET` | `/api/voice/tables` | Returns floor status, available vs occupied tables, active ticket IDs. |
| `getMenu` | `GET` | `/api/voice/menu` | Returns menu items, categories, and authoritative GBP prices. |
| `openTableTab` | `POST` | `/api/voice/open-tab` | Opens new tab or retrieves active tab by table number and guest count. |
| `getTicket` | `POST` | `/api/voice/get-ticket` | Reviews order contents, quantities, modifiers, instructions, and POS total. |
| `addTicketItems` | `POST` | `/api/voice/add-items` | Fuzzy-resolves dish names (e.g. *cheeseburger*, *coke*, *fish & chips*), appends items to ticket, and recalculates total. |
| `sendToKitchen` | `POST` | `/api/voice/send-kitchen` | Confirmed kitchen dispatch directly to the Kitchen Display System without printers. |

Tool endpoints always return HTTP 200 with `success: true|false` and a short spoken-style `error`, so the LLM can relay failures instead of hitting a transport error. Ambiguous dish names (e.g. *pie*) and required menu choices (e.g. steak cooking) come back as `success: false` with the options, and nothing is added. The menu is cached for 60s (`VOICE_MENU_CACHE_MS`), mutations on the same ticket are serialized, a stale revision on add is reloaded and retried once, and a POS timeout is retried with the same `Idempotency-Key`, so items are never added or dispatched twice.

### In-app Sora (the "Sora" tab)

The Sora tab is a conversation with memory, as a typed chat or a hands-free call (Call, Mute, End). It remembers the current table and earlier messages, answers menu questions (what's in an item, price, bar or kitchen) from the POS item descriptions, and if you order for a table that isn't open, it holds the order, asks to open the table and how many guests, then adds the items.

- With `OPENAI_API_KEY` set, it runs the same LLM, system prompt and tools as the headset agent (`VOICE_LLM_MODEL`, default `gpt-4.1-mini`; `OPENAI_BASE_URL` for any OpenAI-compatible endpoint).
- Without a key it uses a built-in rule-based assistant with the same memory and flows (less flexible phrasing).
- Menu answers come from each item's **Description** in Floreant Back Office; fill those in for drinks and dishes.

### Launching the Voice Assistant

```sh
ngrok http 3000                      # public URL for Agora's tool calls
sh pos-web/launch-sora-agent.sh      # auto-detects ngrok, or pass the URL as the first argument
sh pos-web/launch-sora-agent.sh status
sh pos-web/launch-sora-agent.sh stop
```

`agora-join-payload.json` is the agent template (`__PUBLIC_URL__` is substituted at launch). `agora-agent.js` stops the previous agent before joining, gives each agent a unique name and records it in `.agent-state.json`; the **Reconnect Voice Agent** button calls the same code.

| Variable | Purpose |
| --- | --- |
| `AGORA_CUSTOMER_ID` / `AGORA_CUSTOMER_SECRET` | Agora RESTful credentials (preferred; don't expire) |
| `AGORA_AUTH_TOKEN` | Alternative `agora token=` auth (expires) |
| `AGORA_RTC_TOKEN` | Overrides the agent's RTC token in the payload (expires) |
| `PUBLIC_URL` | Public URL when not using ngrok on `:4040` |
| `VOICE_TOOL_TOKEN` | Shared secret; Agora sends it as `x-voice-token` and the server requires it on tunnelled tool calls (set it for both `start.sh` and the launcher) |
| `ALLOW_PUBLIC_UI=1` | Allow the web UI/POS proxy through the tunnel (blocked by default; only `/api/voice/*` tools are exposed) |
| `POS_TIMEOUT_MS` | Per-request POS timeout (default 6000) |
