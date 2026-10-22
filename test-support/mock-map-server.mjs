import { PNG } from "pngjs";

// Diagnostic example only: this mock cache uses (-400, 400). The real Provider
// reads the service origin and supports x <= -180 AND y >= 90 (degrees),
// subject to the WKID, LOD and other constraints documented in README.md.
export function metadata() {
  return {
    currentVersion: 11.3,
    singleFusedMapCache: true,
    mapName: "Offset origin diagnostic cache",
    copyrightText: "Synthetic diagnostic tiles — no external map data",
    spatialReference: { wkid: 4326 },
    fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90, spatialReference: { wkid: 4326 } },
    tileInfo: {
      rows: 256, cols: 256, dpi: 96, format: "PNG32",
      origin: { x: -400, y: 400 }, spatialReference: { wkid: 4326 },
      lods: Array.from({ length: 15 }, (_, level) => ({ level, resolution: 0.703125 / 2 ** level, scale: 295497593.05875003 / 2 ** level })),
    },
  };
}

// Analytic coordinate colors make image positioning testable in a real WebGL
// render. Source tiles remain ordinary independent PNG images served by HTTP.
export function coordinateColor(longitude, latitude) {
  const r = Math.round(35 + 180 * Math.max(0, Math.min(1, (longitude + 180) / 360)));
  const g = Math.round(35 + 180 * Math.max(0, Math.min(1, (latitude + 90) / 180)));
  return [r, g, 145];
}

const tileCache = new Map();
function makeTile(level, row, col) {
  const key = `${level}/${row}/${col}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const resolution = 0.703125 / 2 ** level;
  const west = -400 + col * 256 * resolution;
  const north = 400 - row * 256 * resolution;
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const longitude = west + (x + 0.5) * resolution;
      const latitude = north - (y + 0.5) * resolution;
      const index = (y * 256 + x) * 4;
      let color = coordinateColor(longitude, latitude);
      // Black native tile boundaries expose seams and parent-grid errors.
      if (x === 0 || y === 0 || x === 255 || y === 255) color = [18, 22, 30];
      png.data[index] = color[0];
      png.data[index + 1] = color[1];
      png.data[index + 2] = color[2];
      png.data[index + 3] = 255;
    }
  }
  const data = PNG.sync.write(png);
  if (tileCache.size > 1024) tileCache.clear();
  tileCache.set(key, data);
  return data;
}

export function mockMapServerMiddleware(req, res, next) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/mock/MapServer")) return next();
  res.setHeader("Cache-Control", "no-store");
  if (/^\/mock\/MapServer\/?$/.test(url.pathname)) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(metadata()));
    return;
  }
  const match = url.pathname.match(/^\/mock\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  if (!match) { res.statusCode = 404; res.end("Unknown mock resource"); return; }
  const [, levelText, rowText, colText] = match;
  const [level, row, col] = [levelText, rowText, colText].map(Number);
  if (level > 14 || col >= 4 * 2 ** level || row >= 3 * 2 ** level) {
    res.statusCode = 404; res.end("Tile outside the source grid"); return;
  }
  res.setHeader("Content-Type", "image/png");
  res.end(makeTile(level, row, col));
}
