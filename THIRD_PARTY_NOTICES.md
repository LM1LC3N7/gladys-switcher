# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript and data taken from the project below. The
ported parts were rewritten, not copied; the changes are described below.

## aioswitcher

<https://github.com/TomerFi/aioswitcher> (package `aioswitcher`, version 6.4.0
of 2026-11-01), by Tomer Figenblat and contributors, the library of the Home
Assistant `switcher_kis` integration. Apache License 2.0 (`LICENSE` of the
repository; no `NOTICE` file), the license of this integration too.

Ported: the frame of the local protocol (length, CRC-CCITT seeded with 0x1021
and its key), the model codes, the login, state, on/off (with timer), Runner
stop and position, and Breeze infrared command requests, and the offsets of the
UDP announcements and of the state answers.

Data: `src/breeze/off-codes.json` holds the "off" infrared code of the remotes
of `resources/irset_db.json` that have a plain off key (`OnOffType` 0), as
`<Para>|<HexCode>`. Test fixtures: frames of `tests/testresources` and request
vectors computed with `api/packets.py` (`test/fixtures/`).

Changed: the CRC of every frame read is checked (a frame that fails it is
dropped), the length it announces must be its size, and every field is read
at a fixed offset and bounded (a value outside what the protocol defines is
unknown, never 0); the address inside an announcement must be its source; a
water heater is switched on only with a timer of 1 to 150 minutes; the models
that need the token of the Switcher account are not driven (the token is turned
into a login with a key taken from the vendor app); toggle remotes of the
Breeze are never played.

Switcher is a trademark of its owner; this integration is not affiliated with
Switcher.
