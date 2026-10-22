import assert from "node:assert/strict";
import test from "node:test";
import { Credit, ImageryProvider, Rectangle, Request, Resource } from "cesium";
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

test("custom application credits preserve the service copyright", () => {
  const metadata = makeMetadata();
  metadata.copyrightText = "Source imagery copyright";
  const standard = provider(metadata);
  assert.equal(standard.credit.html, metadata.copyrightText);
  assert.equal(standard.getTileCredits(2, 2, 0), undefined);
  for (const credit of ["Application credit", new Credit("Application credit")]) {
    const custom = provider(metadata, { credit });
    assert.equal(custom.credit.html, "Application credit");
    assert.deepEqual(custom.getTileCredits(2, 2, 0).map((item) => item.html), [metadata.copyrightText]);
    if (credit instanceof Credit) assert.equal(custom.credit, credit);
  }
  assert.equal(provider(metadata, { credit: "" }).credit.html, metadata.copyrightText);
  delete metadata.copyrightText;
  const customOnly = provider(metadata, { credit: "Application credit" });
  assert.equal(customOnly.credit.html, "Application credit");
  assert.equal(customOnly.getTileCredits(2, 2, 0), undefined);
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

test("service-directory format parameters stay out of tile URLs without mutating authenticated Resources", async () => {
  const originalFetch = Resource.prototype.fetchJson;
  const originalLoad = ImageryProvider.loadImage;
  const metadataRequests = [];
  const tileRequests = [];
  Resource.prototype.fetchJson = function () {
    metadataRequests.push(this);
    return Promise.resolve(makeMetadata());
  };
  ImageryProvider.loadImage = (_owner, resource) => {
    tileRequests.push(resource);
    return undefined;
  };
  try {
    for (const format of ["json", "pjson", "html"]) {
      const proxy = { getURL: (url) => `/proxy?url=${encodeURIComponent(url)}` };
      const input = new Resource({
        url: `${SERVICE}?f=${format}&token=query-test-token&blankTile=false`,
        headers: { "X-Test-Authorization": "unit-test-header" },
        proxy,
      });
      const originalUrl = input.url;
      const imagery = await ArcGisOffsetImageryProvider.fromUrl(input);
      assert.equal(input.url, originalUrl, "normalization must not mutate the caller's Resource");
      assert.equal(input.queryParameters.f, format);
      const metadataResource = metadataRequests.at(-1);
      assert.equal(new URL(metadataResource.getUrlComponent(true, false)).searchParams.get("f"), "pjson");
      assert.equal(metadataResource.headers["X-Test-Authorization"], "unit-test-header");
      assert.equal(metadataResource.proxy, proxy);
      imagery.requestImage(2, 2, 0);
      const tileResource = tileRequests.at(-1);
      const tileUrl = new URL(tileResource.getUrlComponent(true, false));
      assert.equal(tileUrl.pathname, "/arcgis/rest/services/offset/MapServer/tile/0/2/2");
      assert.equal(tileUrl.searchParams.has("f"), false);
      assert.equal(tileUrl.searchParams.get("token"), "query-test-token");
      assert.equal(tileUrl.searchParams.get("blankTile"), "false");
      assert.equal(tileResource.headers["X-Test-Authorization"], "unit-test-header");
      assert.equal(tileResource.proxy, proxy);
    }
    const direct = ArcGisOffsetImageryProvider.fromMetadata(`${SERVICE}?F=pjson`, makeMetadata());
    direct.requestImage(2, 2, 0);
    assert.equal(new URL(tileRequests.at(-1).url).searchParams.has("F"), false);
  } finally {
    Resource.prototype.fetchJson = originalFetch;
    ImageryProvider.loadImage = originalLoad;
  }
});

test("metadata failures and invalid or empty coverage reject instead of producing an unusable layer", async () => {
  assert.throws(() => provider({ error: { code: 498, message: "Invalid token" } }), /Invalid token/);
  for (const fullExtent of [
    { xmin: 0, ymin: 0, xmax: NaN, ymax: 1 },
    { xmin: 10, ymin: 0, xmax: 0, ymax: 1 },
    { xmin: 0, ymin: 91, xmax: 1, ymax: 92 },
    { xmin: 0, ymin: 0, xmax: 1, ymax: 1, spatialReference: { wkid: 3857 } },
  ]) {
    assert.throws(() => provider({ ...makeMetadata(), fullExtent }), /fullExtent/);
  }
  const metadata = { ...makeMetadata(), fullExtent: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } };
  for (const rectangle of [Rectangle.fromDegrees(0, 1, 1, 2), Rectangle.fromDegrees(1, 0, 2, 1)]) {
    assert.throws(() => provider(metadata, { rectangle }), /does not intersect/);
  }
  const original = Resource.prototype.fetchJson;
  const networkError = new Error("Metadata request failed");
  Resource.prototype.fetchJson = () => Promise.reject(networkError);
  try {
    await assert.rejects(ArcGisOffsetImageryProvider.fromUrl(SERVICE), (error) => error === networkError);
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
