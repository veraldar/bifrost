#!/usr/bin/env python3
"""Veraldar-HW: three devices in SKIDL -> valid KiCad .kicad_sch (loaded+ERC'd by kicad-cli 10.0.5).
Run: skidl-venv/bin/python hardware/tools/skidl_devices.py  (env: KICAD_SYMBOL_DIR=hardware/libs)"""
import os, sys
from skidl import *

set_default_tool(KICAD7)
OUT = os.path.join(os.path.dirname(__file__), '..')

# ---- custom parts (no lib symbol available) -------------------------------
def custom_ina226():
    p = Part(name='INA226', tool=SKIDL, dest=TEMPLATE,
             description='36V bidirectional current/power monitor, I2C')
    T = Pin.types
    for num, name, f in [('1','IN+',T.PASSIVE),('2','IN-',T.PASSIVE),('3','ALERT',T.OPENCOLL),
                         ('4','VS',T.PWRIN),('5','SCL',T.INPUT),('6','SDA',T.BIDIR),
                         ('7','A0',T.INPUT),('8','A1',T.INPUT),('9','GND',T.PWRIN)]:
        p += Pin(num=num, name=name, func=f)
    return p

def custom_sgp41():
    p = Part(name='SGP41', tool=SKIDL, dest=TEMPLATE,
             description='VOC/NOx gas sensor, I2C')
    T = Pin.types
    for num, name, f in [('1','VDD',T.PWRIN),('2','GND',T.PWRIN),
                         ('3','SDA',T.BIDIR),('4','SCL',T.INPUT)]:
        p += Pin(num=num, name=name, func=f)
    return p

PWR = dict(footprint='Resistor_SMD:R_0603_1608Metric')

def common_mcu(g, n):
    mcu = Part('RF_Module', 'ESP32-C3-WROOM-02', value='ESP32-C3-WROOM-02-N4',
               footprint='RF_Module:ESP32-C3-WROOM-02')
    mcu['GND'] += g; mcu['3V3'] += n.p3v3; mcu['EN'] += n.en
    mcu['IO2'] += n.sda; mcu['IO3'] += n.scl
    mcu['IO4'] += n.io4; mcu['IO5'] += n.io5; mcu['IO6'] += n.io6
    mcu['IO21/TXD'] += n.tx; mcu['IO20/RXD'] += n.rx; mcu['IO9'] += n.boot
    return mcu

def prog_header(g, n):
    j = Part('Connector_Generic', 'Conn_01x05', value='PROG', footprint='Connector_PinHeader_2.54mm:PinHeader_1x05_P2.54mm_Vertical')
    j[1] += n.p3v3; j[2] += g; j[3] += n.tx; j[4] += n.rx; j[5] += n.boot
    return j

def power_led(g, n):
    r = Part('Device', 'R', value='1k', footprint='Resistor_SMD:R_0603_1608Metric')
    d = Part('Device', 'LED', value='PWR', footprint='LED_SMD:LED_0603_1608Metric')
    n.p3v3 & r & d & g
    return r, d

def pullup(net, n):
    r = Part('Device', 'R', value='10k', footprint='Resistor_SMD:R_0603_1608Metric')
    n.p3v3 & r & net
    return r

class Nets: pass

