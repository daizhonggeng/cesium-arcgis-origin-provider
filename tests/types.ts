import {
  Cartographic,
  EllipsoidTerrainProvider,
  ImageryLayer,
  ImageryProvider,
  Rectangle,
  Resource,
  Viewer,
} from "cesium";
import ArcGisOffsetImageryProvider, {
  type ArcGisMapServerMetadata,
  OffsetGeographicTilingScheme,
} from "cesium-arcgis-origin-provider";

const metadata: ArcGisMapServerMetadata = {
  tileInfo: {
    rows: 256,
    cols: 256,
    spatialReference: { wkid: 4326 },
    origin: { x: -400, y: 400 }, // Example within x <= -180 AND y >= 90.
    lods: [
      { level: 0, resolution: 0.703125 },
      { level: 1, resolution: 0.3515625 },
    ],
  },
  fullExtent: { xmin: -180, ymin: -90, xmax: 180, ymax: 90 },
};
const url = "https://example.invalid/arcgis/rest/services/cache/MapServer";
const provider = ArcGisOffsetImageryProvider.fromMetadata(url, metadata);
const compatibleProvider: ImageryProvider = provider;
const layer = new ImageryLayer(compatibleProvider);
const grid = new OffsetGeographicTilingScheme({ tileInfo: metadata.tileInfo });
const xy = grid.positionToTileXY(Cartographic.fromDegrees(116.4, 39.9), 1);
const sourceBounds = grid.tileXYToNativeRectangle(xy.x, xy.y, 1);
const legalCoverage: Rectangle = provider.rectangle;

// Type-check only. This file is not executed by npm test.
async function integrate() {
  const viewer = new Viewer("map", {
    baseLayer: false,
    terrainProvider: new EllipsoidTerrainProvider(),
  });
  viewer.imageryLayers.addImageryProvider(provider);
  viewer.imageryLayers.add(layer);
  viewer.imageryLayers.add(ImageryLayer.fromProviderAsync(
    ArcGisOffsetImageryProvider.fromUrl(new Resource({ url })),
  ));
  const awaited = await ArcGisOffsetImageryProvider.fromUrl(url, {
    rectangle: Rectangle.fromDegrees(70, 10, 140, 60),
    maximumLevel: 1,
  });
  viewer.imageryLayers.addImageryProvider(awaited);
  viewer.camera.setView({ destination: legalCoverage });
  return sourceBounds;
}
void integrate;
