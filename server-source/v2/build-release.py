# -*- coding: utf-8 -*-
"""
发布构建：剥离 JS 注释以压回 gzip 体积，源码保留完整文档。

为什么需要：v2.0 重写引入大量说明性注释（记录历史坑、有意差异、契约顺序），
app.js 注释占 16.5%（28KB），gzip 从 186KB 涨到 200KB。注释对开发者有价值，
但不该让终端用户下载。故源码保留、发布产物剥离。

安全约束（不做通用 JS 解析，只处理确定安全的情形）：
  · 只剥【独占整行】的注释行与块注释，不动行尾注释
    —— 行尾注释可能紧跟正则/字符串，误判风险高
  · 块注释必须整块独占若干行（起止行都只有注释内容）
  · 保留所有含 @license/@preserve/#! 的注释
  · 跳过字符串/正则/模板串内部的行 —— 用逐字符状态机识别，不用正则猜

产出与打包（一步完成，可直接作发布暂存区）：
  python3 build-release.py [输出目录]     # 默认 <本目录>/release

  输出目录内是完整的七文件发布包：六个前端文件（三个 JS 已剥注释，
  index.html/tokens.css/app.css 原样复制）+ server.py（取自上级目录）。
  该目录可直接喂给 deploy-v2.server.sh 作暂存区。

剥离安全性由 verify-strip.js 把关（浏览器内逐函数体比对），
发布前必须跑一次并确认 ALL PASS。
"""
import io, os, re, sys, gzip, json, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = HERE
DIST = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "release")
TARGETS = ["app.js", "motion.js", "data.js"]
COPY_AS_IS = ["index.html", "tokens.css", "app.css"]


def scan_line_states(line, in_block, in_template):
    """返回该行中处于「代码上下文」的字符掩码。
    简化但保守：逐字符跟踪 单引号/双引号/模板串/行注释/块注释/正则。
    正则识别用前一个有效 token 判断（避免把除号当正则）。
    """
    mask = []
    i = 0
    n = len(line)
    quote = None
    prev_sig = ""
    while i < n:
        c = line[i]
        nxt = line[i + 1] if i + 1 < n else ""
        if in_block:
            mask.append(False)
            if c == "*" and nxt == "/":
                mask.append(False)
                i += 2
                in_block = False
                continue
            i += 1
            continue
        if quote:
            mask.append(False)
            if c == "\\":
                if i + 1 < n:
                    mask.append(False)
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if in_template:
            mask.append(False)
            if c == "\\":
                if i + 1 < n:
                    mask.append(False)
                i += 2
                continue
            if c == "`":
                in_template = False
            i += 1
            continue
        # 代码上下文
        if c == "/" and nxt == "/":
            # 行注释：其后全部非代码
            mask.extend([False] * (n - i))
            break
        if c == "/" and nxt == "*":
            in_block = True
            mask.append(False)
            mask.append(False)
            i += 2
            continue
        if c in "'\"":
            quote = c
            mask.append(False)
            i += 1
            continue
        if c == "`":
            in_template = True
            mask.append(False)
            i += 1
            continue
        if c == "/" and prev_sig in ("", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "return"):
            # 正则字面量：吃到未转义的收尾 /
            mask.append(False)
            i += 1
            while i < n:
                cc = line[i]
                mask.append(False)
                if cc == "\\":
                    if i + 1 < n:
                        mask.append(False)
                    i += 2
                    continue
                if cc == "[":
                    i += 1
                    while i < n:
                        mask.append(False)
                        if line[i] == "\\":
                            if i + 1 < n:
                                mask.append(False)
                            i += 2
                            continue
                        if line[i] == "]":
                            break
                        i += 1
                if cc == "/":
                    i += 1
                    break
                i += 1
            continue
        mask.append(True)
        if not c.isspace():
            prev_sig = c
        i += 1
    return mask, in_block, in_template


