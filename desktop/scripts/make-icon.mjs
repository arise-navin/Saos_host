/**
 * desktop/build/icon.png — the app and installer icon, rendered from the same
 * mark the browser tab uses (client/public/favicon.svg), at 1024×1024.
 * electron-builder turns it into the Windows .ico and the macOS .icns.
 *
 * Uses @napi-rs/canvas from the server's dependencies, so it needs nothing new.
 * Run from desktop/: npm run icon
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DESKTOP, '..');
const require = createRequire(path.join(REPO, 'server', 'package.json'));
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const SIZE = 1024;
/* Rasterised at the target size: the SVG's own 64×64 would be drawn small and scaled up blurry. */
const svg = fs.readFileSync(path.join(REPO, 'client', 'public', 'favicon.svg'), 'utf8')
  .replace(/\bwidth="\d+"\s+height="\d+"/, `width="${SIZE}" height="${SIZE}"`);
const image = await loadImage(Buffer.from(svg));
const canvas = createCanvas(SIZE, SIZE);
canvas.getContext('2d').drawImage(image, 0, 0, SIZE, SIZE);
fs.mkdirSync(path.join(DESKTOP, 'build'), { recursive: true });
fs.writeFileSync(path.join(DESKTOP, 'build', 'icon.png'), canvas.toBuffer('image/png'));
console.log(`wrote build/icon.png (${SIZE}×${SIZE})`);
