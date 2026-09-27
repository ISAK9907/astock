"""合并所有分片 + 补跑结果 → dt-counts.json"""
import os
import json
import glob

ROOT = os.path.dirname(os.path.abspath(__file__))

paths = sorted(glob.glob(os.path.join(ROOT, "_sh*", "out.json"))) + sorted(glob.glob(os.path.join(ROOT, "_fill", "out.json")))
print("参与合并的分片:")
for p in paths:
    with open(p, encoding="utf-8") as f:
        j = json.load(f)
    d0 = sorted(j.get("counts") or {})[-1:] or ["-"]
    sample = (j["counts"][d0[0]]["n"] if d0[0] != "-" else 0)
    print(f"  {os.path.relpath(p, ROOT)}  末日样本 {sample}")

total = {}
failed = []
for path in paths:
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
print(f"\n交易日 {len(total)}，失败个股 {len(failed)}")
print(f"每日样本数: 最小 {min(ns)} / 最大 {max(ns)} / 中位 {sorted(ns)[len(ns)//2]}")
print("\n市值占比最高的 10 天:")
for d, v in sorted(total.items(), key=lambda kv: -(kv[1]["dtCap"] / kv[1]["allCap"] if kv[1]["allCap"] else 0))[:10]:
    share = v["dtCap"] / v["allCap"] * 100 if v["allCap"] else 0
    print(f"  {d}  跌停 {v['dt']:4d}家  市值占比 {share:5.2f}%  大{v['big']:3d}/中{v['mid']:3d}/小{v['small']:4d}  权重股 {v['mem']:2d}")
