import {
  Cartesian2,
  Ellipsoid,
  GeographicTilingScheme,
  Math as CesiumMath,
  Rectangle,
} from "cesium";

const MAX_CESIUM_TILE_COUNT = 2 ** 31;
const RELATIVE_RESOLUTION_TOLERANCE = 1e-12;

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function requireLevel(level) {
  if (!Number.isSafeInteger(level) || level < 0) {
    throw new RangeError("level must be a non-negative integer.");
  }
}

function floorCoordinate(value) {
  // Converting degree bounds to radians and back may put an exact tile edge
  // a few machine epsilons below the integer. Keep edge ownership stable.
  const nearestInteger = Math.round(value);
  const tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(value));
  return Math.abs(value - nearestInteger) <= tolerance
    ? nearestInteger
    : Math.floor(value);
}

/**
 * An ArcGIS geographic cache grid with its original origin and tile indices.
 *
 * IMPORTANT: rectangle and tileXYToRectangle intentionally retain mathematical
 * bounds outside [-180, 180] / [-90, 90]. The imagery provider must separately
 * expose a legal coverage rectangle. Clamping a source tile here would stretch
 * its entire image into the clipped area and produce incorrect texture UVs.
 * Use this scheme for imagery, never for a terrain provider or camera bounds.
 *
 * Supported origins must be finite, with x <= -180 AND y >= 90 (degrees).
 * The original grid is padded to whole root tiles covering the world. As an
 * example, origin (-400, 400), 256-pixel tiles and resolution 0.703125 give a 4 x 3
 * root grid over [-400, -140, 320, 400] degrees. Consequently Cesium's normal
 * LOD calculation still sees 720 / 4 = 180 degrees per root tile, and its
 * floor(x / 2), floor(y / 2) parent indices are the ArcGIS source parents.
 *
 * @param {object} options
 * @param {object} options.tileInfo ArcGIS MapServer tileInfo (WKID 4326).
 * @param {Ellipsoid} [options.ellipsoid=Ellipsoid.WGS84]
 */
export default class OffsetGeographicTilingScheme extends GeographicTilingScheme {
  constructor(options = {}) {
    const tileInfo = options.tileInfo;
    if (!tileInfo || typeof tileInfo !== "object") {
      throw new TypeError("tileInfo is required.");
    }

    const spatialReference = tileInfo.spatialReference;
    const wkid = spatialReference?.latestWkid ?? spatialReference?.wkid;
    if (wkid !== 4326) {
      throw new RangeError("Only geographic WKID 4326 caches are supported.");
    }

    const { rows, cols, origin, lods } = tileInfo;
    requirePositiveInteger(rows, "tileInfo.rows");
    requirePositiveInteger(cols, "tileInfo.cols");
    if (!Number.isFinite(origin?.x) || !Number.isFinite(origin?.y)) {
      throw new TypeError("tileInfo.origin.x and origin.y must be finite numbers.");
    }
    if (origin.x > -180 || origin.y < 90) {
      throw new RangeError(
        "This source-index-preserving grid requires origin.x <= -180 and origin.y >= 90.",
      );
    }
    if (!Array.isArray(lods) || lods.length === 0) {
      throw new TypeError("tileInfo.lods must contain at least one level.");
    }

    const resolution = lods[0]?.resolution;
    if (!Number.isFinite(resolution) || resolution <= 0) {
      throw new RangeError("LOD resolutions must be finite and positive.");
    }
    const levelIds = [];
    const resolutions = [];
    const seenLevelIds = new Set();
    for (let index = 0; index < lods.length; index += 1) {
      const lod = lods[index];
      if (!Number.isSafeInteger(lod?.level) || lod.level < 0) {
        throw new RangeError("Each ArcGIS LOD level must be a non-negative integer.");
      }
      if (seenLevelIds.has(lod.level)) {
        throw new RangeError("ArcGIS LOD level identifiers must be unique.");
      }
      const expected = resolution / 2 ** index;
      if (
        !Number.isFinite(lod.resolution) ||
        lod.resolution <= 0 ||
        Math.abs(lod.resolution - expected) / expected >
          RELATIVE_RESOLUTION_TOLERANCE
      ) {
        throw new RangeError(
          `LOD resolution must halve at each level; invalid index ${index}.`,
        );
      }
      seenLevelIds.add(lod.level);
      levelIds.push(lod.level);
      // Use one exact dyadic hierarchy for bounds and parents. The small
      // tolerance above accommodates ArcGIS metadata decimal serialization.
      resolutions.push(expected);
    }

    const rootWidth = cols * resolution;
    const rootHeight = rows * resolution;
    if (!Number.isFinite(rootWidth) || !Number.isFinite(rootHeight)) {
      throw new RangeError("The root tile dimensions are too large.");
    }
    const rootTilesX = Math.ceil((180 - origin.x) / rootWidth);
    const rootTilesY = Math.ceil((origin.y + 90) / rootHeight);
    requirePositiveInteger(rootTilesX, "root tile count X");
    requirePositiveInteger(rootTilesY, "root tile count Y");

    const maximumLevel = lods.length - 1;
    if (
      Math.max(rootTilesX, rootTilesY) * 2 ** maximumLevel >
      MAX_CESIUM_TILE_COUNT
    ) {
      throw new RangeError("The cache exceeds Cesium's signed tile-index range.");
    }

    const rectangle = Rectangle.fromDegrees(
      origin.x,
      origin.y - rootTilesY * rootHeight,
      origin.x + rootTilesX * rootWidth,
      origin.y,
    );
    super({
      ellipsoid: options.ellipsoid ?? Ellipsoid.WGS84,
      rectangle,
      numberOfLevelZeroTilesX: rootTilesX,
      numberOfLevelZeroTilesY: rootTilesY,
    });

    this._originX = origin.x;
    this._originY = origin.y;
    this._rootWidth = rootWidth;
    this._rootHeight = rootHeight;
    this._levelIds = Object.freeze(levelIds);
    this._resolutions = Object.freeze(resolutions);
    this._tileWidth = cols;
    this._tileHeight = rows;
    this._maximumLevel = maximumLevel;
  }

