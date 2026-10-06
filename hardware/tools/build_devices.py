#!/usr/bin/env python3
"""Device A/B/C schematic builder. Connectivity via per-pin net labels + 2.54 stubs.
Run: .venv/bin/python tools/build_devices.py  -> hardware/<dev>/<dev>.kicad_sch"""
import os, sys, uuid as _uuid
sys.path.insert(0, os.path.dirname(__file__))
from schgen import u, esc, pin, wire, label, sym_inst, build_schematic, ROOT_UUID

HW = os.path.join(os.path.dirname(__file__), '..', 'hardware')

# --- part catalog: name -> (pins[(num,name,etype,side)], value, body_w, body_h)
def P(pins): return pins

PARTS = {
 'ESP32C3': P([('1','GND','power_in','L',0),('2','3V3','power_in','L',1),
   ('3','EN','input','L',2),('4','IO2_SDA','bidirectional','R',0),
   ('5','IO3_SCL','bidirectional','R',1),('6','IO4_ADC','input','R',2),
   ('7','IO5_INT','input','R',3),('8','IO6_TRIG','output','R',4),
   ('9','TX','output','R',5),('10','RX','input','R',6),('11','IO9_BOOT','input','R',7)]),
 'ADXL345': P([('1','VDD','power_in','L',0),('2','GND','power_in','L',1),
   ('3','SDA','bidirectional','R',0),('4','SCL','input','R',1),
   ('5','CS','input','L',2),('6','SDO','output','L',3),('7','INT1','output','R',2)]),
 'SCD41': P([('1','VDD','power_in','L',0),('2','GND','power_in','L',1),
   ('3','SDA','bidirectional','R',0),('4','SCL','input','R',1)]),
 'SGP41': P([('1','VDD','power_in','L',0),('2','GND','power_in','L',1),
   ('3','SDA','bidirectional','R',0),('4','SCL','input','R',1)]),
 'INA226': P([('1','VBS','power_in','L',0),('2','GND','power_in','L',1),
   ('3','INP','input','L',2),('4','INN','input','L',3),
   ('5','SDA','bidirectional','R',0),('6','SCL','input','R',1),
   ('7','ALERT','output','R',2)]),
 'TP4056': P([('1','VCC','power_in','L',0),('2','BAT','power_out','R',0),
   ('3','CHRG','open_collector','R',1),('4','STDBY','open_collector','R',2),('5','PROG','passive','L',1)]),
 'LDO33': P([('1','VIN','power_in','L',0),('2','VOUT','power_out','R',0),('3','GND','power_in','L',1)]),
 'R':    P([('1','A','passive','L',0),('2','B','passive','R',0)]),
 'C':    P([('1','A','passive','L',0),('2','B','passive','R',0)]),
 'LED':  P([('1','K','passive','L',0),('2','A','passive','R',0)]),
 'CONN2':P([('1','P1','passive','L',0),('2','P2','passive','L',1)]),
 'CONN4':P([('1','P1','passive','L',0),('2','P2','passive','L',1),('3','P3','passive','L',2),('4','P4','passive','L',3)]),
 'SWD':  P([('1','P1','passive','L',0),('2','P2','passive','L',1),('3','P3','passive','L',2),('4','P4','passive','L',3),('5','P5','passive','L',4)]),
 'NTC':  P([('1','NTC_A','passive','L',0),('2','NTC_B','passive','L',1)]),
 'PWRFLAG': P([('1','PWR_FLAG','power_out','R',0)]),
}

ETYPES = set()
def lib_sym_for(name):
    pins, = PARTS[name],
    ref = {'ESP32C3':'U','ADXL345':'U','SCD41':'U','SGP41':'U','INA226':'U','TP4056':'U','LDO33':'U',
           'R':'R','C':'C','LED':'D','CONN2':'J','CONN4':'J','SWD':'J','NTC':'TH','PWRFLAG':'FLG'}[name]
    val = {'ESP32C3':'ESP32-C3-WROOM-02','ADXL345':'ADXL345','SCD41':'SCD41','SGP41':'SGP41',
           'INA226':'INA226','TP4056':'TP4056','LDO33':'ME6211C33','PWRFLAG':'PWR_FLAG'}.get(name, name)
    from schgen import lib_symbol
    return lib_symbol(f'vl:{name}', ref, [(n, nm if name not in ('R','C','LED') else '~', et, s, 0) for n,nm,et,s,_ in pins])

