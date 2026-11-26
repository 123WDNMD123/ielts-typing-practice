# -*- coding: utf-8 -*-
"""README 发布前自检：把「文档与版本是否对齐」变成可执行门禁，而不是靠自觉。

用法：
    python3 check-readme.py                      # 只做结构 + 内部一致性检查
    python3 check-readme.py --tag v2.2           # 额外确认 README 指向的就是要发布的版本
    python3 check-readme.py --tag v2.2 --strict  # 有任何 WARN 也算失败（发版推荐）

检查项分三层：
    A. 结构完整性 —— 代码围栏配对、表格列数一致、内部锚点都有对应标题
    B. 版本一致性 —— 首屏「当前发布版本」== 发布记录首行版本 == --tag
    C. 陈旧残留   —— 进位说明、latest 指向、发布记录缺链接

退出码 0 = 通过；1 = 有 FAIL（--strict 下 WARN 也算）。
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_README = os.path.abspath(os.path.join(HERE, "..", "..", "README.md"))

RESULT = []  # (level, group, name, detail)


def rec(level, group, name, detail=""):
    RESULT.append((level, group, name, detail))


def main():
    args = sys.argv[1:]
    want_tag = None
    strict = False
    path = DEFAULT_README
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--tag":
            if i + 1 >= len(args):
                print("FAIL: --tag 需要一个版本号，如 --tag v2.2")
                return 1
            want_tag = args[i + 1]
            i += 2
            continue
        if a == "--strict":
            strict = True
        elif not a.startswith("--"):
            path = a
        i += 1

    if not os.path.exists(path):
        print("FAIL: 找不到 README: %s" % path)
        return 1

    src = io.open(path, encoding="utf-8").read()
    lines = src.split("\n")
    print("README: %s  (%d B / %d 行)" % (path, len(src.encode("utf-8")), len(lines)))
    print("")

    # ---------- A. 结构完整性 ----------
    fences = [i + 1 for i, l in enumerate(lines) if l.strip().startswith("```")]
    if len(fences) % 2 == 0:
        rec("PASS", "A", "代码围栏配对", "%d 个" % len(fences))
    else:
        rec("FAIL", "A", "代码围栏配对", "%d 个（奇数，有未闭合的代码块）行号 %s" % (len(fences), fences))

    # 表格列数一致（连续 | 行成组）
    bad_tables = []
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("|"):
            j = i
            grp = []
            while j < len(lines) and lines[j].strip().startswith("|"):
                grp.append((j + 1, lines[j]))
                j += 1
            counts = {}
            for ln, txt in grp:
                n = len(re.findall(r"(?<!\\)\|", txt)) - 1
                counts.setdefault(n, []).append(ln)
            if len(counts) > 1:
                bad_tables.append((grp[0][0], {k: v[:3] for k, v in counts.items()}))
            i = j
        else:
            i += 1
    if not bad_tables:
        rec("PASS", "A", "表格列数一致", "全部表格列数统一")
    else:
        rec("FAIL", "A", "表格列数一致", "%d 处不一致，首个在第 %s 行" % (len(bad_tables), bad_tables[0][0]))

    # 内部锚点
    heads = set()
    for l in lines:
        m = re.match(r"^#{1,4}\s+(.*)$", l)
        if m:
            t = m.group(1).strip()
            t = re.sub(r"[^\w\u4e00-\u9fff\- ]", "", t).strip().replace(" ", "-").lower()
            heads.add(t)
    links = set(re.findall(r"\]\(#([^)]+)\)", src))
    missing = sorted(x for x in links if x not in heads)
    if not missing:
        rec("PASS", "A", "内部锚点", "%d 个全部有对应标题" % len(links))
    else:
        rec("FAIL", "A", "内部锚点", "缺失 %d 个：%s" % (len(missing), missing[:5]))

    # ---------- B. 版本一致性 ----------
    cur = re.search(r"当前发布版本\*\*：\[?\*\*?(v\d+\.\d+(?:\.\d+)?)", src)
    cur_ver = cur.group(1) if cur else None
    if cur_ver:
        rec("PASS", "B", "首屏声明当前版本", cur_ver)
    else:
        rec("FAIL", "B", "首屏声明当前版本", "没找到「当前发布版本」行")

    # 发布记录首行（跳过表头与分隔行：表头含「版本」、分隔行是 |---|）
    rec_ver = rec_link = None
    m = re.search(r"^#{2,4}\s*发布记录\s*$", src, re.M)
    if m:
        for l in src[m.end():].split("\n"):
            s = l.strip()
            if not s.startswith("|"):
                continue
            cells = [c.strip() for c in s.strip("|").split("|")]
            if not cells:
                continue
            first = cells[0]
            # 跳过表头（第一个单元格就是「版本」）与分隔行（----）
            if re.fullmatch(r":?-{2,}:?", first) or "版本" in first:
                continue
            lm = re.search(r"(v\d+\.\d+(?:\.\d+)?)", first)
            lm2 = re.search(r"\((https://github\.com/[^)\s]+/releases/tag/[^)\s]+)\)", s)
            if lm:
                rec_ver = lm.group(1)
                rec_link = lm2.group(1) if lm2 else None
                break

    if rec_ver:
        rec("PASS", "B", "发布记录首行版本", rec_ver + ("  (含 Release 链接)" if rec_link else "  ⚠ 无 Release 链接"))
        if not rec_link:
            rec("WARN", "B", "发布记录首行缺 Release 链接", rec_ver)
    else:
        rec("FAIL", "B", "发布记录首行版本", "解析不到")

    if cur_ver and rec_ver:
        if cur_ver == rec_ver:
            rec("PASS", "B", "首屏 == 发布记录首行", cur_ver)
        else:
            rec("FAIL", "B", "首屏 == 发布记录首行", "首屏 %s vs 记录 %s" % (cur_ver, rec_ver))

    if want_tag:
        tag = want_tag if want_tag.startswith("v") else "v" + want_tag
        if cur_ver == tag:
            rec("PASS", "B", "首屏 == 待发布 tag", tag)
        else:
            rec("FAIL", "B", "首屏 == 待发布 tag", "首屏 %s vs tag %s" % (cur_ver, tag))
        if rec_ver and rec_ver != tag:
            rec("FAIL", "B", "发布记录首行 == 待发布 tag", "记录 %s vs tag %s" % (rec_ver, tag))

    # ---------- C. 陈旧残留 ----------
    # 进位说明应指向「当前版本之后」
    delta = re.search(r"之后为\s*`?(v\d+\.\d+)`?", src)
    if delta and cur_ver:
        major, minor = cur_ver.lstrip("v").split(".")[:2]
        expect = "v%s.%d" % (major, int(minor) + 1)
        if delta.group(1) == expect:
            rec("PASS", "C", "进位说明指向下一版", delta.group(1))
        else:
            rec("FAIL", "C", "进位说明指向下一版", "写了 %s，应为 %s" % (delta.group(1), expect))

    # 不应出现的「当前发布版本」为旧版
    stale = re.findall(r"当前发布版本\*\*：\[?\*\*?(v\d+\.\d+(?:\.\d+)?)", src)
    if len(set(stale)) > 1:
        rec("FAIL", "C", "首屏版本自相矛盾", str(set(stale)))

    # latest 链接存在
    if "releases/latest" in src:
        rec("PASS", "C", "含 releases/latest 入口", "")
    else:
        rec("WARN", "C", "缺 releases/latest 入口", "")

    # ---------- 输出 ----------
    for level, group, name, detail in RESULT:
        print("%-4s [%s] %-28s %s" % (level, group, name, detail))

    fails = [r for r in RESULT if r[0] == "FAIL"]
    warns = [r for r in RESULT if r[0] == "WARN"]
    print("")
    print("小计: %d 项，FAIL %d，WARN %d" % (len(RESULT), len(fails), len(warns)))
    if fails:
        print("结论: FAIL —— 文档与版本未对齐，先修再发布")
        return 1
    if warns and strict:
        print("结论: FAIL(--strict) —— 有 WARN 需处理")
        return 1
    print("结论: PASS —— README 与版本一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())