import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { preview } from "vite";
import { coordinateColor } from "../test-support/mock-map-server.mjs";

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
  const tileUrls = new Set();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") console.error("Browser:", message.text().slice(0, 500)); });
  page.on("request", request => { if (request.url().includes("/tile/")) tileUrls.add(request.url()); });
  await page.route("**/*", route => {
    const url = route.request().url();
    return url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:") ? route.continue() : route.abort();
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__providerDemo?.provider, { timeout: 30000 });
  console.log("Production demo initialized; waiting for world imagery.");
  page.setDefaultTimeout(30000);
  await page.evaluate(() => window.__providerDemo.settle());
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/demo-3d.png" });

  // Test texture positioning at geographic points in 3D, including near the
  // dateline and poles. The screenshot pixel must agree with source lon/lat.
  await page.addStyleTag({ content: ".panel { display: none !important; }" });
  const samples = [[0, 0], [110, 35], [179, 15], [-179, -20], [25, 84], [20, -84]];
  const sampleResults = [];
  for (const [longitude, latitude] of samples) {
    console.log(`Checking geographic texture at ${longitude}, ${latitude}`);
    await page.evaluate(([lon, lat]) => window.__providerDemo.goTo(lon, lat, 1800000), [longitude, latitude]);
    await page.evaluate(() => window.__providerDemo.settle());
    const position = await page.evaluate(([lon, lat]) => window.__providerDemo.samplePosition(lon, lat), [longitude, latitude]);
    assert.ok(position && position.x > 0 && position.y > 0, "Geographic sample must be on screen");
    const png = PNG.sync.read(await page.screenshot());
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    const index = (y * png.width + x) * 4;
    const actual = Array.from(png.data.subarray(index, index + 3));
    const expected = coordinateColor(longitude, latitude);
    assert.ok(actual.every((value, channel) => Math.abs(value - expected[channel]) <= 14),
      `Mispositioned texture at (${longitude},${latitude}): ${actual} expected ${expected}`);
    sampleResults.push({ longitude, latitude, actual, expected });
  }

  await page.evaluate(async () => {
    const { viewer } = window.__providerDemo;
    viewer.scene.morphTo2D(0);
    window.__providerDemo.world();
    await window.__providerDemo.settle();
  });
  await page.screenshot({ path: "artifacts/demo-2d.png" });
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
  assert.deepEqual(errors, [], "Browser must not raise runtime/render errors");
  const report = { cesium: "1.146.0", state, sampleResults, uniqueSourceTileRequests: tileUrls.size, errors };
  await writeFile("artifacts/browser-report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir("artifacts", { recursive: true });
  await page?.screenshot({ path: "artifacts/browser-failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
