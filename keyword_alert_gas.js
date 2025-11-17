const SP = PropertiesService.getScriptProperties();

function cfg(){
  const BOT_TOKEN=SP.getProperty('BOT_TOKEN');
  const SPREADSHEET_ID=SP.getProperty('SPREADSHEET_ID');
  if(!BOT_TOKEN||!SPREADSHEET_ID) throw new Error('Configure BOT_TOKEN e SPREADSHEET_ID em Script Properties.');
  const SECRET=SP.getProperty('WEBHOOK_SECRET')||'';
  const WEB_APP_URL=SP.getProperty('TELEGRAM_WEBHOOK_URL')||'';
  const ALLOWED_CHAT_IDS=(SP.getProperty('ALLOWED_CHAT_IDS')||'').split(',').map(s=>s.trim()).filter(Boolean);
  const OPEN_SIGNUP=String(SP.getProperty('OPEN_SIGNUP')||'false').toLowerCase()==='true';
  return{BOT_TOKEN,SPREADSHEET_ID,SECRET,WEB_APP_URL,ALLOWED_CHAT_IDS,OPEN_SIGNUP,API:`https://api.telegram.org/bot${BOT_TOKEN}`};
}

const TG={
  call:(m,p)=>httpPost(`${cfg().API}/${m}`,p||{}),
  send:(chat_id,text,extra)=>TG.call('sendMessage',Object.assign({chat_id:String(chat_id),text:String(text),parse_mode:'HTML',disable_web_page_preview:true},extra||{})),
  edit:(chat_id,message_id,text,extra)=>TG.call('editMessageText',Object.assign({chat_id:String(chat_id),message_id,text:String(text),parse_mode:'HTML',disable_web_page_preview:true},extra||{})),
  answer:(id,text)=>TG.call('answerCallbackQuery',{callback_query_id:id,text:text||''})
};

function httpPost(url,payload){
  const res=UrlFetchApp.fetch(url,{method:'post',muteHttpExceptions:true,payload});
  try{return JSON.parse(res.getContentText());}catch(e){return{ok:false,status:res.getResponseCode(),text:res.getContentText()};}
}

const nowStr=()=>Utilities.formatDate(new Date(),Session.getScriptTimeZone()||'UTC','yyyy-MM-dd HH:mm:ss');
const parseList_=s=>String(s||'').split(/[;,]/).map(x=>x.trim()).filter(Boolean);
const normalizeList=s=>String(s||'').replace(/，/g,',').replace(/\s*,\s*/g,',').split(',').map(x=>x.trim()).filter(Boolean); // mantida por compat.

/* ======================= KEYWORD TRANSLATOR (símbolos -> regex) ======================= */
// Mantém compatibilidade: se o usuário enviar /.../flags, usamos como está.
function _looksLikeRegexLiteral(s){
  return /^\/.+\/[a-z]*$/i.test(String(s || '').trim());
}

// Escapa metacaracteres de regex
function _escapeRe(s){ return String(s).replace(/[\\.^$|?*+()[\]{}]/g, '\\$&'); }

// Se a palavra contiver acento ou 'ç', expandimos aquele(s) ponto(s) para o grupo apropriado
function _needsAccentExpansion(token){ return /[áàâãéêíóôõúüç]/i.test(token); }

// Mapas de variantes (minúsculas; usamos (?i) para case-insensitive)
const _ACCENT_GROUPS = {
  'a':'aáàâã','á':'aáàâã','à':'aáàâã','â':'aáàâã','ã':'aáàâã',
  'e':'eéê','é':'eéê','ê':'eéê',
  'i':'ií','í':'ií',
  'o':'oóôõ','ó':'oóôõ','ô':'oóôõ','õ':'oóôõ',
  'u':'uúü','ú':'uúü','ü':'uúü',
  'ç':'cç'
};

// Converte um token (palavra) para o núcleo de regex com expansão apenas nos pontos acentuados
function _tokenToCorePattern(token){
  token = String(token || '').trim();
  if(!token) return '';
  if(!_needsAccentExpansion(token)) return _escapeRe(token);

  var out = '';
  for(var i=0;i<token.length;i++){
    var ch = token[i];
    var grp = _ACCENT_GROUPS[ch.toLowerCase()];
    if(grp) out += '[' + grp + ']';
    else out += _escapeRe(ch);
  }
  return out;
}

