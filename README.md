# Cesium ArcGIS 自定义原点影像 Provider

独立的 Cesium `ImageryProvider`，用于直接加载符合下列条件的 ArcGIS 自定义原点经纬度缓存切片。保留服务原始切片和行列号，无需修改 Cesium 源码。

**支持的原点范围（单位：度）：`origin.x <= -180` 且 `origin.y >= 90`，两个条件必须同时满足。** 原点从服务的 `tileInfo.origin` 自动读取，还需满足 **WKID 4326、LOD 分辨率逐级减半**等[切片方案要求](#支持的切片方案)。

**`(-400,400)` 仅是本文和默认演示采用的示例原点，不是固定值，也不是唯一支持的原点。** 例如 `(-180,90)`、`(-200,100)`、`(-512,512)` 均在原点支持范围内；`(-100,80)`、`(0,0)` 则不支持，即使服务只覆盖局部区域，当前实现也会拒绝。

每次 `requestImage(x, y, level)` 只请求并返回一张原始 `/tile/{level}/{row}/{column}` 图片。Provider 不创建 Canvas、不拼图、不裁切图片、不进行图片重投影。Cesium 自身根据地形与影像的相交范围计算纹理坐标，把多张源影像显示在正确位置。

详细说明见 [实现原理：保留源网格，直接显示源瓦片](docs/principle.md)，包括通用网格公式、示例的 `4×3` 扩展网格、地形与影像的多图映射、父子层级及边缘 UV 的计算。

## 运行演示

开发和自动检查使用 Node.js 24、Cesium **1.146.0**。

```sh
npm ci
npm run dev
```

打开 Vite 显示的本地地址。默认演示使用本地诊断服务 `/mock/MapServer`：图片颜色编码经纬度，深色线表示源切片边界。可在页面输入自己的 ArcGIS `MapServer` 地址，或使用 `?url=` 查询参数。加载成功后自动定位到服务覆盖范围，连续切换时以最后一次操作为准。诊断服务仅供本地验证，静态部署时需接入真实服务。

演示采用椭球地形，以透明全球影像占据最底层，使区域服务按实际范围显示，不需要 Cesium ion token。

```sh
# 未安装可用 Chrome/Chromium 时，先安装测试浏览器
npx playwright install chromium

# 单元测试、类型检查、构建、真实浏览器渲染检查
npm run check
```

也可分别运行 `npm test`、`npm run typecheck`、`npm run build` 和 `npm run test:browser`。浏览器检查需要先构建，检查结果和截图保存在 `artifacts/`。测试程序可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定浏览器路径；macOS 已安装的 Google Chrome 会优先使用。

## 接入项目

本仓库提供 ESM 源码与 TypeScript 声明。可将仓库作为本地包安装到现有应用：

```sh
npm install ./path/to/cesium-arcgis-origin-provider
```

也可从公开仓库安装（项目尚未发布到 npm 注册表）：

```sh
npm install github:daizhonggeng/cesium-arcgis-origin-provider
```

需要固定版本时，在 Git 地址后附加 `#<commit SHA>`。本项目开发使用 `.nvmrc` 中的 Node.js 24。

在已配置 Cesium 静态资源的应用中使用：

```js
import {
  EllipsoidTerrainProvider,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { ArcGisOffsetImageryProvider } from "cesium-arcgis-origin-provider";

const viewer = new Viewer("cesiumContainer", {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  terrainProvider: new EllipsoidTerrainProvider(),
});

const provider = await ArcGisOffsetImageryProvider.fromUrl(
  "https://your-server/arcgis/rest/services/your-cache/MapServer",
);
viewer.imageryLayers.addImageryProvider(provider);

// 相机使用实际地理覆盖范围。
viewer.camera.setView({ destination: provider.rectangle });
```

也可用 Cesium 的异步影像层工厂：

```js
import { ImageryLayer } from "cesium";

viewer.imageryLayers.add(ImageryLayer.fromProviderAsync(
  ArcGisOffsetImageryProvider.fromUrl(serviceUrl),
));
```

Cesium 的 Workers、Assets、Widgets、ThirdParty 等静态文件与 `CESIUM_BASE_URL` 按应用原有方式配置；仓库中的演示已包含相应 Vite 配置。Provider 自身不依赖 ion 服务。

区域服务作为最底层影像时，Cesium 默认会把边界像素延展到覆盖区外。需要保留覆盖区外底图时，先添加底图，再把本 Provider 作为上层影像加入。

## 支持的切片方案

| 参数 | 要求 |
| --- | --- |
| 空间参考 | `tileInfo.spatialReference` 为 WKID 4326 |
| 原点 | 两个坐标均为有限数值，且 **`origin.x <= -180` 与 `origin.y >= 90` 同时成立**；从元数据读取 |
| 切片尺寸 | 正整数，按服务的 `cols`、`rows` 使用；标准示例为 `256×256` |
| LOD | `lods` 按从粗到细排序，分辨率逐级减半 |
| LOD 编号 | 使用每项实际的 `lod.level`，不要求编号与数组索引相同 |
| 地理覆盖 | `fullExtent` 为经纬度范围，裁到 `[-180,180] × [-90,90]`；省略时默认全球 |
| 索引范围 | 最高层级每个方向的网格瓦片数量不超过 `2^31`，以满足 Cesium 的索引范围 |

服务必须具有缓存 `tileInfo`，并能返回原始 `/tile/{level}/{row}/{column}` 图片。当前不支持投影坐标缓存、非二倍 LOD、跨日期变更线形式的覆盖矩形、动态 `/export` 和要素拾取。`fullExtent` 省略空间参考时，按与切片相同的 4326 解释。

原点须位于全球范围的西北侧，才能在当前实现中保留非负源行列号及父子层级。这是本 Provider 当前的实现限制，并非 Cesium 原理上只能接受这些原点。

在上述支持条件内，只有原点变化时可保持其他服务参数原样。以下**示例**采用原点 `(-400,400)`、`256×256` 图片与零级分辨率 `0.703125°/像素`，产生 `4×3` 个根瓦片；其他参数组合的根数量按元数据计算：

```json
{
  "rows": 256,
  "cols": 256,
  "origin": { "x": -400, "y": 400 },
  "spatialReference": { "wkid": 4326 },
  "lods": [
    { "level": 0, "resolution": 0.703125 },
    { "level": 1, "resolution": 0.3515625 },
    { "level": 2, "resolution": 0.17578125 }
  ]
}
```

## 为什么使用扩展网格

以本节的**示例原点 `(-400,400)`** 为左上角，每块根瓦片覆盖 `180°×180°`，需要 `4×3` 块才能包住地球。这个示例网格的**数学范围**为：

```text
west=-400, south=-140, east=320, north=400  （度）
```

此范围保留原切片尺寸、源索引和父子关系；`720° / 4 = 180°` 也使 Cesium 的影像 LOD 计算保持正确。真实瓦片范围必须保留，例如源瓦片 `(column=2,row=2,level=0)` 的范围是 `[-40,-140,140,40]` 度。若将该矩形先截到南纬 90°，却仍返回整张图片，纹理会被拉伸。

两个 rectangle 的用途不同：

- **`provider.rectangle`** 是合法的实际地理覆盖范围，单位弧度；可用于相机定位。
- **`provider.tilingScheme.rectangle`** 是扩展后的数学网格范围，单位弧度；仅供影像切片计算，**不可用作地形切片方案或相机范围，也不要用它执行 zoomTo/flyTo**。

超出地球范围的像素仍留在原图片中，由 Cesium 显示时的范围与纹理坐标限制处理。瓦片在 CPU 中不会被重新合成。

## API

### 工厂

```js
// 异步获取 MapServer?f=pjson，并保留 URL / Resource 的查询参数。
const provider = await ArcGisOffsetImageryProvider.fromUrl(url, options);

// 已经获取元数据时同步构造；不再请求元数据。
const provider2 = ArcGisOffsetImageryProvider.fromMetadata(url, metadata, options);
```

`url` 可以是字符串或 Cesium `Resource`，应指向服务的 `MapServer` 根地址。构造函数 `new ArcGisOffsetImageryProvider({ url, metadata, ...options })` 与第二种方式等价。

| `options` | 说明 |
| --- | --- |
| `token` | ArcGIS token，附加到元数据和图片请求 |
| `ellipsoid` | 使用的椭球，默认 `Ellipsoid.WGS84` |
| `rectangle` | 可选的合法地理矩形，单位弧度；与 `fullExtent` 取交集，不支持跨日期变更线 |
| `minimumLevel` | 影像 LOD 选择下限，默认 `0`；祖先图片仍可用于加载回退 |
| `maximumLevel` | 最大可请求 LOD，默认 `lods.length - 1` |
| `credit` | 字符串或 Cesium `Credit`；默认使用服务版权文字，自定义时仍保留服务版权署名 |
| `hasAlphaChannel` | 默认 `true`；不需要透明度时可设置 `false` |
| `tileDiscardPolicy` | 可选 Cesium 空白/缺失瓦片判定策略 |

`minimumLevel`、`maximumLevel` 均为 `lods` 的**数组索引**，不是服务的 `lod.level`。请求 URL 自动映射到实际服务级别。尽量保留默认 `minimumLevel=0`，避免一开始请求大量高层级瓦片。

### 属性与请求

Provider 提供 Cesium 所需的 `tileWidth`、`tileHeight`、`minimumLevel`、`maximumLevel`、`tilingScheme`、`rectangle`、`errorEvent`、`credit`、`hasAlphaChannel`、`tileDiscardPolicy`、`proxy`，以及 `url`、`token`、`ready`、`readyPromise`、`usingPrecachedTiles`。可选版权、代理和丢弃策略在未配置时可能为 `undefined`。

`requestImage(x,y,level,request)` 将 `x/y` 直接作为源列/行号，返回 Cesium `ImageryProvider.loadImage` 的结果。调度器限流时的 `undefined` 会原样返回。Provider 不增加第二套影像缓存，由 Cesium 负责影像复用、纹理和请求生命周期。配置自定义 `credit` 时，`getTileCredits` 保留服务的版权文字；否则无需额外瓦片署名。`pickFeatures` 返回 `undefined`，不支持要素拾取。

从服务目录复制的 `?f=json` / `?f=pjson` 参数不会传到瓦片请求；元数据请求单独使用 `f=pjson`，认证及其他查询参数保持传递。

独立导出的 `OffsetGeographicTilingScheme({ tileInfo, ellipsoid })` 继承 `GeographicTilingScheme`，另提供 `levelIds`、`resolutions`、`tileWidth`、`tileHeight`、`maximumLevel`。`tileXYToNativeRectangle` 返回度，`tileXYToRectangle` 返回弧度，均保留原始瓦片的完整范围。

## 真实服务接入排查

- **CORS / HTTPS**：元数据和瓦片端点都需要允许应用域跨域访问。HTTPS 页面应请求 HTTPS 服务；必要时使用应用自己的同源代理。
- **认证**：可用 `token` 或预先配置的 Cesium `Resource` 传入查询参数、请求头、代理等。token 更新和续期由应用管理，不要把凭据提交到仓库。
- **404 或空白**：检查实际 LOD 编号、`fullExtent` 及缓存是否完整；这个 Provider 不会自动退回 `/export`。服务以正常图片表示缺失时，可配置 `tileDiscardPolicy`；加载失败时 Cesium 可使用已有祖先影像。
- **定位偏差**：确认服务确实使用 4326，且 `origin`、`rows/cols`、每级 `resolution` 与元数据一致。不要截短单块瓦片的矩形。

## 验证与兼容性

仓库包含网格计算、父子索引、极区边界、请求路径、调度限流和 Cesium 影像纹理映射测试，以及使用本地诊断服务的 3D/2D 浏览器检查。浏览器检查通过地理位置采样比较实际像素颜色，覆盖日期变更线两侧与高纬区域。

GitHub Actions 在提交和拉取请求上执行同一套检查，并保存浏览器报告及截图，便于发现后续 Cesium 升级造成的兼容性变化。

**实际运行验证版本为 Cesium 1.146.0。** `peerDependencies` 的 `>=1.146.0 <2` 是允许安装的范围，不代表该范围内所有版本均已验证；升级 Cesium 后应重新运行完整检查。旧版本 Cesium 未验证，也不属于当前支持范围。

目前没有提供真实 ArcGIS 服务地址，验证基于模拟元数据与诊断图片。接入自己的服务后，还需要验证其缓存完整性、认证、跨域配置及业务区域的显示效果。

## 目录

```text
src/             Provider、切片方案与 TypeScript 类型
demo/            浏览器演示
test-support/    本地诊断 MapServer
tests/           单元测试与类型用法示例
scripts/         浏览器检查
```

MIT License。
