/** Line icons — 16-grid, 1.5 stroke, square caps. Geometry only, no pixels
 *  (cohesive-2 "signal path": line icons replace the pixel set). Server-safe:
 *  no hooks, renders in either tree. */

const ICONS = {
  mic: ['M6 1.75h4v7.5H6z', 'M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2.5M5.5 14.75h5'],
  send: ['M2 8h11M9 4l4 4-4 4'],
  attach: ['M11 5 6 10a1.4 1.4 0 0 0 2 2l5-5a3 3 0 0 0-4.25-4.25l-5 5a4.6 4.6 0 0 0 6.5 6.5l3.5-3.5'],
  search: ['M6.75 2.25a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10 10l4 4'],
  plus: ['M8 2.5v11M2.5 8h11'],
  back: ['M13.5 8h-11M6.5 4l-4 4 4 4'],
  close: ['M3.5 3.5l9 9M12.5 3.5l-9 9'],
  // artifact: a found runestone — rounded crown, flat foot set in the ground
  // line, one carved rune (algiz, the warden's mark)
  artifact: ['M4.25 13.25V6.5a3.75 3.75 0 0 1 7.5 0v6.75', 'M1.75 13.25h12.5', 'M8 5.5v5.25M6 6.75l2 2 2-2'],
  volume: ['M2 6h2.75L8.5 3v10L4.75 10H2zM11 5.5a3.5 3.5 0 0 1 0 5M12.75 3.5a6 6 0 0 1 0 9'],
  pause: ['M5.5 3v10M10.5 3v10'],
  play: ['M4.5 2.75v10.5L13 8z'],
  external: ['M9.5 2.5h4v4M13.5 2.5 7.5 8.5', 'M11.5 9.5v4h-9v-9h4'],
} as const;

export type LineIconName = keyof typeof ICONS;

export function LineIcon({
  name,
  size = 16,
  className,
}: {
  name: LineIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`oz-ic ${className || ''}`}
      aria-hidden="true"
    >
      {ICONS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** The one stop glyph: a filled square (red ■ in the deck, hands-free exit). */
export function StopSquare({ size = 12 }: { size?: number }) {
  return <span aria-hidden="true" className="oz-sq" style={{ width: size, height: size }} />;
}
