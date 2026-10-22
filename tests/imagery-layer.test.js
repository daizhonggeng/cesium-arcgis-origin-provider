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
