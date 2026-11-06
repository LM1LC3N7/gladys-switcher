# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Switcher devices (water
heaters, Power Plug, Runner shutters, Breeze air conditioners) over their local
protocol: a Node.js service (Node 22+, ESM, no build step) that runs in its own
sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. See `TODO.md` for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/stops.test.js            # one file
npm run cover                             # regenerate cover.png (800×534)
npm run lint
npm run format:check
node scripts/mutants.mjs                  # mutation check of the guards, one at a time
npx github:GladysAssistant/integration-store .
```

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> SwitcherApp (shared with the tests)
src/app.js                        SwitcherApp: scans, reads, stops, commands, runs, status
src/protocol/frame.js             frame length and CRC (seal, check)
src/protocol/packets.js           models and requests (bounded values)
src/protocol/parse.js             announcements and answers (fixed offsets, unknown != 0)
src/protocol/session.js           one TCP session: framing, bounded waits, abort
src/breeze/                       the infrared "off" codes of the Breeze remotes
src/devices.js                    known devices -> Gladys devices, identifier rule (pure)
src/lane.js                       one session at a time per device: stops, commands, reads
src/publisher.js                  states within 300/min
src/store.js                      /data/switcher-state.json: devices, stops, runs, attempt
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
scripts/mutants.mjs, .json        mutation check of the guards (not in the image, not in CI)
test/                             node --test, against the SDK's fake Gladys and fake devices
                                  on real loopback sockets (test/helpers/fakeSwitcher.js)
```

## Safety rules of this integration

- Stops (water heater, plug and Breeze off, shutter stop) are never behind an
  option, the identity, a read, the configuration, /data or a pause; they cut
  the session in progress and cancel the commands waiting. Never put them
  behind anything.
- A water heater is switched on only with the device timer (`heaterOn()`, 1 to
  150 minutes): never add a path that switches it on without one.
- Every other command is behind its option (off by default), checked on
  arrival and in `beforeSend`, and needs an identity confirmed by a recent
  scan and a writable /data.
- Never a `switch` for a water heater or an air conditioner.
- Models that need the account token are never driven (app imitation).

## Rules

- **External ids are forever** (`ext:<selector>:switcher:<mac>`): changing the
  rule orphans every device, its history and its scenes.
- **The container rootfs is read-only.** Write only under `/data`, never
  waiting on it without a bound.
- **Two clocks.** `now` (wall) only dates what `/data` keeps and the clock
  field of the requests; every pace, deadline and guard runs on `monotonic`.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  the four places agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs kept in sync
  with the code (the list of the refusals of a stop is exact).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network beyond 127.0.0.x, and every wait in
  them is bounded.
- **Encoding.** UTF-8 without BOM; `test/encoding.test.js` refuses mojibake.
