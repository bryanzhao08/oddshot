# API and app checks

Checked the local server at `http://localhost:8787` on 2026-10-15. Reproduce the
complete sweep with `node validation/scripts/api_checks.mjs`; raw status, response,
health, sample market, demo spike, and SSE observations are in `api_checks.json`.

## Results

- `GET /`, health, markets, known-market history, movers, VIX, alerts, and subscriptions
  returned HTTP 200. The server reported 600 markets (300 from each venue).
- Subscription create returned 201; read and update returned 200; delete returned
  200. A final subscription-list read was empty.
- The test route was called with a subscription that has `webhook: null`; it returned
  HTTP 400 with `no webhook configured`. This is the expected safe behavior and sent
  no request to any external destination.
- `POST /api/demo/spike` returned HTTP 201 with `demo: true`. The connected SSE stream
  returned HTTP 200 and delivered initial `tick` and `vix` events plus the injected
  `spike` event.
- No API bug found in this pass. The required demo injection is recorded in the
  persistent recent-alerts buffer by the server. The temporary subscription was
  deleted; the final list showed zero subscriptions.

## Reproduction

Run the script from the repository root while the server is running. It makes no
webhook request. If a request fails partway through, its `finally` cleanup deletes
the temporary subscription and records remaining subscriptions in the output.
