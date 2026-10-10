/**
 * 应用图标生成器：**唯一的人工输入是下面这段 SVG**，PNG 与 ICO 全是它的派生物。
 * 改图标 = 改 SVG，然后跑 `pnpm icons:generate`（不要手改 public/icons 下的 PNG）。
 *
 * 为什么用 sharp：它是 Next 15 的可选依赖（`next` 的 optionalDependencies 里就有，
 * 本机与容器都已装好），自带 librsvg 与各平台预编译二进制，不需要 ImageMagick / Inkscape。
 * 已按 NFR-9 登记到 THIRD-PARTY-NOTICES.md（Apache-2.0，无 GPL 传染项）。
 *
 * 产出与用途：
 *   public/icons/icon.svg             矢量源 + 现代浏览器的 favicon（缩放不糊）
 *   public/icons/icon-192.png         Android 加到主屏 / 通用
 *   public/icons/icon-512.png         高清图标（安装提示等）
 *   public/icons/apple-touch-icon.png 180×180，iOS 主屏；**满幅不透明**（iOS 自己切圆角，
 *                                     带透明圆角会被填成黑底）
 *   public/favicon.ico                16/32/48 多尺寸，给不看 <link> 的客户端兜底
 *
 * 设计取舍：手机标签页里只有 16px，所以只用粗轮廓（哑铃），不写字、不加细节；
 * 配色直接取应用的设计令牌（--accent 的深浅两端），保证与界面同一套色。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_DIR = join(ROOT, "public", "icons");

/** 画布 512×512；圆角 112 ≈ 22%，常见的 squircle 观感 */
const CANVAS = 512;
const TILE_RADIUS = 112;

/**
 * 哑铃的几何：五个白色形状叠在一起（外片 / 内片 / 横杆 / 内片 / 外片）。
 * 横杆两端故意插进内片里（186→326），白色叠白色 = 无缝并集，拼接处不会露缝。
 * 整体 296×212、居中并四边留白，缩到 16px 的标签页里也还认得出；这组比例是拿
 * 几个候选（两段光杆 / 缓阶 / 宽外片）在 16 / 48 / 256 三个尺寸上比过之后定的。
 * 留白同时满足 Android maskable 的安全区（中间 80% 的圆，本图形对角线 182 < 205）。
 */
const PLATES = [
  { x: 108, y: 150, w: 60, h: 212, rx: 30 }, // 左外片
  { x: 168, y: 180, w: 48, h: 152, rx: 24 }, // 左内片
  { x: 186, y: 212, w: 140, h: 88, rx: 0 }, // 横杆（两端藏在两片内片下面）
  { x: 296, y: 180, w: 48, h: 152, rx: 24 }, // 右内片
  { x: 344, y: 150, w: 60, h: 212, rx: 30 }, // 右外片
];

/**
 * @param {number} size 输出边长（写进 width/height，让 librsvg 按目标尺寸直接采样，比事后缩放锐利）
 * @param {object} [opts]
 * @param {boolean} [opts.rounded] 是否切圆角。favicon / 通用图标要切；apple-touch-icon 与 maskable 要满幅
 * @param {number} [opts.glyphScale] 哑铃整体缩放（绕画布中心）。maskable 用，见下方说明
 */
function iconSvg(size, { rounded = true, glyphScale = 1 } = {}) {
  const rx = rounded ? TILE_RADIUS : 0;
  const shapes = PLATES.map((p) => {
    const round = p.rx ? ` rx="${p.rx}"` : "";
    return `    <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"${round}/>`;
  }).join("\n");
  // 绕中心缩放：maskable 图标会被系统裁成圆形 / 水滴 / 圆角方形等各种形状，
  // 图形要退到中间 80% 的安全区里才不会被裁掉边角
  const scale =
    glyphScale === 1
      ? ""
      : ` transform="translate(${CANVAS / 2} ${CANVAS / 2}) scale(${glyphScale}) translate(${-CANVAS / 2} ${-CANVAS / 2})"`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${size}" height="${size}" role="img" aria-label="健身助手">
  <defs>
    <!-- 光源在左上角：从设计令牌里的深色态 accent 渐变到浅色态 accent，再压深一档收边 -->
    <radialGradient id="tile" cx="0.3" cy="0.12" r="1.1">
      <stop offset="0" stop-color="#6b93ff"/>
      <stop offset="0.55" stop-color="#2f6bff"/>
      <stop offset="1" stop-color="#1b3fae"/>
    </radialGradient>
  </defs>
  <rect width="${CANVAS}" height="${CANVAS}" rx="${rx}" fill="url(#tile)"/>
  <g fill="#ffffff"${scale}>
${shapes}
  </g>
</svg>
`;
}

/** 把若干张 PNG 打包成 ICO（Vista 起支持内嵌 PNG，浏览器全支持） */
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at); // 0 表示 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2); // 调色板数（真彩不用）
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // 颜色平面
    dir.writeUInt16LE(32, at + 6); // 位深
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

async function render(size, opts) {
  return sharp(Buffer.from(iconSvg(size, opts)))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  await mkdir(ICON_DIR, { recursive: true });

  const svg = iconSvg(CANVAS);
  await writeFile(join(ICON_DIR, "icon.svg"), svg, "utf8");

  const pngs = [
    ["icon-192.png", await render(192)],
    ["icon-512.png", await render(512)],
    // iOS 主屏：满幅、不透明（圆角由系统切）
    ["apple-touch-icon.png", await render(180, { rounded: false })],
    // Android 自适应图标：同样满幅，哑铃再缩到 0.86，保证被裁成圆形 / 水滴 / 方圆形时都不缺角
    ["icon-maskable-512.png", await render(512, { rounded: false, glyphScale: 0.86 })],
  ];
  for (const [name, data] of pngs) {
    await writeFile(join(ICON_DIR, name), data);
    console.log(`✓ public/icons/${name}  ${data.length} B`);
  }

  const faviconEntries = [];
  for (const size of [16, 32, 48]) {
    faviconEntries.push({ size, data: await render(size) });
  }
  const ico = packIco(faviconEntries);
  await writeFile(join(ROOT, "public", "favicon.ico"), ico);
  console.log(`✓ public/favicon.ico  ${ico.length} B（16/32/48）`);
  console.log(`✓ public/icons/icon.svg  ${Buffer.byteLength(svg)} B`);
}

await main();
