// Department colours are picked to look good as rugs and shirts, and some (#f2cc8f) are far too light
// to read as text on white. Mixing in the ink colour keeps the hue and gets the worst case to about
// 4.9:1 on white (WCAG AA needs 4.5:1); 50% would only reach about 4.3:1.
const TEXT_MIX = 45;

/** A department colour, darkened enough to use for text. Use the plain colour for borders, rugs and dots. */
export const inkFor = (color: string) => `color-mix(in srgb, ${color} ${TEXT_MIX}%, #1f2329)`;
