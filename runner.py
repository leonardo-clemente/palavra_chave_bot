import os, asyncio, time, requests
from datetime import datetime, timedelta
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import ImportChatInviteRequest, CheckChatInviteRequest
from telethon.tl.types import PeerChannel
from telethon import utils as tg_utils

from sheets_db import list_users, list_active_subs, state_get, state_set, backfill_chat_id
from utils_ported import is_regex_str, js_to_py_re, channel_url

API_ID   = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
SESSION  = os.environ["TG_SESSION"]         # StringSession
BOT_TOKEN = os.environ["BOT_TOKEN"]

# ----------------------------
# Tunables (env overrides)
# ----------------------------
LOOKBACK_HOURS = int(os.getenv("LOOKBACK_HOURS", "24"))
MAX_MSGS_PER_CHANNEL = int(os.getenv("MAX_MSGS_PER_CHANNEL", "1000"))
MAX_CONCURRENCY = int(os.getenv("MAX_CONCURRENCY", "4"))

# ----------------------------
# Bot API session + retries
# ----------------------------
_session = requests.Session()
def send_bot(chat_id, text):
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    data = {"chat_id": str(chat_id), "text": text, "parse_mode": "Markdown", "disable_web_page_preview": False}
    for attempt in range(3):
        r = _session.post(url, data=data, timeout=20)
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(1 + attempt * 2)
            continue
        r.raise_for_status()
        return r.json()

# ----------------------------
# Join/resolve otimizado
# ----------------------------
async def ensure_join_fast(client, identifier: str):
    """
    Resolve canal para (username, marked_id), evitando joins desnecessários.
    - Se já for -100..., só resolve o peer (não dá join).
    - Se for convite +hash, importa uma vez e pega o id.
    - Se for @username, tenta get_entity; só dá join se precisar.
    """
    username = ""; marked = ""
    try:
        if identifier.lstrip("-").isdigit():  # -100...
            real, _ = tg_utils.resolve_id(int(identifier))
            marked = tg_utils.get_peer_id(PeerChannel(real))
        elif identifier.startswith("+"):      # convite
            inv = identifier[1:]
            await client(ImportChatInviteRequest(inv))
            chk = await client(CheckChatInviteRequest(inv))
            if chk and hasattr(chk, "chat"):
                marked = tg_utils.get_peer_id(PeerChannel(chk.chat.id))
        else:                                 # @canal
            uname = identifier.strip("@")
            try:
                ent = await client.get_entity(uname)  # leve
            except Exception:
                await client(JoinChannelRequest(uname))  # fallback
                ent = await client.get_entity(uname)
            username = ent.username or uname
            marked = tg_utils.get_peer_id(PeerChannel(ent.id))
    except Exception:
        pass
    return username, marked

def _state_key_for(marked: str | None, canal: str, username: str | None = ""):
    """Prefira chave por chat_id (estável)."""
    if marked:
        real_id, _ = tg_utils.resolve_id(int(marked))
        return f"last_msg_id:c/{real_id}"
    if username:
        return f"last_msg_id:@{username}"
    return f"last_msg_id:{canal}"

def _compile_keywords(assinaturas, users_map):
    """
    Pré-compila keywords por canal.
    Retorna tuplas: (kind, obj, display_kw, dest_chat_id)
    """
    compiled = []
    for s in assinaturas:
        uid = str(s["user_id"]); kw = str(s["keywords"] or "")
        user = users_map.get(uid)
        if not user:
            continue
        dest = user["chat_id"]
        if is_regex_str(kw):
            import regex as re
            query, params = kw[1:].rsplit("/", 1)
            flags = re.I if "i" in params else 0
            fn = re.findall if "g" in params else re.search
            rx = lambda text, _q=query, _f=flags, _fn=fn: _fn(_q, text, flags=_f)
            compiled.append(("regex", rx, kw, dest))
        else:
            compiled.append(("plain", kw.lower(), kw, dest))
    return compiled

async def process_channel(client, canal, assinaturas, users):
    # Resolve canal e estabiliza chat_id
    uname, marked = await ensure_join_fast(client, canal)
    if (uname or marked) and canal and not canal.lstrip("-").isdigit():
        try:
            if marked and uname:
                backfill_chat_id(uname, marked)
        except Exception:
            pass

    # Entidade a percorrer
    entity = canal
    try:
        if (marked and canal.startswith("+")) or canal.lstrip("-").isdigit():
            real, _ = tg_utils.resolve_id(int(marked or canal))
            entity = PeerChannel(real)
        else:
            entity = (uname or canal).strip("@")
    except Exception:
        pass

    # Checkpoint (prefer chat_id)
    state_key = _state_key_for(marked, canal, uname)
    last = int(state_get(state_key, "0"))
    max_seen = last

    # Iterator incremental ou lookback de 24h (configurável)
    if last > 0:
        iterator = client.iter_messages(entity, min_id=last, reverse=True)
    else:
        offset_date = datetime.utcnow() - timedelta(hours=LOOKBACK_HOURS)
        iterator = client.iter_messages(entity, offset_date=offset_date, reverse=True)

    # Pré-compilação
    compiled = _compile_keywords(assinaturas, users)

    # Varredura
    count = 0
    async for msg in iterator:
        text = (msg.message or "")
        if msg.file and msg.file.name:
            text += " " + msg.file.name
        text_l = text.lower()

        # Agrega hits por usuário (evita múltiplos envios)
        hits_by_user = {}  # dest_chat_id -> set(kw)
        for kind, obj, disp, dest in compiled:
            if kind == "plain":
                if obj and obj in text_l:
                    hits_by_user.setdefault(dest, set()).add(disp)
            else:
                matches = obj(text) or []
                if not isinstance(matches, list):
                    matches = [matches.group()] if matches else []
                flat = {("".join(m) if isinstance(m, tuple) else m) for m in matches if m}
                if flat:
                    hits_by_user.setdefault(dest, set()).update(flat or {disp})

        if hits_by_user:
            # usa qualquer chat_id conhecido para construir a URL quando possível
            known_chat_id = next((s.get("chat_id") for s in assinaturas if s.get("chat_id")), "")
            url = channel_url(uname, marked or known_chat_id, msg.id)
            for dest, kws in hits_by_user.items():
                hit_str = "**" + ", ".join(sorted(kws)) + "**"
                try:
                    send_bot(dest, f"[#FOUND]({url}) {hit_str}")
                except Exception:
                    pass

        if msg.id > max_seen:
            max_seen = msg.id

        count += 1
        if count >= MAX_MSGS_PER_CHANNEL:
            break

    if max_seen > last:
        state_set(state_key, str(max_seen))

async def main():
    users = {str(u["id"]): u for u in list_users() if "id" in u}
    subs = list_active_subs()

    # Agrupa assinaturas por canal
    by_channel: dict[str, list[dict]] = {}
    for s in subs:
        ck = s.get("chat_id") or s.get("channel_name")
        if ck:
            by_channel.setdefault(str(ck), []).append(s)

    async with TelegramClient(StringSession(SESSION), API_ID, API_HASH) as client:
        sem = asyncio.Semaphore(MAX_CONCURRENCY)

        async def run_one(canal, assinaturas):
            async with sem:
                await process_channel(client, canal, assinaturas, users)

        await asyncio.gather(*(run_one(c, a) for c, a in by_channel.items()))

if __name__ == "__main__":
    asyncio.run(main())
