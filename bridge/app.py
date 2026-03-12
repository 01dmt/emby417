#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import os
import re
import json
import base64
import hashlib
import secrets
from pathlib import Path
from typing import Optional
from time import time
from urllib.parse import parse_qs, urlparse

import requests
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from p115client import P115Client
from p115client.fs import P115FileSystem
from p115client.client import check_response


class DownloadRequest(BaseModel):
    path: str


class DownloadResponse(BaseModel):
    url: str
    pickcode: str


class PickcodeRequest(BaseModel):
    path: str


class PickcodeResponse(BaseModel):
    pickcode: str
    path: str


class FastTransferRequest(BaseModel):
    cookie_a: str
    pickcode_a: str
    cookie_b: str
    path_b: str = "/sha1cache"
    user_agent: str = ""
    filename: str = ""
    file_name_b: str = ""
    file_name: str = ""
    target_name: str = ""
    new_name: str = ""
    name: str = ""
    name_b: str = ""
    target_file_name: str = ""


class FastTransferResponse(BaseModel):
    ok: bool
    target_pickcode: str = ""
    source_pickcode: str = ""
    error: str = ""
    source_uid: str = ""
    target_uid: str = ""
    file_name: str = ""
    file_size: int = 0
    file_sha1: str = ""
    range_verified: bool = False


class CleanupDirectoriesRequest(BaseModel):
    cookie: str = ""
    directories: list[str] = Field(default_factory=list)
    safe_code: str = ""
    user_agent: str = ""


class CleanupDirectoriesResponse(BaseModel):
    ok: bool
    deleted_count: int = 0
    directories: int = 0
    recycle_cleared: bool = False
    errors: list[str] = Field(default_factory=list)


class QrLoginStartRequest(BaseModel):
    app: str = "android"


class QrLoginStartResponse(BaseModel):
    ok: bool = True
    session_id: str
    app: str
    uid: str
    qrcode_url: str
    image_data_url: str
    expires_in: int


class QrLoginPollRequest(BaseModel):
    session_id: str


class QrLoginPollResponse(BaseModel):
    ok: bool = True
    session_id: str
    app: str
    status: str
    message: str = ""
    cookies: str = ""
    uid: str = ""
    data: dict = Field(default_factory=dict)


def _build_client() -> P115Client:
    cookie_file = os.getenv("P115_COOKIE_FILE", "").strip()
    cookie_value = os.getenv("P115_COOKIE", "").strip()
    app_name = _resolve_default_app()

    if cookie_file:
        return P115Client(Path(cookie_file).expanduser(), app=app_name)
    if cookie_value:
        return P115Client(cookie_value, app=app_name)

    raise RuntimeError("P115_COOKIE_FILE or P115_COOKIE is required")


def _try_build_client() -> Optional[P115Client]:
    try:
        return _build_client()
    except RuntimeError:
        return None


def _cleanup_qr_login_sessions() -> None:
    now = int(time())
    expired_ids = [
        session_id
        for session_id, session in _qr_login_sessions.items()
        if now - int(session.get("created_at", now)) >= _QR_LOGIN_TTL_SECONDS
    ]
    for session_id in expired_ids:
        _qr_login_sessions.pop(session_id, None)


def _normalize_qr_login_app(app_name: str) -> str:
    normalized = str(app_name or "").strip().lower()
    if not normalized:
        return "android"
    aliases = {
        "desktop": "desktop",
        "macos": "mac",
    }
    return aliases.get(normalized, normalized)


def _classify_qr_login_status(payload: dict) -> tuple[str, str]:
    if not isinstance(payload, dict):
        return "waiting", "等待扫码"
    raw_message = str(payload.get("message") or payload.get("msg") or "").strip()
    code = str(payload.get("status") or payload.get("code") or payload.get("errno") or "").strip()
    state = payload.get("state")
    text = f"{code} {raw_message}".lower()
    if "expired" in text or "过期" in raw_message:
        return "expired", raw_message or "二维码已过期"
    if "cancel" in text or "取消" in raw_message:
        return "canceled", raw_message or "已取消扫码登录"
    if "scan" in text or "扫描" in raw_message or code == "1":
        return "scanned", raw_message or "已扫码，请在设备上确认登录"
    if "login" in text or "sign" in text or "登录" in raw_message or code in {"2", "3"}:
        return "scanned", raw_message or "已扫码，请在设备上确认登录"
    if state in (0, False):
        return "waiting", raw_message or "等待扫码"
    return "waiting", raw_message or "等待扫码"


