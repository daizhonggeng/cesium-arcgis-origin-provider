import { defineConfig } from "vite";
import { createReadStream } from "node:fs";
import { cp, mkdir, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mockMapServerMiddleware } from "./test-support/mock-map-server.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const cesiumAssets = resolve(root, "node_modules/cesium/Build/Cesium");
const mimeTypes = { ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".wasm": "application/wasm" };
function assetMiddleware(req, res, next) {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/cesium/")) return next();
  let file;
  try { file = resolve(cesiumAssets, decodeURIComponent(pathname.slice(8))); }
  catch { res.statusCode = 400; res.end(); return; }
  if (!file.startsWith(cesiumAssets + sep)) { res.statusCode = 403; res.end(); return; }
  stat(file).then(info => {
    if (!info.isFile()) return next();
    res.setHeader("Content-Type", mimeTypes[extname(file)] || "application/octet-stream");
    createReadStream(file).on("error", next).pipe(res);
  }).catch(() => next());
}

export default defineConfig({
  plugins: [
    {
      name: "cesium-runtime-assets",
      configureServer(server) { server.middlewares.use(assetMiddleware); },
      async writeBundle(options) {
        const destination = resolve(options.dir || "dist", "cesium");
        await mkdir(destination, { recursive: true });
        await Promise.all(["Workers", "ThirdParty", "Assets", "Widgets"].map(name => cp(resolve(cesiumAssets, name), resolve(destination, name), { recursive: true })));
      },
    },
    {
      name: "diagnostic-arcgis-cache",
      configureServer(server) { server.middlewares.use(mockMapServerMiddleware); },
      configurePreviewServer(server) { server.middlewares.use(mockMapServerMiddleware); },
    },
  ],
  server: { host: "127.0.0.1" },
  build: { chunkSizeWarningLimit: 6000 },
});
