import assert from "node:assert/strict";
import test from "node:test";
import { ImageryLayer, Math as CesiumMath, Rectangle } from "cesium";
import ArcGisOffsetImageryProvider from "../src/ArcGisOffsetImageryProvider.js";
import { makeMetadata } from "./fixtures/metadata.js";

const forceRootLOD = { getLevelMaximumGeometricError: () => 1e10 };

function terrain(west, south, east, north) {
  return { level: 0, rectangle: Rectangle.fromDegrees(west, south, east, north), data: { imagery: [] } };
}

function createLayer() {
  return new ImageryLayer(ArcGisOffsetImageryProvider.fromMetadata(
    "https://example.invalid/MapServer",
    makeMetadata(),
  ));
}

function close(actual, expected, message = "") {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} != ${expected}`);
}

function free(tile) {
  for (const mapping of tile.data.imagery) mapping.freeResources();
}

// These tests intentionally call Cesium's real ImageryLayer implementation.
// A numerically correct grid alone cannot prove that Cesium accepts its padded
// bounds or that clipping retains the source image's texture coordinates.
test("real Cesium maps four unmodified source images over each world terrain root", () => {
  const layer = createLayer();
  const west = terrain(-180, -90, 0, 90);
  const east = terrain(0, -90, 180, 90);
  try {
    for (const tile of [west, east]) {
      assert.equal(layer._createTileImagerySkeletons(tile, forceRootLOD), true);
      assert.equal(tile.data.imagery.length, 4);
      let area = 0;
      for (const mapping of tile.data.imagery) {
        const image = mapping.loadingImagery;
        assert.equal(image.level, 0);
        const textureBounds = mapping.textureCoordinateRectangle;
        // Cesium can leave texture bounds outside a terrain tile's [0,1]
        // interval. Only their intersection with actual terrain is rendered.
        const rect = {
          x: Math.max(0, textureBounds.x),
          y: Math.max(0, textureBounds.y),
          z: Math.min(1, textureBounds.z),
          w: Math.min(1, textureBounds.w),
        };
        assert.ok(rect.z > rect.x && rect.w > rect.y);
        area += (rect.z - rect.x) * (rect.w - rect.y);
        const transform = layer._calculateTextureTranslationAndScale(tile, {
          readyImagery: image,
          useWebMercatorT: mapping.useWebMercatorT,
        });
        for (const u of [rect.x, rect.z]) {
          for (const v of [rect.y, rect.w]) {
            const sourceU = transform.x + u * transform.z;
            const sourceV = transform.y + v * transform.w;
            const longitude = tile.rectangle.west + u * tile.rectangle.width;
            const latitude = tile.rectangle.south + v * tile.rectangle.height;
            close(sourceU, (longitude - image.rectangle.west) / image.rectangle.width, "source u");
            close(sourceV, (latitude - image.rectangle.south) / image.rectangle.height, "source v");
            assert.ok(sourceU >= -1e-12 && sourceU <= 1 + 1e-12);
            assert.ok(sourceV >= -1e-12 && sourceV <= 1 + 1e-12);
          }
        }
      }
      close(area, 1, "imagery partitions cover the complete terrain rectangle");
    }
    assert.deepEqual(west.data.imagery.map((m) => [m.loadingImagery.x, m.loadingImagery.y]), [[1, 1], [1, 2], [2, 1], [2, 2]]);
    assert.deepEqual(east.data.imagery.map((m) => [m.loadingImagery.x, m.loadingImagery.y]), [[2, 1], [2, 2], [3, 1], [3, 2]]);
    assert.equal(west.data.imagery[2].loadingImagery, east.data.imagery[0].loadingImagery,
      "adjacent terrain tiles must reuse Cesium's cached source imagery");
  } finally {
    free(west);
    free(east);
    layer.destroy();
  }
});

test("polar and dateline clipping keeps the original oversized image UV range", () => {
  const layer = createLayer();
  const tile = terrain(170, 80, 180, 90);
  try {
    assert.equal(layer._createTileImagerySkeletons(tile, forceRootLOD), true);
    assert.equal(tile.data.imagery.length, 1);
    const mapping = tile.data.imagery[0];
    const image = mapping.loadingImagery;
    assert.deepEqual([image.x, image.y, image.level], [3, 1, 0]);
    close(image.rectangle.east * CesiumMath.DEGREES_PER_RADIAN, 320);
    close(image.rectangle.north * CesiumMath.DEGREES_PER_RADIAN, 220);
    const transform = layer._calculateTextureTranslationAndScale(tile, { readyImagery: image, useWebMercatorT: false });
    close(transform.x + 0.5 * transform.z, (175 - 140) / 180);
    close(transform.y + 0.5 * transform.w, (85 - 40) / 180);
    assert.ok(transform.z < 1 && transform.w < 1, "source pixels outside the legal world remain outside the sampled texture region");
  } finally {
    free(tile);
    layer.destroy();
  }
});

test("Cesium selects the same imagery resolution as a standard-origin cache", () => {
  const offset = createLayer();
  const standard = new ImageryLayer(ArcGisOffsetImageryProvider.fromMetadata(
    "https://example.invalid/MapServer",
    makeMetadata({ origin: { x: -180, y: 90 } }),
  ));
  try {
    for (const error of [50000, 10000, 2000]) {
      const a = terrain(112, 27, 118, 33);
      const b = terrain(112, 27, 118, 33);
      try {
        const terrainProvider = { getLevelMaximumGeometricError: () => error };
        offset._createTileImagerySkeletons(a, terrainProvider);
        standard._createTileImagerySkeletons(b, terrainProvider);
        assert.ok(a.data.imagery.length > 0 && b.data.imagery.length > 0);
        const offsetLevels = [...new Set(a.data.imagery.map((m) => m.loadingImagery.level))];
        const standardLevels = [...new Set(b.data.imagery.map((m) => m.loadingImagery.level))];
        assert.deepEqual(offsetLevels, standardLevels, `terrain error ${error}`);
      } finally {
        free(a);
        free(b);
      }
    }
  } finally {
    offset.destroy();
    standard.destroy();
  }
});

test("higher LODs and fractional origins preserve full coverage and source UVs", () => {
  for (const origin of [{ x: -400, y: 400 }, { x: -400.1, y: 400.1 }]) {
    const provider = ArcGisOffsetImageryProvider.fromMetadata(
      "https://example.invalid/MapServer", makeMetadata({ origin }),
    );
    const layer = new ImageryLayer(provider);
    try {
      for (const level of [0, 2, 6]) {
        const span = 180 / 2 ** level;
        const columns = 2 ** (level + 1);
        const rows = 2 ** level;
        // The corner tiles exercise both sides of the date line and both poles.
        const coordinates = [[0, 0], [columns - 1, 0], [0, rows - 1], [columns - 1, rows - 1]];
        for (const [x, y] of coordinates) {
          const tile = terrain(-180 + x * span, 90 - (y + 1) * span, -180 + (x + 1) * span, 90 - y * span);
          tile.level = level;
          // Select this exact imagery LOD through Cesium's real LOD calculation.
          const error = provider.tilingScheme.ellipsoid.maximumRadius * Math.PI / provider.tileWidth / 2 ** level;
          try {
            layer._createTileImagerySkeletons(tile, { getLevelMaximumGeometricError: () => error });
            let area = 0;
            for (const mapping of tile.data.imagery) {
              const image = mapping.loadingImagery;
              assert.equal(image.level, level);
              const r = mapping.textureCoordinateRectangle;
              const west = Math.max(0, r.x), south = Math.max(0, r.y);
              const east = Math.min(1, r.z), north = Math.min(1, r.w);
              assert.ok(east > west && north > south);
              area += (east - west) * (north - south);
              const transform = layer._calculateTextureTranslationAndScale(tile, {
                readyImagery: image, useWebMercatorT: false,
              });
              for (const u of [west, east]) {
                for (const v of [south, north]) {
                  const sourceU = transform.x + u * transform.z;
                  const sourceV = transform.y + v * transform.w;
                  const longitude = tile.rectangle.west + u * tile.rectangle.width;
                  const latitude = tile.rectangle.south + v * tile.rectangle.height;
                  close(sourceU, (longitude - image.rectangle.west) / image.rectangle.width);
                  close(sourceV, (latitude - image.rectangle.south) / image.rectangle.height);
                  assert.ok(sourceU >= -1e-10 && sourceU <= 1 + 1e-10);
                  assert.ok(sourceV >= -1e-10 && sourceV <= 1 + 1e-10);
                }
              }
            }
            close(area, 1, `coverage for origin=${origin.x}, level=${level}, x=${x}, y=${y}`);
          } finally {
            free(tile);
          }
        }
      }
    } finally {
      layer.destroy();
    }
  }
});

test("a regional overlay clips to fullExtent while keeping original source UVs", () => {
  const metadata = makeMetadata();
  metadata.fullExtent = { xmin: 110, ymin: 20, xmax: 120, ymax: 30, spatialReference: { wkid: 4326 } };
  const layer = new ImageryLayer(ArcGisOffsetImageryProvider.fromMetadata(
    "https://example.invalid/MapServer", metadata,
  ));
  const overlapping = terrain(100, 10, 125, 35);
  const outside = terrain(-180, -90, 0, 90);
  try {
    assert.equal(layer.isBaseLayer(), false);
    assert.equal(layer._createTileImagerySkeletons(outside, forceRootLOD), false);
    assert.equal(outside.data.imagery.length, 0);
    assert.equal(layer._createTileImagerySkeletons(overlapping, forceRootLOD), true);
    assert.equal(overlapping.data.imagery.length, 1);
    const mapping = overlapping.data.imagery[0];
    const bounds = mapping.textureCoordinateRectangle;
    close(bounds.x, 10 / 25);
    close(bounds.y, 10 / 25);
    close(bounds.z, 20 / 25);
    close(bounds.w, 20 / 25);
    const transform = layer._calculateTextureTranslationAndScale(overlapping, {
      readyImagery: mapping.loadingImagery, useWebMercatorT: false,
    });
    // The source remains the full [-40,-140,140,40] image, including pixels
    // outside the regional display extent. The central point is (115,25).
    close(transform.x + 0.6 * transform.z, (115 + 40) / 180);
    close(transform.y + 0.6 * transform.w, (25 + 140) / 180);
  } finally {
    free(overlapping);
    free(outside);
    layer.destroy();
  }
});
