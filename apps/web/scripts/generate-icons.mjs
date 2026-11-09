// 生成 PWA 图标（icon-192.png / icon-512.png / apple-touch-icon）
// 用法：pnpm --filter web icons
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'icons');
await mkdir(outDir, { recursive: true });

// 品牌 SVG：蓝色圆角底 + 白色 "M" + 橙色圆点（协作感）
const svg = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#409EFF"/>
      <stop offset="100%" stop-color="#2b6fd4"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <text x="256" y="340" font-family="Arial, Helvetica, sans-serif" font-size="300" font-weight="800"
        fill="#ffffff" text-anchor="middle" dominant-baseline="middle">M</text>
  <circle cx="392" cy="140" r="52" fill="#FFB84D"/>
</svg>`;

const tasks = [192, 512].map(async (size) => {
  await sharp(Buffer.from(svg(size)))
    .png()
    .toFile(join(outDir, `icon-${size}.png`));
  console.log(`icon-${size}.png 已生成`);
});

await Promise.all(tasks);
// apple-touch-icon 用 180x180
await sharp(Buffer.from(svg(180))).png().toFile(join(outDir, 'apple-touch-icon.png'));
console.log('apple-touch-icon.png 已生成');

// 占位 manifest.webmanifest 由 vite-plugin-pwa 自动生成，无需手动创建
console.log('PWA 图标生成完成');
