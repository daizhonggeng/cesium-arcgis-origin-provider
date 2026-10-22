import {
  Credit,
  Event,
  ImageryProvider,
  Rectangle,
  Resource,
} from "cesium";
import OffsetGeographicTilingScheme from "./OffsetGeographicTilingScheme.js";

function serviceResource(url, token) {
  if (!url) throw new Error("A MapServer URL is required.");
  const resource = Resource.createIfNeeded(url).clone();
  // Service-directory URLs often contain ?f=json/pjson. The format belongs to
  // the metadata request, not the binary tile endpoint. Mutate only our clone.
  for (const key of Object.keys(resource.queryParameters)) {
    if (key.toLowerCase() === "f") delete resource.queryParameters[key];
  }
  resource.appendForwardSlash();
  if (token !== undefined) resource.setQueryParameters({ token });
  return resource;
}

function geographicRectangle(extent, name) {
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (wkid !== undefined && wkid !== 4326) {
    throw new Error(`${name} must use EPSG:4326, received ${wkid}.`);
  }
  const values = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!values.every(Number.isFinite) || extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) {
    throw new Error(`${name} must have finite, increasing geographic bounds.`);
  }
  const west = Math.max(-180, extent.xmin);
  const east = Math.min(180, extent.xmax);
  const south = Math.max(-90, extent.ymin);
  const north = Math.min(90, extent.ymax);
  if (west >= east || south >= north) throw new Error(`${name} does not intersect the earth.`);
  return Rectangle.fromDegrees(west, south, east, north);
}

/**
 * An independent ImageryProvider for an ArcGIS geographic tile cache.
 * Supports WKID 4326, origin.x <= -180 AND origin.y >= 90 (degrees), and
 * halving LOD resolutions. The origin is read from service metadata.
 * Each request returns exactly one original server tile. No canvas, cropping,
 * image composition, reprojection, or Cesium prototype patches are performed.
 * Construct with fromUrl(), or fromMetadata() when metadata is already available.
 */
export class ArcGisOffsetImageryProvider {
  constructor(options = {}) {
    const { metadata } = options;
    if (!metadata || metadata.error) {
      throw new Error(metadata?.error?.message ?? "ArcGIS service metadata is required.");
    }
    if (!metadata.tileInfo) throw new Error("The service must expose cached imagery tileInfo.");

    this._resource = serviceResource(options.url, options.token);
    this._tilingScheme = new OffsetGeographicTilingScheme({
      tileInfo: metadata.tileInfo,
      ellipsoid: options.ellipsoid,
    });
    let rectangle = metadata.fullExtent
      ? geographicRectangle(metadata.fullExtent, "fullExtent")
      : Rectangle.clone(Rectangle.MAX_VALUE);
    if (options.rectangle) {
      if (![options.rectangle.west, options.rectangle.south, options.rectangle.east, options.rectangle.north].every(Number.isFinite)
        || options.rectangle.west < -Math.PI || options.rectangle.east > Math.PI
        || options.rectangle.south < -Math.PI / 2 || options.rectangle.north > Math.PI / 2
        || options.rectangle.west >= options.rectangle.east || options.rectangle.south >= options.rectangle.north) {
        throw new Error("rectangle must be a non-wrapping, valid geographic rectangle in radians.");
      }
      rectangle = Rectangle.intersection(rectangle, options.rectangle);
      if (!rectangle) throw new Error("rectangle does not intersect the service fullExtent.");
    }
    this._rectangle = rectangle;
    this._errorEvent = new Event();
    const credit = options.credit;
    this._credit = typeof credit === "string" ? (credit ? new Credit(credit) : undefined) : credit;
    this._tileCredits = undefined;
    if (typeof metadata.copyrightText === "string" && metadata.copyrightText.length > 0) {
      const serviceCredit = new Credit(metadata.copyrightText);
      // Match Cesium's ArcGIS provider: custom application attribution must
      // not erase the imagery service's own copyright credit.
      if (this._credit) this._tileCredits = [serviceCredit];
      else this._credit = serviceCredit;
    }
    this._hasAlphaChannel = options.hasAlphaChannel ?? true;
    this._tileDiscardPolicy = options.tileDiscardPolicy;
    this._minimumLevel = options.minimumLevel ?? 0;
    this._maximumLevel = options.maximumLevel ?? this._tilingScheme.maximumLevel;
    if (!Number.isInteger(this._minimumLevel) || !Number.isInteger(this._maximumLevel)
      || this._minimumLevel < 0 || this._maximumLevel < this._minimumLevel
      || this._maximumLevel > this._tilingScheme.maximumLevel) {
      throw new Error("minimumLevel/maximumLevel must be indices into the available LOD list.");
    }
    this.enablePickFeatures = false;
  }

  /** Fetch MapServer?f=pjson once, then request its original /tile/level/row/col images. */
  static async fromUrl(url, options = {}) {
    const resource = serviceResource(url, options.token);
    const metadata = await resource.getDerivedResource({ queryParameters: { f: "pjson" } }).fetchJson();
    return new ArcGisOffsetImageryProvider({ ...options, url: resource, metadata });
  }

  /** A synchronous factory, useful with an authenticated/preloaded metadata response. */
  static fromMetadata(url, metadata, options = {}) {
    return new ArcGisOffsetImageryProvider({ ...options, url, metadata });
  }

  get url() { return this._resource.url; }
  get token() { return this._resource.queryParameters.token; }
  get proxy() { return this._resource.proxy; }
  get tileWidth() { return this._tilingScheme.tileWidth; }
  get tileHeight() { return this._tilingScheme.tileHeight; }
  get maximumLevel() { return this._maximumLevel; }
  get minimumLevel() { return this._minimumLevel; }
  get tilingScheme() { return this._tilingScheme; }
  get rectangle() { return this._rectangle; }
  get tileDiscardPolicy() { return this._tileDiscardPolicy; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get hasAlphaChannel() { return this._hasAlphaChannel; }
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(this); }
  get usingPrecachedTiles() { return true; }

  getTileCredits() { return this._tileCredits; }
  pickFeatures() { return undefined; }

  requestImage(x, y, level, request) {
    const scheme = this._tilingScheme;
    if (!Number.isInteger(level) || level < 0 || level > this._maximumLevel) {
      throw new Error("Requested imagery level is outside the configured LOD range.");
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
      || x >= scheme.getNumberOfXTilesAtLevel(level) || y >= scheme.getNumberOfYTilesAtLevel(level)) {
      throw new Error("Requested tile coordinates are outside the source grid.");
    }
    const resource = this._resource.getDerivedResource({
      url: `tile/${scheme.levelIds[level]}/${y}/${x}`,
      request,
    });
    // Return undefined unchanged when Cesium's RequestScheduler throttles a request.
    return ImageryProvider.loadImage(this, resource);
  }
}

export default ArcGisOffsetImageryProvider;
