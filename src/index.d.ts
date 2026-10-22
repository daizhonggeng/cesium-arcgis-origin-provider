import {
  Cartesian2,
  Cartographic,
  Credit,
  Ellipsoid,
  Event,
  GeographicTilingScheme,
  ImageryLayerFeatureInfo,
  ImageryProvider,
  ImageryTypes,
  Proxy,
  Rectangle,
  Request,
  Resource,
  TileDiscardPolicy,
} from "cesium";

export interface ArcGisSpatialReference {
  /** Must identify geographic WKID 4326. */
  wkid?: number;
  latestWkid?: number;
  [key: string]: unknown;
}

export interface ArcGisLevelOfDetail {
  /** The actual identifier placed in /tile/{level}/{row}/{column}. */
  level: number;
  /** Degrees per pixel; must halve at each successive array entry. */
  resolution: number;
  scale?: number;
  [key: string]: unknown;
}

export interface ArcGisTileInfo {
  rows: number;
  cols: number;
  /** Source origin in degrees, with x <= -180 and y >= 90. */
  origin: { x: number; y: number };
  spatialReference: ArcGisSpatialReference;
  lods: ArcGisLevelOfDetail[];
  format?: string;
  dpi?: number;
  [key: string]: unknown;
}

export interface ArcGisGeographicExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: ArcGisSpatialReference;
  [key: string]: unknown;
}

export interface ArcGisMapServerMetadata {
  tileInfo: ArcGisTileInfo;
  fullExtent?: ArcGisGeographicExtent;
  copyrightText?: string;
  error?: { code?: number; message: string; details?: string[] };
  [key: string]: unknown;
}

export interface ArcGisOffsetImageryProviderOptions {
  /** ArcGIS token. Passed to both metadata and tile requests. */
  token?: string;
  ellipsoid?: Ellipsoid;
  /** Optional legal, non-wrapping coverage rectangle in radians. */
  rectangle?: Rectangle;
  /** Indices into tileInfo.lods, rather than its server-side level identifiers. */
  minimumLevel?: number;
  maximumLevel?: number;
  credit?: Credit | string;
  hasAlphaChannel?: boolean;
  tileDiscardPolicy?: TileDiscardPolicy;
}

export interface ArcGisOffsetImageryProviderConstructorOptions
  extends ArcGisOffsetImageryProviderOptions {
  url: string | Resource;
  metadata: ArcGisMapServerMetadata;
}

/**
 * Imagery-only source grid. Its padded mathematical rectangle may exceed the
 * earth's coordinate bounds. Use provider.rectangle for coverage and cameras.
 */
export class OffsetGeographicTilingScheme extends GeographicTilingScheme {
  constructor(options: { tileInfo: ArcGisTileInfo; ellipsoid?: Ellipsoid });
  readonly levelIds: readonly number[];
  readonly resolutions: readonly number[];
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly maximumLevel: number;
  getNumberOfXTilesAtLevel(level: number): number;
  getNumberOfYTilesAtLevel(level: number): number;
  tileXYToNativeRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle;
  tileXYToRectangle(x: number, y: number, level: number, result?: Rectangle): Rectangle;
  /** Follows Cesium's declaration; returns undefined outside the grid at runtime. */
  positionToTileXY(position: Cartographic, level: number, result?: Cartesian2): Cartesian2;
}

/**
 * Direct ArcGIS geographic cache imagery. No image composition, canvas,
 * reprojection, or Cesium prototype patching is performed.
 * Optional Cesium properties follow the upstream ImageryProvider declarations.
 */
export class ArcGisOffsetImageryProvider implements ImageryProvider {
  constructor(options: ArcGisOffsetImageryProviderConstructorOptions);
  static fromUrl(
    url: string | Resource,
    options?: ArcGisOffsetImageryProviderOptions,
  ): Promise<ArcGisOffsetImageryProvider>;
  static fromMetadata(
    url: string | Resource,
    metadata: ArcGisMapServerMetadata,
    options?: ArcGisOffsetImageryProviderOptions,
  ): ArcGisOffsetImageryProvider;
  readonly url: string;
  readonly token: string | undefined;
  readonly proxy: Proxy;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly maximumLevel: number;
  readonly minimumLevel: number;
  readonly tilingScheme: OffsetGeographicTilingScheme;
  /** Legal geographic coverage in radians. Suitable for camera.setView. */
  readonly rectangle: Rectangle;
  readonly tileDiscardPolicy: TileDiscardPolicy;
  readonly errorEvent: Event;
  readonly credit: Credit;
  readonly hasAlphaChannel: boolean;
  readonly ready: true;
  readonly readyPromise: Promise<ArcGisOffsetImageryProvider>;
  readonly usingPrecachedTiles: true;
  /** Always returns undefined; feature picking is unsupported. */
  enablePickFeatures: boolean;
  getTileCredits(x: number, y: number, level: number): Credit[];
  pickFeatures(
    x: number,
    y: number,
    level: number,
    longitude: number,
    latitude: number,
  ): Promise<ImageryLayerFeatureInfo[]> | undefined;
  /** One source image per request; undefined is preserved on scheduler throttle. */
  requestImage(x: number, y: number, level: number, request?: Request): Promise<ImageryTypes> | undefined;
}

export default ArcGisOffsetImageryProvider;
