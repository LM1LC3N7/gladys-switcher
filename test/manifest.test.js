// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned: only its form and its agreement everywhere.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, HEATER_MINUTES, READ_INTERVAL, UDP_PORTS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; the same semver version in the four places', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-switcher:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-switcher');
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-switcher/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['climate', 'lighting', 'energy']);
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.countries, undefined);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  // The SDK as a range, never pinned.
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^\d+\.\d+\.\d+$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Switcher|sans\s+lien\s+avec\s+Switcher/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+testé\s+avec\s+un\s+vrai\s+appareil/i,
    );
    assert.match(docs, /trusted\s+network|réseau\s+de\s+confiance/i);
  }
  assert.match(manifest.config_schema[0].description.fr, /jamais testé avec un vrai appareil/i);
  assert.match(manifest.config_schema[0].description.en, /never tested with a real device/i);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: placeholder`);
  }
});

test('the UDP capture of the four Switcher ports only; no sub-container, no secret field, no key prefixed gladys_', () => {
  assert.deepEqual(manifest.network_discovery, [{ type: 'udp-broadcast', ports: [...UDP_PORTS] }]);
  assert.equal(manifest.containers, undefined);
  for (const field of manifest.config_schema) {
    assert.ok(!field.key.startsWith('gladys_'), field.key);
    assert.notEqual(field.type, 'password', field.key);
  }
});

test('the configuration matches the code; the commands are off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const key of ['allow_heater_on', 'allow_plug_on', 'allow_shutter_moves']) {
    assert.equal(fields[key].type, 'boolean', key);
    assert.equal(fields[key].default, false, key);
  }
  assert.deepEqual(
    [fields.read_interval.min, fields.read_interval.max, fields.read_interval.default],
    [READ_INTERVAL.min, READ_INTERVAL.max, READ_INTERVAL.default],
  );
  assert.deepEqual(
    [fields.heater_minutes.min, fields.heater_minutes.max, fields.heater_minutes.default],
    [HEATER_MINUTES.min, HEATER_MINUTES.max, HEATER_MINUTES.default],
  );
  assert.ok(HEATER_MINUTES.max <= 150);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 30 && action.timeout_seconds <= 120, action.key);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});
