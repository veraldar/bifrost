#!/usr/bin/env python3
"""Render SKiDL circuits -> valid .kicad_sch (kicad-cli 10.0.5 loads them).
Hybrid: circuit/connectivity from SKiDL objects; symbols embedded verbatim from
real KiCad lib files (valid by construction); writer structure proven loadable."""
import os, re, sys, uuid as _uuid

sys.path.insert(0, os.path.dirname(__file__))
import skidl_devices as SD

LIBS = os.path.join(os.path.dirname(__file__), '..', 'libs')
OUTD = os.path.join(os.path.dirname(__file__), '..')

def esc(s): return s.replace('\\', '\\\\').replace('"', '\\"')

def extract_lib_symbol(libfile, symname):
    """Extract balanced (symbol "NAME" ...) block from a .kicad_sym file."""
    txt = open(libfile, encoding='utf-8', errors='ignore').read()
    start = txt.find(f'(symbol "{symname}"')
    if start < 0: return None
    depth, i = 0, start
    while i < len(txt):
        if txt[i] == '(': depth += 1
        elif txt[i] == ')':
            depth -= 1
            if depth == 0: return txt[start:i+1]
        i += 1
    return None

def pin_geo_from_libsym(libsym):
    """Map pin number -> (x, y, rot) from a lib symbol s-expr (root + child units)."""
    geo = {}
    for m in re.finditer(r'\(pin \w+ \w+\s*\(at ([-\d.]+) ([-\d.]+) (\d+)\)(.*?)\(number "([^"]+)"', libsym, re.S):
        x, y, rot, mid, num = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        length = 2.54
        lm = re.search(r'\(length ([-\d.]+)\)', mid)
        if lm: length = float(lm.group(1))
        x, y, rot = float(x), float(y), int(rot)
        import math
        dx = length * (1 if rot == 0 else -1 if rot == 180 else 0)
        dy = length * (0 if rot in (0, 180) else (1 if rot == 90 else -1))
        geo[num] = (x + dx, y + dy, rot)  # pin END (wire attach point), lib coords y-up
    return geo

