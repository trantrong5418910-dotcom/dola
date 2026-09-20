"""
video_provider —— 可替换 provider 的视频生成任务 Python 版（零第三方依赖）。

对应 Node 版 mvp/src 的同一套契约，见 ../API_ANALYSIS.md。

    from video_provider import VideoClient, Status

    c = VideoClient(provider="dola-workbench", credential="你的令牌")
    t = c.create_and_wait({"prompt": "一只橘猫在窗台上晒太阳"})
    c.download_to(t, "./out")

加自己的 provider：实现 Provider 协议（login/create_task/get_task/list_tasks/download），
然后 VideoClient(provider="你的名字", provider_registry={...})。
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import ssl
import threading
import time
import urllib.parse
import uuid
from dataclasses import dataclass, field
from http.client import HTTPSConnection, HTTPConnection
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


# ---------------------------------------------------------------- 状态

class Status:
    QUEUED = "queued"
    PROCESSING = "processing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    UNKNOWN = "unknown"


_TERMINAL = {Status.SUCCEEDED, Status.FAILED}

_ALIASES = {
    "queued": Status.QUEUED, "pending": Status.QUEUED, "waiting": Status.QUEUED,
    "processing": Status.PROCESSING, "running": Status.PROCESSING, "generating": Status.PROCESSING,
    "succeeded": Status.SUCCEEDED, "success": Status.SUCCEEDED, "completed": Status.SUCCEEDED, "done": Status.SUCCEEDED,
    "failed": Status.FAILED, "error": Status.FAILED,
}


def normalize_status(raw: Any) -> str:
    if raw is None:
        return Status.UNKNOWN
    k = str(raw).strip().lower()
    return _ALIASES.get(k, Status.UNKNOWN)


def normalize_task(raw: Dict[str, Any], id_hint: str = "") -> Dict[str, Any]:
    """实测：未完成时 url/error/estimated_wait 是空串 ''，统一转 None。"""
    raw = raw or {}
    st = raw.get("status", raw.get("public_state"))

    def nz(v):
        return None if (v is None or v == "") else v

    return {
        "id": str(raw.get("task_id") or raw.get("id") or id_hint or ""),
        "status": normalize_status(st),
        "statusText": str(st) if st else None,
        "url": nz(raw.get("url") or raw.get("video_url")),
        "error": nz(raw.get("error") or raw.get("public_error")),
        "notice": nz(raw.get("estimated_wait") or raw.get("query_notice")),
        "charged": raw.get("charged_points"),
        "createdAt": raw.get("created_at"),
        "updatedAt": raw.get("updated_at"),
        "billingState": nz(raw.get("billing_state")),
        # 服务端是否真的去上游查了一次；快速重复查询为 False（走缓存）
        "refreshed": raw.get("refreshed"),
        "canDelete": bool(raw.get("can_delete")),
        "raw": raw,
    }


def _extract_task_id(js: Any) -> Optional[str]:
    if not isinstance(js, dict):
        return None
    for k in ("task_id", "taskId", "id"):
        if js.get(k):
            return str(js[k])
    for wrap in ("task", "data", "result", "job"):
        w = js.get(wrap)
        if isinstance(w, dict):
            for k in ("task_id", "taskId", "id"):
                if w.get(k):
                    return str(w[k])
    return None


# ---------------------------------------------------------------- 错误

class VideoProviderError(Exception):
    def __init__(self, message: str, *, status: Optional[int] = None, raw: Any = None):
        super().__init__(message)
        self.status = status
        self.raw = raw


class AuthError(VideoProviderError): ...
class CsrfError(VideoProviderError): ...
class BusinessError(VideoProviderError): ...
class TimeoutError_(VideoProviderError): ...
class TaskFailedError(VideoProviderError): ...
class ConfigError(VideoProviderError): ...


# ---------------------------------------------------------------- HTTP

@dataclass
class _Resp:
    status: int
    headers: Dict[str, str]
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8")) if self.body else None
        except Exception:
            return None


class HttpClient:
    """Cookie 持久化 + 业务失败判定（body.code == "0"）。零依赖实现。"""

    def __init__(self, base_url: str, timeout: float = 60.0, insecure: bool = False):
        u = urllib.parse.urlparse(base_url)
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or (443 if u.scheme == "https" else 80)
        self.scheme = u.scheme or "https"
        self.timeout = timeout
        self.insecure = insecure
        self.cookies: Dict[str, str] = {}
        self.on_trace: Optional[Callable[[dict], None]] = None
        self.header_hook: Optional[Callable[[str, str], Dict[str, str]]] = None

    def _cookie_header(self) -> str:
        return "; ".join(f"{k}={v}" for k, v in self.cookies.items())

    def request(self, method: str, path: str, body: Any = None,
                headers: Optional[Dict[str, str]] = None,
                raw_body: Optional[bytes] = None) -> _Resp:
        hdrs: Dict[str, str] = dict(headers or {})
        if self.header_hook and method != "GET":
            hdrs.update(self.header_hook(method, path) or {})
        ck = self._cookie_header()
        if ck:
            hdrs.setdefault("Cookie", ck)

        payload: Optional[bytes] = raw_body
        if body is not None and raw_body is None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        if payload is not None:
            hdrs.setdefault("Content-Length", str(len(payload)))

        started = time.time()
        if self.scheme == "https":
            ctx = ssl._create_unverified_context() if self.insecure else ssl.create_default_context()
            conn: Any = HTTPSConnection(self.host, self.port, timeout=self.timeout, context=ctx)
        else:
            conn = HTTPConnection(self.host, self.port, timeout=self.timeout)

        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        out = _Resp(resp.status, {k.lower(): v for k, v in resp.getheaders()}, data)

        # 收 Set-Cookie（简单解析，够用）
        for k, v in out.headers.items():
            if k == "set-cookie":
                pair = v.split(";", 1)[0]
                if "=" in pair:
                    n, _, val = pair.partition("=")
                    self.cookies[n.strip()] = val.strip()

        conn.close()
        if self.on_trace:
            self.on_trace({"method": method, "url": path, "status": out.status,
                           "ms": int((time.time() - started) * 1000)})
        return out

    def request_json(self, method: str, path: str, **kw) -> Any:
        r = self.request(method, path, **kw)
        js = r.json()
        fail = (r.status >= 300) or (isinstance(js, dict) and str(js.get("code")) == "0")
        if fail:
            msg = (js or {}).get("message") or f"HTTP {r.status}"
            cls = AuthError if (r.status == 401 or "令牌无效" in msg or "请先登录" in msg or "登录凭据无效" in msg) \
                else CsrfError if (r.status == 403 or msg == "请求校验失败") \
                else BusinessError
            raise cls(msg, status=r.status, raw=js)
        return js


def build_multipart(fields: List[Tuple[str, str]], files: List[Tuple[str, str, bytes]]) -> Tuple[bytes, str]:
    boundary = "----vt" + uuid.uuid4().hex
    buf = bytearray()
    for name, value in fields:
        buf += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
    for field_name, filename, data in files:
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        buf += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field_name}\"; "
                f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
        buf += data + b"\r\n"
    buf += f"--{boundary}--\r\n".encode()
    return bytes(buf), f"multipart/form-data; boundary={boundary}"


# ---------------------------------------------------------------- Mock

class MockProvider:
    """不联网的演示 provider，把链路先跑通。"""

    RATIOS = ["16:9", "9:16", "1:1", "3:4", "4:3", "21:9"]

    def __init__(self, queue_delay: float = 1.5, process_delay: float = 6.0, **_):
        self.name = "mock"
        self.queue_delay, self.process_delay = queue_delay, process_delay
        self.tasks: Dict[str, dict] = {}
        self.balance = 100
        self._lock = threading.Lock()

    def login(self, credential: str = "") -> dict:
        return {"role": "user", "balance": self.balance}

    def create_task(self, p: dict) -> dict:
        prompt = (p.get("prompt") or "").strip()
        if not prompt:
            raise TaskFailedError("prompt 不能为空")
        tid = "mock_" + uuid.uuid4().hex[:8]
        now = time.time()
        with self._lock:
            self.tasks[tid] = {
                "task_id": tid, "status": Status.QUEUED, "created_at": now,
                "charged_points": 10, "can_delete": True, "url": None,
                "_t_proc": now + self.queue_delay, "_t_fin": now + self.queue_delay + self.process_delay,
            }
            self.balance -= 10
        return {"taskId": tid, "raw": {"task_id": tid, "status": Status.QUEUED}, "via": "create-response"}

    def _advance(self, t: dict) -> dict:
        now = time.time()
        if t["status"] == Status.QUEUED and now >= t["_t_proc"]:
            t["status"], t["estimated_wait"] = Status.PROCESSING, "预计还需 1 分钟"
        if t["status"] == Status.PROCESSING and now >= t["_t_fin"]:
            t["status"], t["url"], t["estimated_wait"] = Status.SUCCEEDED, f"mock://video/{t['task_id']}.mp4", None
        return t

    def get_task(self, task_id: str) -> dict:
        t = self.tasks.get(task_id)
        if not t:
            raise TaskFailedError(f"任务不存在：{task_id}")
        return normalize_task(self._advance(t))

    def list_tasks(self, limit: int = 50, **_) -> dict:
        items = sorted((self._advance(t) for t in self.tasks.values()),
                       key=lambda x: x["created_at"], reverse=True)[:limit]
        return {"items": [normalize_task(t) for t in items], "nextCursor": None}

    def delete_task(self, task_id: str) -> dict:
        self.tasks.pop(task_id, None)
        return {"ok": True}

    def get_balance(self):
        return self.balance

    def download(self, task: dict, dest: str) -> dict:
        path = Path(dest or f"{task['id']}.mp4")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"MOCK VIDEO PLACEHOLDER (Python \xe7\x89\x88\xe6\x9c\xaa\xe7\x94\x9f\xe6\x88\x90\xe7\x9c\x9f\xe5\xae\x9e mp4)\n")
        return {"filePath": str(path), "bytes": path.stat().st_size}


# ---------------------------------------------------------------- Dola 工作台

class DolaWorkbenchProvider:
    """
    对接 https://43.254.166.145 「视频工作台」，契约来自前端逆向 + 抓包实测。
    注意：创建响应里是否有 task_id 未验证 —— 所以和 Node 版一样走「响应取 id + 列表 diff 兜底」。
    """

    RATIOS = ["16:9", "9:16", "1:1", "3:4", "4:3", "21:9"]
    FIXED_SECONDS = 30
    PROMPT_MAX = 12000
    IMAGE_MAX_COUNT = 9
    IMAGE_MAX_BYTES = 20 * 1024 * 1024

    def __init__(self, base_url: str = "https://43.254.166.145", credential: str = "",
                 timeout: float = 60.0, min_poll_interval: float = 5.0, **_):
        self.name = "dola-workbench"
        self.base_url = base_url.rstrip("/")
        self.credential = credential or os.environ.get("DOLA_CREDENTIAL", "")
        self.min_poll_interval = min_poll_interval
        self.session: Optional[dict] = None
        self._last_query = 0.0
        self.http = HttpClient(base_url, timeout=timeout)
        self.http.header_hook = lambda m, p: ({"X-CSRF-Token": self.session["csrf"]} if self.session and self.session.get("csrf") else {})

    # ---- 会话 ----
    def login(self, credential: str = "") -> dict:
        cred = credential or self.credential
        if not cred:
            raise AuthError("缺少访问令牌：传 credential 或设置 DOLA_CREDENTIAL")
        self.http.request_json("POST", "/api/session", body={"credential": cred})
        self.refresh_session()
        return self.session

    def refresh_session(self) -> dict:
        self.session = self.http.request_json("GET", "/api/session")
        return self.session

    def get_balance(self):
        # 每次都刷会话拿权威余额；缓存的 balance 会因其他客户端创建任务而过期
        try:
            self.refresh_session()
        except Exception:
            if not self.session:
                raise
        return (self.session or {}).get("balance")

    def redeem_card(self, card: str) -> dict:
        out = self.http.request_json("POST", "/api/v1/cards/redeem",
                                     body={"card": card.strip()},
                                     headers={"Idempotency-Key": str(uuid.uuid4())})
        self.refresh_session()
        return out

    # ---- 任务 ----
    def create_task(self, p: dict) -> dict:
        prompt = str(p.get("prompt") or "").strip()
        ratio = p.get("ratio") or "16:9"
        seconds = int(p.get("seconds") or self.FIXED_SECONDS)
        images: List[Tuple[str, bytes]] = []

        if not prompt:
            raise VideoProviderError("prompt 不能为空")
        if len(prompt) > self.PROMPT_MAX:
            raise VideoProviderError(f"prompt 超过 {self.PROMPT_MAX} 字上限")
        if ratio not in self.RATIOS:
            raise VideoProviderError(f"ratio 必须是 {'/'.join(self.RATIOS)} 之一，收到 {ratio}")
        if seconds != self.FIXED_SECONDS:
            raise VideoProviderError(f"该站点固定 seconds={self.FIXED_SECONDS}")
        for i, item in enumerate(p.get("images") or []):
            if isinstance(item, (bytes, bytearray)):
                images.append((f"image-{i}.png", bytes(item)))
            elif isinstance(item, str) and os.path.exists(item):
                images.append((os.path.basename(item), Path(item).read_bytes()))
            elif isinstance(item, dict) and "dataBase64" in item:
                images.append((item.get("name") or f"image-{i}.png", base64.b64decode(item["dataBase64"])))
        if len(images) > self.IMAGE_MAX_COUNT:
            raise VideoProviderError(f"参考图片最多 {self.IMAGE_MAX_COUNT} 张")
        if sum(len(d) for _, d in images) > self.IMAGE_MAX_BYTES:
            raise VideoProviderError("参考图片合计超过 20 MiB")

        if not self.session:
            self.refresh_session()
        before = {t["id"] for t in self.list_tasks(limit=100)["items"]}

        body, ctype = build_multipart(
            [("prompt", prompt), ("ratio", ratio), ("seconds", str(seconds))],
            [("images[]", n, d) for n, d in images],
        )
        # 实测：同一 Idempotency-Key 重复提交不会二次扣费（返回 existing:true + 同一 task_id）
        key = p.get("idempotency_key") or str(uuid.uuid4())
        try:
            js = self.http.request_json("POST", "/api/v1/videos", raw_body=body,
                                        headers={"Content-Type": ctype, "Idempotency-Key": key})
        except VideoProviderError as e:
            if e.status is not None and e.status < 500:
                raise
            js = self.http.request_json("POST", "/api/v1/videos", raw_body=body,
                                        headers={"Content-Type": ctype, "Idempotency-Key": key})

        if js and js.get("balance") is not None and isinstance(self.session, dict):
            self.session["balance"] = js["balance"]

        tid = _extract_task_id(js)   # 实测：创建响应确实含 task_id
        if tid:
            return {"taskId": tid, "raw": js, "via": "create-response",
                    "existing": bool(js.get("existing")), "balance": js.get("balance")}

        after = self.list_tasks(limit=100)["items"]
        fresh = [t for t in after if t["id"] not in before]
        if not fresh:
            raise VideoProviderError("创建已受理，但拿不到 task_id 且列表没有新任务（响应见 raw）", raw=js)
        fresh.sort(key=lambda t: t.get("createdAt") or "", reverse=True)
        return {"taskId": fresh[0]["id"], "raw": js, "via": "list-diff"}

    def get_task(self, task_id: str) -> dict:
        wait = self.min_poll_interval - (time.time() - self._last_query)
        if wait > 0:
            time.sleep(wait)
        self._last_query = time.time()
        js = self.http.request_json("GET", f"/api/v1/videos/{urllib.parse.quote(task_id)}")
        # 响应是「扁平字段 + 嵌套 task」双份；refreshed / query_notice 只在顶层
        top = dict(js or {})
        top.pop("task", None)
        merged = {**(js or {}).get("task", {}), **top}
        for k, v in top.items():
            if v in ("", None) and (js or {}).get("task", {}).get(k) is not None:
                merged[k] = js["task"][k]
        t = normalize_task(merged, id_hint=task_id)
        t["queryNotice"] = (js or {}).get("query_notice")
        return t

    def list_tasks(self, limit: int = 50, cursor: str = "", **_) -> dict:
        items, cur = [], cursor
        while len(items) < limit:
            path = f"/api/v1/videos?cursor={urllib.parse.quote(cur)}" if cur else "/api/v1/videos"
            js = self.http.request_json("GET", path)
            # 实测 tasks 和 data 是同一份内容的两个别名
            items += [normalize_task(t) for t in ((js or {}).get("tasks") or (js or {}).get("data") or [])]
            cur = (js or {}).get("next_cursor")
            if not cur:
                break
        return {"items": items[:limit], "nextCursor": cur}

    def delete_task(self, task_id: str) -> dict:
        return {"ok": True, "raw": self.http.request_json("DELETE", f"/api/v1/videos/{urllib.parse.quote(task_id)}")}

    def download(self, task: dict, dest: str) -> dict:
        t = self.get_task(task) if isinstance(task, str) else task
        if not t.get("url"):
            raise VideoProviderError(f"任务 {t['id']} 还没有视频直链，当前状态 {t['status']}")
        # 直链是否需要 cookie 未验证：带上无害
        r = self.http.request("GET", t["url"]) if t["url"].startswith(self.base_url) else None
        if r is None:
            import urllib.request
            req = urllib.request.Request(t["url"], headers={"Cookie": self.http._cookie_header()})
            with urllib.request.urlopen(req) as resp:  # noqa: S310
                data = resp.read()
        else:
            data = r.body
        path = Path(dest or f"{t['id']}.mp4")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"filePath": str(path), "bytes": len(data)}


# ---------------------------------------------------------------- 门面

DEFAULT_REGISTRY = {"dola-workbench": DolaWorkbenchProvider, "dola": DolaWorkbenchProvider, "mock": MockProvider}


class VideoClient:
    def __init__(self, provider: str = "mock", credential: str = "",
                 provider_registry: Optional[Dict[str, type]] = None, **opts):
        reg = {**DEFAULT_REGISTRY, **(provider_registry or {})}
        cls = reg.get(provider.lower())
        if not cls:
            raise ConfigError(f"未知 provider：{provider}。可用：{', '.join(reg)}")
        self.provider_name = provider
        self.p = cls(credential=credential, **opts)

    def login(self, credential: str = "") -> dict:
        return self.p.login(credential)

    def get_balance(self):
        return self.p.get_balance()

    def list_tasks(self, **kw) -> dict:
        return self.p.list_tasks(**kw)

    def get_task(self, task_id: str) -> dict:
        return self.p.get_task(task_id)

    def delete_task(self, task_id: str) -> dict:
        return self.p.delete_task(task_id)

    def create_task(self, p: dict) -> dict:
        return self.p.create_task(p)

    def create_and_wait(self, p: dict, poll_interval: float = 30.0, timeout: float = 3600.0,
                        on_progress: Optional[Callable[[dict, dict], None]] = None) -> dict:
        created = self.p.create_task(p)
        tid, deadline, rnd = created["taskId"], time.time() + timeout, 0
        last = None
        while True:
            last = self.p.get_task(tid)
            rnd += 1
            if on_progress:
                on_progress(last, {"round": rnd, "taskId": tid, "via": created.get("via")})
            if last["status"] in _TERMINAL:
                break
            if time.time() >= deadline:
                raise TimeoutError_(f"等待超时，任务 {tid} 仍处 {last['status']}，可用 get_task 继续查", raw=last["raw"])
            time.sleep(poll_interval)
        if last["status"] == Status.FAILED:
            raise TaskFailedError(f"任务失败：{last.get('error') or '无错误信息'}", raw=last["raw"])
        return last

    def wait_for(self, task_id: str, poll_interval: float = 30.0, timeout: float = 3600.0) -> dict:
        deadline = time.time() + timeout
        last = None
        while True:
            last = self.p.get_task(task_id)
            if last["status"] in _TERMINAL:
                return last
            if time.time() >= deadline:
                raise TimeoutError_("等待超时", raw=last["raw"])
            time.sleep(poll_interval)

    def download_to(self, task: Any, out_dir: str = ".") -> dict:
        t = self.p.get_task(task) if isinstance(task, str) else task
        return self.p.download(t, os.path.join(out_dir, f"{t['id']}.mp4"))
