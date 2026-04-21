// Generates the Open Graph image for the Appalachian Trail page.
// Output: images/og/og-appalachian-trail.png (1200x630)
// Run: node tools/generate-og-image-at.js

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'images', 'og');
const OUT_FILE = path.join(OUT_DIR, 'og-appalachian-trail.png');

const W = 1200;
const H = 630;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background: dark forest green gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a3d1a');
  bg.addColorStop(1, '#2d6a2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Subtle vignette overlay (darkens edges)
  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // AT logo — centered, tall
  const logo = await loadImage(path.join(ROOT, 'images', 'ANSTLogo.png'));
  const logoMaxH = 340;
  const logoMaxW = 500;
  const scale = Math.min(logoMaxW / logo.width, logoMaxH / logo.height);
  const logoW = logo.width * scale;
  const logoH = logo.height * scale;
  const logoX = (W - logoW) / 2;
  const logoY = 80;
  ctx.drawImage(logo, logoX, logoY, logoW, logoH);

  // Divider line
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  const lineY = logoY + logoH + 28;
  ctx.beginPath();
  ctx.moveTo(W * 0.25, lineY);
  ctx.lineTo(W * 0.75, lineY);
  ctx.stroke();

  // Main label: two lines
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  ctx.font = 'bold 52px sans-serif';
  ctx.fillText('TrailTemps Weather Planner', W / 2, lineY + 22);
  ctx.fillText('and Best Start Date Calculator', W / 2, lineY + 86);

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(OUT_FILE, buf);
  console.log(`Saved: ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
