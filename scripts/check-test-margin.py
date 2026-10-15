#!/usr/bin/env python3
"""单条测试的「余量」必须能被看见 —— 默认 20000ms 不写在源码里。

## 为什么（#1627）

bun 的默认单条超时是 **20000ms**，而这个数字**不出现在任何测试源码里**。于是：

  · 源码里 grep `timeout` 一无所获，看起来「这条测试没有超时问题」；
  · 一台慢 1.8 倍的 runner 会让贴着上限的测试变红，报错读起来**和真缺陷一模一样**
    —— `[20832.89ms]` 的**下一行**才是 `^ this test timed out after 20000ms.`。

2026-08-31 一天里三批红（`agent-node unit`、`test686-rest-shape-golden`、以及一个
**只改两个 .md 的纯文档 PR**）全是这个形状。

仓库里已经有 `L1-TIMING v1`（`scripts/qa.sh`），但它是**套件**粒度；
而这个失效模式发生在**单条测试**上 —— 套件级仪表看不见它。

## 判据：占**有效**超时的百分比，不是占默认值的百分比

「有效超时」= 该条自己声明的 timeout，否则它所在 `describe` 声明的，否则默认 20000ms。

🔴 这一条不是洁癖，是本脚本第一版踩过的坑：按「占默认 20000ms」排序，会
把一条**自己声明了 `}, 60_000)`** 的测试（实测 18069ms）报成「90.3%、危险」——
而它真实余量是 3.3 倍。**任何忽略声明值的余量排序，都会把已经修好的测试误报成高危。**

## 用法

    python3 scripts/check-test-margin.py --logs '/tmp/qa-l0-*.log' '/tmp/qa-l1-*-run.log'
    python3 scripts/check-test-margin.py --logs job.log --pct 50
    python3 scripts/check-test-margin.py --logs job.log --fail     # 有贴上限的 → 退出 1
    python3 scripts/check-test-margin.py --selftest                # 用内嵌夹具自证（不读日志）

默认 **report-only**（退出 0）；阈值用 `--pct` 或环境变量 `TEST_MARGIN_PCT` 覆盖。
`--logs` 可以给任意文本（GitHub job 全文也可以 —— 它就是所有 per-suite 日志的拼接）。

## 输出

一行固定形状，跨 run 可比，与 `L1-TIMING v1` 同族（**字段顺序定了就别改**，
改了之前所有 run 的日志就对不上）：

    TEST-MARGIN v1 tests=<n> hooks=<m> threshold=50% near=<k> slowest=<slug>=<pct>%,...

`near>0` 时再逐条打印 `耗时 / 有效超时 / 占比 / 源码位置`。

## 覆盖边界（诚实声明）

只能看见**跑过的**测试，而且只解析**静态可读**的标题（模板字面量里含 `${}` 的
标题取不到，会退回默认 20000ms —— 这是**偏保守**的方向：只会多报，不会漏报）。
`tests=` 字段就是本次样本量，判读前先看它。
"""

from __future__ import annotations

import argparse
import glob as globlib
import os
import re
import shutil
import sys
import tempfile

ANSI = re.compile(r"\x1b\[[0-9;]*m")
JOBTS = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ")
# bun: `(pass) describe > test [123.45ms]` / `(fail) (unnamed) [5490.92ms]`
TIMING = re.compile(r"^\s*\(?\b(pass|fail|skip)\)?\s+(?P<name>.+?)\s+\[(?P<ms>\d+(?:\.\d+)?)ms\]\s*$")

TEST_START = re.compile(
    r"^(?P<ind>\s*)(?:test|it)(?:\.(?:each|only|skip|todo|concurrent|failing|if))?\("
    r"\s*(?:\"(?P<d>[^\"]{1,300})\"|'(?P<s>[^']{1,300})'|`(?P<b>[^`$]{1,300})`)"
)
DESC_START = re.compile(
    r"^(?P<ind>\s*)describe(?:\.(?:each|only|skip|if))?\("
    r"\s*(?:\"(?P<d>[^\"]{1,300})\"|'(?P<s>[^']{1,300})'|`(?P<b>[^`$]{1,300})`)"
)
# `}, 60_000);` 或 `});` —— 缩进必须与 opener 相同，否则不动栈（防止内层闭包打乱对齐）
CLOSE = re.compile(r"^(?P<ind>\s*)\}\s*(?:,\s*(?P<ms>[0-9][0-9_]*)\s*)?\)")

