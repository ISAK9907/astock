// 推送归档：把每天生成的推送正文存下来，供看板顶部的日期滚轮回看
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = 'push-archive.json';
const MAX = 240; // 约一年

export function readArchive() {
  if (!existsSync(FILE)) return [];
  try { const a = JSON.parse(readFileSync(FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** kind: 'close' | 'premarket'。同一天同一 kind 覆盖写 */
export function appendPush(kind, title, body, date) {
  const d = date || new Date();
  const iso = typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const list = readArchive().filter((x) => !(x.date === iso && x.kind === kind));
  list.push({ date: iso, kind, ts: new Date().toISOString(), title, body });
  list.sort((a, b) => (a.date === b.date ? (a.kind === 'premarket' ? -1 : 1) : a.date < b.date ? -1 : 1));
  writeFileSync(FILE, JSON.stringify(list.slice(-MAX), null, 0), 'utf8');
  return list.length;
}
