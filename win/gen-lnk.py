#!/usr/bin/env python3
"""gen-lnk.py — write a minimal valid MS-SHLLINK (.lnk) ShellLink file.

Usage: gen-lnk.py <target-win-path> <out.lnk>
Header + LinkInfo (VolumeID + LocalBasePath), ANSI, no StringData.
This is the documented .lnk format (MS-SHLLINK); Explorer double-clicks it
like any shortcut. Used because wine's ShellLink COM class is not reachable
from the 32-bit NSIS view (see artifacts/win-qr-sim-report.md).
"""
import struct, sys

def main():
    target, out = sys.argv[1], sys.argv[2]
    target_bytes = target.encode("mbcs", errors="replace") if False else target.encode("latin-1", "replace")

    # ---- LinkInfo: flags = VolumeIDAndLocalBasePath ----
    label = b"VERALDAR\x00"                       # volume label (ANSI, NUL-terminated)
    volumeid = struct.pack("<IIII", 3, 0x1234ABCD, 0, 16 + len(label)) + label  # DriveType=FIXED, VolSeq, NameOff=0, Size=hdr16+label
    base = target_bytes + b"\x00"
    common_suffix = b"\x00"
    li_hdr = 0x1C
    vol_off = li_hdr
    lbp_off = vol_off + len(volumeid)
    cnrl_off = 0
    suffix_off = lbp_off + len(base)
    li_size = suffix_off + len(common_suffix)
    linkinfo = (struct.pack("<IIIIIII", li_size, li_hdr, 0x1, vol_off, lbp_off, cnrl_off, suffix_off)
                + volumeid + base + common_suffix)

    # ---- ShellLinkHeader ----
    # LinkFlags: HasLinkInfo(0x4). FileAttributes: 0. Times: 0.
    # ShowCommand = SW_SHOWNORMAL(1).
    header = struct.pack("<I", 0x4C)                                   # HeaderSize
    header += bytes([0x01,0x14,0x02,0x00,0x00,0x00,0x00,0x00,
                     0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46])         # LinkCLSID
    header += struct.pack("<I", 0x4)                                   # LinkFlags
    header += struct.pack("<I", 0)                                     # FileAttributes
    header += struct.pack("<Q", 0) + struct.pack("<Q", 0) + struct.pack("<Q", 0)  # 3×FILETIME
    header += struct.pack("<III", 1, 0, 0)                             # ShowCommand, HotKey, Res1(2)
    header += b"\x00" * 0

    with open(out, "wb") as f:
        f.write(header + linkinfo)
    print(f"wrote {out}: target={target} ({len(header)+len(linkinfo)} bytes)")

if __name__ == "__main__":
    main()
