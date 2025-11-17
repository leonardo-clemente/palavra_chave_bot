/* ======================= CONFIG & HELPERS ======================= */
const SP = PropertiesService.getScriptProperties();

function cfg() {
  const BOT_TOKEN = SP.getProperty('BOT_TOKEN');
  const SPREADSHEET_ID = SP.getProperty('SPREADSHEET_ID');
  const SECRET = SP.getProperty('WEBHOOK_SECRET') || 'changeme';
  const WEB_APP_URL = SP.getProperty('TELEGRAM_WEBHOOK_URL') || '';
  if (!BOT_TOKEN || !SPREADSHEET_ID) throw new Error('Configure BOT_TOKEN e SPREADSHEET_ID em Script Properties.');
  return { BOT_TOKEN, SPREADSHEET_ID, SECRET, WEB_APP_URL, API: `https://api.telegram.org/bot${BOT_TOKEN}` };
}

function httpPost(url, payload) {
  const opts = { method: 'post', muteHttpExceptions: true };
  if (payload) opts.payload = payload;
  const res = UrlFetchApp.fetch(url, opts);
  try { return JSON.parse(res.getContentText()); } catch (e) { return { ok:false, status: res.getResponseCode(), text: res.getContentText() }; }
}

function sendMessage(chatId, text, parse_mode) {
  const { API } = cfg();
  const payload = { chat_id: chatId, text: String(text) };
  if (parse_mode) payload.parse_mode = parse_mode;
  return httpPost(`${API}/sendMessage`, payload);
}

function nowStr() {
  const tz = Session.getScriptTimeZone() || 'UTC';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
}

function normalizeList(s) {
  return String(s || '')
    .replace(/，/g, ',') // vírgula chinesa
    .replace(/\s*,\s*/g, ',')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

/* ======================= SHEETS LAYER ======================= */
function ss() { return SpreadsheetApp.openById(cfg().SPREADSHEET_ID); }

function getExistingUserId_(chat_id) {
  const sh = ss().getSheetByName('users');
  const vals = sh.getDataRange().getValues(); // header + linhas
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][1]) === String(chat_id)) return parseInt(vals[i][0], 10);
  }
  return null;
}

function isAllowed_(chat_id) {
  const cache = CacheService.getScriptCache();
  const key = 'allow:' + String(chat_id);
  const hit = cache.get(key);
  if (hit !== null) return hit === '1';

  const ok = getExistingUserId_(chat_id) !== null;
  cache.put(key, ok ? '1' : '0', 300); // 5 min
  return ok;
}

function ensureSheets() {
  const s = ss();
  const want = {
    users: ['id','chat_id','created_at'],
    subscriptions: ['id','user_id','keywords','channel_name','chat_id','status','create_time'],
    state: ['key','value'],
  };
  Object.keys(want).forEach(name => {
    let sh = s.getSheetByName(name);
    if (!sh) { sh = s.insertSheet(name); sh.appendRow(want[name]); }
    else if (sh.getLastRow() === 0) { sh.appendRow(want[name]); }
    // Garante header correto:
    const header = sh.getRange(1,1,1,want[name].length).getValues()[0];
    if (header.join('\t') !== want[name].join('\t')) {
      sh.clear();
      sh.appendRow(want[name]);
    }
  });
}

function nextId_(values, colIndex) {
  // values inclui header; colIndex 1-based
  let mx = 0;
  for (let i=1; i<values.length; i++) {
    const v = (values[i][colIndex-1]||'').toString().trim();
    if (/^\d+$/.test(v)) mx = Math.max(mx, parseInt(v,10));
  }
  return mx + 1;
}

function getOrCreateUser_(chat_id) {
  const s = ss();
  const sh = s.getSheetByName('users');
  const vals = sh.getDataRange().getValues();
  for (let i=1;i<vals.length;i++) {
    if (String(vals[i][1]) === String(chat_id)) return parseInt(vals[i][0],10);
  }
  const id = nextId_(vals,1);
  sh.appendRow([id, String(chat_id), nowStr()]);
  return id;
}

function addSubscription_(user_id, keyword, channel_name, chat_id) {
  const s = ss();
  const sh = s.getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  const id = nextId_(vals,1);
  sh.appendRow([id, user_id, keyword, channel_name, String(chat_id||''), 0, nowStr()]);
  return id;
}

function listActiveSubsByUser_(user_id) {
  const s = ss();
  const sh = s.getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  const out = [];
  for (let i=1;i<vals.length;i++) {
    const r = vals[i];
    if (String(r[1])===String(user_id) && String(r[5])==='0') {
      out.push({ id:r[0], keyword:r[2], channel_name:r[3], chat_id:r[4] });
    }
  }
  return out;
}

