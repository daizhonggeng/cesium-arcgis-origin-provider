import assert from "node:assert/strict";
import test from "node:test";
import { ImageryProvider, Rectangle, Request, Resource } from "cesium";
import ArcGisOffsetImageryProvider from "../src/ArcGisOffsetImageryProvider.js";
import { makeMetadata } from "./fixtures/metadata.js";

const SERVICE = "https://example.invalid/arcgis/rest/services/offset/MapServer";

function provider(metadata = makeMetadata(), options = {}) {
  return ArcGisOffsetImageryProvider.fromMetadata(SERVICE, metadata, options);
}

test("provider exposes the original image size, padded grid and legal display extent", () => {
  const imagery = provider();
  assert.equal(imagery.ready, true);
  assert.equal(imagery.tileWidth, 256);
  assert.equal(imagery.tileHeight, 256);
  assert.equal(imagery.minimumLevel, 0);
  assert.equal(imagery.maximumLevel, 6);
  assert.equal(imagery.usingPrecachedTiles, true);
  assert.equal(imagery.hasAlphaChannel, true);
  assert.equal(imagery.rectangle.west, -Math.PI);
  assert.equal(imagery.rectangle.east, Math.PI);
  assert.equal(imagery.rectangle.south, -Math.PI / 2);
  assert.equal(imagery.rectangle.north, Math.PI / 2);
  assert.ok(imagery.tilingScheme.rectangle.north > Math.PI / 2);
  assert.equal(typeof imagery.errorEvent.addEventListener, "function");
  assert.equal(imagery.pickFeatures(0, 0, 0, 0, 0), undefined);
});

test("fullExtent and an explicit rectangle limit display without changing source UVs", () => {
  const metadata = makeMetadata();
  Object.assign(metadata.fullExtent, { xmin: 100, ymin: 20, xmax: 120, ymax: 40 });
  const imagery = provider(metadata);
  assert.ok(Rectangle.equalsEpsilon(imagery.rectangle, Rectangle.fromDegrees(100, 20, 120, 40), 1e-12));
  const rect = imagery.tilingScheme.tileXYToNativeRectangle(2, 2, 0);
  assert.equal(rect.west, -40);
  assert.equal(rect.south, -140);
  const restricted = provider(makeMetadata(), { rectangle: Rectangle.fromDegrees(105, 25, 115, 35) });
  assert.ok(Rectangle.equalsEpsilon(restricted.rectangle, Rectangle.fromDegrees(105, 25, 115, 35), 1e-12));
});

test("requestImage loads exactly one original service image and returns it unchanged", async () => {
  const original = ImageryProvider.loadImage;
  const request = new Request();
  const sentinel = Promise.resolve({ sourceImage: true });
  const calls = [];
  ImageryProvider.loadImage = (owner, resource) => {
    calls.push({ owner, resource });
    return sentinel;
  };
  try {
    const imagery = provider(makeMetadata(), { token: "unit-test-token" });
    const actual = imagery.requestImage(5, 4, 1, request);
    assert.equal(actual, sentinel, "no intermediate canvas, image or promise should replace the source result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].owner, imagery);
    assert.equal(calls[0].resource.request, request);
    const url = new URL(calls[0].resource.url);
    assert.equal(url.pathname, "/arcgis/rest/services/offset/MapServer/tile/1/4/5");
    assert.equal(url.searchParams.get("token"), "unit-test-token");
    assert.deepEqual(await actual, { sourceImage: true });
  } finally {
    ImageryProvider.loadImage = original;
  }
});

test("ArcGIS LOD labels are mapped separately from Cesium's zero-based level index", () => {
  const original = ImageryProvider.loadImage;
  const metadata = makeMetadata();
  for (const lod of metadata.tileInfo.lods) lod.level += 5;
  const calls = [];
  ImageryProvider.loadImage = (_owner, resource) => { calls.push(resource.url); return undefined; };
  try {
    const imagery = provider(metadata);
    assert.equal(imagery.requestImage(2, 2, 0), undefined, "scheduler deferrals must pass through");
    assert.equal(new URL(calls[0]).pathname, "/arcgis/rest/services/offset/MapServer/tile/5/2/2");
    imagery.requestImage(5, 4, 1);
    assert.equal(new URL(calls[1]).pathname, "/arcgis/rest/services/offset/MapServer/tile/6/4/5");
    assert.equal(calls.length, 2);
  } finally {
    ImageryProvider.loadImage = original;
  }
});

test("minimumLevel selects imagery LODs but does not block lower-resolution parent fallback", () => {
  const original = ImageryProvider.loadImage;
  const calls = [];
  ImageryProvider.loadImage = (_owner, resource) => { calls.push(resource.url); return undefined; };
  try {
    const imagery = provider(makeMetadata(), { minimumLevel: 2 });
    assert.equal(imagery.minimumLevel, 2);
    imagery.requestImage(2, 2, 0);
    assert.equal(new URL(calls[0]).pathname, "/arcgis/rest/services/offset/MapServer/tile/0/2/2");
  } finally {
    ImageryProvider.loadImage = original;
  }
});

test("fromUrl reads metadata once, preserves query credentials, and supports service URLs ending in slash", async () => {
  const original = Resource.prototype.fetchJson;
  const calls = [];
  Resource.prototype.fetchJson = function () { calls.push(this.url); return Promise.resolve(makeMetadata()); };
  try {
    const imagery = await ArcGisOffsetImageryProvider.fromUrl(`${SERVICE}/?token=query-test-token`);
    assert.equal(imagery.tileWidth, 256);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("f"), "pjson");
    assert.equal(url.searchParams.get("token"), "query-test-token");
  } finally {
    Resource.prototype.fetchJson = original;
  }
});

test("provider rejects dynamic/export services and incompatible projections or resolutions", () => {
  const missing = makeMetadata();
  delete missing.tileInfo;
  assert.throws(() => provider(missing));
  assert.throws(() => provider(makeMetadata({ wkid: 3857 })));
  const irregular = makeMetadata();
  irregular.tileInfo.lods[3].resolution *= 1.25;
  assert.throws(() => provider(irregular));
});