function _wordBoundary(core){ return '\\b(?:' + core + ')\\b'; }

// Converte expressão com +, -, = para uma regex PCRE-like: /(?i)^(?!...)(?=.*...)(?=.*...).*/
function compileSymbolsExpressionToRegex(expr){
  expr = String(expr || '').trim();
  if(!expr) return expr;
  if(_looksLikeRegexLiteral(expr)) return expr;     // já é regex literal => mantém
  if(!/[+\-=]/.test(expr)) return expr;            // sem símbolos => mantém texto simples

  // Dividimos por '+': cada segmento pode ter OR (=) e exclusões (-)
  var includeGroups = []; // cada item: array de alternativas OR
  var excludes = [];
  var segments = expr.split('+').map(function(s){ return s.trim(); }).filter(function(x){ return !!x; });

  segments.forEach(function(seg){
    var minusParts = seg.split('-').map(function(s){ return s.trim(); }).filter(function(x){ return !!x; });
    var base = minusParts.shift(); // parte obrigatória deste segmento (pode ter '='
    if(base){
      var alts = base.split('=').map(function(s){ return s.trim(); }).filter(function(x){ return !!x; });
      includeGroups.push(alts);
    }
    minusParts.forEach(function(ex){ if(ex) excludes.push(ex); });
  });

  // Negativos (um único ^ no começo se houver exclusões)
  var negativePart = '';
  if(excludes.length){
    negativePart = '^' + excludes.map(function(ex){
      var core = _tokenToCorePattern(ex);
      return '(?!.*' + _wordBoundary(core) + ')';
    }).join('');
  }

  // Positivos (todas as AND devem aparecer)
  var positivePart = includeGroups.map(function(group){
    var core = group.map(_tokenToCorePattern).filter(function(x){ return !!x; }).join('|');
    return '(?=.*' + _wordBoundary(core) + ')';
  }).join('');

  var body = negativePart + positivePart + '.*';
  return '/(?i)' + body + '/';
}

/* ======================= SHEETS LAYER ======================= */
function ss(){return SpreadsheetApp.openById(cfg().SPREADSHEET_ID);} // abre 1x/execução por cache do Apps Script

function ensureSheets(){
  const s=ss();
  const want={
    users:['id','chat_id','created_at'],
    subscriptions:['id','user_id','keywords','channel_name','chat_id','status','create_time'],
    state:['key','value']
  };
  Object.keys(want).forEach(name=>{
    let sh=s.getSheetByName(name); if(!sh) sh=s.insertSheet(name);
    if(sh.getLastRow()===0) sh.appendRow(want[name]);
    const rng=sh.getRange(1,1,1,want[name].length), header=rng.getValues()[0];
    if(header.join('\t')!==want[name].join('\t')){ sh.clear(); sh.getRange(1,1,1,want[name].length).setValues([want[name]]); }
  });
}

function nextId_(values,col){let mx=0;for(let i=1;i<values.length;i++){const v=(values[i][col-1]||'').toString().trim();if(/^\d+$/.test(v)) mx=Math.max(mx,parseInt(v,10));}return mx+1;}

function _vals(name){return ss().getSheetByName(name).getDataRange().getValues();}

function getExistingUserId_(chat_id){const vals=_vals('users');for(let i=1;i<vals.length;i++) if(String(vals[i][1])===String(chat_id)) return parseInt(vals[i][0],10);return null;}

function getOrCreateUser_(chat_id){
  const s=ss(), sh=s.getSheetByName('users'), vals=sh.getDataRange().getValues();
  for(let i=1;i<vals.length;i++) if(String(vals[i][1])===String(chat_id)) return parseInt(vals[i][0],10);
  const id=nextId_(vals,1); sh.appendRow([id,String(chat_id),nowStr()]);
  CacheService.getScriptCache().remove('allow:'+String(chat_id));
  return id;
}