def abs_pins(x, y, name):
    """sheet coords of pin ENDS for symbol at (x,y): sheet = (x+px, y-py)."""
    from schgen import lib_symbol  # noqa
    pins = PARTS[name]
    body_h = 17.78 if name not in ('R','C','LED','PWRFLAG') else 12.7
    n_l = sum(1 for p in pins if p[3]=='L'); n_r = sum(1 for p in pins if p[3]=='R')
    out = {}
    def positions(side):
        n = n_l if side=='L' else n_r
        return {i: (2.54*(n-1)/2 - 2.54*i) if n>1 else 0.0 for i in range(n)}
    pl, pr = positions('L'), positions('R')
    li = ri = 0
    for num, nm, et, side, off in pins:
        if side=='L': py = pl[li]; li+=1; px = -6.35-2.54
        else: py = pr[ri]; ri+=1; px = 6.35+2.54
        out[num] = (x+px, y-py, side)
    return out

def stub_net(x, y, side, net):
    dx = 1.27 if side=='L' else -1.27
    lx = x + (0.0 if side=='L' else 0.635)
    w = wire(((x,y),(x+dx,y)))
    lb = f'  (label "{esc(net)}" (at {x+dx} {y} {180 if side=="L" else 0}) (effects (font (size 1.016 1.016)) (justify right bottom)) (uuid {u()}))'
    return w, lb

def build(name, dev_title, netmap, bom):
    """netmap: ref.pinnum -> net name ; bom: list of (ref, part, value, mpn, lcsc)"""
    used = sorted({p.split('.')[0] for p in netmap})
    libs, insts, wires, labels = [], [], [], []
    placed = {}
    y0 = 70.0
    for i, ref in enumerate(used):
        part = bom_map[ref]
        x = 60 + (i%4)*70; y = y0 + (i//4)*45
        if part not in [l.split('"')[1] for l in libs]:
            libs.append(lib_sym_for(part))
        insts.append(sym_inst(f'vl:{part}', ref, part_value[ref], x, y))
        placed[ref] = (x, y, part)
    for key, net in netmap.items():
        ref, pinnum = key.split('.')
        x, y, side = abs_pins(*placed[ref][:2], placed[ref][2])[pinnum]
        w, lb = stub_net(x, y, side, net)
        wires.append(w); labels.append(lb)
    # PWR flags on supplies
    for net, (fx, fy) in POWER_FLAGS:
        if 'vl:PWRFLAG' not in [l.split('"')[1] for l in libs]:
            libs.append(lib_sym_for('PWRFLAG'))
        insts.append(sym_inst('vl:PWRFLAG', f'FLG{net[:2]}', 'PWR_FLAG', fx, fy))
        px, py, side = abs_pins(fx, fy, 'PWRFLAG')['1']
        w, lb = stub_net(px, py, side, net)
        wires.append(w); labels.append(lb)
    sch = build_schematic(dev_title, libs, insts, wires, labels)
    d = os.path.join(HW, name); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f'{name}.kicad_sch'),'w') as f: f.write(sch)
    with open(os.path.join(d, f'{name}.kicad_pro'),'w') as f:
        f.write('{"meta":{"filename":"%s.kicad_pro","version":1},"boards":[],"libraries":{"pinned_footprint_libs":[],"pinned_symbol_libs":[]},"schematic":{"legacy_lib_dir":"","legacy_lib_list":[]},"sheets":[["%s","Root"]],"text_variables":{}}' % (name, ROOT_UUID))
    return d

bom_map, part_value, POWER_FLAGS = {}, {}, []

