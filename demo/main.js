import {
  Cartesian3, Color, EllipsoidTerrainProvider,
  Rectangle, SceneMode, Viewer,
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

const requests = new Set();
let provider;
let layer;
async function loadService(url) {
  status.textContent = "正在读取切片方案…";
  try {
    const next = await ArcGisOffsetImageryProvider.fromUrl(url);
    const originalRequestImage = next.requestImage.bind(next);
    next.requestImage = (x, y, level, request) => {
      requests.add(`${level}/${y}/${x}`);
      document.querySelector("#request-count").textContent = requests.size;
      return originalRequestImage(x, y, level, request);
    };
    if (layer) viewer.imageryLayers.remove(layer);
    provider = next;
    requests.clear();
    layer = viewer.imageryLayers.addImageryProvider(provider);
    const scheme = provider.tilingScheme;
    document.querySelector("#grid-info").textContent = `${scheme.getNumberOfXTilesAtLevel(0)} × ${scheme.getNumberOfYTilesAtLevel(0)} 根瓦片 / ${provider.maximumLevel + 1} 级`;
    status.textContent = "已加载 · 源瓦片直接渲染";
    return provider;
  } catch (error) {
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
function china() { setView(Rectangle.fromDegrees(75, 15, 135, 55)); }
document.querySelector("#service-form").addEventListener("submit", event => {
  event.preventDefault();
  loadService(document.querySelector("#service-url").value.trim()).catch(() => {});
});
document.querySelector("#view-china").addEventListener("click", china);
document.querySelector("#view-world").addEventListener("click", world);
document.querySelector("#mode-2d").addEventListener("click", () => { viewer.scene.morphTo2D(0); world(); });
document.querySelector("#mode-3d").addEventListener("click", () => { viewer.scene.morphTo3D(0); world(); });

window.__providerDemo = {
  viewer, get provider() { return provider; }, requests, loadService, world, china,
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
loadService(service).then(world).catch(() => {});
