// 把 reference.html（损坏前最后一次成功构建）与当前构建做「可见文本 + 关键属性」对照
// 找出修复过程中可能遗漏或改错的中文字符串
import { readFileSync } from 'node:fs';

const text = (f) => {
  let h = readFileSync(f, 'utf8');
  h = h.replace(/<script[\s\S]*?<\/script>/g, '\u0001'); // 脚本单独比
  h = h.replace(/<style[\s\S]*?<\/style>/g, '\u0002');
  h = h.replace(/<[^>]+>/g, ' ');
  return h
    .split(/[\s\u0001\u0002]+/)
    .filter((w) => /[\u4e00-\u9fff]/.test(w)) // 只比含中文的词
    .join('\n');
};

const a = text('.shot/reference.html').split('\n');
const b = text('astock-dashboard.html').split('\n');
const setB = new Map();
b.forEach((w) => setB.set(w, (setB.get(w) ?? 0) + 1));
const setA = new Map();
a.forEach((w) => setA.set(w, (setA.get(w) ?? 0) + 1));

const onlyA = [...setA].filter(([w, n]) => (setB.get(w) ?? 0) < n);
const onlyB = [...setB].filter(([w, n]) => (setA.get(w) ?? 0) < n);
console.log(`参考独有词 ${onlyA.length} 个；当前独有词 ${onlyB.length} 个\n`);
console.log('--- 当前构建新增（这些是本轮有意改动）---');
console.log(onlyB.map(([w, n]) => `${w}×${n}`).join('  '));
console.log('\n--- 参考里有、当前丢了（疑似修复遗漏）---');
console.log(onlyA.map(([w, n]) => `${w}×${n}`).join('  '));
