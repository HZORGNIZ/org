// 第三方二维码生成库（qrcode-generator 2.0.4，MIT，Kazuhiko Arase）的类型声明。
// 库文件随仓库内置于同目录 qrcode-generator.mjs（无外网/无 npm 依赖），此处只声明本项目用到的部分。
declare module '*/qrcode-generator.mjs' {
  export interface QRCodeInstance {
    addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
    createSvgTag(cellSize?: number, margin?: number): string;
    createSvgTag(opts?: { cellSize?: number; margin?: number; scalable?: boolean }): string;
    createDataURL(cellSize?: number, margin?: number): string;
  }
  export function qrcode(typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QRCodeInstance;
  export default qrcode;
}
