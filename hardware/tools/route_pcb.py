#!/usr/bin/env python3
"""Route pipeline per board: export DSN -> freerouting (subprocess) -> import SES -> save."""
import os, subprocess, sys
import pcbnew

BUILD = os.path.join(os.path.dirname(__file__), '..', 'build')
FR = os.path.expanduser('~/tools/freerouting.jar')

def route(name):
    pcb = os.path.join(BUILD, f'{name}.kicad_pcb')
    dsn = os.path.join(BUILD, f'{name}.dsn')
    ses = os.path.join(BUILD, f'{name}.ses')
    board = pcbnew.LoadBoard(pcb)
    pcbnew.ExportSpecctraDSN(board, dsn)
    print(f'{name}: DSN exported {os.path.getsize(dsn)} bytes', flush=True)
    r = subprocess.run(['java', '-jar', FR, '-de', dsn, '-do', ses, '-mpa', '30'],
                       capture_output=True, text=True, timeout=1200)
    tail = (r.stdout + r.stderr).strip().splitlines()
    print(f'{name}: freerouting rc={r.returncode} | ' + ' | '.join(tail[-2:])[-160:], flush=True)
    if not os.path.exists(ses):
        print(f'{name}: NO SES - routing failed', flush=True)
        return 0, 0
    board2 = pcbnew.LoadBoard(pcb)
    pcbnew.ImportSpecctraSES(board2, ses)
    # count routes
    tracks = board2.GetTracks()
    n = sum(1 for t in tracks if t.GetClass() == 'PCB_TRACK')
    connected = len({t.GetNetCode() for t in tracks if t.GetClass() == 'PCB_TRACK' and t.GetNetCode() > 0})
    total_nets = sum(1 for x in range(1, board2.GetNetCount()))
    pcbnew.SaveBoard(pcb, board2)
    pct = round(100 * connected / max(total_nets, 1))
    print(f'ROUTED {name}: {n} track segments, {connected}/{total_nets} nets have copper ({pct}%), saved', flush=True)
    return n, pct

if __name__ == '__main__':
    for dev in ('beacon-A', 'airnode-B', 'current-C'):
        try:
            route(dev)
        except Exception as e:
            print(f'ROUTE_FAIL {dev}: {type(e).__name__} {str(e)[:140]}', flush=True)
    print('ROUTE_ALL_DONE', flush=True)
