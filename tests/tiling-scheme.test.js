import assert from "node:assert/strict";
import test from "node:test";
import {
  Cartesian2,
  Cartographic,
  Ellipsoid,
  Math as CesiumMath,
  Rectangle,
} from "cesium";
import OffsetGeographicTilingScheme from "../src/OffsetGeographicTilingScheme.js";
import { makeMetadata } from "./fixtures/metadata.js";

function scheme(tileInfo = makeMetadata().tileInfo) {
  return new OffsetGeographicTilingScheme({ tileInfo });
}

function close(actual, expected, message = "", tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

function rectClose(actual, expected, factor = 1) {
  for (const name of ["west", "south", "east", "north"]) {
    close(actual[name], expected[name] * factor, name);
  }
}

test("offset roots cover the world and preserve the original cache grid", () => {
  const grid = scheme();
  assert.equal(grid.getNumberOfXTilesAtLevel(0), 4);
  assert.equal(grid.getNumberOfYTilesAtLevel(0), 3);
  rectClose(grid.rectangle, { west: -400, south: -140, east: 320, north: 400 }, CesiumMath.RADIANS_PER_DEGREE);
  assert.ok(grid.rectangle.west <= -Math.PI);
  assert.ok(grid.rectangle.east >= Math.PI);
  assert.ok(grid.rectangle.south <= -Math.PI / 2);
  assert.ok(grid.rectangle.north >= Math.PI / 2);
  assert.ok(grid.ellipsoid.equals(Ellipsoid.WGS84));
});

test("geographic coordinates map to the actual ArcGIS column and row", () => {
  const grid = scheme();
  const samples = [
    [0, 0, 0, 2, 2],
    [116.4, 39.9, 0, 2, 2],
    [116.4, 39.9, 1, 5, 4],
    [-180, 90, 0, 1, 1],
    [180, -90, 0, 3, 2],
    [-179.9, -89.9, 6, 78, 174],
  ];
  for (const [longitude, latitude, level, x, y] of samples) {
    const actual = grid.positionToTileXY(Cartographic.fromDegrees(longitude, latitude), level);
    assert.deepEqual([actual.x, actual.y], [x, y], `lon=${longitude}, lat=${latitude}, level=${level}`);
  }
});

test("all sampled locations retain quadtree parents across levels", () => {
  const grid = scheme();
  for (let longitude = -179; longitude <= 179; longitude += 13) {
    for (let latitude = -89; latitude <= 89; latitude += 11) {
      const position = Cartographic.fromDegrees(longitude, latitude);
      for (let level = 1; level <= 6; level += 1) {
        const child = grid.positionToTileXY(position, level);
        const parent = grid.positionToTileXY(position, level - 1);
        assert.equal(Math.floor(child.x / 2), parent.x);
        assert.equal(Math.floor(child.y / 2), parent.y);
        assert.ok(child.x >= 0 && child.x < grid.getNumberOfXTilesAtLevel(level));
        assert.ok(child.y >= 0 && child.y < grid.getNumberOfYTilesAtLevel(level));
      }
    }
  }
});

test("raw tile rectangles retain out-of-world pixels instead of stretching a clipped image", () => {
  const grid = scheme();
  const expected = { west: -40, south: -140, east: 140, north: 40 };
  rectClose(grid.tileXYToNativeRectangle(2, 2, 0), expected);
  rectClose(grid.tileXYToRectangle(2, 2, 0), expected, CesiumMath.RADIANS_PER_DEGREE);
  const polar = grid.tileXYToNativeRectangle(1, 1, 0);
  rectClose(polar, { west: -220, south: 40, east: -40, north: 220 });
  // Parent bounds are exactly the union of four children, even at the poles.
  const children = [[2, 2], [3, 2], [2, 3], [3, 3]].map(([x, y]) => grid.tileXYToNativeRectangle(x, y, 1));
  rectClose({
    west: Math.min(...children.map((r) => r.west)),
    south: Math.min(...children.map((r) => r.south)),
    east: Math.max(...children.map((r) => r.east)),
    north: Math.max(...children.map((r) => r.north)),
  }, polar);
});

test("level pixel spans match ArcGIS resolutions and reusable result objects work", () => {
  const metadata = makeMetadata();
  const grid = scheme(metadata.tileInfo);
  const tileResult = new Cartesian2();
  const rectResult = new Rectangle();
  assert.equal(grid.positionToTileXY(Cartographic.fromDegrees(120, 30), 4, tileResult), tileResult);
  assert.equal(grid.tileXYToNativeRectangle(46, 32, 4, rectResult), rectResult);
  for (let level = 0; level <= 6; level += 1) {
    const tile = grid.tileXYToNativeRectangle(0, 0, level);
    close(tile.east - tile.west, metadata.tileInfo.cols * metadata.tileInfo.lods[level].resolution);
    close(tile.north - tile.south, metadata.tileInfo.rows * metadata.tileInfo.lods[level].resolution);
    assert.equal(grid.getNumberOfXTilesAtLevel(level), 4 * 2 ** level);
    assert.equal(grid.getNumberOfYTilesAtLevel(level), 3 * 2 ** level);
  }
});

test("native rectangles use degrees, projected cartographic rectangles use radians", () => {
  const grid = scheme();
  const radians = Rectangle.fromDegrees(100, 20, 120, 40);
  rectClose(grid.rectangleToNativeRectangle(radians), { west: 100, south: 20, east: 120, north: 40 });
});

test("standard origin remains compatible with the normal two-by-one root layout", () => {
  const grid = scheme(makeMetadata({ origin: { x: -180, y: 90 } }).tileInfo);
  assert.equal(grid.getNumberOfXTilesAtLevel(0), 2);
  assert.equal(grid.getNumberOfYTilesAtLevel(0), 1);
  rectClose(grid.rectangle, { west: -180, south: -90, east: 180, north: 90 }, CesiumMath.RADIANS_PER_DEGREE);
});

test("constructor rejects cache grids that cannot retain Cesium parent-child relationships", () => {
  const invalid = [
    (info) => { info.lods[2].resolution *= 1.1; },
    (info) => { info.rows = 0; },
    (info) => { info.cols = -256; },
    (info) => { info.origin.x = Number.NaN; },
    (info) => { info.spatialReference.wkid = 3857; },
    (info) => { info.lods = []; },
  ];
  for (const mutate of invalid) {
    const info = makeMetadata().tileInfo;
    mutate(info);
    assert.throws(() => scheme(info));
  }
});
