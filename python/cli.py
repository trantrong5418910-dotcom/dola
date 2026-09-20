#!/usr/bin/env python3
"""Python 版命令行（与 Node 版 CLI 等价，零第三方依赖）。

    python3 cli.py create --prompt "一只橘猫在窗台上晒太阳" --wait --download ./out
    python3 cli.py status <task_id>
    python3 cli.py list
    python3 cli.py balance
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from video_provider import VideoClient

ZH = {"queued": "排队中", "processing": "处理中", "succeeded": "已成功", "failed": "已失败", "unknown": "未知"}


def build(args) -> VideoClient:
    return VideoClient(
        provider=args.provider or os.environ.get("VIDEO_PROVIDER", "mock"),
        credential=args.credential or os.environ.get("DOLA_CREDENTIAL", ""),
        base_url=args.base_url or os.environ.get("DOLA_BASE_URL", "https://43.254.166.145"),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="视频任务 MVP（Python 版）")
    ap.add_argument("--provider", default=None, help="dola-workbench | mock（也可放子命令后）")
    ap.add_argument("--credential", default=None)
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--json", action="store_true", help="机器可读输出")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--provider", default=None)
    common.add_argument("--credential", default=None)
    common.add_argument("--base-url", default=None)

    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create", help="创建任务", parents=[common])
    p.add_argument("--prompt", required=True)
    p.add_argument("--ratio", default="16:9")
    p.add_argument("--wait", action="store_true")
    p.add_argument("--interval", type=float, default=30.0)
    p.add_argument("--timeout", type=float, default=3600.0)
    p.add_argument("--download", default=None)
    p.add_argument("--image", action="append", default=[])

    p = sub.add_parser("status", parents=[common]);  p.add_argument("task_id")
    p = sub.add_parser("download", parents=[common]); p.add_argument("task_id"); p.add_argument("--out", default=".")
    p = sub.add_parser("list", parents=[common]);    p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("balance", parents=[common])
    p = sub.add_parser("redeem", parents=[common]);  p.add_argument("card")

    args = ap.parse_args()
    c = build(args)

    if args.cmd == "balance":
        c.login()
        print(json.dumps({"balance": c.get_balance()}, ensure_ascii=False))
    elif args.cmd == "list":
        c.login()
        items = c.list_tasks(limit=args.limit)["items"]
        if args.json:
            print(json.dumps(items, ensure_ascii=False, indent=2))
        else:
            for t in items:
                print(f"  {t['id']:<24} {ZH.get(t['status'], t['status'])}  {t.get('error') or t.get('notice') or ''}")
    elif args.cmd == "status":
        c.login()
        print(json.dumps(c.get_task(args.task_id), ensure_ascii=False, indent=2))
    elif args.cmd == "download":
        c.login()
        print(json.dumps(c.download_to(args.task_id, args.out), ensure_ascii=False))
    elif args.cmd == "redeem":
        c.login()
        print(json.dumps(c.p.redeem_card(args.card), ensure_ascii=False))
    elif args.cmd == "create":
        c.login()
        payload = {"prompt": args.prompt, "ratio": args.ratio, "images": args.image}
        if not args.wait:
            created = c.create_task(payload)
            print(json.dumps(created, ensure_ascii=False, indent=2, default=str))
            return 0
        started = __import__("time").time()

        def _progress(cur, info):
            el = __import__("time").time() - started
            line = f"  [{el:.0f}s] 第 {info['round']} 次查询：{ZH.get(cur['status'], cur['status'])}"
            if cur.get("notice"):
                line += f" · {cur['notice']}"
            print(line, flush=True)

        t = c.create_and_wait(payload, poll_interval=args.interval, timeout=args.timeout,
                              on_progress=_progress)
        result = {k: t.get(k) for k in ("id", "status", "url", "charged")}
        if args.download:
            result["downloaded"] = c.download_to(t, args.download)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        print(f"✗ {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