function addSubscription_(user_id,keyword,channel_name,chat_id){
  const sh=ss().getSheetByName('subscriptions');
  const vals=sh.getDataRange().getValues();
  const id=nextId_(vals,1);
  sh.appendRow([id,user_id,keyword,channel_name||'',String(chat_id||''),0,nowStr()]);
  return id;
}

function listActiveSubsByUser_(user_id){
  const vals=_vals('subscriptions');
  const out=[]; for(let i=1;i<vals.length;i++){const r=vals[i]; if(String(r[1])===String(user_id)&&String(r[5])==='0') out.push({id:r[0],keyword:r[2],channel_name:r[3],chat_id:r[4]});}
  return out;
}

function deactivateByKeyword_(user_id,keyword,channel_name_opt,chat_id_opt){
  const sh=ss().getSheetByName('subscriptions'), vals=sh.getDataRange().getValues();
  let updated=0; for(let i=1;i<vals.length;i++){const r=vals[i];
    if(String(r[1])===String(user_id)&&String(r[2])===String(keyword)&&String(r[5])==='0'&&(!channel_name_opt||String(r[3])===String(channel_name_opt))&&(!chat_id_opt||String(r[4])===String(chat_id_opt)))
      {sh.getRange(i+1,6).setValue(1); updated++;}
  } return updated;
}

function deactivateByIds_(user_id,idsArr){
  const sh=ss().getSheetByName('subscriptions'), vals=sh.getDataRange().getValues(), wanted=new Set(idsArr.map(String));
  let updated=0; for(let i=1;i<vals.length;i++){const r=vals[i]; if(wanted.has(String(r[0]))&&String(r[1])===String(user_id)&&String(r[5])==='0'){ sh.getRange(i+1,6).setValue(1); updated++; }}
  return updated;
}

function deactivateAll_(user_id){
  const sh=ss().getSheetByName('subscriptions'), vals=sh.getDataRange().getValues();
  let updated=0; for(let i=1;i<vals.length;i++){const r=vals[i]; if(String(r[1])===String(user_id)&&String(r[5])==='0'){ sh.getRange(i+1,6).setValue(1); updated++; }}
  return updated;
}

/* ======================= AUTH / ALLOWLIST ======================= */
function isAllowed_(chat_id){
  const {ALLOWED_CHAT_IDS}=cfg();
  const cache=CacheService.getScriptCache(); const key='allow:'+String(chat_id); const hit=cache.get(key); if(hit!==null) return hit==='1';
  const inAllow=ALLOWED_CHAT_IDS.length?ALLOWED_CHAT_IDS.includes(String(chat_id)):false;
  const hasUser=getExistingUserId_(chat_id)!==null; const ok=inAllow||hasUser;
  cache.put(key,ok?'1':'0',300); return ok;
}

/* ======================= TELEGRAM WEBHOOK ======================= */
function setWebhook(){ const {WEB_APP_URL,SECRET}=cfg(); if(!WEB_APP_URL) throw new Error('Defina TELEGRAM_WEBHOOK_URL nas Script Properties (URL do Web App publicado).'); const url=`${WEB_APP_URL}?secret=${encodeURIComponent(SECRET)}`; Logger.log(TG.call('setWebhook',{url})); }
function deleteWebhook(){ Logger.log(TG.call('deleteWebhook',{})); }
function setMyCommands_(){
  const commands=[
    {command:'start',description:'Iniciar e autorizar o bot'},
    {command:'help',description:'Ajuda e instruções'},
    {command:'subscribe',description:'Assinar: <kw1,kw2> <canal1,canal2>'},
    {command:'unsubscribe',description:'Desativar por keyword (canal opcional)'},
    {command:'unsubscribe_id',description:'Desativar por IDs'},
    {command:'unsubscribe_all',description:'Desativar todas'},
    {command:'list',description:'Listar assinaturas'},
    {command:'cancel',description:'Cancelar operação'}
  ];
  return TG.call('setMyCommands',{commands:JSON.stringify(commands),language_code:'pt'});
}

