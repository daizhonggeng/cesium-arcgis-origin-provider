import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { preview } from "vite";
import { coordinateColor, metadata } from "../test-support/mock-map-server.mjs";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  || (process.platform === "darwin" && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
let browser;
let page;
try {
  browser = await chromium.launch({
    executablePath, headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  const consoleErrors = [];
  const tileUrls = new Set();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500)); });
  page.on("request", request => { if (request.url().includes("/tile/")) tileUrls.add(request.url()); });
  await page.route("**/*", route => {
    const url = route.request().url();
    return url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__providerDemo?.provider, { timeout: 30000 });
  console.log("Production demo initialized; waiting for world imagery.");
  page.setDefaultTimeout(30000);
  await page.evaluate(() => window.__providerDemo.world());
  await page.evaluate(() => window.__providerDemo.settle());
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/demo-3d.png" });

  // Test texture positioning at geographic points in 3D, including near the
  // dateline and poles. The screenshot pixel must agree with source lon/lat.
  await page.addStyleTag({ content: ".panel { display: none !important; }" });
  // Pixel correctness does not need the full documentation screenshot size.
  // A smaller viewport keeps the polar terrain refinement bounded on software
  // WebGL renderers while still waiting for every visible tile to finish.
  await page.setViewportSize({ width: 640, height: 480 });
  const samples = [[0, 0], [110, 35], [179, 15], [-179, -20], [25, 84], [20, -84]];
  const sampleResults = [];
  async function checkPixel(longitude, latitude, mode, expected = coordinateColor(longitude, latitude), tolerance = 3) {
    const position = await page.evaluate(([lon, lat]) => window.__providerDemo.samplePosition(lon, lat), [longitude, latitude]);
    const png = PNG.sync.read(await page.screenshot());
    const x = Math.round(position?.x);
    const y = Math.round(position?.y);
    assert.ok(Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && x < png.width && y >= 0 && y < png.height,
    `Geographic sample (${longitude},${latitude}) must be inside the screenshot`);
    const index = (y * png.width + x) * 4;
    const actual = Array.from(png.data.subarray(index, index + 3));
    assert.equal(actual.length, 3);
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= tolerance),
      `Mispositioned ${mode} texture at (${longitude},${latitude}): ${actual} expected ${expected}`);
    sampleResults.push({ mode, longitude, latitude, actual, expected });
  }
  for (const [longitude, latitude] of samples) {
    console.log(`Checking geographic texture at ${longitude}, ${latitude}`);
    await page.evaluate(([lon, lat]) => window.__providerDemo.goTo(lon, lat, 1800000), [longitude, latitude]);
    await page.evaluate(() => window.__providerDemo.settle());
    await checkPixel(longitude, latitude, "3D");
  }

  console.log("Checking 2D geographic texture and documentation screenshot.");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => {
    const { viewer } = window.__providerDemo;
    viewer.scene.morphTo2D(0);
    window.__providerDemo.world();
    await window.__providerDemo.settle();
  });
  await page.screenshot({ path: "artifacts/demo-2d.png" });
  await page.setViewportSize({ width: 640, height: 480 });
  await page.evaluate(() => window.__providerDemo.settle());
  for (const [longitude, latitude] of samples) await checkPixel(longitude, latitude, "2D");
  const state = await page.evaluate(() => ({
    mode: window.__providerDemo.viewer.scene.mode,
    tilesLoaded: window.__providerDemo.viewer.scene.globe.tilesLoaded,
    uniqueRequests: window.__providerDemo.requests.size,
    rootX: window.__providerDemo.provider.tilingScheme.getNumberOfXTilesAtLevel(0),
    rootY: window.__providerDemo.provider.tilingScheme.getNumberOfYTilesAtLevel(0),
  }));
  assert.equal(state.mode, 2, "2D scene must render successfully");
  assert.equal(state.tilesLoaded, true);
  assert.equal(state.rootX, 4);
  assert.equal(state.rootY, 3);
  assert.ok(tileUrls.size > 10, "Browser must load original source tile URLs across levels");

  // Intercept metadata only. All image requests still use the real local HTTP
  // diagnostic cache, including when testing a limited geographic coverage.
  const pendingMetadata = new Map();
  await page.route(/\/mock\/MapServer\/\?/, async route => {
    const scenario = new URL(route.request().url()).searchParams.get("scenario");
    if (!scenario) return route.continue();
    if (scenario.startsWith("slow")) {
      const pending = pendingMetadata.get(scenario);
      if (!pending) return route.abort("timedout");
      pending.entered();
      await pending.hold;
    }
    if (scenario.includes("failure")) {
      return route.fulfill({ json: { error: { code: 400, message: "Intentional metadata failure" } } });
    }
    const data = metadata();
    if (scenario === "regional") {
      data.fullExtent = { xmin: 100, ymin: 20, xmax: 120, ymax: 40, spatialReference: { wkid: 4326 } };
    }
    return route.fulfill({ json: data });
  });
  console.log("Checking regional coverage and automatic camera framing.");
  await page.evaluate(async () => {
    window.__providerDemo.viewer.scene.morphTo3D(0);
    await window.__providerDemo.loadService("/mock/MapServer?scenario=regional");
    await window.__providerDemo.settle();
  });
  const regionalPosition = await page.evaluate(() => window.__providerDemo.samplePosition(110, 30));
  assert.ok(regionalPosition.x > 160 && regionalPosition.x < 480
    && regionalPosition.y > 120 && regionalPosition.y < 360, "Loading a regional service must frame its coverage");
  await checkPixel(110, 30, "regional 3D");
  await page.evaluate(async () => { window.__providerDemo.goTo(0, 0); await window.__providerDemo.settle(); });
  await checkPixel(0, 0, "outside regional coverage", [27, 37, 54]);

  async function checkSupersededLoad(scenario) {
    console.log(`Checking service switch: ${scenario}`);
    let entered;
    let release;
    let timer;
    const started = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    pendingMetadata.set(scenario, { entered, hold });
    try {
      await page.evaluate(name => {
        window.__pendingDemoLoad = window.__providerDemo.loadService(`/mock/MapServer?scenario=${name}`);
      }, scenario);
      await Promise.race([started, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Metadata interception did not start for ${scenario}`)), 10000);
      })]);
      await page.evaluate(() => window.__providerDemo.loadService("/mock/MapServer?scenario=latest"));
    } finally {
      clearTimeout(timer);
      release();
      pendingMetadata.delete(scenario);
    }
    await page.evaluate(() => window.__pendingDemoLoad);
    const current = await page.evaluate(() => ({ url: window.__providerDemo.provider.url, status: document.querySelector("#status").textContent }));
    assert.ok(current.url.includes("scenario=latest"), "A stale response must not replace the newest selected service");
    assert.ok(current.status.startsWith("已加载"), "A stale failure must not replace the newest successful status");
  }
  await checkSupersededLoad("slow-success");
  await checkSupersededLoad("slow-failure");
  const failedLoad = await page.evaluate(async () => {
    const before = window.__providerDemo.provider;
    try { await window.__providerDemo.loadService("/mock/MapServer?scenario=failure"); }
    catch { /* Expected: leave the already-rendered provider in place. */ }
    return { retained: before === window.__providerDemo.provider, layerCount: window.__providerDemo.viewer.imageryLayers.length, status: document.querySelector("#status").textContent };
  });
  assert.ok(failedLoad.retained, "A failed service switch must retain the existing imagery");
  assert.equal(failedLoad.layerCount, 2, "Switches must keep exactly one transparent base and one source layer");
  assert.ok(failedLoad.status.startsWith("加载失败"));
  assert.deepEqual(errors, [], "Browser must not raise runtime/render errors");
  assert.deepEqual(consoleErrors, [], "Browser must not report console errors");
  const report = { cesium: "1.146.0", state, sampleResults, serviceSwitchChecks: ["regional coverage", "stale success", "stale failure", "failed switch retention"], uniqueSourceTileRequests: tileUrls.size, errors, consoleErrors };
  await writeFile("artifacts/browser-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir("artifacts", { recursive: true });
  const diagnostics = await page?.evaluate(() => {
    const globe = window.__providerDemo?.viewer.scene.globe;
    const surface = globe?._surface;
    return {
      tilesLoaded: globe?.tilesLoaded,
      sceneMode: window.__providerDemo?.viewer.scene.mode,
      uniqueSourceRequests: window.__providerDemo?.requests.size,
      // Cesium internals are used only for failure diagnostics, never rendering.
      loadQueues: surface && { high: surface._tileLoadQueueHigh.length, medium: surface._tileLoadQueueMedium.length, low: surface._tileLoadQueueLow.length },
      renderedTerrainTiles: surface?._tilesToRender.length,
    };
  }).catch(() => undefined);
  console.error("Browser failure diagnostics:", diagnostics);
  await writeFile("artifacts/browser-failure.json", JSON.stringify({ message: error.message, diagnostics }, null, 2));
  await page?.screenshot({ path: "artifacts/browser-failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