function deactivateByKeyword_(user_id, keyword, channel_name_opt) {
  const s = ss();
  const sh = s.getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  let updated=0;
  for (let i=1;i<vals.length;i++) {
    const r = vals[i];
    if (String(r[1])===String(user_id) && String(r[2])===String(keyword) && String(r[5])==='0') {
      if (!channel_name_opt || String(r[3])===String(channel_name_opt)) {
        sh.getRange(i+1, 6).setValue(1); // status -> 1
        updated++;
      }
    }
  }
  return updated;
}

function deactivateByIds_(user_id, idsArr) {
  const s = ss();
  const sh = s.getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  const wanted = new Set(idsArr.map(x=>String(x)));
  let updated=0;
  for (let i=1;i<vals.length;i++) {
    const r = vals[i];
    if (wanted.has(String(r[0])) && String(r[1])===String(user_id) && String(r[5])==='0') {
      sh.getRange(i+1, 6).setValue(1); updated++;
    }
  }
  return updated;
}

function deactivateAll_(user_id) {
  const s = ss();
  const sh = s.getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  let updated=0;
  for (let i=1;i<vals.length;i++) {
    const r = vals[i];
    if (String(r[1])===String(user_id) && String(r[5])==='0') { sh.getRange(i+1,6).setValue(1); updated++; }
  }
  return updated;
}

/* ======================= TELEGRAM WEBHOOK (apenas comandos) ======================= */
function setWebhook() {
  const { API, WEB_APP_URL, SECRET } = cfg();
  if (!WEB_APP_URL) throw new Error('Defina WEB_APP_URL nas Script Properties (URL do Web App).');
  const url = `${WEB_APP_URL}?secret=${encodeURIComponent(SECRET)}`;
  const r = httpPost(`${API}/setWebhook`, { url });
  Logger.log(r);
}

function deleteWebhook() {
  const { API } = cfg();
  const r = httpPost(`${API}/deleteWebhook`, {});
  Logger.log(r);
}

function doPost(e) {
  try {
    ensureSheets();
    const { SECRET } = cfg();
    if (!e || !e.postData) return HtmlService.createHtmlOutput("");
    if (!e.parameter || e.parameter.secret !== SECRET) return HtmlService.createHtmlOutput('unauthorized');

    const update = JSON.parse(e.postData.contents);
    if (update.message) handleMessage_(update.message);
    return HtmlService.createHtmlOutput("");
  } catch (err) {
    console.error(err);
    return HtmlService.createHtmlOutput('error');
  }
}

function handleMessage_(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId) return;
  const text = (msg.text || msg.caption || '').trim();
  if (!text.startsWith('/')) return; // só comandos via DM
  if (msg.chat && msg.chat.type !== 'private') return;

  if (!isAllowed_(chatId)) {
  }

  const userId = getExistingUserId_(chatId);

  const parts = text.replace(/\s+/g, ' ').split(' ');
  const cmd = (parts[0]||'').toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/start':
      sendMessage(chatId, '✅ Bot pronto! Use /help para ver os comandos.');
      break;
    case '/help':
        sendMessage(chatId,
        'Comandos:\n' +
        '/start – Inicia e autoriza o bot\n' +
        '/help – Ajuda e instruções\n' +
        '/subscribe kw1,kw2 canal1,canal2 – Assinar (suporta regex: /exp/gi)\n' +
        '/unsubscribe kw canal – Desativar por keyword\n' +
        '/unsubscribe_id 10,22 – Desativar por IDs\n' +
        '/unsubscribe_all – Desativar tudo\n' +
        '/list – Listar assinaturas ativas\n' +
        '/cancel – Cancelar operação');
      break;
    case '/subscribe':
      cmdSubscribe_(chatId, userId, args);
      break;
    case '/unsubscribe':
      cmdUnsubscribe_(chatId, userId, args);
      break;
    case '/unsubscribe_id':
      cmdUnsubscribeId_(chatId, userId, args);
      break;
    case '/unsubscribe_all':
      const n = deactivateAll_(userId);
      sendMessage(chatId, `🧹 Assinaturas desativadas: ${n}`);
      break;
    case '/list':
      cmdList_(chatId, userId);
      break;
    case '/cancel':
      sendMessage(chatId, 'OK, nada a cancelar.');
      break;
    default:
      sendMessage(chatId, 'Comando não reconhecido. Use /help.');
  }
}

