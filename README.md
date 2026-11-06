# gladys-switcher

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for **Switcher** devices: water heaters (V2, V4, Mini, Touch),
Power Plug, Runner and Runner Mini shutters and Breeze air conditioners,
over their local protocol (UDP announcements captured by Gladys, TCP 9957 and
10000). No cloud. Stops need no option; switching on and moving are off by
default; every switch-on of a water heater carries a device timer.

Never tested with a real device. Not affiliated with Switcher.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Protocol logic ported from [aioswitcher](https://github.com/TomerFi/aioswitcher)
  (Apache-2.0): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Changes: [CHANGELOG.md](CHANGELOG.md); decisions and next steps:
  [TODO.md](TODO.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .
node scripts/mutants.mjs        # mutation check of the guards (one at a time)
```

`src/app.js` holds the integration (scans, reads, stops, commands),
`src/protocol/` the frames, requests, answers and the TCP session,
`src/breeze/` the infrared off codes of the Breeze remotes,
`src/handlers.js` the SDK wiring shared with the tests (against the SDK's fake
Gladys and fake devices on real loopback sockets, `test/helpers/`). See
[CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache License 2.0, see [LICENSE](LICENSE).