# ================= DEVICE A — Machine Health Beacon =================
A_BOM = [
 ('U1','ESP32C3','ESP32-C3-WROOM-02','ESP32-C3-WROOM-02-N4','C2934538'),
 ('U2','ADXL345','ADXL345','ADXL345BCCZ','C13581'),
 ('U3','LDO33','ME6211C33M5G','ME6211C33M5G','C82942'),
 ('U4','TP4056','TP4056','TP4056','C382139'),
 ('R1','R','10k','0603WAF1002T5E','C25804'),
 ('R2','R','10k NTC div','0603WAF1002T5E','C25804'),
 ('R3','R','1k LED','0603WAF1001T5E','C21190'),
 ('R4','R','1k CHRG','0603WAF1001T5E','C21190'),
 ('R5','R','1k STDBY','0603WAF1001T5E','C21190'),
 ('C1','C','10uF','0603B104K500NT','C19702'),
 ('C2','C','10uF','0603B104K500NT','C19702'),
 ('C3','C','100nF','0603B104K500NT','C14663'),
 ('D1','LED','PWR','0603','C2286'),
 ('J1','SWD','PROG 5p','PINHEADER-5','C2337'),
 ('J2','CONN2','RELAY','PINHEADER-2','C2337'),
 ('J3','CONN2','BAT 18650','JST-PH2','C20080'),
 ('J4','NTC','NTC probe','NTC-10K-B3950','C17215'),
 ('TH1','NTC','NTC net','divider lower leg','C17215'),
]
A_NETS = {
 'U1.1':'GND','U1.2':'+3V3','U1.3':'EN','U1.4':'SDA','U1.5':'SCL','U1.6':'NTC_ADC',
 'U1.7':'ACC_INT','U1.8':'RELAY_TRIG','U1.9':'UART_TX','U1.10':'UART_RX','U1.11':'IO9_BOOT',
 'U2.1':'+3V3','U2.2':'GND','U2.3':'SDA','U2.4':'SCL','U2.5':'+3V3','U2.6':'GND','U2.7':'ACC_INT',
 'U3.1':'VBAT','U3.2':'+3V3','U3.3':'GND',
 'U4.1':'VIN_5V','U4.2':'VBAT','U4.3':'NCHRG','U4.4':'NSTDBY','U4.5':'PROG_SET',
 'R1.1':'EN','R1.2':'+3V3','R2.1':'NTC_ADC','R2.2':'+3V3',
 'R3.1':'GND','R3.2':'LED_A','R4.1':'NCHRG','R4.2':'LED_A','R5.1':'NSTDBY','R5.2':'LED_A',
 'C1.1':'VIN_5V','C1.2':'GND','C2.1':'VBAT','C2.2':'GND','C3.1':'+3V3','C3.2':'GND',
 'D1.1':'LED_A','D1.2':'+3V3',
 'J1.1':'+3V3','J1.2':'GND','J1.3':'UART_TX','J1.4':'UART_RX','J1.5':'IO9_BOOT',
 'J2.1':'RELAY_TRIG','J2.2':'GND',
 'J3.1':'VBAT','J3.2':'GND',
 'TH1.1':'NTC_ADC','TH1.2':'GND',
}
A_FLAGS = [('+3V3',(20,40)),('GND',(30,40))]

# ================= DEVICE B — Air Quality Prevention Node =================
B_BOM = [
 ('U1','ESP32C3','ESP32-C3-WROOM-02','ESP32-C3-WROOM-02-N4','C2934538'),
 ('U2','SCD41','SCD41','SCD41-D-R2','C82875'),
 ('U3','SGP41','SGP41','SGP41-D-R2','C2689479'),
 ('U4','LDO33','ME6211C33M5G','ME6211C33M5G','C82942'),
 ('R1','R','10k EN','0603WAF1002T5E','C25804'),
 ('R2','R','10k SDA pull','0603WAF1002T5E','C25804'),
 ('R3','R','10k SCL pull','0603WAF1002T5E','C25804'),
 ('C1','C','10uF','0603B104K500NT','C19702'),
 ('C2','C','100nF','0603B104K500NT','C14663'),
 ('C3','C','100nF','0603B104K500NT','C14663'),
 ('D1','LED','PWR','0603','C2286'),
 ('R4','R','1k LED','0603WAF1001T5E','C21190'),
 ('J1','SWD','PROG 5p','PINHEADER-5','C2337'),
 ('J2','CONN2','FAN relay','PINHEADER-2','C2337'),
 ('J3','CONN2','PIR in','PINHEADER-2','C2337'),
 ('J4','CONN2','5V in','PINHEADER-2','C2337'),
]
B_NETS = {
 'U1.1':'GND','U1.2':'+3V3','U1.3':'EN','U1.4':'SDA','U1.5':'SCL','U1.6':'PIR_IN',
 'U1.8':'FAN_TRIG','U1.9':'UART_TX','U1.10':'UART_RX','U1.11':'IO9_BOOT',
 'U2.1':'+3V3','U2.2':'GND','U2.3':'SDA','U2.4':'SCL',
 'U3.1':'+3V3','U3.2':'GND','U3.3':'SDA','U3.4':'SCL',
 'U4.1':'VIN_5V','U4.2':'+3V3','U4.3':'GND',
 'R1.1':'EN','R1.2':'+3V3','R2.1':'SDA','R2.2':'+3V3','R3.1':'SCL','R3.2':'+3V3',
 'R4.1':'LED_A','R4.2':'+3V3',
 'C1.1':'VIN_5V','C1.2':'GND','C2.1':'+3V3','C2.2':'GND','C3.1':'+3V3','C3.2':'GND',
 'D1.1':'LED_A','D1.2':'GND',
 'J1.1':'+3V3','J1.2':'GND','J1.3':'UART_TX','J1.4':'UART_RX','J1.5':'IO9_BOOT',
 'J2.1':'FAN_TRIG','J2.2':'GND',
 'J3.1':'PIR_IN','J3.2':'GND',
 'J4.1':'VIN_5V','J4.2':'GND',
}
B_FLAGS = [('+3V3',(20,40)),('GND',(30,40))]

