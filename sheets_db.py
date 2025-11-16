# sheets_db.py
import os, json, time
import gspread
from google.oauth2.service_account import Credentials

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET_ID = os.environ["GSHEET_ID"]
GOOGLE_CREDS = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])

_creds = Credentials.from_service_account_info(GOOGLE_CREDS, scopes=SCOPES)
_gc = gspread.authorize(_creds)
_sh = _gc.open_by_key(SHEET_ID)
_ws_users = _sh.worksheet("users")
_ws_subs  = _sh.worksheet("subscriptions")
_ws_state = _sh.worksheet("state")

def _rows(ws): return ws.get_all_records()

def upsert_user(chat_id: str):
    # id = timestamp p/ simplicidade
    users = _rows(_ws_users)
    for i, r in enumerate(users, start=2):
        if str(r.get("chat_id")) == str(chat_id): return r.get("id")
    new_id = int(time.time() * 1000)
    _ws_users.append_row([new_id, str(chat_id), time.strftime("%Y-%m-%d %H:%M:%S")])
    return new_id

def list_users(): return _rows(_ws_users)

def list_active_subs():
    return [r for r in _rows(_ws_subs) if str(r.get("status", 0)) == "0"]

def add_sub(user_id, keyword, channel_name, chat_id=""):
    _ws_subs.append_row([
        int(time.time()*1000), user_id, keyword, (channel_name or "").replace("@",""),
        str(chat_id or ""), 0, time.strftime("%Y-%m-%d %H:%M:%S")
    ])

def deactivate_sub_by_id(user_id, sub_id):
    rows = _rows(_ws_subs)
    for idx, r in enumerate(rows, start=2):
        if r.get("id") == sub_id and r.get("user_id") == user_id:
            _ws_subs.update(f"F{idx}", 1)  # status
            return True
    return False

def state_get(key, default="0"):
    rows = _rows(_ws_state)
    for idx, r in enumerate(rows, start=2):
        if r.get("key") == key:
            return r.get("value", default)
    return default

def state_set(key, value):
    rows = _rows(_ws_state)
    for idx, r in enumerate(rows, start=2):
        if r.get("key") == key:
            _ws_state.update(f"B{idx}", str(value)); return
    _ws_state.append_row([key, str(value)])
