// -----------------------------------------------------------------------------
// The infrared "off" code of the air conditioner remotes a Breeze can play,
// taken from the remote database of aioswitcher 6.4.0 (Apache-2.0,
// `resources/irset_db.json`): only the remotes with a plain off key
// (`OnOffType` 0, key "off"), as "<Para>|<HexCode>". The other remotes
// (toggle remotes, where the same code switches on and off, or without an off
// key) cannot be stopped safely: their Breeze is shown read only.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const CODES = Object.freeze(
  Object.assign(
    Object.create(null),
    JSON.parse(readFileSync(new URL('./off-codes.json', import.meta.url), 'utf8')),
  ),
);

/** The off code of a remote id (as the Breeze announces it), else undefined. */
export function breezeOffCode(remote) {
  if (typeof remote !== 'string' || !/^[A-Za-z0-9_]{1,8}$/.test(remote)) return undefined;
  return Object.hasOwn(CODES, remote) ? CODES[remote] : undefined;
}
