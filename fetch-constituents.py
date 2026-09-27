"""取沪深300 / 中证500 成分股名单（方案 F 用）"""
import json
import baostock as bs

lg = bs.login()
if lg.error_code != "0":
    raise SystemExit(f"login failed: {lg.error_msg}")

out = {}
for name, fn in [("hs300", bs.query_hs300_stocks), ("zz500", bs.query_zz500_stocks)]:
    rs = fn()
    rows = []
    while rs.error_code == "0" and rs.next():
        rows.append(rs.get_row_data())
    out[name] = [{"code": r[1], "name": r[2], "updateDate": r[0]} for r in rows]
    print(f"{name}: {len(rows)} 只  更新日 {rows[0][0] if rows else '-'}")

bs.logout()
with open("constituents.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("wrote constituents.json")
