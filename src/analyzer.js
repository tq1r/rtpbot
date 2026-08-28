/**
 * Grid Analyzer & Gold Zone Detector
 * Improved: cluster detection, better stats, prioritized gold zones
 */

const fs = require('fs');
const path = require('path');

class GridAnalyzer {
  constructor(config) {
    this.worldBorder = config.worldBorder;
    this.cellSize = config.goldZone?.cellSize || 5000;
    this.thresholdPercentile = config.goldZone?.thresholdPercentile || 10;
    this.smoothing = config.goldZone?.smoothing !== false;
    this.gridSize = Math.ceil((this.worldBorder * 2) / this.cellSize);
    this.grid = [];
    this.smoothedGrid = null;
    this.goldZones = [];
    this.clusters = [];
    this.threshold = 0;
    this.stats = {};
  }

  loadCoords(filePath) {
    const full = path.resolve(__dirname, '..', filePath);
    if (!fs.existsSync(full)) throw new Error(`No data found: ${full}`);
    const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    // Validate coords
    return data.filter(c =>
      c && typeof c.x === 'number' && typeof c.z === 'number' &&
      isFinite(c.x) && isFinite(c.z)
    );
  }

  buildGrid(coords) {
    this.grid = Array.from({ length: this.gridSize }, () =>
      Array.from({ length: this.gridSize }, () => 0)
    );
    let outOfBounds = 0;
    for (const c of coords) {
      const col = Math.floor((c.x + this.worldBorder) / this.cellSize);
      const row = Math.floor((c.z + this.worldBorder) / this.cellSize);
      if (col >= 0 && col < this.gridSize && row >= 0 && row < this.gridSize) {
        this.grid[row][col]++;
      } else {
        outOfBounds++;
      }
    }
    if (outOfBounds > 0) {
      console.log(`[Analyzer] ${outOfBounds} coords outside world border, skipped`);
    }
    return this.grid;
  }

  applySmoothing(sigma = 1.2) {
    if (!this.smoothing) { this.smoothedGrid = this.grid; return this.grid; }
    const size = Math.ceil(sigma * 3) * 2 + 1;
    const kernel = [];
    let kSum = 0;
    const half = Math.floor(size / 2);
    for (let i = -half; i <= half; i++) {
      kernel[i + half] = [];
      for (let j = -half; j <= half; j++) {
        const v = Math.exp(-(i * i + j * j) / (2 * sigma * sigma));
        kernel[i + half][j + half] = v;
        kSum += v;
      }
    }
    for (let i = 0; i < size; i++)
      for (let j = 0; j < size; j++)
        kernel[i][j] /= kSum;

    const s = Array.from({ length: this.gridSize }, () =>
      Array.from({ length: this.gridSize }, () => 0)
    );
    for (let r = 0; r < this.gridSize; r++) {
      for (let c = 0; c < this.gridSize; c++) {
        let sum = 0;
        for (let kr = 0; kr < size; kr++) {
          for (let kc = 0; kc < size; kc++) {
            const gr = r + kr - half, gc = c + kc - half;
            if (gr >= 0 && gr < this.gridSize && gc >= 0 && gc < this.gridSize) {
              sum += this.grid[gr][gc] * kernel[kr][kc];
            }
          }
        }
        s[r][c] = sum;
      }
    }
    this.smoothedGrid = s;
    return s;
  }

  findGoldZones() {
    const dataGrid = this.smoothedGrid || this.grid;
    const allVals = [];
    for (let r = 0; r < this.gridSize; r++)
      for (let c = 0; c < this.gridSize; c++)
        allVals.push(dataGrid[r][c]);
    allVals.sort((a, b) => a - b);
    const ti = Math.floor(allVals.length * (this.thresholdPercentile / 100));
    this.threshold = allVals[ti];

    const goldSet = new Set();
    this.goldZones = [];
    for (let r = 0; r < this.gridSize; r++) {
      for (let c = 0; c < this.gridSize; c++) {
        if (this.grid[r][c] <= this.threshold) {
          const idx = r * this.gridSize + c;
          goldSet.add(idx);
          this.goldZones.push({
            row: r, col: c,
            x: c * this.cellSize - this.worldBorder + this.cellSize / 2,
            z: r * this.cellSize - this.worldBorder + this.cellSize / 2,
            count: this.grid[r][c]
          });
        }
      }
    }

    // Find clusters of adjacent gold zones (flood fill)
    this.clusters = this.findClusters(goldSet);
    return this.goldZones;
  }

