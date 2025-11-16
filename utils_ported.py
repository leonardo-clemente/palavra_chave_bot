# utils_ported.py
import regex as re
from telethon import utils as tg_utils
from telethon.tl.types import PeerChannel

def is_regex_str(s: str) -> bool:
    return bool(re.search(r"^/.*/[a-zA-Z]*?$", s))  # :contentReference[oaicite:4]{index=4}

def js_to_py_re(rx):
    q, params = rx[1:].rsplit("/", 1)              # :contentReference[oaicite:5]{index=5}
    fn = re.findall if "g" in params else re.search
    flags = re.I if "i" in params else 0
    return lambda L: fn(q, L, flags=flags)

def channel_url(username, marked_id, msg_id=None):
    host = "https://t.me/"                          # :contentReference[oaicite:6]{index=6}
    if marked_id:
        real_id, _ = tg_utils.resolve_id(int(marked_id))
        base = f"{host}c/{real_id}/"
    elif username:
        base = f"{host}{username.strip('@')}/"
    else:
        base = host
    return base if msg_id is None else base + str(msg_id)
