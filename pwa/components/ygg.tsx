/** Yggdrasil drawn as circuit traces — the one drawing every surface crops
 *  (session-list band, the front page's roots, settings world minis,
 *  veraldar.org hero). Static
 *  markup, no client code: motion is pure CSS, governed by state classes
 *  on the wrapper (styles/brand.css § tree):
 *    wake     one pulse climbs the trunk, once — the box answered
 *    live     one thought at a time walks the band while something works
 *    rest     nothing moves. no ambient loop, no idle shimmer.
 *  Every signal is normalised (pathLength=1) so short and long traces take
 *  the same time. */

const BASE = [
  'base',
  'M195 0 296 102 296 178 358 242 488 243 528 284 527 305 355 305 373 325 545 325 650 431 650 489 508 344 345 344 228 222 199 222 335 364 498 364 568 435 512 436 429 520 323 520 243 600 272 600 332 540 438 540 521 456 588 456 651 520 651 641 525 767 555 767 650 672 651 703 587 767 617 767 672 712 671 423 549 299 548 275 497 223 369 223 335 188 544 187 594 237 594 308 671 386 671 313 714 270 714 154 777 92 777 0 756 0 756 83 693 146 694 260 671 283 670 96 714 52 714 0 693 0 693 44 671 65 670 20 650 0 621 0 650 30 649 176 556 81 556 0 535 0 534 70 462 0 432 0 472 41 409 41 368 0 338 0 400 62 495 62 516 82 419 83 438 103 548 104 567 123 461 124 481 145 589 145 650 207 649 335 615 299 615 229 554 167 422 167 354 99 353 64 289 0 259 0 333 74 333 108 391 165 390 167 318 167 317 93 225 0Z',
  'M1407 58 1284 183 1213 183 1066 344 900 344 737 510 737 711 792 767 821 767 758 703 759 673 852 767 882 767 758 642 758 518 819 456 887 457 969 540 1076 540 1136 600 1164 600 1106 542 1107 540 1139 540 1181 582 1407 582 1407 562 1191 562 1148 520 978 520 895 436 840 435 909 364 1047 365 1009 407 905 407 886 427 1075 427 1209 281 1321 281 1341 261 1199 261 1065 407 1039 407 1044 399 1187 242 1407 242 1407 222 1206 221 1223 203 1294 203 1407 88Z',
  'M1211 0 1181 0 1065 117 1065 196 1033 229 905 229 860 275 860 329 825 366 816 366 816 236 865 187 963 187 1025 124 1026 159 975 210 1003 211 1047 166 1047 102 1148 0 1118 0 953 167 855 167 794 229 794 359 737 417 737 473 814 386 834 386 894 325 1034 325 1053 305 882 306 881 284 915 249 1042 249 1085 205 1086 125Z',
  'M1069 0 1040 0 999 41 936 41 975 0 946 0 874 70 873 0 852 0 853 80 737 198 737 320 693 364 694 767 714 767 714 373 758 329 758 207 819 145 878 145 918 104 968 104 990 83 910 83 869 124 840 123 875 88 886 88 912 62 1007 62Z',
  'M0 582 226 582 306 501 423 501 443 481 208 481 155 422 155 453 198 501 216 502 199 520 0 520 0 540 208 540 246 501 276 502 217 562 0 562Z',
  'M1407 303 1257 303 1115 449 932 449 952 469 1187 469 1267 387 1238 387 1177 449 1146 448 1267 323 1407 323Z',
  'M1277 0 1247 0 1108 141 1109 170 1156 122 1158 126 1157 160 1054 272 930 273 912 293 1063 293 1177 169 1178 100Z',
  'M0 303 0 323 176 323 278 427 524 427 505 407 287 407 186 303Z',
  'M1407 540 1407 520 1209 520 1192 503 1215 502 1246 470 1246 441 1206 482 965 482 985 502 1161 502 1199 540Z',
  'M128 0 253 126 253 193 255 199 338 285 489 286 470 265 348 265 275 190 274 118 157 0Z',
  'M0 197 0 217 135 217 178 260 116 261 136 281 199 282 302 386 331 386 145 197Z',
  'M80 344 100 364 154 364 156 387 228 469 454 469 474 449 237 449 176 378 176 362 159 344Z',
  'M1250 364 1313 364 1332 344 1269 344Z',
];

