#!/usr/bin/env python3
"""WebAI2API adapter debug CLI.

固定调用 https://webai2api.kk1.fun/api/{adapterId}，并自动附带
Authorization: Bearer ${TOOLS_API_KEY}。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


BASE_URL = "https://webai2api.kk1.fun"
API_KEY_ENV = "TOOLS_API_KEY"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="webai2api-cli.py",
        description=(
            "向固定 WebAI2API 实例发送 adapter 请求。"
            "从最终 adapter JS 文件 import manifest，读取 manifest.script，"
            "本地编译校验后作为 overrideScript 发往远端。"
        ),
        epilog=(
            "Examples:\n"
            "  1) 使用最终 adapter 文件进行调试:\n"
            "     python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py "
            "--adapter-file /home/fengwk/proj/WebAI2API/examples/dynamic-adapters/chatgpt.js "
            "--prompt '你好' --debug --worker-id arraesraven@gmail.com-chatgpt\n\n"
            "  2) 调试已有 session:\n"
            "     python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py "
            "--adapter-file /path/to/chatgpt.js "
            "--prompt '继续' --session-id 6a3dxxxx --debug --worker-id arraesraven@gmail.com-chatgpt\n\n"
            "  3) 将完整原始响应另存为文件:\n"
            "     python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py "
            "--adapter-file /path/to/chatgpt.js --prompt '你好' "
            "--save-response /tmp/resp.json --pretty\n\n"
            "  4) 上传本地附件（先调用上传接口，再发 adapter 请求）:\n"
            "     python3 skills/webai2api-adapter-debug/scripts/webai2api-cli.py "
            "--adapter-file /path/to/chatgpt.js --prompt '请总结附件内容' "
            "--attach-file /path/to/report.pdf --debug\n\n"
            f"  认证固定使用环境变量 {API_KEY_ENV}。默认 stdout 输出原始响应 body。"
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--adapter-id",
        help="可选。默认取 adapter 文件中的 manifest.id；仅在需要覆盖目标路由时显式传入",
    )
    parser.add_argument("--prompt", help="写入 input.prompt")
    parser.add_argument("--prompt-file", help="从文件读取并写入 input.prompt")
    parser.add_argument("--session-id", help="写入 input.sessionId")
    parser.add_argument("--worker-id", help="指定 sticky workerId")
    parser.add_argument("--debug", action="store_true", help="发送 debug=true，请求返回 trace")
    parser.add_argument("--http-timeout", type=float, default=240.0, help="HTTP 超时秒数，默认 240")
    parser.add_argument("--pretty", action="store_true", help="若响应为 JSON，则格式化后输出")
    parser.add_argument("--save-response", help="把原始响应 body 保存到文件")
    parser.add_argument(
        "--print-request",
        action="store_true",
        help="把实际发送的请求摘要打印到 stderr（overrideScript 仅显示长度）",
    )
    parser.add_argument(
        "--input-json",
        help="JSON 对象字符串，作为 input 基底；可再被 --prompt / --session-id / --input-kv 覆盖",
    )
    parser.add_argument("--input-file", help="从 JSON 文件读取 input 对象")
    parser.add_argument(
        "--input-kv",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="额外写入 input 的字符串字段，可重复指定",
    )
    parser.add_argument(
        "--adapter-file",
        required=True,
        help="最终 adapter JS 文件路径。CLI 会 import 该文件并读取 manifest.script 作为 overrideScript",
    )
    parser.add_argument(
        "--attach-file",
        action="append",
        default=[],
        metavar="PATH",
        help="本地附件路径。可重复指定；CLI 会先上传文件，再把 upload descriptor 合并进 input.attachments",
    )
    return parser


def load_text_file(path: str) -> str:
    return Path(path).expanduser().resolve().read_text(encoding="utf-8")


def load_json_object_from_text(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{label} 不是合法 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"{label} 必须是 JSON 对象")
    return value


def parse_input_kv(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"--input-kv 必须是 KEY=VALUE 形式: {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise SystemExit(f"--input-kv 的 key 不能为空: {item}")
        out[key] = value
    return out


def compile_script_locally(script: str) -> tuple[bool, str]:
    node_code = (
        "import fs from 'fs';"
        "const s = fs.readFileSync(0, 'utf8');"
        "const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;"
        "new AsyncFunction('page','input','api','helpers','runtime', s);"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_code],
        input=script,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return True, ""
    return False, (result.stderr or result.stdout or "unknown error").strip()


def import_manifest(adapter_file: str) -> dict[str, Any]:
    path = Path(adapter_file).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"adapter 文件不存在: {path}")
    node_code = (
        "const mod = await import(process.argv[1]);"
        "const manifest = mod?.manifest;"
        "if (!manifest || typeof manifest !== 'object') {"
        "  console.error('adapter file does not export manifest');"
        "  process.exit(2);"
        "}"
        "if (typeof manifest.id !== 'string' || !manifest.id.trim()) {"
        "  console.error('adapter file does not export manifest.id');"
        "  process.exit(2);"
        "}"
        "if (typeof manifest.script !== 'string') {"
        "  console.error('adapter file does not export manifest.script');"
        "  process.exit(2);"
        "}"
        "process.stdout.write(JSON.stringify({ id: manifest.id, script: manifest.script }));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_code, path.as_uri()],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip() or "unknown error"
        raise SystemExit(f"导入 manifest 失败: {stderr}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"导入 manifest 成功，但返回结果不是合法 JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit("导入 manifest 成功，但返回结果不是对象")
    return payload


def load_manifest_script(adapter_file: str) -> tuple[str, str]:
    manifest = import_manifest(adapter_file)
    adapter_id = str(manifest.get("id") or "").strip()
    script = manifest.get("script")
    if not adapter_id:
        raise SystemExit("manifest.id 不能为空")
    if not isinstance(script, str) or not script.strip():
        raise SystemExit("manifest.script 必须是非空字符串")

    ok, err = compile_script_locally(script)
    if ok:
        return adapter_id, script
    raise SystemExit(
        "adapter 文件已成功 import，但 manifest.script 作为最终函数体无法通过本地编译。"
        "这通常说明你写进 adapter 文件的 script 仍然带有错误的字符串/正则转义，"
        "或者内层脚本自身语法不合法。请修正最终 adapter JS 文件后重试。\n"
        f"本地编译错误:\n{err}"
    )


def load_override_script(adapter_file: str) -> tuple[str, str]:
    return load_manifest_script(adapter_file)


def build_input(args: argparse.Namespace) -> dict[str, Any]:
    if args.input_file:
        input_obj = load_json_object_from_text(load_text_file(args.input_file), "--input-file")
    elif args.input_json:
        input_obj = load_json_object_from_text(args.input_json, "--input-json")
    else:
        input_obj = {}

    if args.prompt_file:
        input_obj["prompt"] = load_text_file(args.prompt_file).rstrip("\n")
    elif args.prompt is not None:
        input_obj["prompt"] = args.prompt

    if args.session_id is not None:
        input_obj["sessionId"] = args.session_id

    input_obj.update(parse_input_kv(args.input_kv))
    return input_obj


def build_request_body(args: argparse.Namespace, override_script: str) -> dict[str, Any]:
    body: dict[str, Any] = {"input": build_input(args)}
    if args.debug:
        body["debug"] = True
    if args.worker_id:
        body["workerId"] = args.worker_id
    body["overrideScript"] = override_script
    return body


def require_api_key() -> str:
    token = os.environ.get(API_KEY_ENV, "").strip()
    if not token:
        raise SystemExit(f"缺少环境变量 {API_KEY_ENV}")
    return token


def format_output(raw_text: str, pretty: bool) -> str:
    if not pretty:
        return raw_text
    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        return raw_text
    return json.dumps(parsed, ensure_ascii=False, indent=2)


def print_request_summary(adapter_id: str, body: dict[str, Any]) -> None:
    summary = dict(body)
    if "overrideScript" in summary:
        summary["overrideScript"] = f"<{len(str(body['overrideScript']))} chars>"
    req = {
        "url": f"{BASE_URL}/api/{adapter_id}",
        "headers": {
            "Content-Type": "application/json",
            "Authorization": f"Bearer ${{{API_KEY_ENV}}}",
        },
        "body": summary,
    }
    sys.stderr.write(json.dumps(req, ensure_ascii=False, indent=2) + "\n")


def build_upload_payload(paths: list[str]) -> tuple[bytes, str]:
    boundary = f"----WebAI2ApiCli{uuid.uuid4().hex}"
    parts: list[bytes] = []

    for raw_path in paths:
        file_path = Path(raw_path).expanduser().resolve()
        if not file_path.is_file():
            raise SystemExit(f"附件文件不存在: {file_path}")
        guessed_content_type = mimetypes.guess_type(file_path.name)[0] or 'application/octet-stream'
        parts.append(f"--{boundary}\r\n".encode('utf-8'))
        disposition = f'Content-Disposition: form-data; name="attachments"; filename="{file_path.name}"\r\n'
        parts.append(disposition.encode('utf-8'))
        parts.append(f'Content-Type: {guessed_content_type}\r\n\r\n'.encode('utf-8'))
        parts.append(file_path.read_bytes())
        parts.append(b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode('utf-8'))
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def upload_attachments(paths: list[str], token: str, timeout: float) -> list[dict[str, Any]]:
    if not paths:
        return []
    payload, content_type = build_upload_payload(paths)
    req = urllib.request.Request(
        url=f"{BASE_URL}/api/uploads",
        data=payload,
        headers={
            'Content-Type': content_type,
            'Authorization': f'Bearer {token}',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"上传附件失败: HTTP {exc.code}\n{exc.read().decode('utf-8')}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"上传附件失败: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"上传附件成功，但响应不是合法 JSON: {exc}\n{raw}") from exc

    uploads = parsed.get('uploads')
    if not isinstance(uploads, list):
        raise SystemExit(f"上传附件响应缺少 uploads 数组: {raw}")
    return uploads


def save_response(path: str, raw_text: str) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(raw_text, encoding="utf-8")


def send_request(adapter_id: str, args: argparse.Namespace, body: dict[str, Any]) -> tuple[int, str]:
    token = require_api_key()
    attachments = upload_attachments(args.attach_file, token, args.http_timeout)
    if attachments:
        existing = body['input'].get('attachments')
        existing_list = existing if isinstance(existing, list) else ([] if existing is None else [existing])
        body['input']['attachments'] = existing_list + attachments
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url=f"{BASE_URL}/api/{adapter_id}",
        data=payload,
        headers={
            "Content-Type": 'application/json',
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=args.http_timeout) as resp:
            return int(resp.status), resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8")
    except TimeoutError as exc:
        raise SystemExit(f"请求超时（>{args.http_timeout}s）: {exc}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"网络请求失败: {exc}") from exc


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    inferred_adapter_id, override_script = load_override_script(args.adapter_file)
    adapter_id = str(args.adapter_id or inferred_adapter_id).strip()
    if not adapter_id:
        raise SystemExit("缺少 adapterId，且无法从 manifest.id 推断")
    body = build_request_body(args, override_script)

    if args.print_request:
        print_request_summary(adapter_id, body)

    status, raw_text = send_request(adapter_id, args, body)

    if args.save_response:
        save_response(args.save_response, raw_text)

    output = format_output(raw_text, args.pretty)
    sys.stdout.write(output)
    if not output.endswith("\n"):
        sys.stdout.write("\n")
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    raise SystemExit(main())
