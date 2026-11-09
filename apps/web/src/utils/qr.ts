import qrcode from '../vendor/qrcode-generator.mjs';

/**
 * 生成 SVG 二维码字符串（纯前端、无网络依赖）
 * - 内容为签到链接等 ASCII 文本，用 Byte 模式即可
 * - 容错级别 M：投影/打印后仍可扫；scalable 让 SVG 自适应容器宽度
 */
export function qrSvg(text: string, opts: { cellSize?: number; margin?: number } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(String(text ?? ''), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize: opts.cellSize ?? 6, margin: opts.margin ?? 3, scalable: true });
}

/**
 * 生成 PNG 二维码（data URL）
 * - 用在需要「长按识别 / 保存图片」的场合：SVG 在微信里长按无法识别
 */
export function qrDataUrl(text: string, opts: { cellSize?: number; margin?: number } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(String(text ?? ''), 'Byte');
  qr.make();
  return qr.createDataURL(opts.cellSize ?? 8, opts.margin ?? 2);
}
