import {
  Cartesian3, Color, EllipsoidTerrainProvider,
  Rectangle, SceneMode, SingleTileImageryProvider, Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { ArcGisOffsetImageryProvider } from "../src/index.js";
import "./style.css";

window.CESIUM_BASE_URL = "/cesium/";
const status = document.querySelector("#status");
const viewer = new Viewer("globe", {
  baseLayer: false,
  terrainProvider: new EllipsoidTerrainProvider(),
  animation: false, timeline: false, geocoder: false, baseLayerPicker: false,
  navigationHelpButton: false, homeButton: false, sceneModePicker: false,
  fullscreenButton: false, infoBox: false, selectionIndicator: false,
  skyBox: false, skyAtmosphere: false,
  contextOptions: { webgl: { preserveDrawingBuffer: true } },
});
viewer.scene.globe.baseColor = Color.fromCssColorString("#1b2536");
viewer.scene.globe.enableLighting = false;
viewer.scene.backgroundColor = Color.fromCssColorString("#080d16");
viewer.scene.globe.showGroundAtmosphere = false;
viewer.scene.fog.enabled = false;
viewer.resolutionScale = 1;
viewer.scene.globe.maximumScreenSpaceError = 2;

// A transparent worldwide base layer keeps a regional ArcGIS layer from being
// stretched to the globe edge by Cesium's base-layer boundary behavior.
viewer.imageryLayers.addImageryProvider(new SingleTileImageryProvider({
  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  tileWidth: 1,
  tileHeight: 1,
}));

const requests = new Set();
let provider;
let layer;
let loadGeneration = 0;
async function loadService(url) {
  const generation = ++loadGeneration;
  status.textContent = "正在读取切片方案…";
  try {
    const next = await ArcGisOffsetImageryProvider.fromUrl(url);
    if (generation !== loadGeneration) return undefined;
    const originalRequestImage = next.requestImage.bind(next);
    next.requestImage = (x, y, level, request) => {
      const result = originalRequestImage(x, y, level, request);
      if (result !== undefined && provider === next) {
        requests.add(`${level}/${y}/${x}`);
        document.querySelector("#request-count").textContent = requests.size;
      }
      return result;
    };
    const nextLayer = viewer.imageryLayers.addImageryProvider(next);
    if (layer) viewer.imageryLayers.remove(layer);
    provider = next;
    requests.clear();
    document.querySelector("#request-count").textContent = "0";
    layer = nextLayer;
    const scheme = provider.tilingScheme;
    document.querySelector("#grid-info").textContent = `${scheme.getNumberOfXTilesAtLevel(0)} × ${scheme.getNumberOfYTilesAtLevel(0)} 根瓦片 / ${provider.maximumLevel + 1} 级`;
    status.textContent = "已加载 · 源瓦片直接渲染";
    coverage();
    return provider;
  } catch (error) {
    if (generation !== loadGeneration) return undefined;
    status.textContent = `加载失败：${error.message}`;
    throw error;
  }
}
function setView(rectangle) {
  viewer.camera.setView({ destination: rectangle });
}
function world() {
  if (viewer.scene.mode === SceneMode.SCENE3D) {
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(0, 0, 21000000) });
  } else setView(Rectangle.fromDegrees(-179.99, -89.99, 179.99, 89.99));
}
function coverage() {
  if (provider) setView(provider.rectangle);
}
document.querySelector("#service-form").addEventListener("submit", event => {
  event.preventDefault();
  loadService(document.querySelector("#service-url").value.trim()).catch(() => {});
});
document.querySelector("#view-china").addEventListener("click", coverage);
document.querySelector("#view-world").addEventListener("click", world);
document.querySelector("#mode-2d").addEventListener("click", () => { viewer.scene.morphTo2D(0); world(); });
document.querySelector("#mode-3d").addEventListener("click", () => { viewer.scene.morphTo3D(0); world(); });

window.__providerDemo = {
  viewer, get provider() { return provider; }, requests, loadService, world, coverage,
  setView,
  goTo(longitude, latitude, height = 1800000) {
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(longitude, latitude, height) });
  },
  samplePosition(longitude, latitude) {
    return viewer.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(longitude, latitude));
  },
  async settle() {
    await new Promise((resolve, reject) => {
      let frames = 0;
      const timeout = setTimeout(() => { remove(); reject(new Error("Timed out waiting for source tiles to finish loading.")); }, 30000);
      const remove = viewer.scene.postRender.addEventListener(() => {
        if (viewer.scene.globe.tilesLoaded && ++frames >= 6) { clearTimeout(timeout); remove(); resolve(); }
        else if (!viewer.scene.globe.tilesLoaded) frames = 0;
      });
      viewer.scene.requestRender();
    });
  },
};
const service = new URLSearchParams(location.search).get("url") || "/mock/MapServer";
document.querySelector("#service-url").value = service;
loadService(service).catch(() => {});