def _extract_login_cookies(payload: dict) -> str:
    if not isinstance(payload, dict):
        return ""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    cookie_value = data.get("cookie")
    if isinstance(cookie_value, str):
        return cookie_value.strip()
    if isinstance(cookie_value, dict):
        parts = []
        for key in ("UID", "CID", "SEID", "KID"):
            value = str(cookie_value.get(key) or "").strip()
            if value:
                parts.append(f"{key}={value}")
        return "; ".join(parts)
    return ""


app = FastAPI(title="p115client Bridge", version="0.1.0")
_client: Optional[P115Client] = None
_fs: Optional[P115FileSystem] = None
_prefix_rules: list[tuple[str, str]] = []
_qr_login_sessions: dict[str, dict] = {}
_QR_LOGIN_TTL_SECONDS = 300


@app.on_event("startup")
async def _startup() -> None:
    global _client
    global _fs
    global _prefix_rules
    _client = _try_build_client()
    _fs = P115FileSystem(_client) if _client is not None else None
    _prefix_rules = _load_prefix_rules()


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/")
async def index() -> dict[str, str]:
    return {
        "service": "p115client bridge",
        "health": "/health",
        "download": "POST /api/tool/download",
        "fast_transfer": "POST /api/tool/fast-transfer",
        "cleanup_directories": "POST /api/tool/cleanup-directories",
        "qr_login_start": "POST /api/tool/qr-login/start",
        "qr_login_poll": "POST /api/tool/qr-login/poll",
    }


@app.get("/api/tool/download")
async def download_hint() -> dict[str, str]:
    return {
        "detail": "use POST /api/tool/download with JSON body: {\"path\":\"...\"}",
    }


