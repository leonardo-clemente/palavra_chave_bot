# runner.py
import os, asyncio, json
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import JoinChannelRequest
from telethon.tl.functions.messages import ImportChatInviteRequest, CheckChatInviteRequest
from telethon.tl.types import PeerChannel
from telethon import utils as tg_utils
import requests

from sheets_db import list_users, list_active_subs, state_get, state_set
from utils_ported import is_regex_str, js_to_py_re, channel_url

API_ID   = int(os.environ["TG_API_ID"])
API_HASH = os.environ["TG_API_HASH"]
SESSION  = os.environ["TG_SESSION"]         # StringSession
BOT_TOKEN = os.environ["BOT_TOKEN"]

def send_bot(chat_id, text):
    requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
        data={"chat_id": str(chat_id), "text": text, "parse_mode": "Markdown",
              "disable_web_page_preview": False},
        timeout=30
    )

async def ensure_join(client, identifier):
    username = ""; marked = ""
    try:
        if identifier.lstrip("-").isdigit():  # -100...
            real, _ = tg_utils.resolve_id(int(identifier))
            await client(JoinChannelRequest(PeerChannel(real)))
            marked = tg_utils.get_peer_id(PeerChannel(real))
        elif identifier.startswith("+"):      # convite
            inv = identifier[1:]
            await client(ImportChatInviteRequest(inv))
            chk = await client(CheckChatInviteRequest(inv))
            if chk and hasattr(chk, "chat"):
                marked = tg_utils.get_peer_id(PeerChannel(chk.chat.id))
        else:                                 # @canal
            uname = identifier.strip("@")
            await client(JoinChannelRequest(uname))
            ent = await client.get_entity(uname)
            username = ent.username
            marked = tg_utils.get_peer_id(PeerChannel(ent.id))
    except Exception:
        pass
    return username, marked

async def main():
    users = {str(u["id"]): u for u in list_users() if "id" in u}
    subs = list_active_subs()

    # agrupa por canal
    by_channel = {}
    for s in subs:
        ck = s.get("chat_id") or s.get("channel_name")
        if ck: by_channel.setdefault(str(ck), []).append(s)

    async with TelegramClient(StringSession(SESSION), API_ID, API_HASH) as client:
        for canal, assinaturas in by_channel.items():
            uname, marked = await ensure_join(client, canal)
            entity = canal
            try:
                if canal.lstrip("-").isdigit():
                    real, _ = tg_utils.resolve_id(int(canal))
                    entity = PeerChannel(real)
                elif canal.startswith("+") and marked:
                    real, _ = tg_utils.resolve_id(int(marked))
                    entity = PeerChannel(real)
                else:
                    entity = canal.strip("@")
            except Exception:
                pass

            state_key = f"last_msg_id:{('@'+uname) if uname else (('c/'+str(tg_utils.resolve_id(int(marked))[0])) if marked else canal)}"
            last = int(state_get(state_key, "0"))
            max_seen = last

            async for msg in client.iter_messages(entity, min_id=last, reverse=True):
                text = (msg.message or "")
                if msg.file and msg.file.name:
                    text += " " + msg.file.name                           # :contentReference[oaicite:8]{index=8}

                for s in assinaturas:
                    uid = str(s["user_id"]); kw = s["keywords"]
                    user = users.get(uid); 
                    if not user: continue
                    dest = user["chat_id"]

                    matched, hit_str = False, ""
                    if is_regex_str(kw):
                        hits = js_to_py_re(kw)(text) or []
                        if not isinstance(hits, list): 
                            hits = [hits.group()] if hits else []
                        hits = list({("".join(h) if isinstance(h, tuple) else h) for h in hits if h})
                        matched = bool(hits); hit_str = "**" + ", ".join(hits) + "**" if hits else ""
                    else:
                        matched = kw.lower() in text.lower()
                        hit_str = f"**{kw}**" if matched else ""

                    if matched:
                        url = channel_url(uname, marked or s.get("chat_id"), msg.id)
                        send_bot(dest, f"[#FOUND]({url}) {hit_str}")

                if msg.id > max_seen: max_seen = msg.id

            if max_seen > last:
                state_set(state_key, str(max_seen))

if __name__ == "__main__":
    asyncio.run(main())
