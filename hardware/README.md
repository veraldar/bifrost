# Veraldar-HW — three predictive-prevention devices (AI-built)

Mission: measure how far AI can self-implement hardware. Circuit definitions in
SKiDL Python (`tools/skidl_devices.py`), rendered to KiCad schematics
(`tools/render_sch.py`), verified by kicad-cli 10.0.5 (`sch erc` — loads all
three, reports design violations, zero load errors).

## Devices
| Dir | Device | Predicts | Prevents |
|---|---|---|---|
| `beacon-A/` | Machine Health Beacon (ESP32-C3 + ADXL343 + NTC, 18650, WiFi/MQTT) | bearing wear, imbalance, misalignment, lube failure (RMS velocity/crest/kurtosis/FFT + temp trend) | unplanned stoppage — MQTT alarm + relay output |
| `airnode-B/` | Air Quality Prevention Node (ESP32-C3 + SCD41 + SGP41 + PIR) | CO2 buildup, VOC spike trajectories | exposure — closes the loop by driving a ventilation relay |
| `current-C/` | Motor Current Watchdog (ESP32-C3 + INA226 + 0.1Ω shunt) | overcurrent, stall, jam via load-signature trend | motor burnout — cutoff relay |

## Per-device files
- `<dev>.kicad_sch` — schematic (kicad-cli 10.0.5 `sch erc` verified, reports in `docs/`)
- `bom.csv` — JLCPCB/LCSC part candidates (verify stock at order time)
- `main.c` — firmware skeleton (Arduino/ESP-IDF hybrid, pipeline + nets documented)
- `<dev>.kicad_pcb` — outline-only M4 placeholder (layout after schematic review)

## ERC status (v0)
Files load and ERC executes; hundreds of design violations remain (unconnected
power pins, missing PWR_FLAGs on some rails, stub-label connectivity) — these
are the M2.5 cleanup list, tracked per device in `docs/<dev>-erc.rpt`.

## JLCPCB order notes
1. All passives 0603/0805 basic parts (cheap assembly).
2. ESP32-C3-WROOM-02-N4, SCD41, TP4056, ME6211C33, INA226, ADXL343: extended
   parts — confirm in-stock + economic assembly at order time.
3. Custom SKiDL symbols (SGP41, INA226) need footprint assignment before layout.
4. M4 (layout+DRC+gerbers) pending — schematics first.

## Honest method note
SKiDL 2.3.0's `generate_schematic` placement engine crashed on mixed
lib/custom circuits (internal bugs: missing net/pin attrs); we render through
`tools/render_sch.py` instead: SKiDL defines circuits and connectivity, the
renderer embeds verbatim KiCad lib symbols and emits label-stub netting that
kicad-cli 10.0.5 provably loads. Bare symbol names in `lib_symbols` are
mandatory — prefixed names fail to load (root-caused empirically).