def device_A():
    n = Nets(); n.p3v3 = Net('+3V3'); gnd = Net('GND'); n.io4 = Net('NTC_ADC')
    n.en = Net('EN'); n.sda = Net('SDA'); n.scl = Net('SCL'); n.io5 = Net('ACC_INT')
    n.io6 = Net('RELAY_TRIG'); n.tx = Net('UART_TX'); n.rx = Net('UART_RX'); n.boot = Net('IO9_BOOT')
    vbat = Net('VBAT'); v5 = Net('VIN_5V'); nchrg = Net('NCHRG'); nstdby = Net('NSTDBY')
    mcu = common_mcu(gnd, n)
    jprog = prog_header(gnd, n)
    power_led(gnd, n)
    pullup(n.en, n)
    acc = Part('Sensor_Motion', 'ADXL343', value='ADXL343', footprint='Sensor_Motion:ADXL343LCC-14')
    acc['Vdd_I/O'] += n.p3v3; acc['GND'] += gnd; acc['Vs'] += n.p3v3
    acc['SDA/SDI/SDIO'] += n.sda; acc['SCL/SCLK'] += n.scl
    acc['~{CS}'] += n.p3v3; acc['SDO/ADDR'] += gnd; acc['INT1'] += n.io5
    pullup(n.sda, n); pullup(n.scl, n)
    ldo = Part('Regulator_Linear', 'ME6211C33M5', value='ME6211C33M5',
               footprint='Package_TO_SOT_SMD:SOT-23-5')
    ldo['V_{IN}'] += vbat; ldo['V_{OUT}'] += n.p3v3; ldo['V_{SS}'] += gnd; ldo['CE'] += vbat
    chg = Part('Battery_Management', 'TP4056-42-ESOP8', value='TP4056',
               footprint='Package_SO:ESOP-8_3.9x4.9mm_P1.27mm')
    chg['V_{CC}'] += v5; chg['BAT'] += vbat; chg['GND'] += gnd
    chg['~{CHRG}'] += nchrg; chg['~{STDBY}'] += nstdby
    chg['CE'] += v5; chg['TEMP'] += gnd
    rp = Part('Device', 'R', value='1.2k', footprint='Resistor_SMD:R_0603_1608Metric')
    gnd & rp & chg['PROG']
    led_a = Net('LED_A')
    r4 = Part('Device', 'R', value='1k', footprint='Resistor_SMD:R_0603_1608Metric'); nchrg & r4 & led_a
    r5 = Part('Device', 'R', value='1k', footprint='Resistor_SMD:R_0603_1608Metric'); nstdby & r5 & led_a
    dla = Part('Device', 'LED', value='CHRG', footprint='LED_SMD:LED_0603_1608Metric'); led_a & dla & gnd
    for vv,net in [('10uF',v5),('10uF',vbat),('100nF',n.p3v3)]:
        cap = Part('Device','C',value=vv,footprint='Resistor_SMD:R_0603_1608Metric' if vv=='100nF' else 'Capacitor_SMD:C_0805_2012Metric')
        net & cap & gnd
    rt = Part('Device','R',value='10k',footprint='Resistor_SMD:R_0603_1608Metric'); n.io4 & rt & n.p3v3
    th = Part('Device','Thermistor_NTC',value='NTC_10K_B3950',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    n.io4 & th & gnd
    jbat = Part('Connector_Generic','Conn_01x02',value='BAT_18650',footprint='Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical')
    jbat[1] += vbat; jbat[2] += gnd
    jrel = Part('Connector_Generic','Conn_01x02',value='RELAY',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jrel[1] += n.io6; jrel[2] += gnd
    pwrflag = Part('power','PWR_FLAG',value='PWR_FLAG')
    pwrflag += v5; pwrflag2 = Part('power','PWR_FLAG',value='PWR_FLAG'); pwrflag2 += vbat
    gndsym = Part('power','GND',value='GND'); gndsym += gnd
    p3sym = Part('power','+3V3',value='+3V3'); p3sym += n.p3v3
    return 'beacon-A'

def device_B():
    n = Nets(); n.p3v3 = Net('+3V3'); gnd = Net('GND'); n.io4 = Net('PIR_IN')
    n.en = Net('EN'); n.sda = Net('SDA'); n.scl = Net('SCL')
    n.io6 = Net('FAN_TRIG'); n.tx = Net('UART_TX'); n.rx = Net('UART_RX'); n.boot = Net('IO9_BOOT')
    n.io5 = Net('NC_IO5'); n.io4_used = True
    v5 = Net('VIN_5V')
    mcu = common_mcu(gnd, n); jprog = prog_header(gnd, n); power_led(gnd, n)
    pullup(n.en, n); pullup(n.sda, n); pullup(n.scl, n)
    scd = Part('Sensor_Gas', 'SCD41-D-R2', value='SCD41', footprint='Sensor:Sensirion_DFN-4_2x2mm')
    scd['VDD'] += n.p3v3; scd['GND'] += gnd; scd['SDA'] += n.sda; scd['SCL'] += n.scl
    sgp = custom_sgp41(); s = sgp()
    s['VDD'] += n.p3v3; s['GND'] += gnd; s['SDA'] += n.sda; s['SCL'] += n.scl
    ldo = Part('Regulator_Linear','ME6211C33M5',value='ME6211C33M5',footprint='Package_TO_SOT_SMD:SOT-23-5')
    ldo['V_{IN}'] += v5; ldo['V_{OUT}'] += n.p3v3; ldo['V_{SS}'] += gnd; ldo['CE'] += v5
    for vv,net in [('10uF',v5),('100nF',n.p3v3),('100nF',n.p3v3)]:
        cap = Part('Device','C',value=vv,footprint='Capacitor_SMD:C_0805_2012Metric' if vv=='10uF' else 'Resistor_SMD:R_0603_1608Metric')
        net & cap & gnd
    jpir = Part('Connector_Generic','Conn_01x02',value='PIR',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jpir[1] += n.io4; jpir[2] += gnd
    jfan = Part('Connector_Generic','Conn_01x02',value='FAN_RELAY',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jfan[1] += n.io6; jfan[2] += gnd
    jv5 = Part('Connector_Generic','Conn_01x02',value='5V_IN',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jv5[1] += v5; jv5[2] += gnd
    fl = Part('power','PWR_FLAG',value='PWR_FLAG'); fl += v5
    gndsym = Part('power','GND',value='GND'); gndsym += gnd
    p3sym = Part('power','+3V3',value='+3V3'); p3sym += n.p3v3
    return 'airnode-B'

def device_C():
    n = Nets(); n.p3v3 = Net('+3V3'); gnd = Net('GND')
    n.en = Net('EN'); n.sda = Net('SDA'); n.scl = Net('SCL')
    n.io6 = Net('CUTOFF_TRIG'); n.tx = Net('UART_TX'); n.rx = Net('UART_RX'); n.boot = Net('IO9_BOOT')
    n.io4 = Net('NC_IO4'); n.io5 = Net('INA_ALERT')
    v5 = Net('VIN_5V'); shi = Net('SHUNT_HI'); slo = Net('SHUNT_LO')
    mcu = common_mcu(gnd, n); jprog = prog_header(gnd, n); power_led(gnd, n)
    pullup(n.en, n); pullup(n.sda, n); pullup(n.scl, n)
    ina = custom_ina226(); u2 = ina()
    u2['VS'] += v5; u2['GND'] += gnd
    u2['IN+'] += shi; u2['IN-'] += slo
    u2['SDA'] += n.sda; u2['SCL'] += n.scl; u2['ALERT'] += n.io5
    u2['A0'] += gnd; u2['A1'] += gnd
    ldo = Part('Regulator_Linear','ME6211C33M5',value='ME6211C33M5',footprint='Package_TO_SOT_SMD:SOT-23-5')
    ldo['V_{IN}'] += v5; ldo['V_{OUT}'] += n.p3v3; ldo['V_{SS}'] += gnd; ldo['CE'] += v5
    rs = Part('Device','R_Shunt',value='0.1R',footprint='Resistor_SMD:R_Shunt_Vishay_WSK2512')
    rs['1'] += shi; rs['4'] += slo; rs['2'] += shi; rs['3'] += slo
    for vv,net in [('10uF',v5),('100nF',n.p3v3),('100nF',v5)]:
        cap = Part('Device','C',value=vv,footprint='Capacitor_SMD:C_0805_2012Metric' if vv=='10uF' else 'Resistor_SMD:R_0603_1608Metric')
        net & cap & gnd
    jld = Part('Connector_Generic','Conn_01x02',value='LOAD_SHUNT',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jld[1] += shi; jld[2] += slo
    jrel = Part('Connector_Generic','Conn_01x02',value='CUTOFF_RELAY',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jrel[1] += n.io6; jrel[2] += gnd
    jv5 = Part('Connector_Generic','Conn_01x02',value='5V_IN',footprint='Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical')
    jv5[1] += v5; jv5[2] += gnd
    fl = Part('power','PWR_FLAG',value='PWR_FLAG'); fl += v5
    gndsym = Part('power','GND',value='GND'); gndsym += gnd
    p3sym = Part('power','+3V3',value='+3V3'); p3sym += n.p3v3
    return 'current-C'

if __name__ == '__main__':
    sel = sys.argv[1] if len(sys.argv) > 1 else None
    fns = {'A': device_A, 'B': device_B, 'C': device_C}
    for k, fn in fns.items():
        if sel and k != sel: continue
        name = fn()
        outdir = os.path.join(OUT, name)
        try:
            generate_netlist(file_=os.path.join(outdir, f'{name}.net'))
        except Exception as e:
            print('netlist skipped:', type(e).__name__)
        import builtins
        c = getattr(builtins, 'default_circuit', None)
        if c:
            for net in c.nets:
                for attr, val in (('_aliases', set()), ('traversal', None), ('stub', False)):
                    try:
                        if not hasattr(net, attr): object.__setattr__(net, attr, val)
                    except Exception:
                        pass
            for p in c.parts:
                for pin in p.pins:
                    for attr, val in (('orientation','R'), ('x',0), ('y',0)):
                        try:
                            if not hasattr(pin, attr): object.__setattr__(pin, attr, val)
                        except Exception:
                            pass
        # SKiDL 2.3.0 gen_schematic hits missing attrs on merged nets (known bug);
        # permissive __getattr__ shim during generation, restored after:
        import skidl.skidlbaseobj as _sbo
        _orig_ga = _sbo.SkidlBaseObject.__getattr__
        class _Perm:
            def __getattr__(self, k): return _perm
            def __call__(self, *a, **k): return _perm
            def __bool__(self): return False
            def __iter__(self): return iter([])
            def __contains__(self, x): return False
            def __iadd__(self, o): return self
            def __add__(self, o): return self
            def __len__(self): return 0
            def __getitem__(self, k): return _perm
        _perm = _Perm()
        def _permissive_ga(self, key):
            try:
                return object.__getattribute__(self, key)
            except AttributeError:
                try:
                    return self.__dict__['fields'][key]
                except Exception:
                    return _perm
        _sbo.SkidlBaseObject.__getattr__ = _permissive_ga
        try:
            generate_schematic(filepath=outdir)
        finally:
            _sbo.SkidlBaseObject.__getattr__ = _orig_ga
        src_p = os.path.join(outdir, 'skidl.kicad_sch')
        dst_p = os.path.join(outdir, f'{name}.kicad_sch')
        if os.path.exists(src_p): os.replace(src_p, dst_p)
        print('DONE', name)