@app.post("/api/tool/download", response_model=DownloadResponse)
async def tool_download(
    payload: DownloadRequest,
    user_agent: str = Header(default="", alias="user-agent"),
    cookie_header: str = Header(default="", alias="cookie"),
    path_prefix_rules: str = Header(default="", alias="x-path-prefix-rules"),
    extra_headers_raw: str = Header(default="", alias="x-p115-extra-headers"),
    app_header: str = Header(default="", alias="x-p115-app"),
) -> DownloadResponse:
    app_candidates = _resolve_app_candidates(app_header)
    client = _client
    fs = _fs
    if client is None or fs is None:
        cookie_value = cookie_header.strip()
        if not cookie_value:
            raise HTTPException(
                status_code=500,
                detail=(
                    "p115 client is not initialized; provide P115_COOKIE/P115_COOKIE_FILE "
                    "or send Cookie header from upstream"
                ),
            )
        client = P115Client(cookie_value, app=app_candidates[0])
        fs = P115FileSystem(client)

    rules = _parse_prefix_rules(path_prefix_rules) if path_prefix_rules.strip() else _prefix_rules
    source_path = _rewrite_path(payload.path.strip(), rules)
    pickcode = _extract_pickcode(source_path, client)
    request_headers = _build_request_headers(user_agent, extra_headers_raw)

    try:
        url = await _resolve_download_url(
            client=client,
            fs=fs,
            pickcode=pickcode,
            source_path=source_path,
            request_headers=request_headers,
            app_candidates=app_candidates,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return DownloadResponse(url=str(url), pickcode=pickcode or "")


@app.post("/api/tool/pickcode", response_model=PickcodeResponse)
async def tool_pickcode(
    payload: PickcodeRequest,
    user_agent: str = Header(default="", alias="user-agent"),
    cookie_header: str = Header(default="", alias="cookie"),
    path_prefix_rules: str = Header(default="", alias="x-path-prefix-rules"),
    extra_headers_raw: str = Header(default="", alias="x-p115-extra-headers"),
    app_header: str = Header(default="", alias="x-p115-app"),
) -> PickcodeResponse:
    app_candidates = _resolve_app_candidates(app_header)
    client = _client
    fs = _fs
    if client is None or fs is None:
        cookie_value = cookie_header.strip()
        if not cookie_value:
            raise HTTPException(
                status_code=500,
                detail=(
                    "p115 client is not initialized; provide P115_COOKIE/P115_COOKIE_FILE "
                    "or send Cookie header from upstream"
                ),
            )
        client = P115Client(cookie_value, app=app_candidates[0])
        fs = P115FileSystem(client)

    rules = _parse_prefix_rules(path_prefix_rules) if path_prefix_rules.strip() else _prefix_rules
    source_path = _rewrite_path(payload.path.strip(), rules)
    pickcode = _extract_pickcode(source_path, client)
    if not pickcode:
        request_headers = _build_request_headers(user_agent, extra_headers_raw)
        try:
            pickcode = await _resolve_pickcode_from_path(
                client=client,
                source_path=source_path,
                request_headers=request_headers,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    return PickcodeResponse(pickcode=pickcode or "", path=source_path)


@app.post("/api/tool/fast-transfer", response_model=FastTransferResponse)
async def tool_fast_transfer(
    payload: FastTransferRequest,
    app_header: str = Header(default="", alias="x-p115-app"),
) -> FastTransferResponse:
    app_candidates = _resolve_app_candidates(app_header)
    app_name = app_candidates[0] if app_candidates else "android"
    source_cookie = payload.cookie_a.strip()
    target_cookie = payload.cookie_b.strip()
    source_pickcode = payload.pickcode_a.strip()
    target_path = payload.path_b.strip() or "/sha1cache"
    ua = payload.user_agent.strip() or "Mozilla/5.0 115disk/37.1.1 115Browser/37.1.1 115wangpan_android/37.1.1"
    target_file_name = _resolve_target_file_name(payload)

    if not source_cookie or not target_cookie or not source_pickcode:
        return FastTransferResponse(ok=False, error="cookie_a/cookie_b/pickcode_a are required")

    try:
        source_client = P115Client(source_cookie, app=app_name)
        target_client = P115Client(target_cookie, app=app_name)

        file_info = await _get_file_info_by_pickcode(source_client, source_pickcode, ua, app_name)
        target_pid = await _ensure_target_dir(target_client, target_path)
        if target_pid is None:
            return FastTransferResponse(ok=False, error=f"目标目录解析失败: {target_path}")

        result = await _upload_init_transfer(
            source_client=source_client,
            target_client=target_client,
            file_info=file_info,
            target_pid=target_pid,
            target_file_name=target_file_name,
            ua=ua,
            app_name=app_name,
        )
        return result
    except Exception as exc:  # noqa: BLE001
        return FastTransferResponse(ok=False, error=str(exc))


@app.post("/api/tool/cleanup-directories", response_model=CleanupDirectoriesResponse)
async def tool_cleanup_directories(
    payload: CleanupDirectoriesRequest,
) -> CleanupDirectoriesResponse:
    cookie = payload.cookie.strip()
    if not cookie:
        raise HTTPException(status_code=400, detail="cookie is required")

    directories = _normalize_cleanup_directories(payload.directories)
    if not directories:
        raise HTTPException(status_code=400, detail="directories is required")

    headers: dict[str, str] = {}
    user_agent = payload.user_agent.strip()
    if user_agent:
        headers["user-agent"] = user_agent

    client = P115Client(cookie, app=_resolve_default_app())
    deleted_total = 0
    errors: list[str] = []

    for directory in directories:
        try:
            cid = await _resolve_directory_cid(client, directory, headers)
            if cid <= 0:
                errors.append(f"目录不存在: {directory}")
                continue
            deleted = await _delete_all_children(client, cid, headers)
            deleted_total += deleted
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{directory}: {exc}")

    recycle_cleared = False
    try:
        recycle_result = await client.recyclebin_clean(
            {"password": _normalize_safe_code(payload.safe_code)},
            base_url="https://webapi.115.com",
            async_=True,
            headers=headers,
        )
        check_response(recycle_result)
        recycle_cleared = True
    except Exception as exc:  # noqa: BLE001
        errors.append(f"清空回收站失败: {exc}")

    return CleanupDirectoriesResponse(
        ok=len(errors) == 0,
        deleted_count=deleted_total,
        directories=len(directories),
        recycle_cleared=recycle_cleared,
        errors=errors,
    )


@app.post("/api/tool/qr-login/start", response_model=QrLoginStartResponse)
async def tool_qr_login_start(payload: QrLoginStartRequest) -> QrLoginStartResponse:
    _cleanup_qr_login_sessions()
    target_app = _normalize_qr_login_app(payload.app)
    try:
        token_response = await asyncio.wait_for(
            asyncio.to_thread(P115Client.login_qrcode_token, app="web"),
            timeout=10,
        )
        token_data = token_response["data"]
        uid = str(token_data["uid"])
        qrcode_url = str(token_data.get("qrcode") or f"https://115.com/scan/dg-{uid}")
        image_bytes = await asyncio.wait_for(
            asyncio.to_thread(P115Client.login_qrcode, uid),
            timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"qr login start failed: {exc}") from exc

    session_id = secrets.token_urlsafe(18)
    _qr_login_sessions[session_id] = {
        "session_id": session_id,
        "app": target_app,
        "uid": uid,
        "token": token_data,
        "created_at": int(time()),
    }
    image_data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")
    return QrLoginStartResponse(
        session_id=session_id,
        app=target_app,
        uid=uid,
        qrcode_url=qrcode_url,
        image_data_url=image_data_url,
        expires_in=_QR_LOGIN_TTL_SECONDS,
    )


@app.post("/api/tool/qr-login/poll", response_model=QrLoginPollResponse)
async def tool_qr_login_poll(payload: QrLoginPollRequest) -> QrLoginPollResponse:
    _cleanup_qr_login_sessions()
    session_id = payload.session_id.strip()
    session = _qr_login_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="qr login session not found or expired")

    token_data = session["token"]
    uid = str(session["uid"])
    target_app = str(session["app"])

    try:
        status_response = await asyncio.wait_for(
            asyncio.to_thread(P115Client.login_qrcode_scan_status, token_data),
            timeout=8,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"qr login status failed: {exc}") from exc

    status_name, status_message = _classify_qr_login_status(status_response)
    if status_name in {"expired", "canceled"}:
        _qr_login_sessions.pop(session_id, None)
        return QrLoginPollResponse(
            session_id=session_id,
            app=target_app,
            uid=uid,
            status=status_name,
            message=status_message,
            data=status_response if isinstance(status_response, dict) else {},
        )

    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(P115Client.login_qrcode_scan_result, uid, app=target_app),
            timeout=8,
        )
        cookies = _extract_login_cookies(result)
        if cookies:
            _qr_login_sessions.pop(session_id, None)
            return QrLoginPollResponse(
                session_id=session_id,
                app=target_app,
                uid=uid,
                status="success",
                message="扫码登录成功",
                cookies=cookies,
                data=result if isinstance(result, dict) else {},
            )
    except Exception:
        pass

    return QrLoginPollResponse(
        session_id=session_id,
        app=target_app,
        uid=uid,
        status=status_name,
        message=status_message,
        data=status_response if isinstance(status_response, dict) else {},
    )


