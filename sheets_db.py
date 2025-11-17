import os
import json
from typing import Any, Dict, List, Optional

import gspread
from google.oauth2.service_account import Credentials


# ======== Auth / Sheets =========
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET_ID = os.environ["GSHEET_ID"]
GOOGLE_CREDS = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])

_creds = Credentials.from_service_account_info(GOOGLE_CREDS, scopes=SCOPES)
_gc = gspread.authorize(_creds)
_sh = _gc.open_by_key(SHEET_ID)

# Expected worksheets
_ws_users = _sh.worksheet("users")
_ws_subs = _sh.worksheet("subscriptions")
_ws_state = _sh.worksheet("state")


# ======== Helpers =========
def _norm_key(s: str) -> str:
    """normalize header names -> snake_case, lower, trimmed"""
    return (
        str(s or "")
        .strip()
        .lower()
        .replace(" ", "_")
        .replace("-", "_")
    )


def _safe_str(x: Any) -> str:
    return "" if x is None else str(x)


def _rows(ws) -> List[Dict[str, Any]]:
    """
    Read a worksheet into a list of dicts using the first row as headers.
    Empty trailing rows are ignored.
    """
    values = ws.get_all_values() or []
    if not values:
        return []
    headers = [_norm_key(h) for h in values[0]]
    rows: List[Dict[str, Any]] = []
    for r in values[1:]:
        if not any(_safe_str(c).strip() for c in r):
            # skip fully empty row
            continue
        # pad row to header length
        padded = list(r) + [""] * (len(headers) - len(r))
        rows.append({headers[i]: padded[i] for i in range(len(headers))})
    return rows


def _is_true(v: Any) -> bool:
    s = _safe_str(v).strip().lower()
    return s in {"1", "true", "t", "yes", "y", "sim", "on", "ativo", "active", "enabled", "enable"}


# ======== Public API used by runner.py =========
def list_users() -> List[Dict[str, Any]]:
    """
    Returns list of users from 'users' sheet.
    Must include an 'id' key (Telegram chat_id of the user).
    Other columns are passed through as-is.
    """
    rows = _rows(_ws_users)
    out = []
    for r in rows:
        # Common headers: id, name, username, allowed
        rid = _safe_str(r.get("id") or r.get("chat_id") or r.get("user_id"))
        if not rid:
            continue
        r["id"] = rid
        out.append(r)
    return out


def list_active_subs() -> List[Dict[str, Any]]:
    """
    Returns only active subscriptions with keys at least:
      - user_id
      - keywords
      - channel_name OR chat_id
    Accepts various column spellings and a 'status' or 'active' boolean.
    """
    rows = _rows(_ws_subs)
    out: List[Dict[str, Any]] = []
    for r in rows:
        status = r.get("status")
        active_flag = r.get("active") or r.get("enabled")
        
        if status is not None:
            if str(status).strip() != "0":
                continue
        elif active_flag is not None:
            if not _is_true(active_flag):
                continue
                
        user_id = _safe_str(r.get("user_id") or r.get("uid") or r.get("owner_id") or "")
        keywords = _safe_str(r.get("keywords") or r.get("kw") or "")

        channel_name = _safe_str(
            r.get("channel_name") or r.get("channel") or r.get("canal") or r.get("username") or ""
        )
        chat_id = _safe_str(r.get("chat_id") or r.get("marked_id") or "")

        if not user_id or not keywords or not (chat_id or channel_name):
            # require minimum fields
            continue

        out.append(
            {
                **r,
                "user_id": user_id,
                "keywords": keywords,
                "channel_name": channel_name,
                "chat_id": chat_id,
            }
        )
    return out


def state_get(key: str, default: Optional[str] = None) -> Optional[str]:
    """
    Reads from 'state' sheet (A=key, B=value).
    Returns default when key isn't found or when value is empty.
    """
    key = _safe_str(key)
    if not key:
        return default
    try:
        cell = _ws_state.find(key, in_column=1)
    except gspread.exceptions.CellNotFound:
        cell = None
    if not cell:
        return default
    value = _ws_state.acell(f"B{cell.row}").value
    return value if value not in (None, "") else default


def state_set(key: str, value: Optional[str]) -> None:
    """
    Upserts 'state' sheet (A=key, B=value). Fixes the 400 by
    using update_acell (or 1x1 values_update) for single cell writes.
    """
    key = _safe_str(key)
    value = _safe_str(value)
    if not key:
        return
    try:
        cell = _ws_state.find(key, in_column=1)
    except gspread.exceptions.CellNotFound:
        cell = None

    if cell:
        # Update existing B{row}
        _ws_state.update_acell(f"B{cell.row}", value)
    else:
        # Append new row [key, value]
        _ws_state.append_row([key, value], value_input_option="RAW")


def backfill_chat_id(channel_name: str, chat_id: str) -> None:
    """
    Fills chat_id in 'subscriptions' when channel_name matches and chat_id is empty.
    Helps stabilizing the state key on the runner.
    """
    if not channel_name or not chat_id:
        return
    rows = _rows(_ws_subs)
    normalized = channel_name.replace("@", "")
    for idx, r in enumerate(rows, start=2):  # +2: skip header and 1-indexed sheet
        rn = _safe_str(r.get("channel_name") or r.get("channel") or "").replace("@", "")
        cid = _safe_str(r.get("chat_id")).strip()
        if rn == normalized and not cid:
            # Single-cell update -> use update_acell to avoid API 400
            _ws_subs.update_acell(f"E{idx}", _safe_str(chat_id))  # E = 'chat_id' in template


__all__ = [
    "list_users",
    "list_active_subs",
    "state_get",
    "state_set",
    "backfill_chat_id",
]
