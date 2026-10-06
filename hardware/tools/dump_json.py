#!/usr/bin/env python3
"""Stage 1: dump device connectivity from SKiDL circuits to JSON (for pcbnew builder)."""
import json, os, sys, builtins
sys.path.insert(0, os.path.dirname(__file__))
import skidl_devices as sd

OUTD = os.path.join(os.path.dirname(__file__), '..', 'build')
os.makedirs(OUTD, exist_ok=True)

ANCHORS = {
 'U1': (40, 26, 0), 'U2': (40, 8, 0), 'U3': (58, 26, 0), 'U4': (66, 26, 0),
 'J1': (8, 44, 0), 'J2': (20, 56, 0), 'J3': (40, 56, 0), 'J4': (60, 56, 0),
 'TH1': (24, 8, 0), 'D1': (12, 26, 0), 'D2': (30, 26, 0), 'FLG+3': (74, 8, 0), 'FLGGN': (74, 12, 0),
}

def dump(dev_key, name):
    {'A': sd.device_A, 'B': sd.device_B, 'C': sd.device_C}[dev_key]()
    c = builtins.default_circuit
    parts, pads = [], {}
    for p in c.parts:
        try: fp = p.footprint
        except Exception: fp = ''
        parts.append(dict(ref=p.ref, name=p.name, value=p.value, footprint=fp))
        for pin in p.pins:
            try:
                nets = list(pin.nets)
                num = pin.num
            except Exception:
                continue
            if nets and num:
                pads[f'{p.ref}.{num}'] = nets[0].name
    with open(os.path.join(OUTD, f'{name}.nets.json'), 'w') as f:
        json.dump(dict(device=name, parts=parts, pads=pads, anchors=ANCHORS), f, indent=1)
    print('DUMPED', name, len(parts), 'parts', len(pads), 'pad-nets')

if __name__ == '__main__':
    dump('A', 'beacon-A'); dump('B', 'airnode-B'); dump('C', 'current-C')
