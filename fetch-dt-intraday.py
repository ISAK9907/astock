"""回填「标记日 · 当日跌停家数随时间」曲线 → dt-intraday.json

两遍扫描（baostock）：
  1) 全市场日线（覆盖所有标记日）→ 找出每个标记日的跌停个股，并记下当日 preclose/isST
  2) 对这些 (标记日, 个股) 取当日 5 分钟线 → 统计每根 5 分钟 bar 的跌停家数

为什么不用东财跌停池：该接口只保留最近约 7 个交易日，且只有「最后封板时间 lbt」而非
「首次触及」——北方铜业 09:40 就触及跌停、14:56 才最终封死，用 lbt 画曲线会系统性滞后。
baostock 5 分钟收盘价可以精确判定「该 5 分钟结束时是否封死跌停」。

两条曲线（同一遍扫描产出）：
  curve  当档封死家数（非单调）—— 15:00 那档应等于当日统计的跌停家数
  touch  累计首触家数（单调）—— 反映跌停扩散的速度

用法: python fetch-dt-intraday.py
"""
import json
import os
import socket
import sys
import time

import baostock as bs

socket.setdefaulttimeout(30)
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "dt-intraday.json")
N_SLOT = 48  # 09:35-11:30 (24) + 13:05-15:00 (24)


def slot_of(hhmm):
    """把 HHMM 映射到 48 档；不在交易时段返回 None"""
    t = int(hhmm[:2]) * 60 + int(hhmm[2:4])
    if 575 <= t <= 690:
        return (t - 575) // 5
    if 785 <= t <= 900:
        return 24 + (t - 785) // 5
    return None


def limit_pct(code6, is_st):
    if code6.startswith(("300", "301", "688")):
        return 20.0
    if code6.startswith(("8", "4")):
        return 30.0
    # is_st 是字符串，必须显式比较（"0" 在 Python 中为 truthy —— 曾因此把全部股票当 ST 按 5% 计算）
    return 5.0 if is_st == "1" else 10.0


def is_a_stock(code):
    p = code.split(".")
    if len(p) != 2:
        return False
    mkt, c = p
    if mkt == "sh":
        return c.startswith(("600", "601", "603", "605", "688"))
    if mkt == "sz":
        return c.startswith(("000", "001", "002", "003", "300", "301"))
    if mkt == "bj":
        return c.startswith(("4", "8"))
    return False


def fetch_daily(code, start, end):
    for _ in range(3):
        try:
            q = bs.query_history_k_data_plus(code, "date,close,preclose,isST",
                                             start_date=start, end_date=end, frequency="d", adjustflag="3")
            rows = []
            while q.error_code == "0" and q.next():
                rows.append(q.get_row_data())
            return rows
        except Exception:
            time.sleep(0.3)
    return []


