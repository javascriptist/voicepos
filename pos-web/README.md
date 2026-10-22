# pos-web

The POS screen: tables, touch ordering, kitchen view and an activity log of every voice and
touch order. React + Vite + TypeScript (strict).

It holds no order logic of its own. Touch actions are sent to the voice server as order JSON
(the same contract the voice pipeline produces), and the server sends back ticket updates, so
voice and touch are validated, applied and timed the same way.

```sh
npm install
npm run dev          # http://localhost:5173, proxies /ws to the server on :8000
npm test             # unit tests (Vitest)
npm run lint && npm run typecheck && npm run format:check
```

Start the server first: `cd ../server && uv run uvicorn voicepos.app:app --port 8000`
(`VOICEPOS_SERVER=http://host:port npm run dev` to point elsewhere).

- `src/useServer.ts`: socket to `/ws/pos`, reconnects, acknowledges each order after paint
  (the `pos_updated` timing stage).
- `src/state.ts`: reducer for server messages; `src/order.ts`: prices, options, touch orders.
- `src/components/`: Tables, Order (menu + ticket + options sheet), Kitchen, Activity.
