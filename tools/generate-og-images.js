// Generates Open Graph images (1200x630) for all TrailTemps pages.
// Output: images/og/og-<trail-id>.png
// Run: node tools/generate-og-images.js

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'images', 'og');

const W = 1200;
const H = 630;

const TRAILS = [
  {
    id:      'hub',
    logo:    'TrailTemps_Logo.png',
    out:     'og-hub.png',
    line1:   'TrailTemps — National Scenic Trail',
    line2:   'Weather Planner and Best Start Date Calculator',
    whiteBg: true,
  },
  { id: 'appalachian-trail',        logo: 'ANSTLogo.png',                        out: 'og-appalachian-trail.png'        },
  { id: 'arizona-trail',            logo: 'Arizona_trail_logo_transparent.png',  out: 'og-arizona-trail.png'            },
  { id: 'continental-divide-trail', logo: 'ContinentalDivideTrailLogo.png',      out: 'og-continental-divide-trail.png' },
  { id: 'florida-trail',            logo: 'Florida_Trail.png',                   out: 'og-florida-trail.png',           whiteBg: true },
  { id: 'ice-age-trail',            logo: 'ice_age_trail_logo.jpg',              out: 'og-ice-age-trail.png',           whiteBg: true },
  { id: 'natchez-trace-trail',      logo: 'natchez_trace_logo.jpg',              out: 'og-natchez-trace-trail.png',     whiteBg: true },
  { id: 'new-england-trail',        logo: 'new_england_trail-logo.png',          out: 'og-new-england-trail.png'        },
  { id: 'north-country-trail',      logo: 'north_country_trail_logo.jpeg',       out: 'og-north-country-trail.png',     whiteBg: true },
  { id: 'pacific-crest-trail',      logo: 'Pct-logo.svg.png',                   out: 'og-pacific-crest-trail.png',     whiteBg: true },
  { id: 'pacific-northwest-trail',  logo: 'pacific_northwest_trail_logo.webp',  out: 'og-pacific-northwest-trail.png'  },
  { id: 'potomac-heritage-trail',   logo: 'potomac_trail_logo.png',             out: 'og-potomac-heritage-trail.png'   },
];

const DEFAULT_LINE1 = 'TrailTemps Weather Planner';
const DEFAULT_LINE2 = 'and Best Start Date Calculator';

async function generateImage(trail) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  if (trail.whiteBg) {
    // Plain white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  } else {
    // Dark forest green gradient
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#1a3d1a');
    bg.addColorStop(1, '#2d6a2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle vignette
    const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.85);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }

  // Logo — centered
  const logo = await loadImage(path.join(ROOT, 'images', trail.logo));
  const logoMaxH = 340;
  const logoMaxW = 500;
  const scale = Math.min(logoMaxW / logo.width, logoMaxH / logo.height);
  const logoW = logo.width * scale;
  const logoH = logo.height * scale;
  const logoX = (W - logoW) / 2;
  const logoY = 80;
  ctx.drawImage(logo, logoX, logoY, logoW, logoH);

  // Divider line
  ctx.strokeStyle = trail.whiteBg ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  const lineY = logoY + logoH + 28;
  ctx.beginPath();
  ctx.moveTo(W * 0.25, lineY);
  ctx.lineTo(W * 0.75, lineY);
  ctx.stroke();

  // Text
  const line1 = trail.line1 || DEFAULT_LINE1;
  const line2 = trail.line2 || DEFAULT_LINE2;

  ctx.fillStyle = trail.whiteBg ? '#1a3d1a' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText(line1, W / 2, lineY + 22);
  ctx.fillText(line2, W / 2, lineY + 86);

  const outPath = path.join(OUT_DIR, trail.out);
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`  ✓  ${trail.out}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${TRAILS.length} OG images → images/og/\n`);
  for (const trail of TRAILS) {
    await generateImage(trail);
  }
  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
