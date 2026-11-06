# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: Switcher water heaters (V2, V4, Mini, Touch), Power Plug,
  Runner and Runner Mini shutters and Breeze air conditioners, found by the
  network scan of Gladys (UDP announcements) and read and driven over their
  local TCP protocol, one connection at a time per device: on/off, power and
  time left of the water heaters, on/off and power of the plug, position and
  stop of the shutters, state, room temperature, setpoint and mode of the
  Breeze (switching off only).
- Stops (water heater, plug and Breeze off, shutter stop) need no option, kept
  in /data until a read shows them applied, sent again 3 times at most.
- Switching on (water heaters, plugs) and moving the shutters behind options,
  off by default; every switch-on of a water heater carries the device timer
  of the configured run (1 to 150 minutes), and a run still on 2 minutes after
  its end is switched off by the integration.