def render(dev_name, title):
    import builtins
    # rebuild circuit for this device in-process
    getattr(SD, {'beacon-A':'device_A','airnode-B':'device_B','current-C':'device_C'}[dev_name])()
    c = builtins.default_circuit
    c.merge_net_names(); c.merge_nets()

    lib_syms, parts_ss, wires_ss, labels_ss = [], [], [], []
    root_uuid = str(_uuid.uuid4())
    x_cursor = 60.0
    inst_line = 0
    used_libs = {}

    PART_LIB = {
      'ESP32-C3-WROOM-02':'RF_Module', 'ADXL343':'Sensor_Motion', 'SCD41-D-R2':'Sensor_Gas',
      'TP4056-42-ESOP8':'Battery_Management', 'ME6211C33M5':'Regulator_Linear',
      'R':'Device', 'C':'Device', 'LED':'Device', 'Thermistor_NTC':'Device', 'R_Shunt':'Device',
      'Conn_01x02':'Connector_Generic', 'Conn_01x05':'Connector_Generic',
      'PWR_FLAG':'power', 'GND':'power', '+3V3':'power',
    }
    for p in c.parts:
        libname = PART_LIB.get(p.name)
        symname = p.name
        if libname is None and os.environ.get('SKIP_CUSTOM'):
            print(f'  SKIP_CUSTOM: {p.name} {p.ref} omitted'); inst_line += 1; continue
        if libname is None:
            # custom SKIDL part (SGP41/INA226): synthesize minimal valid lib symbol
            from schgen import lib_symbol
            etypes = {'PWRIN':'power_in','PWROUT':'power_out','INPUT':'input','BIDIR':'bidirectional','PASSIVE':'passive','OPENCOLL':'open_collector'}
            pins = [(pin.num, pin.name, etypes.get(str(pin.func), 'passive'), 'L' if i%2==0 else 'R', 0) for i, pin in enumerate(p.pins)]
            ref = 'U'
            libname = 'vl_custom'
            block = '  ' + lib_symbol(f'vl_custom:{symname}', ref, pins).strip().replace('  (lib_symbol', '(lib_symbol', 1)
            block = block.replace(f'(lib_symbol "vl_custom:{symname}"', f'(symbol "{symname}"', 1)
            if f'vl_custom:{symname}' not in used_libs:
                used_libs[f'vl_custom:{symname}'] = pin_geo_from_libsym(block)
                lib_syms.append(block.replace('\n', '\n  '))
            geo = used_libs[f'vl_custom:{symname}']
            libkey = f'vl_custom:{symname}'
        else:
            libfile = os.path.join(LIBS, f'{libname}.kicad_sym')
            libkey = f'{libname}:{symname}'
            if libkey not in used_libs:
                block = extract_lib_symbol(libfile, symname)
                if block is None:
                    print(f'  WARN no lib symbol {libkey}, skipping part {p.ref}')
                    continue
                used_libs[libkey] = pin_geo_from_libsym(block)
                lib_syms.append('  ' + block.replace('\n', '\n  '))
            geo = used_libs.get(libkey, {})
        libkey = f'{libname}:{symname}'
        px, py = x_cursor, 70 + (inst_line % 6) * 45
        x_cursor += 45
        if x_cursor > 260: x_cursor = 60; inst_line += 6
        try:
            fp = p.footprint
        except Exception:
            fp = ''
        u = str(_uuid.uuid4())
        part_ss = f'''  (symbol (lib_id "{libkey}") (at {px} {py} 0) (unit 1)
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid {u})
    (property "Reference" "{p.ref}" (at {px} {py-15} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "{esc(p.value)}" (at {px} {py+15} 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "{esc(fp)}" (at {px} {py} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at {px} {py} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Description" "" (at {px} {py} 0) (effects (font (size 1.27 1.27)) hide))
    (instances
      (project "{dev_name}"
        (path "/{root_uuid}" (reference "{p.ref}") (unit 1))
      )
    )
  )'''
        parts_ss.append(part_ss)
        # stub + label every connected pin
        for pin in p.pins:
            try:
                nets = list(pin.nets) if hasattr(pin, 'nets') else []
                if not nets: continue
                net = nets[0]
                try: pnum = pin.num
                except Exception: pnum = getattr(pin, 'name', '')
                g = geo.get(pnum, geo.get(getattr(pin,'name',''), (0, 0, 0)))
                # lib y-up -> sheet y-down; stub outward by rot
                ex, ey, erot = px + g[0], py - g[1], g[2]
                dx = 2.54 if erot in (0, 90) else -2.54
                wires_ss.append(f'  (wire (pts (xy {ex} {ey}) (xy {ex+dx} {ey})) (stroke (width 0) (type default)) (uuid {str(_uuid.uuid4())}))')
                just = 'right' if dx < 0 else 'left'
                labels_ss.append(f'  (label "{esc(net.name)}" (at {ex+dx} {ey} {0 if dx>0 else 180}) (effects (font (size 1.016 1.016)) (justify {just} bottom)) (uuid {str(_uuid.uuid4())}))')
            except Exception as e:
                print(f'  pin skip {p.ref}.{getattr(pin,"name","?")}: {type(e).__name__}')
        inst_line += 1

    sch = f'''(kicad_sch
  (version 20230121)
  (generator veraldar_hw_skidl_render)
  (uuid {root_uuid})
  (paper "A3")
  (title_block (title "{esc(title)}") (company "Veraldar") (rev "A"))
  (lib_symbols
{chr(10).join(lib_syms)}
  )
{chr(10).join(parts_ss)}
{chr(10).join(wires_ss)}
{chr(10).join(labels_ss)}
  (sheet_instances
    (path "/" (page "1"))
  )
)
'''
    outdir = os.path.join(OUTD, dev_name)
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, f'{dev_name}.kicad_sch')
    open(out, 'w').write(sch)
    print(f'RENDERED {out} ({len(parts_ss)} parts, {len(labels_ss)} net stubs)')
    return out

if __name__ == '__main__':
    for dev in ('beacon-A', 'airnode-B', 'current-C'):
        try:
            render(dev, dict(beaconA=0).get(dev.replace('-',''), 0) or dev)
        except Exception as e:
            import traceback; traceback.print_exc()
            print(f'FAIL {dev}: {e}')