function doPost(e){
  try{
    ensureSheets(); const {SECRET}=cfg();
    if(!e||!e.postData) return HtmlService.createHtmlOutput('');
    if(!e.parameter||e.parameter.secret!==SECRET) return HtmlService.createHtmlOutput('unauthorized');
    const update=JSON.parse(e.postData.contents);
    if(update.message) handleMessage_(update.message); else if(update.callback_query) handleCallback_(update.callback_query);
    return HtmlService.createHtmlOutput('');
  }catch(err){ console.error(err); return HtmlService.createHtmlOutput('error'); }
}

/* ======================= ROUTER & COMMANDS ======================= */
function handleMessage_(msg){
  const {OPEN_SIGNUP,ALLOWED_CHAT_IDS}=cfg();
  const chatId=msg.chat&&msg.chat.id; if(!chatId) return; if(msg.chat&&msg.chat.type!=='private') return; // só DM
  const text=(msg.text||msg.caption||'').trim(); if(!text.startsWith('/')) return; // só slash commands

  const parts=text.replace(/\s+/g,' ').split(' '), cmd=(parts[0].split('@')[0]||'').toLowerCase(), args=parts.slice(1).join(' ').trim();

  if(cmd==='/start'){
    const inAllow=ALLOWED_CHAT_IDS.length?ALLOWED_CHAT_IDS.includes(String(chatId)):false; const already=getExistingUserId_(chatId)!==null;
    if(already){ TG.send(chatId,'✅ Bot pronto! Use /help para ver os comandos.'); return; }
    if(OPEN_SIGNUP||inAllow||!ALLOWED_CHAT_IDS.length){ getOrCreateUser_(chatId); TG.send(chatId,'✅ Bot pronto! Use /help para ver os comandos.'); return; }
    TG.send(chatId,'🚫 Não autorizado. Peça acesso ao admin.'); return;
  }

  if(!isAllowed_(chatId)){ TG.send(chatId,'🚫 Não autorizado. Use /start (se permitido) ou peça acesso ao admin.'); return; }

  const userId=getOrCreateUser_(chatId);
  const map = {
    '/help': () => cmdHelp_(chatId),
    '/subscribe': () => cmdSubscribe_(chatId, userId, args),
    '/unsubscribe': () => cmdUnsubscribe_(chatId, userId, args),
    '/unsubscribe_id': () => cmdUnsubscribeId_(chatId, userId, args),
    '/unsubscribe_all': () => cmdUnsubscribeAll_(chatId /*, userId*/),
    '/list': () => cmdList_(chatId, userId),
    '/cancel': () => TG.send(chatId, 'Cancelado.')
  };
  (map[cmd]||(()=>TG.send(chatId,'Comando não reconhecido. Use /help.')))();
}

function cmdHelp_(chatId){
  TG.send(chatId,[
    '<b>Comandos</b>',
    '<code>/start</code> – Inicia e autoriza o bot',
    '<code>/help</code> – Ajuda',
    '<code>/subscribe &lt;kw1,kw2&gt; &lt;canal1,canal2&gt;</code> – Assinar (suporta regex: <code>/exp/gi</code> e sintaxe simplificada: <code>+</code> AND, <code>=</code> OR, <code>-</code> NOT)',
    '<code>/unsubscribe &lt;keyword&gt; [canal]</code> – Desativar por keyword (e canal opcional)',
    '<code>/unsubscribe_id &lt;id1,id2&gt;</code> – Desativar por IDs',
    '<code>/unsubscribe_all</code> – Desativar todas as assinaturas (confirmação)',
    '<code>/list</code> – Listar assinaturas ativas',
    '<code>/cancel</code> – Cancelar operação',
  
    '',
    '<b>Exemplos de sintaxe simplificada → regex</b>',
    '<code>/subscribe +panela+ferro+fundido BenchPromos</code>',
    '→ <code>/(?i)(?=.*\\bpanela\\b)(?=.*\\bferro\\b)(?=.*\\bfundido\\b).*/</code>',
    '<code>/subscribe +celular+iphone=samsung BenchPromos</code>',
    '→ <code>/(?i)(?=.*\\bcelular\\b)(?=.*\\b(iphone|samsung)\\b).*/</code>',
    '<code>/subscribe celular+iphone-samsung BenchPromos</code>',
    '→ <code>/(?i)^(?!.*\\bsamsung\\b)(?=.*\\bcelular\\b)(?=.*\\biphone\\b).*/</code>',
    '<code>/subscribe fogão=cooktop+indução-atlas BenchPromos</code>',
    '→ <code>/(?i)^(?!.*\\batlas\\b)(?=.*\\bindu[cç][aáàâã]o\\b)(?=.*\\b(cooktop|fog[aáàâã]o)\\b).*/</code>'
].join('\n'));
}

