/** Synthetic test metadata. (-400, 400) is the default example, not a Provider constant. */
export function makeMetadata({ origin = { x: -400, y: 400 }, wkid = 4326 } = {}) {
  return {
    currentVersion: 11.3,
    singleFusedMapCache: true,
    capabilities: "Map,Tilemap",
    copyrightText: "Synthetic integration-test imagery",
    spatialReference: { wkid },
    fullExtent: {
      xmin: -180,
      ymin: -90,
      xmax: 180,
      ymax: 90,
      spatialReference: { wkid },
    },
    tileInfo: {
      rows: 256,
      cols: 256,
      dpi: 96,
      format: "PNG32",
      compressionQuality: 0,
      origin: { ...origin },
      spatialReference: { wkid },
      lods: Array.from({ length: 7 }, (_, level) => ({
        level,
        resolution: 0.703125 / 2 ** level,
        scale: 295828763.795777 / 2 ** level,
      })),
    },
  };
}
