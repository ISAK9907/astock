"""按分片统计每日「跌停家数 + 市值占比 + 市值分层 + 权重股跌停」（baostock 全市场逐股）
用法: python fetch-dtcounts.py <分片序号> <分片总数> <输出文件> [--limit N]

历史市值估算: 市值(D) = 当前流通市值 × 收盘(D) / 收盘(最新)
  —— 假设股本不变；锚点来自东财当前快照 caps.json
"""
import os
import sys
import json
import time
import glob
import socket
import baostock as bs

# 防止 baostock 会话异常时无限阻塞（并发下出现过卡死）
socket.setdefaulttimeout(30)

# 区间可由环境变量覆盖（不传则沿用原默认值，老调用方式完全不变）：
#   DT_START / DT_END —— 例如拉三年：DT_START=2023-09-01 DT_END=2026-09-24
START = os.environ.get("DT_START", "2025-05-01")   # 默认约 300 个交易日
END = os.environ.get("DT_END", "2026-09-17")
ROOT = os.path.dirname(os.path.abspath(__file__))

# 市值分层阈值（元）
BIG = 3e10     # >= 300 亿
MID = 5e9      # 50 亿 ~ 300 亿；以下为小盘

# 数值型字段（合并时求和）
NUM = ["dt", "n", "dtCap", "allCap", "big", "mid", "small", "mBig", "mMid", "mSmall", "mem", "memN", "noCap"]


def load_caps():
    with open(os.path.join(ROOT, "caps.json"), encoding="utf-8") as f:
        return {c["code"]: c["cap"] for c in json.load(f)["caps"]}


def load_members():
    with open(os.path.join(ROOT, "constituents.json"), encoding="utf-8") as f:
        j = json.load(f)
    s = set()
    for k in ("hs300", "zz500"):
        for m in j.get(k) or []:
            s.add(m["code"].split(".")[-1])
    return s


def limit_pct(code, is_st):
    c = code.split(".")[-1]
    if c.startswith(("300", "301", "688")):
        return 20.0
    if c.startswith(("8", "4")):
        return 30.0
    return 5.0 if is_st else 10.0


def is_a_stock(code):
    parts = code.split(".")
    if len(parts) != 2:
        return False
    mkt, c = parts
    if mkt == "sh":
        return c.startswith(("600", "601", "603", "605", "688"))
    if mkt == "sz":
        return c.startswith(("000", "001", "002", "003", "300", "301"))
    if mkt == "bj":
        return c.startswith(("4", "8"))
    return False


def main():
    shard = int(sys.argv[1])
    total = int(sys.argv[2])
    outfile = sys.argv[3]
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    caps = load_caps()
    members = load_members()

    lg = bs.login()
    if lg.error_code != "0":
        print(f"login failed: {lg.error_msg}", flush=True)
        sys.exit(1)

    rs = bs.query_all_stock(day=END)
    codes = []
    while rs.error_code == "0" and rs.next():
        code = rs.get_row_data()[0]
        if is_a_stock(code):
            codes.append(code)
    codes = sorted(set(codes))

    if "--fill" in sys.argv:
        # 补跑模式：最后一个分片的份额 + 各分片已记录的失败个股
        mine = list(codes[total - 1 :: total])
        for p in sorted(glob.glob(os.path.join(ROOT, "_sh*", "out.json"))):
            with open(p, encoding="utf-8") as f:
                mine += json.load(f).get("failed") or []
        mine = sorted(set(mine))
        print(f"[fill] 需补跑 {len(mine)} 只", flush=True)
    else:
        mine = codes[shard::total]
    if limit:
        mine = mine[:limit]
    print(f"[shard {shard}/{total}] 分配 {len(mine)} 只 (全市场 {len(codes)})", flush=True)
    sys.stdout.flush()

    counts = {}
    failed = []
    t0 = time.time()
    for k, code in enumerate(mine):
        c6 = code.split(".")[-1]
        rows = []
        for attempt in range(3):
            try:
                q = bs.query_history_k_data_plus(
                    code, "date,close,preclose,isST",
                    start_date=START, end_date=END, frequency="d", adjustflag="3",
                )
                if q.error_code == "0":
                    while q.next():
                        rows.append(q.get_row_data())
                    if rows:
                        break
            except Exception as e:
                print(f"  {code} 第{attempt+1}次异常: {e}", flush=True)
            time.sleep(0.3)
        if not rows:
            failed.append(code)
            continue

        cap_now = caps.get(c6)
        close_now = float(rows[-1][1]) if rows[-1][1] else None

        for d, close, preclose, is_st in rows:
            if not preclose or not close:
                continue
            pre, cl = float(preclose), float(close)
            if pre <= 0:
                continue
            pct = limit_pct(code, is_st == "1")
            limit_price = round(pre * (1 - pct / 100.0), 2)
            is_dt = abs(cl - limit_price) < 0.005

            # 历史流通市值（按价格比例缩放）
            cap = None
            if cap_now and close_now:
                cap = cap_now * cl / close_now

            rec = counts.setdefault(d, {x: 0 for x in NUM})
            rec["n"] += 1
            if cap:
                rec["allCap"] += cap
                bucket = "big" if cap >= BIG else "mid" if cap >= MID else "small"
                rec["m" + bucket[0].upper() + bucket[1:]] += 1
            else:
                rec["noCap"] += 1
            if c6 in members:
                rec["memN"] += 1
            if is_dt:
                rec["dt"] += 1
                if cap:
                    rec["dtCap"] += cap
                    bucket = "big" if cap >= BIG else "mid" if cap >= MID else "small"
                    rec[bucket] += 1
                if c6 in members:
                    rec["mem"] += 1

        if (k + 1) % 200 == 0:
            el = time.time() - t0
            print(f"  {k+1}/{len(mine)}  {el:.0f}s  剩余 {el/(k+1)*(len(mine)-k-1)/60:.1f} 分钟  失败 {len(failed)}", flush=True)

    bs.logout()
    with open(outfile, "w", encoding="utf-8") as f:
        json.dump({"counts": {d: v for d, v in sorted(counts.items())}, "failed": failed}, f)
    print(f"[shard {shard}/{total}] 完成，{len(counts)} 个交易日，失败 {len(failed)} → {outfile}", flush=True)


if __name__ == "__main__":
    main()