# ================= DEVICE C — Motor Current Watchdog =================
C_BOM = [
 ('U1','ESP32C3','ESP32-C3-WROOM-02','ESP32-C3-WROOM-02-N4','C2934538'),
 ('U2','INA226','INA226','INA226AIDGSR','C10462'),
 ('U3','LDO33','ME6211C33M5G','ME6211C33M5G','C82942'),
 ('R1','R','10k EN','0603WAF1002T5E','C25804'),
 ('R2','R','0.1R shunt','1206W2F1002T5E? R100','C325841'),
 ('R3','R','10k SDA pull','0603WAF1002T5E','C25804'),
 ('R4','R','10k SCL pull','0603WAF1002T5E','C25804'),
 ('C1','C','10uF','0603B104K500NT','C19702'),
 ('C2','C','100nF','0603B104K500NT','C14663'),
 ('C3','C','100nF','0603B104K500NT','C14663'),
 ('D1','LED','PWR','0603','C2286'),
 ('R5','R','1k LED','0603WAF1001T5E','C21190'),
 ('J1','SWD','PROG 5p','PINHEADER-5','C2337'),
 ('J2','CONN2','LOAD+ (shunt to machine)','PINHEADER-2','C2337'),
 ('J3','CONN2','RELAY cutoff','PINHEADER-2','C2337'),
 ('J4','CONN2','5V in','PINHEADER-2','C2337'),
]
C_NETS = {
 'U1.1':'GND','U1.2':'+3V3','U1.3':'EN','U1.4':'SDA','U1.5':'SCL',
 'U1.8':'CUTOFF_TRIG','U1.9':'UART_TX','U1.10':'UART_RX','U1.11':'IO9_BOOT',
 'U2.1':'VIN_5V','U2.2':'GND','U2.3':'SHUNT_HI','U2.4':'SHUNT_LO',
 'U2.5':'SDA','U2.6':'SCL','U2.7':'INA_ALERT',
 'U3.1':'VIN_5V','U3.2':'+3V3','U3.3':'GND',
 'R1.1':'EN','R1.2':'+3V3','R3.1':'SDA','R3.2':'+3V3','R4.1':'SCL','R4.2':'+3V3',
 'R5.1':'LED_A','R5.2':'+3V3',
 'C1.1':'VIN_5V','C1.2':'GND','C2.1':'+3V3','C2.2':'GND','C3.1':'+3V3','C3.2':'GND',
 'D1.1':'LED_A','D1.2':'GND',
 'J1.1':'+3V3','J1.2':'GND','J1.3':'UART_TX','J1.4':'UART_RX','J1.5':'IO9_BOOT',
 'J2.1':'SHUNT_HI','J2.2':'SHUNT_LO',
 'J3.1':'CUTOFF_TRIG','J3.2':'GND',
 'J4.1':'VIN_5V','J4.2':'GND',
}
C_FLAGS = [('+3V3',(20,40)),('GND',(30,40))]

DEVICES = {
  'beacon-A':   (A_BOM, A_NETS, A_FLAGS, 'Veraldar Beacon A — Machine Health Beacon'),
  'airnode-B':  (B_BOM, B_NETS, B_FLAGS, 'Veraldar AirNode B — Air Quality Prevention Node'),
  'current-C':  (C_BOM, C_NETS, C_FLAGS, 'Veraldar Current-C — Motor Current Watchdog'),
}

if __name__ == '__main__':
    # stash nets/flags for build()
    for dev,(bom,nets,flags,title) in DEVICES.items():
        globals()['bom_map'] = {ref: p for ref,p,_,_,_ in bom}
        globals()['part_value'] = {ref: v for ref,_,v,_,_ in bom}
        globals()['POWER_FLAGS'] = flags
        d = build(dev, title, nets, bom)
        print('built', d)

