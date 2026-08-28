const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

class HeatmapGenerator {
  constructor(config) {
    this.worldBorder = config.worldBorder;
    this.cellSize = config.goldZone?.cellSize || 5000;
  }

  heatColor(t) {
    t = Math.min(Math.max(t, 0), 1);
    const stops = [
      { t: 0.0,  r: 8,   g: 8,   b: 30  },
      { t: 0.12, r: 20,  g: 40,  b: 90  },
      { t: 0.30, r: 0,   g: 150, b: 180 },
      { t: 0.50, r: 60,  g: 160, b: 60  },
      { t: 0.70, r: 230, g: 210, b: 40  },
      { t: 0.88, r: 230, g: 70,  b: 20  },
      { t: 1.0,  r: 220, g: 0,   b: 0   }
    ];
    let i = 0;
    for (i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i + 1].t) break;
    }
    const a = stops[i], b = stops[i + 1];
    const f = (t - a.t) / (b.t - a.t);
    return {
      r: Math.round(a.r + (b.r - a.r) * f),
      g: Math.round(a.g + (b.g - a.g) * f),
      b: Math.round(a.b + (b.b - a.b) * f)
    };
  }

  async generate(analysisResults) {
    const { grid, smoothedGrid, goldZones, stats, threshold } = analysisResults;
    const gs = grid.length;
    const imgSize = 2048;
    const cellPx = imgSize / gs;

    let maxVal = 0;
    for (let r = 0; r < gs; r++)
      for (let c = 0; c < gs; c++)
        if (smoothedGrid[r][c] > maxVal) maxVal = smoothedGrid[r][c];

    const goldSet = new Set();
    for (const gz of goldZones) goldSet.add(gz.row * gs + gz.col);

    const image = new Jimp(imgSize, imgSize, 0x08081EFF);

    // Draw heat cells
    for (let r = 0; r < gs; r++) {
      for (let c = 0; c < gs; c++) {
        const val = smoothedGrid[r][c];
        const t = maxVal > 0 ? val / maxVal : 0;
        const color = this.heatColor(t);
        const hex = 0xFF000000 | (color.b << 16) | (color.g << 8) | color.r;

        const x = Math.floor(c * cellPx);
        const y = Math.floor(r * cellPx);
        const w = Math.floor((c + 1) * cellPx) - x;
        const h = Math.floor((r + 1) * cellPx) - y;

        for (let py = y; py < y + h && py < imgSize; py++) {
          for (let px = x; px < x + w && px < imgSize; px++) {
            image.setPixelColor(hex, px, py);
          }
        }

        // Gold zone border (right and bottom edges of cell)
        if (goldSet.has(r * gs + c)) {
          const gold = 0xFF000000 | 0x00FFD700;
          for (let px = x; px < x + w && px < imgSize; px++) {
            if (y < imgSize) image.setPixelColor(gold, px, y);
            if (y + h - 1 < imgSize) image.setPixelColor(gold, px, y + h - 1);
          }
          for (let py = y; py < y + h && py < imgSize; py++) {
            if (x < imgSize) image.setPixelColor(gold, x, py);
            if (x + w - 1 < imgSize) image.setPixelColor(gold, x + w - 1, py);
          }
        }
      }
    }

    // Title bar background
    const barColor = 0xAA000000;
    for (let py = 0; py < 70; py++)
      for (let px = 0; px < imgSize; px++)
        image.setPixelColor(barColor, px, py);

    // Legend bar background
    for (let py = imgSize - 35; py < imgSize; py++)
      for (let px = 0; px < imgSize; px++)
        image.setPixelColor(barColor, px, py);

    // Legend gradient
    for (let px = 20; px < imgSize - 100; px++) {
      const t = px / (imgSize - 120);
      const c = this.heatColor(t);
      const hex = 0xFF000000 | (c.b << 16) | (c.g << 8) | c.r;
      for (let py = imgSize - 28; py < imgSize - 10; py++)
        image.setPixelColor(hex, px, py);
    }

    const buffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const outPath = path.resolve(__dirname, '..', 'data', 'heatmap.png');
    fs.writeFileSync(outPath, buffer);
    return Buffer.from(buffer);
  }
}

module.exports = HeatmapGenerator;
