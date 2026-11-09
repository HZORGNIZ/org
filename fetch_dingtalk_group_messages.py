# -*- coding: utf-8 -*-
"""
抓取指定钉钉群在某个时间范围内的全部群消息。

依赖：钉钉官方 CLI `dws`（dingtalk-workspace-cli，需 >= 1.0.24）且已登录
      （登录命令：dws auth login）

原理（三步）：
  1. dws auth status                     —— 校验登录状态
  2. dws chat +chat-search --keyword X   —— 按群名唯一解析出 openConversationId
  3. dws chat +chat-messages
         --group <openConversationId>
         --start "YYYY-MM-DD HH:mm:ss"   —— 时间范围（闭区间）
         --end   "YYYY-MM-DD HH:mm:ss"
         --order asc --page-all          —— 自动翻页直到拉完（CLI 保证有界完整）
         --output <file.json>            —— 原子导出完整 ledger

用法示例：
  python fetch_dingtalk_group_messages.py --group "暑期项目实践群91" --start "2026-08-29 00:00:00"
  python fetch_dingtalk_group_messages.py --group "暑期项目实践群91" --start "2026-08-29" --end "2026-08-31 12:00:00" --output msgs.json
"""

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timedelta


def find_dws():
    """解析 dws 可执行入口：PATH 上的 dws/dws.cmd/dws.exe，或 npm 包内的 node 入口。"""
    candidates = [shutil.which("dws"), shutil.which("dws.cmd"), shutil.which("dws.exe")]
    # npm 全局/连接器安装目录兜底（Windows 下常见：dws.cmd 与 dws.js 同目录）
    for base in (
        os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "node", "cli-connector-packages"),
        os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "npm"),
    ):
        candidates.append(os.path.join(base, "dws.cmd"))
        candidates.append(os.path.join(base, "dws.cmd.exe"))
        # node 入口：交给 node 执行
        djs = os.path.join(base, "node_modules", "dingtalk-workspace-cli", "bin", "dws.js")
        if os.path.isfile(djs):
            node = shutil.which("node") or "node"
            candidates.append(None)  # 占位，见下方特殊处理
            candidates[-1] = [node, djs]
    for c in candidates:
        if c and (isinstance(c, list) or os.path.isfile(c)):
            return c
    raise RuntimeError("找不到 dws 命令，请先安装：npm install -g dingtalk-workspace-cli")


DWS = find_dws()


def run_dws(args, timeout=120):
    """执行 dws 命令并解析 JSON 输出；stdout/stderr 都检查。"""
    prefix = DWS if isinstance(DWS, list) else [DWS]
    cmd = prefix + args + ["--format", "json"]
    print("[dws] " + " ".join(args))
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    raw = proc.stdout.strip() or proc.stderr.strip()
    try:
        return json.loads(raw), proc.returncode
    except json.JSONDecodeError:
        raise RuntimeError(
            f"dws 返回了非 JSON 输出（exit={proc.returncode}），可能是未登录或命令不存在：\n{raw[:2000]}"
        )


def check_auth():
    """校验登录状态；token 失效时提示走 dws auth login。"""
    data, rc = run_dws(["auth", "status"])
    if not data.get("authenticated") or not data.get("token_valid"):
        raise RuntimeError("钉钉未登录或 token 已失效，请先执行：dws auth login")
    print(f"已登录组织：{data.get('corp_name', '未知')}")


def resolve_group_id(group_name):
    """按群名唯一解析 openConversationId。多候选时报错并给出候选列表。"""
    data, _ = run_dws(["chat", "+chat-search", "--keyword", group_name])
    chats = data.get("chats", [])
    if not chats:
        raise RuntimeError(f"未找到名为「{group_name}」的群")
    exact = [c for c in chats if c.get("name") == group_name]
    if len(exact) != 1:
        names = "\n".join(f"  - {c.get('name')} ({c.get('memberCount')} 人)" for c in chats)
        raise RuntimeError(f"群名「{group_name}」匹配到 {len(chats)} 个群，请用更精确的群名：\n{names}")
    chat = exact[0]
    print(f"目标群：{chat['name']}（{chat.get('memberCount')} 人，openConversationId={chat['openConversationId']}）")
    return chat["openConversationId"]


def parse_time(s, default):
    """接受 'YYYY-MM-DD' 或 'YYYY-MM-DD HH:mm[:ss]'，缺省补 default。"""
    if not s:
        return default
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    raise ValueError(f"无法解析时间：{s}（支持 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss）")


def fetch_messages(conversation_id, start, end, output):
    """按 [start, end) 拉取全部消息，asc 排序，page-all 自动翻页，并导出 JSON。"""
    args = [
        "chat", "+chat-messages",
        "--group", conversation_id,
        "--start", start,
        "--end", end,
        "--order", "asc",
        "--page-all", "--page-limit", "100",
    ]
    if output:
        args += ["--output", output]
    data, rc = run_dws(args, timeout=300)

    if data.get("partial") or data.get("hasMore"):
        print("警告：结果可能不完整（partial/hasMore），可加大 --page-limit 或分时间段重试", file=sys.stderr)

    messages = data.get("messages", [])
    print(f"\n共 {len(messages)} 条消息（范围 {start} ~ {end}，complete={data.get('complete')}）\n")
    print(f"{'时间':<20}{'发送人':<10}内容")
    print("-" * 70)
    for m in messages:
        text = (m.get("text") or "").replace("\n", " ")
        print(f"{m.get('createTime', ''):<20}{m.get('sender', ''):<10}{text}")
    if not messages:
        print("（该时间范围内没有消息）")
    return messages


def main():
    parser = argparse.ArgumentParser(description="抓取指定钉钉群一定时间范围内的消息")
    parser.add_argument("--group", required=True, help="群名称（需唯一，或直接传 openConversationId）")
    parser.add_argument("--start", help="开始时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（默认 3 天前）")
    parser.add_argument("--end", help="结束时间 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss（默认当前时间）")
    parser.add_argument("--output", help="完整 ledger 导出的 JSON 文件名（相对当前目录）")
    args = parser.parse_args()

    now = datetime.now()
    start = parse_time(args.start, (now - timedelta(days=3)).strftime("%Y-%m-%d 00:00:00"))
    end = parse_time(args.end, now.strftime("%Y-%m-%d %H:%M:%S"))

    check_auth()
    conversation_id = args.group if args.group.startswith("cid") else resolve_group_id(args.group)
    fetch_messages(conversation_id, start, end, args.output)


if __name__ == "__main__":
    main()