function hasSubscription_(user_id,keyword,channel_name,chat_id){
  const vals=_vals('subscriptions');
  for(let i=1;i<vals.length;i++){
    const r=vals[i], active=String(r[5])==='0';
    if(active&&String(r[1])===String(user_id)&&String(r[2])===String(keyword)&&String(r[3])===String(channel_name||'')&&String(r[4])===String(chat_id||'')) return true;
  } return false;
}

function resolveChannel_(input){
  let u=String(input||'').trim().replace(/^https?:\/\/t\.me\//i,'').replace(/^@/,'');
  const mC=u.match(/^c\/(\d+)/i); if(mC) return {channel_name:'',chat_id:`-100${mC[1]}`};
  if(/^-?\d+$/.test(u)) return {channel_name:'',chat_id:u};
  return {channel_name:u,chat_id:''};
}

function cmdSubscribe_(chatId,userId,args){
  if(!args){ TG.send(chatId,'Uso: <code>/subscribe kw1,kw2 canal1,canal2</code>'); return; }
  const m=args.replace(/\s+/g,' ').match(/^(\S+)\s+(.+)$/);
  if(!m){ TG.send(chatId,'Uso: <code>/subscribe kw1,kw2 canal1,canal2</code>'); return; }
  const keywordsRaw=parseList_(m[1]), channelsRaw=parseList_(m[2]);
  const keywords=keywordsRaw.map(compileSymbolsExpressionToRegex);
  if(!keywords.length||!channelsRaw.length){ TG.send(chatId,'Uso: <code>/subscribe kw1,kw2 canal1,canal2</code>'); return; }

  const channels=channelsRaw.map(resolveChannel_), added=[], errors=[];
  channels.forEach(ch=>keywords.forEach(kw=>{
    try{ if(!hasSubscription_(userId,kw,ch.channel_name,ch.chat_id)){ const id=addSubscription_(userId,kw,ch.channel_name,ch.chat_id); added.push({id,kw,ch:(ch.channel_name||ch.chat_id)});} }
    catch(e){ errors.push(`${kw} @ ${(ch.channel_name||ch.chat_id)}: ${e.message}`); }
  }));

  if(added.length){ TG.send(chatId,'✅ Assinaturas criadas:\n'+added.map(x=>`#${x.id} • <b>${x.kw}</b> • <i>${x.ch}</i>`).join('\n')); } else { TG.send(chatId,'Nenhuma assinatura nova (pode já existir).'); }
  if(errors.length) TG.send(chatId,'⚠️ Alguns itens falharam:\n'+errors.map(Utilities.formatString).join('\n'));
}

function cmdUnsubscribe_(chatId,userId,args){
  if(!args){ TG.send(chatId,'Uso: <code>/unsubscribe keyword [canal]</code>'); return; }
  const parts=args.trim().split(/\s+/,2), kw=parts[0], channel=parts[1]||''; const res=channel?resolveChannel_(channel):{channel_name:'',chat_id:''};
  const count=deactivateByKeyword_(userId,kw,res.channel_name||'',res.chat_id||'');
  TG.send(chatId,`♻️ Desativadas: ${count}`);
}

function cmdUnsubscribeId_(chatId,userId,args){
  if(!args){ TG.send(chatId,'Uso: <code>/unsubscribe_id 10,22</code>'); return; }
  const ids=parseList_(args).map(x=>parseInt(x,10)).filter(n=>!isNaN(n)); if(!ids.length){ TG.send(chatId,'Uso: <code>/unsubscribe_id 10,22</code>'); return; }
  TG.send(chatId,`🗑️ Desativadas por ID: ${deactivateByIds_(userId,ids)}`);
}

function cmdUnsubscribeAll_(chatId/*,userId*/){
  TG.send(chatId,'Tem certeza que deseja desativar <b>todas</b> as assinaturas?',{reply_markup:JSON.stringify({inline_keyboard:[[{text:'✅ Confirmar',callback_data:'confirm_unsub_all'},{text:'❌ Cancelar',callback_data:'cancel_unsub_all'}]]})});
}

function cmdList_(chatId,userId){ renderListPage_(chatId,userId,1,20,null); }

/* ======================= CALLBACK QUERIES ======================= */
function renderListPage_(chatId,userId,page,pageSize,messageIdOpt){
  const rows=listActiveSubsByUser_(userId);
  if(!rows.length){ const txt='Nenhuma assinatura ativa.'; return messageIdOpt?TG.edit(chatId,messageIdOpt,txt):TG.send(chatId,txt); }
  rows.sort((a,b)=>Number(a.id)-Number(b.id));
  const total=rows.length, totalPages=Math.max(1,Math.ceil(total/pageSize)); page=Math.min(Math.max(1,page),totalPages);
  const slice=rows.slice((page-1)*pageSize,(page-1)*pageSize+pageSize);
  const lines=slice.map(r=>`#${r.id} • <b>${r.keyword}</b> • <i>${r.channel_name||r.chat_id}</i>`).join('\n');
  const itemRows=slice.map(r=>[{text:`Desativar #${r.id}`,callback_data:'unsub_id:'+r.id}]);
  const nav=[]; if(page>1) nav.push({text:'⬅️ Anterior',callback_data:'list:page:'+(page-1)}); nav.push({text:`📄 ${page}/${totalPages}`,callback_data:'noop'}); if(page<totalPages) nav.push({text:'Próxima ➡️',callback_data:'list:page:'+(page+1)});
  const kb={inline_keyboard:[...itemRows,nav,[{text:'❌ Fechar',callback_data:'list:close'}]]};
  const txt=`📋 Assinaturas ativas (${total}):\n`+lines; const extra={reply_markup:JSON.stringify(kb)};
  return messageIdOpt?TG.edit(chatId,messageIdOpt,txt,extra):TG.send(chatId,txt,extra);
}

function handleCallback_(cb){
  const chatId=cb.message&&cb.message.chat&&cb.message.chat.id; const messageId=cb.message&&cb.message.message_id; const data=cb.data||''; if(!chatId||!data) return;
  if(!isAllowed_(chatId)){ TG.answer(cb.id,'Não autorizado'); return; }
  const userId=getOrCreateUser_(chatId);
  if(data.startsWith('list:page:')){ const page=parseInt(data.split(':')[2],10)||1; renderListPage_(chatId,userId,page,20,messageId); TG.answer(cb.id,''); return; }
  if(data==='list:close'){ TG.edit(chatId,messageId,'Lista fechada. ✅'); TG.answer(cb.id,''); return; }
  if(data==='noop'){ TG.answer(cb.id,''); return; }
  if(data.startsWith('unsub_id:')){ const id=data.split(':')[1]; const n=deactivateByIds_(userId,[id]); TG.answer(cb.id,n?'Desativado':'Não encontrado'); if(n) TG.edit(chatId,messageId,`Assinatura #${id} desativada ✅`); return; }
  if(data==='confirm_unsub_all'){ const count=deactivateAll_(userId); TG.answer(cb.id,'Tudo desativado'); TG.edit(chatId,messageId,`Desativadas ${count} assinatura(s). ✅`); return; }
  if(data==='cancel_unsub_all'){ TG.answer(cb.id,'Cancelado'); TG.edit(chatId,messageId,'Operação cancelada. ❌'); return; }
  TG.answer(cb.id,'');
}

/* ======================= MAINTENANCE ======================= */
function bootstrap(){ ensureSheets(); Logger.log('Sheets ok'); }
