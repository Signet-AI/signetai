# Generative Patterns

Signet uses procedural canvas-based halftone dithering as bold
compositional elements. These are structural to the layout, not
subtle background noise.

## Pipeline

```
Seeded Perlin noise → fbm (fractal Brownian motion) → Bayer 4x4 dither → canvas pixel fill
```

## Seeded Perlin Noise

Use a seeded PRNG for consistent patterns across page reloads:

```js
let seed = 42;
function seededRand() {
  seed = (seed * 16807 + 0) % 2147483647;
  return (seed - 1) / 2147483646;
}

const PERM = new Uint8Array(512);
for (let i = 0; i < 256; i++) PERM[i] = i;
for (let i = 255; i > 0; i--) {
  const j = Math.floor(seededRand() * (i + 1));
  [PERM[i], PERM[j]] = [PERM[j], PERM[i]];
}
for (let i = 0; i < 256; i++) PERM[i + 256] = PERM[i];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function grad(hash, x, y) {
  const h = hash & 3;
  return (h < 2 ? x : -x) + (h === 0 || h === 3 ? y : -y);
}

function noise2d(x, y) {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[xi] + yi], ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi], bb = PERM[PERM[xi + 1] + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v
  );
}
```

## Fractal Brownian Motion (fbm)

```js
function fbm(x, y, octaves = 4) {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise2d(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}
```

## Bayer 4x4 Ordered Dither

Theme-aware — reads `--color-dither` from CSS so dots adapt to
dark/light mode:

```js
const BAYER4 = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5,
];

function getDitherColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue('--color-dither').trim() || '#f0f0f2';
}

function ditherCanvas(canvas, noiseFn, pixelSize = 4, threshold = 0.5) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.floor(rect.width), h = Math.floor(rect.height);
  if (w === 0 || h === 0) return;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const cols = Math.floor(w / pixelSize), rows = Math.floor(h / pixelSize);
  ctx.fillStyle = getDitherColor();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const val = noiseFn(x, y, cols, rows);
      const bayerVal = BAYER4[(y % 4) * 4 + (x % 4)] / 16;
      if (val + (bayerVal - 0.5) * 0.4 > threshold) {
        ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize - 1, pixelSize - 1);
      }
    }
  }
}
```

## Glitch/Smear Dither

Inspired by rave poster scan distortion. Combines vertical smear
(stretched-Y sampling) with horizontal glitch bands (random x-shift):

```js
function glitchNoise(x, y, cols, rows, offsetX = 0, offsetY = 0) {
  const nx = x / cols * 5 + offsetX;
  const ny = y / rows * 3 + offsetY;
  // Base organic shape
  const base = fbm(nx, ny, 5) * 0.5 + 0.5;
  // Vertical smear — sample noise with stretched Y
  const smearY = y / rows * 0.4;
  const smear = fbm(nx * 0.3, smearY + offsetY, 3) * 0.5 + 0.5;
  // Horizontal glitch bands
  const bandNoise = noise2d(0.1, y / rows * 20 + offsetY) * 0.5 + 0.5;
  const glitchShift = bandNoise > 0.65 ? (bandNoise - 0.65) * 8 : 0;
  const shiftedBase = fbm(nx + glitchShift, ny, 4) * 0.5 + 0.5;
  // Combine
  return shiftedBase * 0.5 + smear * 0.3 + base * 0.2;
}
```

Use different `offsetX`/`offsetY` for each block so they don't repeat.

## Canvas Layer Recipes

### Hero (organic blobs from edges)
- pixelSize: 4, threshold: 0.46, opacity: 0.35
- Noise: two fbm layers blended 60/40, biased toward edges
- Edge fade: `min(x/cols, 1-x/cols) * 2` for both axes
- min-height: 360px

### Right edge bleed
- pixelSize: 3, threshold: 0.52, opacity: 0.18
- Fixed position, 240px wide, full viewport height
- Noise fades in from right: multiply by `x/cols`

### Bold dither blocks (compositional anchors)
- pixelSize: 3, threshold: 0.42–0.45, opacity: 0.8
- Height: 80–160px, full content width
- Use glitch/smear mode for rave poster feel
- Placed between sections as visual weight

### Section dither bands
- pixelSize: 3, threshold: 0.5–0.55, opacity: 0.8
- Height: 80px, full content width
- "band" variant: stretched horizontal noise
- "cloud" variant: radial distance-faded noise

## Theme Re-rendering

On theme toggle, all canvases must re-render because dot color changes:
- Dark: `--color-dither: #f0f0f2` (light dots on dark)
- Light: `--color-dither: #0a0a0c` (dark dots on cream)

Call a `renderAllDither()` function after toggling `data-theme` with
a short delay (~60ms) so CSS variables have time to update.

## Tuning

- **More dots**: lower threshold (0.46 → 0.40)
- **Fewer dots**: raise threshold (0.46 → 0.55)
- **Larger dots**: increase pixelSize (3 → 5)
- **More organic**: increase fbm octaves (4 → 6)
- **More visible**: raise canvas opacity (0.18 → 0.35)
- **Subtler**: lower canvas opacity (0.35 → 0.15)
- **More glitch**: lower glitch band threshold (0.65 → 0.55)
- **Less glitch**: raise glitch band threshold (0.65 → 0.75)
