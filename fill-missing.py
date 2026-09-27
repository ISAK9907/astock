"""补跑缺失个股（分片5 份额 + 已记录失败），串行执行避免并发卡死，完成后重新合并。"""
import os
import sys
import json
import glob
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(ROOT, "_fill")
os.makedirs(D, exist_ok=True)

print("=== 补跑缺失个股（串行）===", flush=True)
log = open(os.path.join(D, "log.txt"), "w", encoding="utf-8")
p = subprocess.Popen(
    [sys.executable, os.path.join(ROOT, "fetch-dtcounts.py"), "5", "5", "out.json", "--fill"],
    cwd=D, stdout=log, stderr=subprocess.STDOUT,
)
p.wait()
log.close()
print(f"补跑结束 exit={p.returncode}", flush=True)

# 重新合并（含补跑结果）
total = {}
failed = []
for path in sorted(glob.glob(os.path.join(ROOT, "_s*", "out.json"))):
    with open(path, encoding="utf-8") as f:
        j = json.load(f)
    for d, rec in (j.get("counts") or {}).items():
        t = total.setdefault(d, {})
        for k, v in rec.items():
            t[k] = t.get(k, 0) + v
    failed += j.get("failed") or []

out = {
    "source": "baostock",
    "note": (
        "跌停判定：收盘价 == round(昨收*(1-限制幅度),2)；主板10%/双创20%/北交所30%/ST 5%。"
        "历史流通市值 = 当前流通市值 × 当日收盘/最新收盘（假设股本不变）。"
        "权重股 = 沪深300+中证500 成分（当前名单）。"
    ),
    "counts": {d: v for d, v in sorted(total.items())},
    "failed": failed,
}
with open(os.path.join(ROOT, "dt-counts.json"), "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

ns = [v["n"] for v in total.values()]
print(f"\n交易日 {len(total)}，失败个股 {len(failed)}", flush=True)
if ns:
    print(f"每日样本数: 最小 {min(ns)} / 最大 {max(ns)}", flush=True)
print("\n市值占比最高的 10 天:", flush=True)
for d, v in sorted(total.items(), key=lambda kv: -(kv[1]["dtCap"] / kv[1]["allCap"] if kv[1]["allCap"] else 0))[:10]:
    share = v["dtCap"] / v["allCap"] * 100 if v["allCap"] else 0
    print(
        f"  {d}  跌停 {v['dt']:4d}家  市值占比 {share:5.2f}%  大{v['big']:3d}/中{v['mid']:3d}/小{v['small']:4d}  权重股 {v['mem']:2d}",
        flush=True,
    )