/* ======================= COMANDOS ======================= */
function hasSubscription_(user_id, keyword, channel_name, chat_id) {
  const sh = ss().getSheetByName('subscriptions');
  const vals = sh.getDataRange().getValues();
  for (let i=1;i<vals.length;i++) {
    const r = vals[i];
    const active = String(r[5]) === '0';
    if (active &&
        String(r[1])===String(user_id) &&
        String(r[2])===String(keyword) &&
        String(r[3])===String(channel_name||'') &&
        String(r[4])===String(chat_id||'')) {
      return true;
    }
  }
  return false;
}

function cmdSubscribe_(chatId, userId, args) {
  if (!args) { sendMessage(chatId, 'Uso: /subscribe kw1,kw2 canal1,canal2'); return; }
  const split = args.replace(/\s*,\s*/g, ',').split(' ');
  if (split.length < 2) { sendMessage(chatId, 'Uso: /subscribe kw1,kw2 canal1,canal2'); return; }
  const keywords = normalizeList(split[0]);
  const channels = normalizeList(split.slice(1).join(' '));
  if (!keywords.length || !channels.length) { sendMessage(chatId, 'Uso: /subscribe kw1,kw2 canal1,canal2'); return; }

  const added = [];
  const errors = [];
  channels.forEach(ch => {
    const res = resolveChannel_(ch); // retorna {channel_name, chat_id}
    keywords.forEach(kw => {
      try {
        if (!hasSubscription_(userId, kw, res.channel_name, res.chat_id)) {
          const id = addSubscription_(userId, kw, res.channel_name, res.chat_id);
          added.push({id, kw, ch: res.channel_name || res.chat_id});
        }
      } catch (e) {
        errors.push(`${kw} @ ${ch}: ${e.message}`);
      }
    });
  });
  if (added.length) {
    const lines = added.map(x => `#${x.id} • ${x.kw} • ${x.ch}`).join('\n');
    sendMessage(chatId, '✅ Assinaturas criadas:\n' + lines);
  }
  if (errors.length) sendMessage(chatId, '⚠️ Alguns itens falharam:\n' + errors.join('\n'));
}

function cmdUnsubscribe_(chatId, userId, args) {
  const parts = args.replace(/\s*,\s*/g, ',').split(' ');
  if (!parts[0]) { sendMessage(chatId, 'Uso: /unsubscribe kw canal'); return; }
  const kw = parts[0];
  const channel = parts[1] || '';
  const ch = channel ? resolveChannel_(channel) : { channel_name: '', chat_id: '' };
  const key = ch.channel_name || '';
  const count = deactivateByKeyword_(userId, kw, key || null);
  sendMessage(chatId, `♻️ Desativadas: ${count}`);
}

function cmdUnsubscribeId_(chatId, userId, args) {
  if (!args) { sendMessage(chatId, 'Uso: /unsubscribe_id 10,22'); return; }
  const ids = normalizeList(args).map(x => parseInt(x,10)).filter(n => !isNaN(n));
  if (!ids.length) { sendMessage(chatId, 'Uso: /unsubscribe_id 10,22'); return; }
  const n = deactivateByIds_(userId, ids);
  sendMessage(chatId, `🗑️ Desativadas por ID: ${n}`);
}

function cmdList_(chatId, userId) {
  const rows = listActiveSubsByUser_(userId);
  if (!rows.length) { sendMessage(chatId, 'Nenhuma assinatura ativa.'); return; }
  const lines = rows.map(r => `#${r.id} • ${r.keyword} • ${(r.channel_name||r.chat_id)}`).join('\n');
  sendMessage(chatId, '📋 Assinaturas ativas:\n' + lines);
}

/* ======================= PARSER DE CANAL ======================= */
function resolveChannel_(input) {
  // Aceita: @username | https://t.me/username | -100123 | c/NNN
  let u = String(input || '').trim();
  u = u.replace(/^https?:\/\/t\.me\//, '');
  u = u.replace(/^@/, '');
  // Link de canal privado t.me/c/NNN/MSG -> usamos NNN como sufixo do -100
  const mC = u.match(/^c\/(\d+)/);
  if (mC) return { channel_name: '', chat_id: `-100${mC[1]}` };
  if (/^-?\d+$/.test(u)) return { channel_name: '', chat_id: u };
  return { channel_name: u, chat_id: '' };
}

/* ======================= MAINTENANCE ======================= */
function bootstrap() { ensureSheets(); Logger.log('Sheets ok'); }