// every trace starts at the trunk and runs outward. --i = order when held,
// --j = turn when working; lo = visible inside the band crop
const SIGS: { d: string; cls: string; i: number; j?: number }[] = [
  { cls: 't lo', i: 0, j: 0, d: 'M704 767 704 364 737 329 737 207 819 145 918 104 968 104 990 83' },
  { cls: 'lo', i: 1, j: 1, d: 'M660 500 588 456 521 456 438 540 332 540 272 600' },
  { cls: 'lo', i: 2, j: 2, d: 'M737 500 819 456 887 457 969 540 1076 540 1136 600' },
  { cls: '', i: 3, d: 'M649 335 615 299 615 229 554 167 422 167 391 165 318 167 317 93 225 0' },
  { cls: '', i: 4, d: 'M737 460 952 459 1115 449 1257 313 1407 313' },
  { cls: '', i: 5, d: 'M650 176 556 81 556 0' },
  { cls: 'lo', i: 6, j: 3, d: 'M651 641 525 767M737 711 759 673 852 767' },
];

/** crop = the band's slice of the tree (trunk + low boughs) */
export const BAND_VIEWBOX = '150 430 1108 338';

export function YggTree({ viewBox, slice }: { viewBox?: string; slice?: boolean }) {
  return (
    <svg
      viewBox={viewBox || '0 0 1408 768'}
      preserveAspectRatio={slice ? 'xMidYMid slice' : undefined}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g className="base">
        {BASE.map((d, k) => (
          <path key={k} d={d} />
        ))}
      </g>
      <g>
        {SIGS.map((s, k) => (
          <path
            key={k}
            className={`sig ${s.cls}`}
            pathLength={1}
            data-j={s.j}
            style={{ '--i': s.i, '--j': s.j ?? 0 } as React.CSSProperties}
            d={s.d}
          />
        ))}
      </g>
    </svg>
  );
}

// THE ROOTS (MAINFRAME-C, 10-26) — the same tree continued below its bottom
// edge (y 767 of the crown becomes y 0 here): the five trunk exits at x 540 ·
// 602 · 704 · 806 · 867 carry on in the direction they leave the crown (45°
// flares, the vertical bus), then spread in the crown's own vocabulary.
// Stroked, not filled: w = trace width. Geometry from the C mockup
// (artifacts/mainframe-proposals.html, ROOTS/RSIG).
const ROOTS: { d: string; w: number }[] = [
  { d: 'M704 -24 V230', w: 20 },
  { d: 'M564 -24 L540 0 M540 0 L470 70 H330 L270 130 H120', w: 28 },
  { d: 'M843 -24 L867 0 M867 0 L937 70 H1080 L1140 130 H1290', w: 28 },
  { d: 'M626 -24 L602 0 M602 0 L560 42 V90 L520 130 V230', w: 26 },
  { d: 'M782 -24 L806 0 M806 0 L848 42 V90 L888 130 V230', w: 26 },
  { d: 'M420 70 L380 110 V230', w: 18 },
  { d: 'M990 70 L1030 110 V230', w: 18 },
  { d: 'M704 56 L664 96 V230', w: 14 },
  { d: 'M704 92 L744 132 V230', w: 14 },
  { d: 'M300 100 L262 62 H180', w: 14 },
  { d: 'M1110 100 L1148 62 H1230', w: 14 },
];

// signal centrelines, every one from the trunk outward (pathLength=1):
// --i = order while held (your words run down to the root tips), --j = turn
// while MAIN works (one thought at a time — the band's 8 s clock)
const RSIG: { d: string; i: number; j?: number }[] = [
  { d: 'M704 0 V200', i: 0 },
  { d: 'M540 0 L470 70 H330 L270 130 H150', i: 1, j: 0 },
  { d: 'M867 0 L937 70 H1080 L1140 130 H1258', i: 2, j: 1 },
  { d: 'M602 0 L560 42 V90 L520 130 V200M806 0 L848 42 V90 L888 130 V200', i: 3, j: 2 },
  { d: 'M420 70 L380 110 V200M990 70 L1030 110 V200', i: 4, j: 3 },
];

/** the roots' crop: same horizontal span as the band, so on a phone the
 *  trunk leaves the band and enters the roots at the same x */
export const ROOTS_VIEWBOX = '150 0 1108 226';

/** The roots: held = every signal runs down (amber, --i); working = one
 *  walks (.w, --j); the answer = one pulse climbs the taproot (.t, wake) */
export function YggRoots() {
  return (
    <svg
      viewBox={ROOTS_VIEWBOX}
      preserveAspectRatio="xMidYMin slice"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g className="base">
        {ROOTS.map((r, k) => (
          <path key={k} d={r.d} strokeWidth={r.w} />
        ))}
      </g>
      <g>
        {RSIG.map((s, k) => (
          <path
            key={k}
            className={s.j === undefined ? 'sig h' : 'sig h w'}
            pathLength={1}
            data-j={s.j}
            style={{ '--i': s.i, '--j': s.j ?? 0 } as React.CSSProperties}
            d={s.d}
          />
        ))}
        <path className="sig t" pathLength={1} d="M704 200 V0" />
      </g>
    </svg>
  );
}
