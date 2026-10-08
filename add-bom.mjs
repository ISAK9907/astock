// 给文本文件加 UTF-8 BOM。
// 为什么需要：Windows PowerShell 5.1（本机只有 5.1，没有 pwsh）读取**无 BOM 的 UTF-8** 文件时，
// 会按系统 ANSI 代码页（这里是 GBK）解码。后果不只是中文变乱码 ——
// GBK 是双字节编码，误解码会把后续字节（含引号、括号）一起吃掉，
// 于是 .ps1 直接语法错误，报出来的错还完全指不到真正的原因
// （实测：报 "Unexpected token '}'"，而真正原因是中文注释被拆错了字节）。
// .ps1 / .cmd 里带非 ASCII 就必须加 BOM；只含 ASCII 的文件加不加都一样，不必加。
import { readFileSync, writeFileSync } from 'node:fs';

const BOM = '\uFEFF';
let changed = 0;
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f, 'utf8');
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const nonAscii = [...raw].some((c) => c.charCodeAt(0) > 127);
  if (hasBom) {
    console.log(`  = ${f} 已有 BOM`);
    continue;
  }
  if (!nonAscii) {
    console.log(`  - ${f} 全 ASCII，不需要 BOM`);
    continue;
  }
  writeFileSync(f, BOM + raw, 'utf8');
  console.log(`  ✓ ${f} 已加 UTF-8 BOM（含非 ASCII 字符）`);
  changed++;
}
console.log(changed ? `加了 ${changed} 个文件` : '没有文件需要改');