  /**
   * Flood-fill to find connected clusters of gold zone cells
   * Returns clusters sorted by size (largest first) - biggest unexplored areas
   */
  findClusters(goldSet) {
    const visited = new Set();
    const clusters = [];

    for (const idx of goldSet) {
      if (visited.has(idx)) continue;

      // BFS flood fill
      const cluster = { cells: [], size: 0, centerX: 0, centerZ: 0 };
      const queue = [idx];
      visited.add(idx);

      while (queue.length > 0) {
        const current = queue.shift();
        const r = Math.floor(current / this.gridSize);
        const c = current % this.gridSize;

        cluster.cells.push({ row: r, col: c });
        cluster.size++;
        cluster.centerX += c * this.cellSize - this.worldBorder + this.cellSize / 2;
        cluster.centerZ += r * this.cellSize - this.worldBorder + this.cellSize / 2;

        // Check 4 adjacent neighbors
        const neighbors = [
          (r - 1) * this.gridSize + c, // up
          (r + 1) * this.gridSize + c, // down
          r * this.gridSize + (c - 1), // left
          r * this.gridSize + (c + 1), // right
        ];
        for (const n of neighbors) {
          if (!visited.has(n) && goldSet.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }

      // Calculate cluster center
      cluster.centerX /= cluster.size;
      cluster.centerZ /= cluster.size;
      clusters.push(cluster);
    }

    // Sort by size descending (biggest clusters first = best hiding spots)
    clusters.sort((a, b) => b.size - a.size);
    return clusters;
  }

  /**
   * Check if a coordinate is in a gold zone
   */
  isGoldZone(x, z) {
    const col = Math.floor((x + this.worldBorder) / this.cellSize);
    const row = Math.floor((z + this.worldBorder) / this.cellSize);
    if (col < 0 || col >= this.gridSize || row < 0 || row >= this.gridSize) return false;
    return this.grid[row][col] <= this.threshold;
  }

  /**
   * Get the largest gold zone cluster center (best target for searching)
   */
  getBestGoldZone() {
    if (this.clusters.length === 0) return null;
    const best = this.clusters[0];
    return { x: best.centerX, z: best.centerZ, clusterSize: best.size };
  }

  /**
   * Get top N gold zone clusters
   */
  getTopClusters(n = 5) {
    return this.clusters.slice(0, n).map(c => ({
      x: c.centerX, z: c.centerZ,
      size: c.size,
      sizeInBlocks: c.size * this.cellSize * this.cellSize
    }));
  }

  calculateStats(totalCoords) {
    let maxCount = 0, maxCell = null, occupied = 0, empty = 0;
    let sumAll = 0;
    for (let r = 0; r < this.gridSize; r++) {
      for (let c = 0; c < this.gridSize; c++) {
        const v = this.grid[r][c];
        sumAll += v;
        if (v > maxCount) { maxCount = v; maxCell = { row: r, col: c }; }
        if (v > 0) occupied++; else empty++;
      }
    }
    const mean = sumAll / (this.gridSize * this.gridSize);

    this.stats = {
      totalCoords,
      gridSize: this.gridSize,
      cellSize: this.cellSize,
      totalCells: this.gridSize * this.gridSize,
      occupiedCells: occupied,
      emptyCells: empty,
      maxCount,
      mean: mean.toFixed(2),
      threshold: this.threshold,
      goldZoneCount: this.goldZones.length,
      goldZonePercent: ((this.goldZones.length / (this.gridSize * this.gridSize)) * 100).toFixed(1),
      clusterCount: this.clusters.length,
      largestClusterSize: this.clusters.length > 0 ? this.clusters[0].size : 0,
      largestClusterBlocks: this.clusters.length > 0 ? this.clusters[0].size * this.cellSize * this.cellSize : 0,
      maxCellWorld: maxCell ? {
        x: maxCell.col * this.cellSize - this.worldBorder + this.cellSize / 2,
        z: maxCell.row * this.cellSize - this.worldBorder + this.cellSize / 2
      } : null
    };
    return this.stats;
  }

  analyze(coordsFilePath) {
    const coords = this.loadCoords(coordsFilePath);
    console.log(`[Analyzer] Loaded ${coords.length} valid coordinates`);
    this.buildGrid(coords);
    this.applySmoothing();
    this.findGoldZones();
    this.calculateStats(coords.length);

    const topClusters = this.getTopClusters(5);
    const results = {
      timestamp: new Date().toISOString(),
      config: { worldBorder: this.worldBorder, cellSize: this.cellSize, thresholdPercentile: this.thresholdPercentile },
      stats: this.stats,
      goldZones: this.goldZones.map(z => ({ x: z.x, z: z.z, count: z.count })),
      topClusters,
      threshold: this.threshold
    };
    const rp = path.resolve(__dirname, '..', 'data', 'analysis-results.json');
    fs.writeFileSync(rp, JSON.stringify(results, null, 2));

    return { grid: this.grid, smoothedGrid: this.smoothedGrid, goldZones: this.goldZones, clusters: this.clusters, stats: this.stats, threshold: this.threshold };
  }
}

module.exports = GridAnalyzer;