DEFAULT_MS = 20_000
HOOK_DEFAULT_MS = 5_000
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".next", "coverage"}
DEFAULT_PCT = 50.0


def clean(line: str) -> str:
    return JOBTS.sub("", ANSI.sub("", line)).rstrip()


def parse_timings(text: str):
    """→ [(status, bun_name, ms)]；bun_name 形如 `describe > describe > test`。"""
    out = []
    for raw in text.split("\n"):
        m = TIMING.match(clean(raw))
        if m:
            out.append((m.group(1), m.group("name").strip(), float(m.group("ms"))))
    return out


def index_source(root: str):
    """扫一遍源码：标题 → (有效超时ms, 'file:line')。

    两次遍历：先记 describe 的 (start, end, timeout)，再按行号把最内层
    describe 的超时套到它里面的测试上 —— 因为 describe 的 `}, N)` 出现在
    它的测试**之后**，正向走一遍是拿不到的。
    """
    index: dict[str, tuple[int | None, str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in filenames:
            if not (fn.endswith(".test.ts") or fn.endswith(".test.tsx") or fn.endswith(".test.js")):
                continue
            path = os.path.join(dirpath, fn)
            try:
                lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
            except OSError:
                continue
            rel = os.path.relpath(path, root)
            frames: list[dict] = []
            tests: list[dict] = []
            descs: list[dict] = []
            for i, line in enumerate(lines):
                mt = TEST_START.match(line)
                if mt:
                    frames.append({"kind": "test", "ind": len(mt.group("ind")), "line": i,
                                   "title": mt.group("d") or mt.group("s") or mt.group("b")})
                    continue
                md = DESC_START.match(line)
                if md:
                    frames.append({"kind": "describe", "ind": len(md.group("ind")), "line": i, "timeout": None})
                    continue
                mc = CLOSE.match(line)
                if mc:
                    ind = len(mc.group("ind"))
                    while frames and frames[-1]["ind"] > ind:
                        frames.pop()
                    if frames and frames[-1]["ind"] == ind:
                        fr = frames.pop()
                        val = int(mc.group("ms").replace("_", "")) if mc.group("ms") else 0
                        tmo = val if val >= 1000 else None     # <1000 不是毫秒超时，是数组下标之类
                        fr["timeout"] = tmo
                        if fr["kind"] == "test":
                            fr["end"] = i
                            tests.append(fr)
                        else:
                            fr["end"] = i
                            descs.append(fr)
            for t in tests:
                eff = t.get("timeout")
                if eff is None:
                    encl = [d for d in descs if d["line"] < t["line"] < d["end"] and d["timeout"]]
                    if encl:
                        eff = max(encl, key=lambda d: d["line"])["timeout"]
                loc = f"{rel}:{t['line'] + 1}"
                title = t["title"]
                prev = index.get(title)
                if prev is None or (eff or 0) > (prev[0] or 0):
                    index[title] = (eff, loc)      # 同名多条取最大（偏保守：只会少报风险）
    return index


def slug(s: str, width: int = 34) -> str:
    s = s.split(" > ")[-1].strip()
    s = re.sub(r"[^0-9A-Za-z_.\-]+", "_", s).strip("_")
    return (s[:width] or "unnamed")


# ── 自证夹具 ────────────────────────────────────────────────────────────────
# 🔴 夹具是**故意**这样设计的:一个 describe **没有**声明超时、另一个**有**,
#    而且有超时的那个把自己的 `}, 30_000);` 放在它的测试**之后**。
#    这正是唯一需要两趟遍历的地方 —— 任何「取下一个 `}, N)`」的朴素实现,
#    都会把 30_000 错记到前一个 describe 的测试上。断言里把 4 个分母全钉死,
#    所以那种退化会在这里炸,而不是在慢 runner 上炸。
SELFTEST_FIXTURE = """import { describe, test } from "bun:test";
describe("margin control", () => {
  test("no declared timeout here", () => {
    expect(1).toBe(1);
  });
  test("declared but tiny", () => {
    expect(1).toBe(1);
  }, 4_000);
  test("safely fast", () => {
    expect(1).toBe(1);
  });
});
describe("inherited control", () => {
  test("inherits the describe timeout", () => {
    expect(1).toBe(1);
  });
}, 30_000);
"""

SELFTEST_LOG = """(pass) margin control > no declared timeout here [19000.00ms]
(pass) margin control > declared but tiny [3800.00ms]
(pass) margin control > safely fast [100.00ms]
(pass) inherited control > inherits the describe timeout [21000.00ms]
(pass) (unnamed) [4900.00ms]
"""


def evaluate(rows, index, pct):
    """把「逐条耗时 × 有效超时」算成裁决结果。main 与 selftest 走**同一条**路径。"""
    # 同名去重取最大：同一个文件被多个套件跑时会重复出现
    best: dict[str, float] = {}
    hook_ms = 0.0
    hooks = 0
    for _st, name, ms in rows:
        if name.strip() in ("(unnamed)", ""):
            # 🔴 #1627 的第二种形态：`(fail) (unnamed) [5490.92ms]` +
            #    下一行 `a beforeEach/afterEach hook timed out`。钩子的默认超时是
            #    **5000ms**（不是 20000ms），所以必须单独用一个分母判定，
            #    否则它会被静默跳过 —— 第一版就是这样：计数了，却不参与判定。
            hooks += 1
            hook_ms = max(hook_ms, ms)
            continue
        best[name] = max(best.get(name, 0.0), ms)

    entries: list[tuple[float, int, float, str, str]] = []
    for name, ms in best.items():
        title = name.split(" > ")[-1].strip()
        eff, loc = index.get(title, (None, "?"))
        eff = eff or DEFAULT_MS
        entries.append((ms, eff, 100.0 * ms / eff, loc, name))
    if hook_ms:
        entries.append((hook_ms, HOOK_DEFAULT_MS, 100.0 * hook_ms / HOOK_DEFAULT_MS,
                        "(hook)", "(unnamed hook — beforeEach/afterEach)"))
    near = sorted([e for e in entries if e[2] >= pct], key=lambda r: -r[2])
    return best, hooks, entries, near


def selftest() -> int:
    """内嵌夹具自证：admin/评审不用信我的话,跑 `--selftest` 就行。"""
    failures: list[str] = []

    def check(cond: bool, what: str) -> None:
        if not cond:
            failures.append(what)

    tmp = tempfile.mkdtemp(prefix="test-margin-selftest-")
    try:
        with open(os.path.join(tmp, "fixture.test.ts"), "w", encoding="utf-8") as fh:
            fh.write(SELFTEST_FIXTURE)
        index = index_source(tmp)

        # ① 声明超时的解析（分母从哪来）
        check(index.get("no declared timeout here", (None, ""))[0] is None,
              "「自己、describe 都没声明」必须解析成 None ⇒ 用默认 20000")
        check(index.get("declared but tiny", (None, ""))[0] == 4_000,
              "自己声明的 4_000 必须被解析出来")
        check(index.get("safely fast", (None, ""))[0] is None,
              "🔴 前一 describe 的测试不得继承后一 describe 的 30_000（两趟遍历的核心）")
        check(index.get("inherits the describe timeout", (None, ""))[0] == 30_000,
              "describe 级 30_000 必须被它的测试继承（`}, N)` 在测试之后）")

        # ② 正控：4 条都该被报出，且分母各不相同
        _b, hooks, _e, near = evaluate(parse_timings(SELFTEST_LOG), index, 50.0)
        got = {n.split(" > ")[-1].strip(): (ms, eff, pct) for ms, eff, pct, _l, n in near}
        want = {
            "no declared timeout here": (19_000.0, 20_000, 95.0),
            "declared but tiny": (3_800.0, 4_000, 95.0),
            "inherits the describe timeout": (21_000.0, 30_000, 70.0),
            "(unnamed hook — beforeEach/afterEach)": (4_900.0, 5_000, 98.0),
        }
        check(set(got) == set(want), f"贴上限集合：得到 {sorted(got)}，期望 {sorted(want)}")
        for k, exp in want.items():
            got1 = got.get(k)
            check(got1 is not None and got1[0] == exp[0] and got1[1] == exp[1]
                  and abs(got1[2] - exp[2]) < 0.051, f"{k}：得到 {got1}，期望 {exp}")
        check(hooks == 1, f"钩子必须被计数（得到 {hooks}）")
        pcts = [p for _m, _e, p, _l, _n in near]
        check(pcts == sorted(pcts, reverse=True), "贴上限条目必须按占比降序")

        # ③ 负控：都不贴上限 ⇒ 一条都不许报
        quiet = ("(pass) margin control > safely fast [100.00ms]\n"
                 "(pass) (unnamed) [100.00ms]\n")
        if evaluate(parse_timings(quiet), index, 50.0)[3] != []:
            failures.append("全都很快时必须一条都不报")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print("TEST-MARGIN SELFTEST FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("TEST-MARGIN SELFTEST OK (4 resolution + 4 positive + 1 hook-count + 1 order + 1 negative)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="per-test timeout margin report (#1627)")
    ap.add_argument("--logs", nargs="+",
                    help="日志文件或 glob（默认当作 glob 展开，不存在则跳过）")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    help="仓库根（用来解析声明超时）")
    ap.add_argument("--pct", type=float, default=float(os.environ.get("TEST_MARGIN_PCT", DEFAULT_PCT)),
                    help="贴上限阈值（占有效超时的百分比），默认 50")
    ap.add_argument("--fail", action="store_true", help="有贴上限条目时退出 1（默认只报告）")
    ap.add_argument("--selftest", action="store_true",
                    help="用内嵌夹具自证（解析/正控/负控），不读任何日志")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.logs:
        ap.error("--logs 必填（除非用 --selftest）")

    files: list[str] = []
    for pat in args.logs:
        hits = sorted(globlib.glob(pat))
        if not hits and os.path.isfile(pat):
            hits = [pat]
        files.extend(h for h in hits if os.path.isfile(h))

    rows: list[tuple[str, str, float]] = []
    for f in files:
        try:
            text = open(f, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        rows.extend(parse_timings(text))

    if not files:
        print(f"TEST-MARGIN v1 tests=0 hooks=0 threshold={args.pct:g}% near=0 slowest=-"
              f"  # 没有可读日志（--logs 给的是 {args.logs}）")
        return 0

    # 同名去重、分母解析、贴上限排序全在 evaluate() 里 —— selftest 走同一条路径，
    # 所以自证通过就意味着真实调用路径正确，而不是「另一份逻辑副本对上了」。
    best, hooks, entries, near = evaluate(rows, index_source(args.root), args.pct)

    # 🔴 `slowest=` 里的百分比必须和 `near=` 用同一个分母（有效超时），
    #    不能打毫秒却标 `%` —— 第一版就是这样，输出 `waitWs_...=18069.0%`，
    #    看起来像一个「超高危」，其实是 30.1%。
    slowest = ", ".join(f"{slug(n)}={p:.1f}%" for _ms, _eff, p, _loc, n in
                        sorted(entries, key=lambda e: -e[0])[:3])
    print(f"TEST-MARGIN v1 tests={len(best)} hooks={hooks} threshold={args.pct:g}% "
          f"near={len(near)} slowest={slowest or '-'}")
    for ms, eff, pct, loc, name in near:
        print(f"  NEAR-LIMIT {ms:.0f}ms / {eff}ms = {pct:.1f}%  {loc}  :: {name}")
    if near:
        print("  ⇒ 有效超时是「自己声明的，否则所在 describe 的，否则 bun 默认 20000ms」；"
              "慢 runner 上这些会先红，而报错会像是真缺陷（#1627）。")
    return 1 if (near and args.fail) else 0


if __name__ == "__main__":
    sys.exit(main())