def strip_js(src):
    lines = src.split("\n")
    in_block = False
    in_template = False
    keep = []
    removed_bytes = 0
    for ln in lines:
        mask, nb, nt = scan_line_states(ln, in_block, in_template)
        # 该行是否有「代码」字符（非空白且掩码为 True）
        has_code = any(mask[k] and not ln[k].isspace() for k in range(min(len(mask), len(ln))))
        stripped = ln.strip()
        is_comment_only = (not has_code) and (
            stripped.startswith("//") or stripped.startswith("/*")
            or stripped.startswith("*") or stripped.startswith("*/")
            or in_block or stripped == ""
        )
        # 保留 license / preserve
        if re.search(r"@license|@preserve|^#!", ln):
            keep.append(ln)
            in_block, in_template = nb, nt
            continue
        if is_comment_only and stripped != "":
            removed_bytes += len(ln.encode("utf-8")) + 1
            in_block, in_template = nb, nt
            continue
        keep.append(ln)
        in_block, in_template = nb, nt
    return "\n".join(keep), removed_bytes


def gz(b):
    return len(gzip.compress(b, compresslevel=6))


def main():
    os.makedirs(DIST, exist_ok=True)
    report = []
    for name in TARGETS:
        p = os.path.join(SRC, name)
        src = io.open(p, encoding="utf-8").read()
        out, removed = strip_js(src)
        sb = src.encode("utf-8")
        ob = out.encode("utf-8")
        io.open(os.path.join(DIST, name), "w", encoding="utf-8", newline="").write(out)
        rec = {"file": name, "src_bytes": len(sb), "dist_bytes": len(ob),
               "removed": len(sb) - len(ob), "src_gzip": gz(sb), "dist_gzip": gz(ob)}
        report.append(rec)
        print("%-11s %7d → %7d B  (-%5d)   gzip %6d → %6d  (-%4d)" % (
            name, rec["src_bytes"], rec["dist_bytes"], rec["removed"],
            rec["src_gzip"], rec["dist_gzip"], rec["src_gzip"] - rec["dist_gzip"]))
    io.open(os.path.join(DIST, "_strip-report.json"), "w", encoding="utf-8").write(
        json.dumps(report, ensure_ascii=False, indent=1))
    print("\n合计 gzip 节省:", sum(r["src_gzip"] - r["dist_gzip"] for r in report), "B")
    # 补齐发布包其余四文件：三个静态文件原样复制 + server.py 取自上级目录
    for name in COPY_AS_IS:
        shutil.copyfile(os.path.join(SRC, name), os.path.join(DIST, name))
    shutil.copyfile(os.path.join(os.path.dirname(SRC), "server.py"),
                    os.path.join(DIST, "server.py"))
    print("发布包就绪（七文件）:", DIST)

    # 门禁随包携带：README + 自检脚本。它们不进公网静态目录（部署脚本只
    # 复制 FRONT_FILES 那六个文件），只在暂存区供 deploy-v2.server.sh 第
    # 3.5 步校验「文档版本 == 本次发布版本」。
    repo_root = os.path.abspath(os.path.join(SRC, "..", ".."))
    readme = os.path.join(repo_root, "README.md")
    checker = os.path.join(SRC, "check-readme.py")
    carried = []
    if os.path.isfile(readme):
        shutil.copyfile(readme, os.path.join(DIST, "README.md"))
        carried.append("README.md")
    if os.path.isfile(checker):
        shutil.copyfile(checker, os.path.join(DIST, "check-readme.py"))
        carried.append("check-readme.py")
    if carried:
        print("门禁材料随包:", ", ".join(carried), "（不入 public，仅供发布校验）")
    else:
        print("警告: 未找到 README.md 或 check-readme.py，发布时将跳过 README 门禁")

    print("下一步: 跑 verify-strip.js 确认剥离安全，再打包传输执行 deploy-v2.server.sh <staging> <version>")


if __name__ == "__main__":
    main()
