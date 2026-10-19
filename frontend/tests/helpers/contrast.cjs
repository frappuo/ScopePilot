// WCAG 2.x relative luminance and contrast ratio for #RRGGBB colours, plus alpha blending.

function channels(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = channels(hex)
    .map(value => value / 255)
    .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// `foreground` at `alpha` opacity over an opaque `background`.
function mix(foreground, background, alpha) {
  const back = channels(background);
  return `#${channels(foreground)
    .map((value, index) => Math.round(value * alpha + back[index] * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

module.exports = { channels, luminance, contrastRatio, mix };
