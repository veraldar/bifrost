#!/usr/bin/env python3
"""Veraldar-HW KiCad generator: builds .kicad_sch files (KiCad 7 format, readable by KiCad 10).
Hand-rolled s-expression writer - full format control, no lib guessing."""
import uuid as _uuid, os, sys

def u(): return str(_uuid.uuid4())

def esc(s): return s.replace('\\', '\\\\').replace('"', '\\"')

# ---------- lib symbol definitions (KiCad 7 lib_symbol s-expr) ----------
def pin(num, name, etype, px, py, rot=0, length=2.54):
    # rot: 0=right, 90=up, 180=left, 270=down
    return f'''    (pin {etype} line
      (at {px} {py} {rot})
      (length {length})
      (name "{esc(name)}" (effects (font (size 1.0 1.0))))
      (number "{num}" (effects (font (size 1.0 1.0))))
    )'''

def lib_symbol(lib_id, ref_prefix, pins, body_w=12.7, body_h=17.78, pin_len=2.54):
    """pins: list of (num, name, etype, side, offset) side in R/L/U/D"""
    half_w, half_h = body_w/2, body_h/2
    pin_sexps, draw_lines = [], []
    left = [p for p in pins if p[3]=='L']; right=[p for p in pins if p[3]=='R']
    def place(plist, side):
        n=len(plist); start=2.54*(n-1)/2
        for i,(num,name,etype,_,off) in enumerate(plist):
            y=start-2.54*i if n>1 else 0
            if side=='L': x=-half_w-pin_len; rot=0
            else: x=half_w+pin_len; rot=180
            pin_sexps.append(pin(num,name,etype,x,y,rot))
    place(left,'L'); place(right,'R')
    draws = f'''    (symbol "{lib_id.split(':')[1]}_0_1"
    (rectangle (start {-half_w} {half_h}) (end {half_w} {-half_h}) (stroke (width 0.254) (type default)) (fill (type background)))
    )'''
    pins_ss = f'''    (symbol "{lib_id.split(':')[1]}_1_1"
{chr(10).join(pin_sexps)}
    )'''
    return f'''  (lib_symbol "{lib_id}"
    (pin_numbers hide)
    (pin_names (offset 0.5))
    (exclude_from_sim no)
    (in_bom yes)
    (on_board yes)
    (property "Reference" "{ref_prefix}" (at 0 {half_h+2.54} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "{lib_id.split(':')[1]}" (at 0 {-half_h-2.54} 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
{draws}
{pins_ss}
  )'''

# ---------- schematic ----------
def wire(pts):
    (x1,y1),(x2,y2)=pts
    return f'  (wire (pts (xy {x1} {y1}) (xy {x2} {y2})) (stroke (width 0) (type default)) (uuid {u()}))'

def label(text, x, y, rot=0):
    return f'  (label "{esc(text)}" (at {x} {y} {rot}) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid {u()}))'

def pwr_flag(x,y,name):
    """PWR_FLAG attached to a power label."""
    return (f'  (global_label "{esc(name)}" (shape input) (at {x} {y} 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid {u()})\n'
            f'    (property "Intersheetrefs" "${{INTERSHEET_REFS}}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))\n  )')

def sym_inst(lib_id, ref, value, x, y, unit=1):
    return f'''  (symbol (lib_id "{lib_id}") (at {x} {y} 0) (unit {unit})
    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
    (uuid {u()})
    (property "Reference" "{ref}" (at {x} {y+12} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "{esc(value)}" (at {x} {y-12} 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Datasheet" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) hide))
    (property "Description" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) hide))
    (instances
      (project "proj"
        (path "/{ROOT_UUID}" (reference "{ref}") (unit {unit}))
      )
    )
  )'''

ROOT_UUID = u()

def build_schematic(name, lib_syms, instances, wires, labels):
    libs = '\n'.join(lib_syms)
    insts = '\n'.join(instances)
    wrs = '\n'.join(wires)
    lbs = '\n'.join(labels)
    return f'''(kicad_sch
  (version 20230121)
  (generator kicad_symbol_editor_v7)
  (generator_version "7.0")
  (uuid {ROOT_UUID})
  (paper "A4")
  (title_block (title "{esc(name)}") (company "Veraldar") (date "2026-10-04"))
  (lib_symbols
{libs}
  )
{insts}
{wrs}
{lbs}
  (sheet_instances
    (path "/" (page "1"))
  )
  (embedded_fonts no)
)
'''