def main():
    with open(os.path.join(ROOT, "dt-stats.json"), encoding="utf-8") as f:
        stats = json.load(f)
    # 两个易错点：
    #   1) dt-stats.json 的 "marked" 是「标记日数量」(int)，不是列表
    #   2) daily 的键已经是 ISO 格式 (2025-11-21)，不要再做 YYYYMMDD 切片
    marked_iso = sorted(k for k, v in stats["daily"].items() if v.get("score", 0) >= 1.25)
    n_by_day = {d: stats["daily"][d]["dt"] for d in marked_iso}

    # 增量：已有的标记日直接跳过；若全部已覆盖则立即退出（避免日更时白跑全市场扫描）
    existing = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                existing = json.load(f).get("days", {})
        except Exception:
            existing = {}
    todo = [d for d in marked_iso if d not in existing]
    if not todo:
        print(f"标记日 {len(marked_iso)} 个均已有曲线，无需回填（{OUT}）")
        return
    print(f"标记日 {len(marked_iso)} 个，其中 {len(todo)} 个待回填: {todo[0]} ~ {todo[-1]}", flush=True)
    marked_iso = todo
    marked_set = set(marked_iso)

    lg = bs.login()
    if lg.error_code != "0":
        print("login failed:", lg.error_msg)
        sys.exit(1)

    rs = bs.query_all_stock(day=marked_iso[-1])
    codes = []
    while rs.error_code == "0" and rs.next():
        c = rs.get_row_data()[0]
        if is_a_stock(c):
            codes.append(c)
    codes = sorted(set(codes))
    print(f"全市场 {len(codes)} 只", flush=True)

    # ---------- 第 1 遍：各标记日的跌停个股（连同 preclose）----------
    day_stocks = {d: [] for d in marked_iso}
    t0 = time.time()
    for k, code in enumerate(codes):
        rows = fetch_daily(code, marked_iso[0], marked_iso[-1])
        c6 = code.split(".")[-1]
        for d, close, preclose, is_st in rows:
            if d not in marked_set or not close or not preclose:
                continue
            pre, cl = float(preclose), float(close)
            if pre <= 0:
                continue
            lim = round(pre * (1 - limit_pct(c6, is_st) / 100.0), 2)
            if abs(cl - lim) < 0.005:
                day_stocks[d].append({"code": code, "preclose": pre, "isST": is_st})
        if (k + 1) % 500 == 0:
            el = time.time() - t0
            print(f"  [1/2] {k+1}/{len(codes)}  {el:.0f}s  剩余约 {el/(k+1)*(len(codes)-k-1)/60:.1f} 分钟", flush=True)

    pairs = [(d, s) for d in marked_iso for s in day_stocks[d]]
    print(f"第 1 遍完成({time.time()-t0:.0f}s)：{len(pairs)} 个 (日,股) 组合", flush=True)
    for d in marked_iso:
        print(f"   {d}  跌停股 {len(day_stocks[d]):>3} 只 / 统计口径 {n_by_day[d]}", flush=True)

    # ---------- 第 2 遍：5 分钟线 → 每档跌停家数 + 累计首触 ----------
    # 保留已算好的旧标记日，只补 todo 部分（增量写回，不能从空字典开始）
    out_days = dict(existing)
    t1 = time.time()
    for i, d in enumerate(marked_iso):
        curve = [0] * N_SLOT
        touched = [0] * N_SLOT
        used = 0
        for st in day_stocks[d]:
            code, c6 = st["code"], st["code"].split(".")[-1]
            lim = round(st["preclose"] * (1 - limit_pct(c6, st["isST"]) / 100.0), 2)
            q5 = bs.query_history_k_data_plus(code, "time,close", start_date=d, end_date=d,
                                              frequency="5", adjustflag="3")
            first = None
            rows = []
            while q5.error_code == "0" and q5.next():
                rows.append(q5.get_row_data())
            if not rows:
                continue
            used += 1
            for row in rows:
                sl = slot_of(row[0][8:12])
                if sl is None:
                    continue
                if abs(float(row[1]) - lim) < 0.005:
                    curve[sl] += 1
                    if first is None:
                        first = sl
            if first is not None:
                for sl in range(first, N_SLOT):
                    touched[sl] += 1
        out_days[d] = {
            "n": n_by_day[d],
            "found": len(day_stocks[d]),
            "used": used,
            "curve": curve,
            "touch": touched,
            "max": max(curve) if curve else 0,
        }
        print(f"   [{i+1}/{len(marked_iso)}] {d}  峰值 {max(curve):>3}  收盘档 {curve[-1]:>3}  首触总数 {touched[-1]:>3}"
              f"  (统计 {n_by_day[d]}, 有效 {used}/{len(day_stocks[d])})", flush=True)

    bs.logout()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "source": "baostock 5分钟线还原：curve=该 5 分钟 bar 收盘价等于跌停价的家数；touch=累计首触家数",
            "slots": N_SLOT,
            "days": out_days,
        }, f, ensure_ascii=False, indent=1)
    print(f"\nwrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
