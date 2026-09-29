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


def _save(days):
    """统一出口：只在真正有内容时写文件，避免把空字典盖掉已有历史。"""
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "source": "baostock 5分钟线还原：curve=该 5 分钟 bar 收盘价等于跌停价的家数；touch=累计首触家数",
            "slots": N_SLOT,
            "days": days,
        }, f, ensure_ascii=False, indent=1)
    print(f"\nwrote {OUT}（{len(days)} 天）", flush=True)


def marked_days(stats):
    """标记日 = 情绪分 sent 超过粉档门槛（分位制，窗口无关）。

    ⚠️ 这里原本写的是 `v.get("score", 0) >= 1.25` —— 一个**写死的绝对分门槛**，
    而看板（build-dashboard.mjs 的 markedDays）用的是 `sent >= tiers[0].sentLo`。
    两套标准会漂移：2026-09-28 当时 score=1.26 被选中并写了一条曲线，
    随后当日数据结算成 score=1.15，看板不再把它当标记日，这里却留着一条全零曲线。
    改成与看板同源（读 dt-stats.json 里的 tiers[0].sentLo），两边永远一致。
    读不到 tiers/sent 时才退回旧的绝对分门槛（老文件兼容）。
    """
    tiers = stats.get("tiers") or []
    if tiers and "sentLo" in tiers[0]:
        lo = tiers[0]["sentLo"]
        got = [k for k, v in stats["daily"].items() if v.get("sent") is not None and v["sent"] >= lo]
        if got:
            print(f"标记日判定：情绪分 ≥ {lo}（与看板同源），命中 {len(got)} 天")
            return sorted(got)
        print("⚠️ 按 sent 门槛一天都没命中，退回绝对分 score ≥ 1.25")
    return sorted(k for k, v in stats["daily"].items() if v.get("score", 0) >= 1.25)


def main():
    with open(os.path.join(ROOT, "dt-stats.json"), encoding="utf-8") as f:
        stats = json.load(f)
    # 两个易错点：
    #   1) dt-stats.json 的 "marked" 是「标记日数量」(int)，不是列表
    #   2) daily 的键已经是 ISO 格式 (2025-11-21)，不要再做 YYYYMMDD 切片
    marked_iso = marked_days(stats)
    n_by_day = {d: stats["daily"][d]["dt"] for d in marked_iso}

    # 增量：已有的标记日直接跳过；若全部已覆盖则立即退出（避免日更时白跑全市场扫描）
    existing = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                existing = json.load(f).get("days", {})
        except Exception:
            existing = {}
    # ⚠️ used=0 的条目是抓取失败的残渣（全零曲线），不能算「已覆盖」——
    #    否则那条曲线会永远留在文件里，而且每次日更都报「均已有曲线」把重试也挡掉。
    bad = [d for d, v in existing.items() if not v.get("used")]
    if bad:
        print(f"丢弃 {len(bad)} 条抓取失败的残渣条目（used=0）：{', '.join(sorted(bad))}")
        for d in bad:
            existing.pop(d, None)
    # 只保留当前仍是标记日的条目：窗口滑动后有些日子不再够格，留着是死数据
    drop = [d for d in existing if d not in set(marked_iso)]
    if drop:
        print(f"剔除 {len(drop)} 条已不再是标记日的旧曲线：{', '.join(sorted(drop))}")
        for d in drop:
            existing.pop(d, None)
    todo = [d for d in marked_iso if d not in existing]
    if not todo:
        print(f"标记日 {len(marked_iso)} 个均已有曲线，无需回填（{OUT}）")
        _save(existing)
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
        if used == 0:
            # 一只都没解析出来（baostock 当日 5 分钟线还没落地 / 全市场扫描没命中）
            # → 不写条目。写进去的话 used=0 的残渣会被当成「已覆盖」，永远不再重试。
            print(f"   [{i+1}/{len(marked_iso)}] {d}  ✗ 无有效个股（found={len(day_stocks[d])}），本次不写入，下次重试", flush=True)
            continue
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
    _save(out_days)


if __name__ == "__main__":
    main()
