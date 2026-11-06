# TODO — Switcher v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — local protocol** (2026-11-06): devices found by the
      network scan of Gladys (UDP announcements on 20002, 10002, 20003,
      10003), read and driven over TCP (9957, 10000), one session at a time
      per device; water heaters, Power Plug, Runner / Runner Mini, Breeze
      (off only); stops never blocked and kept in /data; other commands behind
      options; the water heater runs bounded by the device timer and by the
      integration; docs en/fr; tests against fake devices built from the
      reference and its captures; mutation list of the guards.
- [ ] **Milestone 2 — real hardware** (testers): see "Not verified".
- [ ] **Milestone 3 — more**: switching a Breeze on, its mode, setpoint and
      fan (infrared codes of the remote, behind an option, setpoint bounds of
      the remote); toggle remotes (decided on a state read in the same
      session); the child lock of the Runner; the auto-off setting of the
      water heaters (read today only by the reference).
- [ ] **Milestone 4 — first release**: Release workflow, topic, store
      validator once the image is published.

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-switcher:0.1.0`): the first patch release gives
  0.1.1. The manifest test checks the form and the agreement, never a value.
- Reference: aioswitcher 6.4.0 of 2026-11-01 (Apache-2.0, Tomer Figenblat;
  LICENSE read in the repository, no NOTICE), the library of the Home
  Assistant `switcher_kis` integration. Logic ported to JavaScript, no Python;
  the "off" codes of the remotes with a plain off key taken from its remote
  database (211 remotes, 20 KB instead of 13 MB). Notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image.
- Neighbour modules followed: LM1LC3N7/gladys-slide (shutter: stop only
  protective, moves behind an option, no state published), gladys-airtouch5
  (lane, publisher, /data store, stops), gladys-mystrom (UDP announcements
  through `scanNetwork`).
- No `keywords` nor `countries` in the manifest (IL in practice): the store
  does not take them yet. Categories `climate`, `lighting`, `energy`.
- **Token models out of v1** (Runner S11/S12, Lights, Heater 031f): the token
  is asked by e-mail on the vendor site (not an app imitation by itself), but
  aioswitcher turns it into the login packet by decoding it with an AES key
  taken from the Switcher app (`convert_token_to_packet`): using it is
  imitating the app, refused by the rules without Louis's agreement. They are
  named in the status and by the Test button, never published.
- **Discovery**: only the core hears the broadcasts (bridge network):
  `scanNetwork('udp-broadcast')` 6 s, from the Discovery tab, the Test button,
  at each connection and every 5 minutes. An announcement counts only when
  its frame is sound (start, length, CRC), its model known, its MAC usable and
  the address inside equal to its source; two MACs on one address in a scan:
  neither is trusted there; a device that moved frees the address of the
  other one.
- **Identifier rule** (frozen): `ext:<selector>:switcher:<mac>` (the MAC of
  the announcement, 12 lower-case hex digits), features `:<key>`. No fallback:
  a device without a usable MAC is not published. The params keep the
  protocol id, login key, model, address and Breeze remote, so a device
  created in Gladys can be stopped when /data is lost.
- **Identity**: the protocol answers carry no device id; a device is driven
  (commands other than stops) only while a scan saw it at its address within
  15 minutes; it is read while that holds or while no scan worked since it was
  seen (a failing scan is unknown, never "gone"). Only the devices created in
  Gladys are read. Stops go to the last address known, trusted or not (stopping
  another Switcher after a DHCP swap is harmless, and its login needs our
  device id or key).
- **Frames**: the CRC of every frame read is checked (first 2 bytes: CRC-CCITT
  seeded with 0x1021, as the reference signs; the unedited captures of its
  tests match; the last 2 bytes use a key not known here and are not
  checked). Answers framed by their announced length (1 KB at most), one
  answer per request, nothing kept that was not asked.
- **Features**: water heater as `water-heater/binary` (a dedicated type,
  never `switch`), `energy-sensor/power` (W) and `duration/integer` (time
  left, s); plug as `switch/binary` + power; Runner as `shutter/state`
  (commands only, not published, as gladys-slide) and `shutter/position`
  (100 open, as the reference and Home Assistant); Breeze as
  `air-conditioning/binary` (writable for off only, read only without a plain
  off code), room temperature, setpoint and mode read only. No energy index:
  the devices give power only (the reference computes the current from it at
  220 V: not published).
- **Stops**: see the header of `src/app.js` and the docs (exact list of
  refusals). Only an answered write counts among the 3 sends (review r1 B1):
  a stop the device never answers is sent again at each read started after
  it that shows the device on, without end, and the status says "sent, no
  answer". Only a write counts as a try; never given up (shutter
  excepted: momentary, RAM only, 3 minutes, never replayed after a restart);
  confirmed by a read started after the write; one resend per such read, 3
  writes at most; lifted by a read showing off or a switch-on that left; a new
  click counts its 3 writes again. Never waits for /data (the save runs
  beside); a stop written does not wait for its socket to close (the lane
  does).
- **Water heater runs**: every switch-on carries the device timer (1 to 150
  minutes, `heaterOn()` refuses anything else); the run is written to /data
  before the request (refused if it cannot be); a read started after the
  switch-on showing it on 2 minutes past its end, with a time on at least the
  run's (else switched on again elsewhere), makes the integration send a stop.
  Elapsed time on the session clock (wall clock at the start, monotonic
  since; wall clock only after a restart).
- **Reads**: every interval per device (30 s, 10 to 600), never sooner (the
  attempt time in /data before each read, bounded wait); failed reads
  back off 30 s, 1, 2, 5 min, never under the interval; a read cut by a stop
  is not a failure; follow-up reads 5 s and 20 s after a write. A state is
  applied only when its read started after the one shown.
- **/data**: read bounded (2 s), again every 10 s while unreadable or slow,
  one read at a time, a late answer merged under what RAM holds (clicks,
  scans); never written while unread; non-protective commands refused while
  it cannot be written.
- **No temperature is ever written**: the Switcher water heaters are relays
  (on/off with a timer, no setpoint in the protocol), so the 65 °C ceiling has
  nothing to bound; the bound of a run is its length. The Breeze setpoint is
  read only in v1.
- Breeze modes mapped to `AC_MODE` (auto 0, cool 1, heat 2, dry 3, fan 4); a
  mode byte outside 1..5 is unknown (the reference shows it as cool).

## Not verified

- Never tested with a real device: everything runs against fake devices built
  from aioswitcher 6.4.0 and the captures of its tests.
- The CRC of the family 1 devices (water heaters, plug), announcements and
  answers: every capture of the reference for them is edited (owner hidden),
  so only the family 2 captures prove the signing. Review r1: family 1 frames
  whose only defect is the CRC are read and flagged ("CRC non vérifié, à
  signaler" on the device and in the status); family 2 stays strict, and its
  announcements refused for the CRC alone are named in the status and by the
  Test button; a stop takes the session id of its login whatever the CRC.
- The "time on" field of the water heaters (bytes 93..96, no capture of a
  heater on): trusted for a device only once a read during a run matched the
  time elapsed; until then, a run still on after its end is always stopped.
- DHCP swap of two Switcher (review r1 M5): until the next scan (5 min at
  most), a switch-on could reach the other device if its 1-byte login key is
  the same; the device timer bounds the run. Nothing more in v1.
- The broadcast period of the devices (a 6 s capture assumed enough) and that
  the core relays them on the four ports.
- A login answer of a real device (the reference fixture is synthetic): the
  session id read at bytes 8..11 as the reference does.
- The Breeze mode byte values beyond the reference enum.
- In the sandbox Gladys: the container starts and connects (no device there).
- Mutation (`node scripts/mutants.mjs`, `scripts/mutants.json`): every guard
  listed has a test that fails when it is broken. Known equivalent mutant,
  left out of the list: the cancellation check in `beforeSend` (a stop cancels
  the commands and destroys the session of the holder in the same tick, so a
  cancelled command never reaches a live `beforeSend`).
- The suite runs 20 times in a row on `node:22-alpine` (3 GB) without a
  failure; the virtual clock of the tests waits for the real I/O in progress
  (`clock.busy`), so no count depends on a race between them.
