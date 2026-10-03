const tokens = {
  canvas: '#F7F5F0', panel: '#FFFFFF', text: '#262B27', muted: '#55594F',
  evergreen: '#1E5631', gold: '#7A5E18'
};
const linear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = hex => {
  const [r, g, b] = hex.slice(1).match(/../g).map(x => parseInt(x, 16));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const ratio = (fg, bg) => {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};
const pairs = [
  ['muted on canvas', tokens.muted, tokens.canvas],
  ['muted on white panel', tokens.muted, tokens.panel],
  ['gold on canvas (decorative only)', tokens.gold, tokens.canvas],
  ['evergreen on canvas', tokens.evergreen, tokens.canvas],
  ['charcoal on canvas', tokens.text, tokens.canvas]
];
let failed = false;
for (const [name, fg, bg] of pairs) {
  const value = ratio(fg, bg);
  console.log(`${name}: ${value.toFixed(2)}:1`);
  if (value < 4.5) { console.error(`FAIL: ${name} is below 4.5:1`); failed = true; }
}
if (failed) process.exitCode = 1;