  get levelIds() {
    return this._levelIds;
  }

  get resolutions() {
    return this._resolutions;
  }

  get tileWidth() {
    return this._tileWidth;
  }

  get tileHeight() {
    return this._tileHeight;
  }

  get maximumLevel() {
    return this._maximumLevel;
  }

  getNumberOfXTilesAtLevel(level) {
    requireLevel(level);
    const count = this._numberOfLevelZeroTilesX * 2 ** level;
    if (!Number.isSafeInteger(count) || count > MAX_CESIUM_TILE_COUNT) {
      throw new RangeError("level exceeds Cesium's signed tile-index range.");
    }
    return count;
  }

  getNumberOfYTilesAtLevel(level) {
    requireLevel(level);
    const count = this._numberOfLevelZeroTilesY * 2 ** level;
    if (!Number.isSafeInteger(count) || count > MAX_CESIUM_TILE_COUNT) {
      throw new RangeError("level exceeds Cesium's signed tile-index range.");
    }
    return count;
  }

  tileXYToNativeRectangle(x, y, level, result = new Rectangle()) {
    const xTiles = this.getNumberOfXTilesAtLevel(level);
    const yTiles = this.getNumberOfYTilesAtLevel(level);
    if (
      !Number.isSafeInteger(x) ||
      !Number.isSafeInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= xTiles ||
      y >= yTiles
    ) {
      throw new RangeError("Tile x and y must be inside the source grid.");
    }
    const width = this._rootWidth / 2 ** level;
    const height = this._rootHeight / 2 ** level;
    result.west = this._originX + x * width;
    result.east = this._originX + (x + 1) * width;
    result.north = this._originY - y * height;
    result.south = this._originY - (y + 1) * height;
    return result;
  }

  tileXYToRectangle(x, y, level, result = new Rectangle()) {
    this.tileXYToNativeRectangle(x, y, level, result);
    result.west = CesiumMath.toRadians(result.west);
    result.south = CesiumMath.toRadians(result.south);
    result.east = CesiumMath.toRadians(result.east);
    result.north = CesiumMath.toRadians(result.north);
    return result;
  }

  positionToTileXY(position, level, result) {
    const xTiles = this.getNumberOfXTilesAtLevel(level);
    const yTiles = this.getNumberOfYTilesAtLevel(level);
    if (
      !Number.isFinite(position?.longitude) ||
      !Number.isFinite(position?.latitude) ||
      !Rectangle.contains(this.rectangle, position)
    ) {
      return undefined;
    }
    const longitude = CesiumMath.toDegrees(position.longitude);
    const latitude = CesiumMath.toDegrees(position.latitude);
    const width = this._rootWidth / 2 ** level;
    const height = this._rootHeight / 2 ** level;
    const x = Math.max(
      0,
      Math.min(xTiles - 1, floorCoordinate((longitude - this._originX) / width)),
    );
    const y = Math.max(
      0,
      Math.min(yTiles - 1, floorCoordinate((this._originY - latitude) / height)),
    );
    if (result === undefined) {
      return new Cartesian2(x, y);
    }
    result.x = x;
    result.y = y;
    return result;
  }
}