async def _get_file_info_by_pickcode(
    client: P115Client,
    pickcode: str,
    user_agent: str,
    app_name: str,
) -> dict:
    info_raw = await client.fs_supervision_app(
        pickcode,
        app=app_name,
        base_url="https://proapi.115.com",
        async_=True,
    )
    info_checked = check_response(info_raw)
    data = info_checked.get("data") if isinstance(info_checked, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError("fs_supervision_app returned invalid data")

    file_name = str(data.get("file_name") or "").strip()
    file_size = int(data.get("file_size") or 0)
    file_sha1 = str(data.get("file_sha1") or "").strip().upper()
    file_pickcode = str(data.get("pick_code") or pickcode).strip()
    if not file_name or not file_size or not file_sha1:
        raise RuntimeError("incomplete file info from source pickcode")

    direct_url_obj = await client.download_url(
        file_pickcode,
        user_agent=user_agent,
        app=app_name,
        async_=True,
    )
    direct_url = getattr(direct_url_obj, "url", "") or str(direct_url_obj)
    if not direct_url:
        raise RuntimeError("cannot resolve source direct url for challenge")

    return {
        "name": file_name,
        "size": file_size,
        "sha1": file_sha1,
        "pickcode": file_pickcode,
        "url": str(direct_url),
    }


async def _ensure_target_dir(client: P115Client, path_value: str) -> Optional[int]:
    path = path_value.strip() or "/sha1cache"
    if not path.startswith("/"):
        path = f"/{path}"

    try:
        dir_info = await client.fs_dir_getid(path, base_url="https://webapi.115.com", async_=True)
        if isinstance(dir_info, dict) and dir_info.get("state"):
            raw_id = dir_info.get("id") or dir_info.get("cid")
            if raw_id is not None:
                return int(str(raw_id))
    except Exception:
        pass

    if path in {"/sha1cache", "/sha1media"}:
        dirname = path.strip("/")
        created = await client.fs_mkdir(dirname, pid=0, base_url="https://webapi.115.com", async_=True)
        checked = check_response(created)
        cid = checked.get("cid") if isinstance(checked, dict) else None
        if cid:
            return int(cid)
    return None


async def _upload_init_transfer(
    source_client: P115Client,
    target_client: P115Client,
    file_info: dict,
    target_pid: int,
    target_file_name: str,
    ua: str,
    app_name: str,
) -> FastTransferResponse:
    source_uid = str(getattr(source_client, "user_id", "") or "").strip()
    target_uid = str(getattr(target_client, "user_id", "") or "").strip()
    payload = {
        "fileid": file_info["sha1"],
        "filename": target_file_name or file_info["name"],
        "filesize": file_info["size"],
        "target": f"U_1_{target_pid}",
    }

    first = await target_client.upload_init(payload, async_=True)
    status = first.get("status") if isinstance(first, dict) else None
    if status == 2:
        return FastTransferResponse(
            ok=True,
            target_pickcode=str(first.get("pickcode") or "").strip(),
            source_pickcode=str(file_info.get("pickcode") or "").strip(),
            source_uid=source_uid,
            target_uid=target_uid,
            file_name=str(payload.get("filename") or file_info.get("name") or ""),
            file_size=int(file_info.get("size") or 0),
            file_sha1=str(file_info.get("sha1") or ""),
            range_verified=False,
        )

    if status != 7:
        return FastTransferResponse(
            ok=False,
            error=f"upload_init failed: {first}",
            source_uid=source_uid,
            target_uid=target_uid,
            file_name=str(payload.get("filename") or file_info.get("name") or ""),
            file_size=int(file_info.get("size") or 0),
            file_sha1=str(file_info.get("sha1") or ""),
        )

    sign_check = str(first.get("sign_check") or "").strip()
    sign_key = str(first.get("sign_key") or "").strip()
    if not sign_check or not sign_key or "-" not in sign_check:
        return FastTransferResponse(
            ok=False,
            error=f"upload_init challenge payload invalid: {first}",
            source_uid=source_uid,
            target_uid=target_uid,
            file_name=str(payload.get("filename") or file_info.get("name") or ""),
            file_size=int(file_info.get("size") or 0),
            file_sha1=str(file_info.get("sha1") or ""),
        )

    challenge_headers = {
        "User-Agent": ua,
        "Range": f"bytes={sign_check}",
    }
    response = requests.get(file_info["url"], headers=challenge_headers, timeout=30)
    response.raise_for_status()
    sign_val = hashlib.sha1(response.content).hexdigest().upper()

    payload["sign_key"] = sign_key
    payload["sign_val"] = sign_val
    second = await target_client.upload_init(payload, async_=True)
    status2 = second.get("status") if isinstance(second, dict) else None
    if status2 == 2:
        return FastTransferResponse(
            ok=True,
            target_pickcode=str(second.get("pickcode") or "").strip(),
            source_pickcode=str(file_info.get("pickcode") or "").strip(),
            source_uid=source_uid,
            target_uid=target_uid,
            file_name=str(payload.get("filename") or file_info.get("name") or ""),
            file_size=int(file_info.get("size") or 0),
            file_sha1=str(file_info.get("sha1") or ""),
            range_verified=True,
        )
    return FastTransferResponse(
        ok=False,
        error=f"upload_init challenge failed: {second}",
        source_uid=source_uid,
        target_uid=target_uid,
        file_name=str(payload.get("filename") or file_info.get("name") or ""),
        file_size=int(file_info.get("size") or 0),
        file_sha1=str(file_info.get("sha1") or ""),
        range_verified=True,
    )


def _resolve_target_file_name(payload: FastTransferRequest) -> str:
    candidates = [
        payload.filename,
        payload.file_name_b,
        payload.file_name,
        payload.target_name,
        payload.new_name,
        payload.name,
        payload.name_b,
        payload.target_file_name,
    ]
    for item in candidates:
        name = str(item or "").strip()
        if name:
            return name
    return ""


def _normalize_cleanup_directories(values: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip().replace("\\", "/")
        if not item:
            continue
        if not item.startswith("/"):
            item = f"/{item}"
        if len(item) > 1:
            item = item.rstrip("/")
        if item == "/":
            continue
        if item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def _normalize_safe_code(value: str) -> str:
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits[:6]


async def _resolve_directory_cid(client: P115Client, directory: str, headers: dict[str, str]) -> int:
    result = await client.fs_dir_getid(
        {"path": directory},
        base_url="https://webapi.115.com",
        async_=True,
        headers=headers,
    )
    checked = check_response(result)
    if not isinstance(checked, dict) or not checked.get("state"):
        return 0
    raw_cid = checked.get("id") or checked.get("cid")
    if raw_cid is None:
        return 0
    return int(str(raw_cid))


async def _delete_all_children(client: P115Client, cid: int, headers: dict[str, str]) -> int:
    deleted = 0
    offset = 0
    limit = 1150
    while True:
        listing = await client.fs_files(
            {
                "cid": cid,
                "offset": offset,
                "limit": limit,
                "show_dir": 1,
                "aid": 1,
                "count_folders": 1,
            },
            base_url="https://webapi.115.com",
            async_=True,
            headers=headers,
        )
        checked = check_response(listing)
        rows = checked.get("data") if isinstance(checked, dict) else None
        if not isinstance(rows, list) or len(rows) == 0:
            break

        ids: list[str] = []
        for row in rows:
            fid = _extract_entry_id(row)
            if fid:
                ids.append(fid)

        if not ids:
            break

        delete_result = await client.fs_delete(
            ids,
            base_url="https://webapi.115.com",
            async_=True,
            headers=headers,
        )
        check_response(delete_result)
        deleted += len(ids)
        if len(rows) < limit:
            break
    return deleted


def _extract_entry_id(row: object) -> str:
    if not isinstance(row, dict):
        return ""
    for key in ("fid", "cid", "id"):
        value = row.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _extract_pickcode(value: str, client: Optional[P115Client] = None) -> str:
    raw = value.strip()
    if not raw:
        return ""

    parsed = urlparse(raw)
    if parsed.scheme in {"http", "https"}:
        query_pickcode = parse_qs(parsed.query).get("pickcode", [""])[0].strip()
        if query_pickcode:
            return query_pickcode

        m = re.search(r"/s/([a-zA-Z0-9]+)", parsed.path)
        if m:
            return m.group(1)

    if raw.isdigit() and client is not None:
        try:
            converted = client.to_pickcode(int(raw))
            return str(converted).strip()
        except Exception:
            return ""

    m = re.search(r"pickcode[:=\s]+([a-zA-Z0-9]+)", raw, flags=re.IGNORECASE)
    if m:
        return m.group(1)

    token = raw.split("|")[-1].strip()
    if re.fullmatch(r"[a-zA-Z0-9]{5,32}", token):
        return token

    if re.fullmatch(r"[a-zA-Z0-9]{5,32}", raw):
        return raw

    return ""


def _rewrite_path(value: str, rules: list[tuple[str, str]]) -> str:
    if not value:
        return value
    normalized = value.replace("\\", "/")
    for src, dst in rules:
        if normalized.startswith(src):
            return f"{dst}{normalized[len(src):]}"
    return normalized


def _load_prefix_rules() -> list[tuple[str, str]]:
    raw = os.getenv(
        "P115_PATH_PREFIX_RULES",
        "/CloudNAS/CloudDrive/115open/media=>/media",
    )
    return _parse_prefix_rules(raw)


def _parse_prefix_rules(raw: str) -> list[tuple[str, str]]:
    rules: list[tuple[str, str]] = []
    for part in re.split(r"[;\n]+", raw):
        item = part.strip()
        if not item:
            continue
        if "=>" in item:
            left, right = item.split("=>", 1)
        elif "->" in item:
            left, right = item.split("->", 1)
        else:
            continue

        src = _normalize_prefix(left)
        dst = _normalize_prefix(right)
        if not src:
            continue
        rules.append((src, dst))
    return rules


def _normalize_prefix(value: str) -> str:
    cleaned = value.strip().replace("\\", "/")
    if not cleaned:
        return ""
    if not cleaned.startswith("/"):
        cleaned = f"/{cleaned}"
    if len(cleaned) > 1 and cleaned.endswith("/"):
        cleaned = cleaned.rstrip("/")
    return cleaned


def _build_request_headers(user_agent: str, extra_headers_raw: str) -> dict[str, str]:
    headers: dict[str, str] = {"user-agent": user_agent}
    parsed = _parse_extra_headers_json(extra_headers_raw)
    if parsed is not None:
        for key, value in parsed.items():
            key_clean = key.strip().lower()
            value_clean = value.strip()
            if key_clean and value_clean:
                headers[key_clean] = value_clean
        return headers

    for line in extra_headers_raw.splitlines():
        item = line.strip()
        if not item or ":" not in item:
            continue
        key, value = item.split(":", 1)
        key_clean = key.strip().lower()
        value_clean = value.strip()
        if not key_clean or not value_clean:
            continue
        headers[key_clean] = value_clean
    return headers


def _parse_extra_headers_json(raw: str) -> Optional[dict[str, str]]:
    text = raw.strip()
    if not text.startswith("{"):
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    result: dict[str, str] = {}
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str):
            result[key] = value
    return result


def _resolve_app_candidates(app_header: str) -> list[str]:
    raw = app_header.strip() or os.getenv("P115_APP_CANDIDATES", "")
    if not raw:
        raw = os.getenv("P115_APP", "android,web")
    candidates = [item.strip() for item in raw.split(",") if item.strip()]
    if not candidates:
        candidates = ["android", "web"]
    return candidates


def _resolve_default_app() -> str:
    candidates = _resolve_app_candidates("")
    return candidates[0] if candidates else "web"


async def _resolve_download_url(
    client: P115Client,
    fs: P115FileSystem,
    pickcode: str,
    source_path: str,
    request_headers: dict[str, str],
    app_candidates: list[str],
):
    last_error: Optional[Exception] = None

    for app_name in app_candidates:
        try:
            current_pickcode = pickcode
            if not current_pickcode:
                current_pickcode = await _resolve_pickcode_from_path(
                    client=client,
                    source_path=source_path,
                    request_headers=request_headers,
                )

            if current_pickcode:
                return await client.download_url(
                    current_pickcode,
                    headers=request_headers,
                    app=app_name,
                    async_=True,
                )

            return await fs.get_url(
                source_path,
                headers=request_headers,
                async_=True,
            )
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            continue

    if last_error is not None:
        raise last_error
    raise RuntimeError("unable to resolve download url")


async def _resolve_pickcode_from_path(
    client: P115Client,
    source_path: str,
    request_headers: dict[str, str],
) -> str:
    path = source_path.strip().replace("\\", "/")
    if not path or "/" not in path:
        return ""

    dir_path, filename = path.rsplit("/", 1)
    if not dir_path or not filename:
        return ""

    dir_info = await client.fs_dir_getid(
        {"path": dir_path},
        async_=True,
        headers=request_headers,
    )
    if not isinstance(dir_info, dict) or not dir_info.get("state"):
        return ""

    cid = dir_info.get("id") or dir_info.get("cid")
    if not cid:
        return ""

    result = await client.fs_search(
        {
            "cid": cid,
            "search_value": filename,
            "limit": 200,
            "offset": 0,
            "show_dir": 1,
            "fc_mix": 1,
            "aid": 1,
        },
        async_=True,
        headers=request_headers,
    )
    if not isinstance(result, dict):
        return ""

    rows = result.get("data")
    if not isinstance(rows, list):
        return ""

    for row in rows:
        if isinstance(row, dict) and row.get("n") == filename:
            found = _pick_pickcode(row)
            if found:
                return found

    for row in rows:
        if isinstance(row, dict):
            found = _pick_pickcode(row)
            if found:
                return found

    return ""


def _pick_pickcode(item: dict) -> str:
    for key in ("pc", "pick_code", "pickcode"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""
