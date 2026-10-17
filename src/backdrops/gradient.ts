/** The start and end points [x0, y0, x1, y1] of a CSS-style linear gradient (180° = top → bottom) over w×h. */
export function gradientLine(w: number, h: number, angle: number): [number, number, number, number] {
  const a = ((angle - 90) * Math.PI) / 180;
  const half = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
  return [
    w / 2 - Math.cos(a) * half,
    h / 2 - Math.sin(a) * half,
    w / 2 + Math.cos(a) * half,
    h / 2 + Math.sin(a) * half,
  ];
}
