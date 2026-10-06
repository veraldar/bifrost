#!/usr/bin/env python3
"""Stage 2 (run with KiCad AppImage python3.11 - has pcbnew): build placed boards.
Placement: MCU center, sensors per function, connectors on edges, passives gridded.
Nets: pad->net from SKiDL via sch-net map embedded in <dev>.nets.json (stage 1b)."""
import json, os, sys
import pcbnew

OUTD = os.path.join(os.path.dirname(__file__), '..', 'build')
FPDIR = os.path.expanduser('~/Applications/kicad/squashfs-root/usr/share/kicad/footprints')

FP_SUBS = {
  'ADXL343': ['Package_LGA:LGA-14_3x5mm_P0.8mm_LayoutBorder1x6y'],
  'SCD41': ['Sensor_Humidity:Sensirion_DFN-4-1EP_2x2mm_P1mm_EP0.7x1.6mm'],
  'SGP41': ['Package_DFN_QFN:DFN-6-1EP_2x2mm_P0.5mm_EP0.6x1.4mm'],
  'TP4056': ['Package_SO:SOIC-8_3.9x4.9mm_P1.27mm'],
  'INA226': ['Package_SO:MSOP-10_3x3mm_P0.5mm'],
  'R_Shunt': ['Resistor_SMD:R_1206_3216Metric'],
}

def _exists(spec):
    if not spec or ':' not in spec: return False
    lib, fp = spec.split(':', 1)
    return os.path.exists(os.path.join(FPDIR, f'{lib}.pretty', f'{fp}.kicad_mod'))
GENERIC = {
  'R': 'Resistor_SMD:R_0603_1608Metric',
  'C': 'Capacitor_SMD:C_0603_1608Metric',
  'LED': 'LED_SMD:LED_0603_1608Metric',
  'Conn_01x02': 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical',
  'Conn_01x05': 'Connector_PinHeader_2.54mm:PinHeader_1x05_P2.54mm_Vertical',
  'GND': None, 'PWR_FLAG': None,
}

def resolve_fp(fpstr, partname):
    cands = [fpstr]
    for key, alts in FP_SUBS.items():
        if key in (fpstr or '') or key in partname:
            cands += alts
    if partname in GENERIC and GENERIC[partname]: cands.append(GENERIC[partname])
    for c in cands:
        if _exists(c):
            lib, fp = c.split(':', 1)
            return lib, fp
    return None, None

def load_fp(lib, fp):
    m = pcbnew.FootprintLoad(os.path.join(FPDIR, f'{lib}.pretty'), fp)
    return m

def build(name, netmap):
    board = pcbnew.CreateEmptyBoard()
    # board outline 80x60mm
    b = board
    edges = []
    w = pcbnew.FromMM(0.15)
    def seg(x1,y1,x2,y2):
        s = pcbnew.PCB_SHAPE(board)
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x1), pcbnew.FromMM(y1)))
        s.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x2), pcbnew.FromMM(y2)))
        s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(w)
        board.Add(s)
    seg(0,0,80,0); seg(80,0,80,60); seg(80,60,0,60); seg(0,60,0,0)

    nets = {}
    def getnet(nm):
        if nm not in nets:
            n = pcbnew.NETINFO_ITEM(board, nm)
            board.Add(n)
            nets[nm] = n
        return nets[nm]

    placed = []
    # placement anchor map: ref -> (x, y, rot_deg) in mm
    anchors = netmap['anchors']
    grid_used = []
    def grid_pos():
        cols = 8
        i = len(grid_used)
        x = 26 + (i % cols) * 6.5
        y = 44 + (i // cols) * 4.0
        grid_used.append(i)
        return (x, y, 0)

    count_ok, count_miss = 0, []
    for part in netmap['parts']:
        ref, pname, val, fpstr = part['ref'], part['name'], part['value'], part['footprint']
        lib, fp = resolve_fp(fpstr, pname)
        if fp is None:
            count_miss.append(f'{ref}/{pname}:{fpstr}')
            continue
        f = load_fp(lib, fp)
        f.SetReference(ref)
        try: f.SetValue(val)
        except Exception: pass
        a = anchors.get(ref) or grid_pos()
        f.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(a[0]), pcbnew.FromMM(a[1])))
        f.SetOrientationDegrees(a[2])
        # pad nets
        for pad in f.Pads():
            pn = pad.GetNumber()
            netname = netmap['pads'].get(f'{ref}.{pn}')
            if netname:
                pad.SetNet(getnet(netname))
        board.Add(f)
        placed.append(ref)
        count_ok += 1
    out = os.path.join(OUTD, f'{name}.kicad_pcb')
    pcbnew.SaveBoard(out, board)
    print(f'BUILT {name}: {count_ok} footprints placed, {len(count_miss)} missing: {count_miss[:4]}')
    return count_ok, count_miss

if __name__ == '__main__':
    for dev in ('beacon-A', 'airnode-B', 'current-C'):
        with open(os.path.join(OUTD, f'{dev}.nets.json')) as f:
            netmap = json.load(f)
        build(dev, netmap)
