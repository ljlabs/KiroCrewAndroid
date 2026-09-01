# Offline-first mobile/PWA dashboard testing

This guide covers the responsive dashboard migration in `website/`. The repository currently has **no native Android Gradle/Kotlin project**; the mobile target is the browser/PWA dashboard, which can be installed to an Android home screen after it is served over HTTPS (or tested in Chrome device emulation).

## Prerequisites

- Python 3.10 or newer
- Node.js 22 or newer and npm
- A configured `kiro-cli` installation for real agent turns
- The repository's development dependencies installed

From the repository root:

```bash
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
pip install -e ".[dev]"
cd website
npm install
```

## Run the dashboard

Use two terminals. From the repository root, start the gateway:

```bash
PYTHONPATH=src python -m kiro_crew gateway
```

In a second terminal:

```bash
cd website
npm run dev
```

Open the Vite URL printed by the dev server, normally `http://localhost:5173`. The Vite configuration proxies `/api/*` and `/api/ws` to the gateway. For a production-like check, run `npm run build`, then use the gateway's bundled dashboard at `http://localhost:5476`.

To test the mobile layout, open Chrome DevTools, enable the device toolbar, choose a phone-sized viewport, and navigate to `/chat`. The responsive dashboard shell and chat composer are the migration target. No Android Studio, Gradle wrapper, or APK build is expected from this repository.

## Manual offline test

1. Open a real existing chat slot while the gateway is running. Send one normal message and confirm that the agent response arrives through the existing `/api/ws` connection.
2. Leave the chat slot open. In Chrome DevTools, select **Network → Offline**. The dashboard should show the sync banner and keep the chat shell available from the browser/service-worker cache.
3. Type a normal message in the existing slot and send it. A valid ordinary message is written to IndexedDB before the composer is cleared. It appears as a local user row and remains pending; it is not rendered as a server-owned `queued` row.
4. Reload the page while still offline. The cached shell should load and the durable local message should be restored in the same slot. The message is identified by its stable `sendId`, so reload must not create a second local copy.
5. Return DevTools to **No throttling** or reconnect the network. The WebSocket reconnects, refreshes authoritative slot state, and replays durable messages serially. The original `sendId` is sent in the request metadata and as `X-Idempotency-Key`.
6. Confirm that the local row settles exactly once: an accepted turn becomes delivered, a server-accepted busy turn becomes server-owned queued, and the eventual agent response appears through `/api/ws`. There must not be duplicate user rows or duplicate agent turns.
7. Test a gateway outage separately by stopping the gateway process while the browser remains online. Browser reachability and gateway/WebSocket reachability are different signals; the message should remain durable and retry after the gateway is available again.

The existing split-pane chat composer uses the same durable message path. Steer actions, approvals, question cards, continue/stop controls, and unsupported attachment workflows remain online-only because they cannot safely be represented as a simple replayable chat turn.

## Status and recovery behavior

- **Offline:** cached reads remain visible and ordinary valid messages can be saved locally for later delivery.
- **Syncing:** durable pending messages are replayed in creation order after reconnect.
- **Delivered:** the gateway accepted the turn and returned a receipt or an authoritative transcript echo.
- **Queued:** the gateway accepted the message behind a currently running turn; the server queue owns it from this point onward.
- **Unknown:** the request may have reached the gateway but its response was lost. The same `sendId` is retained instead of blindly minting a replacement turn.
- **Error:** the gateway explicitly refused the message or the transport failed before acceptance. The durable record remains available for retry.
- **Conflict:** the same durable operation cannot be safely applied to the current server state and requires review.

The banner is mounted at the root shell and combines the generic REST outbox with the durable chat/note outbox. Existing WebSocket reconnect behavior is preserved; WebSocket traffic is never routed through the generic `fetch` interceptor.

## Automated verification

Frontend checks:

```bash
cd website
npm run typecheck
npx vitest run src/test/durableOutbox.test.ts
npx vitest run src/test/offline.test.ts
npm run build
```

Backend idempotency checks:

```bash
cd /path/to/KiroCrewAndroid
pytest -q test/test_dashboard_chat.py -k 'idempotency or duplicate or send_id'
```

The full frontend suite is available with `npm run test:website`; the full backend suite is `pytest` from the repository root. Build warnings from the existing Vite/Tailwind configuration do not indicate an offline-sync failure; typecheck and test failures do.

## Important scope and limitations

- This is a responsive web/PWA migration, not a native Android app. A native APK requires a separate Android project and platform integration.
- The service worker caches the application shell only; IndexedDB owns API cache and durable outbox state. WebSocket traffic is not cached.
- Offline sends require an existing slot. Creating a brand-new slot while completely offline is not silently attached to a different session.
- The backend idempotency ledger is bounded and scoped to authenticated user/app/session/slot. It prevents duplicate keyed turns during normal replay and returns the original receipt for a duplicate key. A crash between recording a claim and starting the agent task is a narrow server-side recovery limitation.
- Cached data is last-known data, not authoritative server state. Reconnect reconciliation always prefers the server transcript and server queue.
- Attachments and complex side effects need their own durable contracts; they are not treated as generic offline JSON mutations.
