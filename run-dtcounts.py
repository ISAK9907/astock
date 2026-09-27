"""并行启动 N 个分片统计每日跌停家数，全部结束后合并。
用 Python 编排（本机是 PowerShell 5.1 且禁用了 .ps1，不适合做编排层）。
"""
import os
import sys
import json
import glob
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
# 都可被环境变量覆盖，便于「只跑扫描存档、不覆盖现有 dt-counts.json」：
#   DT_SHARDS        分片数（默认 5）
#   DT_SHARD_PREFIX  分片工作目录前缀（默认 _sh）
#   DT_OUT           合并结果文件名（默认 dt-counts.json）
#   DT_START/DT_END  透传给 fetch-dtcounts.py 的区间
SHARDS = int(os.environ.get("DT_SHARDS", "5"))
PREFIX = os.environ.get("DT_SHARD_PREFIX", "_sh")
OUT_NAME = os.environ.get("DT_OUT", "dt-counts.json")


def main():
    procs = []
    for i in range(1, SHARDS + 1):
        d = os.path.join(ROOT, f"{PREFIX}{i}")
        os.makedirs(d, exist_ok=True)
        for f in ("out.json", "log.txt", "err.txt"):
            p = os.path.join(d, f)
            if os.path.exists(p):
                os.remove(p)
        log = open(os.path.join(d, "log.txt"), "w", encoding="utf-8")
        err = open(os.path.join(d, "err.txt"), "w", encoding="utf-8")
        p = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "fetch-dtcounts.py"), str(i), str(SHARDS), "out.json"],
            cwd=d,
            stdout=log,
            stderr=err,
        )
        procs.append((i, p, log, err))
        print(f"shard {i} started pid={p.pid}", flush=True)

    for i, p, log, err in procs:
        p.wait()
        log.close()
        err.close()
        print(f"shard {i} exit={p.returncode}", flush=True)

    # 合并
    total = {}
    failed = []
    for path in sorted(glob.glob(os.path.join(ROOT, f"{PREFIX}*", "out.json"))):
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
    with open(os.path.join(ROOT, OUT_NAME), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n已写入 {OUT_NAME}（区间 {os.environ.get('DT_START', '默认')} ~ {os.environ.get('DT_END', '默认')}）", flush=True)

    print(f"\n交易日 {len(total)}，失败个股 {len(failed)}", flush=True)
    ns = [v["n"] for v in total.values()]
    if ns:
        print(f"每日样本数: 最小 {min(ns)} / 最大 {max(ns)}", flush=True)
    print("\n市值占比最高的 10 天:", flush=True)
    top = sorted(total.items(), key=lambda kv: -(kv[1]["dtCap"] / kv[1]["allCap"] if kv[1]["allCap"] else 0))[:10]
    for d, v in top:
        share = v["dtCap"] / v["allCap"] * 100 if v["allCap"] else 0
        print(
            f"  {d}  跌停 {v['dt']:4d}家  市值占比 {share:5.2f}%  "
            f"大{v['big']:3d}/中{v['mid']:3d}/小{v['small']:4d}  权重股 {v['mem']:2d}",
            flush=True,
        )


if __name__ == "__main__":
    main()
