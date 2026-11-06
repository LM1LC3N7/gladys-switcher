// -----------------------------------------------------------------------------
// Frozen keys, limits and timings. External ids, feature keys, config keys and
// action keys are stored by Gladys and users: never rename them.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Feature keys (the suffix of the feature external ids). */
export const FEATURES = Object.freeze({
  POWER: 'power', // water-heater/binary, switch/binary, air-conditioning/binary
  CONSUMPTION: 'consumption', // energy-sensor/power (W)
  REMAINING: 'remaining', // duration/integer (s) of a water heater run
  STATE: 'state', // shutter/state (commands only)
  POSITION: 'position', // shutter/position
  TEMPERATURE: 'temperature', // temperature-sensor/decimal of a Breeze
  TARGET: 'target', // air-conditioning/target-temperature (read only)
  MODE: 'mode', // air-conditioning/mode (read only)
});

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/** Read interval (seconds), as in the manifest. */
export const READ_INTERVAL = Object.freeze({ min: 10, max: 600, default: 30 });
/** Water heater run (minutes): the timer every "switch on" carries, as in the manifest. */
export const HEATER_MINUTES = Object.freeze({ min: 1, max: 150, default: 60 });

/** The four ports the devices announce themselves on (UDP broadcast). */
export const UDP_PORTS = Object.freeze([20002, 10002, 20003, 10003]);
/** TCP ports of the two protocol families. */
export const TCP_PORTS = Object.freeze({ 1: 9957, 2: 10000 });

export const LIMITS = Object.freeze({
  devices: 64, // known devices kept (in /data and in RAM)
  datagrams: 2000, // datagrams handled per scan
  frame: 1024, // largest TCP answer accepted (the reference reads 1024 bytes)
  statesPerMinute: 300,
  statesPerRequest: 100,
  statusLength: 900, // characters of a status message
  stopSends: 3, // effective writes of one stop, at most, while contradicted
  storeBytes: 64 * 1024,
});

export const TIMINGS = Object.freeze({
  connect: 1500, // TCP connection
  answer: 1500, // one answer
  readBudget: 4 * SECOND, // a whole read session
  commandBy: 3000, // a command is written by then, or refused "nothing sent"
  ackBy: 3500, // the ack of a command never waits longer
  stopRetry: 250, // a stop that could not leave is tried again after
  stopFirstBudget: 3000, // tries of a stop at the click
  stopRetries: [10 * SECOND, 30 * SECOND, MINUTE], // then kept, tried again (last one repeats)
  shutterStopFor: 3 * MINUTE, // a shutter stop is momentary: kept in RAM this long
  followUps: [5 * SECOND, 20 * SECOND], // reads after a command not confirmed yet
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE], // after failed reads
  scanEvery: 5 * MINUTE, // background scan (addresses, identities)
  scanSeconds: 6, // capture length of a scan
  identityFor: 15 * MINUTE, // a device seen by a scan is trusted this long
  attemptSaveEvery: MINUTE, // the read attempt time written to /data at most this often
  heaterGrace: 2 * MINUTE, // a run still on this long after its end is stopped by the module
  storeLoad: 2 * SECOND, // a load of /data waits at most this
  storeSave: 2 * SECOND,
  storeQueue: 2 * SECOND,
  storeRetry: 10 * SECOND, // /data unreadable at start: read again
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE], // getConfig() failed: tried again (last repeats)
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  closeWait: 500, // a socket destroyed is closed within this (never waited longer)
});
