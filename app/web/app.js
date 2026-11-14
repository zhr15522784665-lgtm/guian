/**
 * 归岸 · 前端。
 *
 * 无框架、无构建。所有文本用 textContent / createElement 写入，不拼 innerHTML ——
 * 消息内容同时来自用户和模型，拼字符串就是给自己开一个 XSS 口子。
 * 从「见岸」迁来的热线面板也遵守这条：那边用模板字符串拼 HTML，这边全部改成建节点。
 */

const state = {
  personas: [],
  hotlines: [],
  provinceHotlines: [],
  hotlineGuide: null,
  reliefData: [],
  reliefNotice: null,
  reliefMounted: false,
  ageBand: null,
  botId: null,
  messages: [],
  sending: false,
  sessionStart: null,
  feedbackAllowed: true,
  leaveAsked: false,
  leaveReported: false,
  leaveReasonReported: false,
  leaveTarget: null,
  growSessionId: null,
  sessionUserTurns: 0,
  chatVisit: 0,
  chatRequest: null,
  historyLoading: false,
  reviewRunning: false,
  growthLoadId: 0
};

const $ = (id) => document.getElementById(id);

// ── 请求 ──

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = { ok: false, message: '服务返回了看不懂的东西' };
  }
  if (!res.ok && !data.message) data.message = `请求失败（${res.status}）`;
  return data;
}

// ── 视图切换 ──

function show(name) {
  if (document.body.dataset.view === 'chat' && name !== 'chat' && state.botId) {
    if (maybeAskLeave(name)) return;
    reportLeave();
  }
  ['home', 'chat', 'about', 'relief'].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== name;
  });
  document.body.dataset.view = name;
  if (name === 'chat') {
    // 会话起点：法规定义的「连续使用」从这里开始算
    if (!state.sessionStart) state.sessionStart = Date.now();
    setTimeout(() => $('input').focus(), 60);
  }
  if (name === 'relief') mountRelief();
  if (name === 'about') loadGrowth();
  window.scrollTo(0, 0);
}

// ── 首页卡片 ──

function renderCards() {
  const box = $('cards');
  box.textContent = '';

  state.personas.forEach((p) => {
    const card = document.createElement('button');
    card.className = 'persona';
    card.type = 'button';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = p.avatar.bg;
    avatar.textContent = p.avatar.emoji;

    const info = document.createElement('div');
    info.className = 'p-info';
    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = p.name;
    const tagline = document.createElement('div');
    tagline.className = 'p-tagline';
    tagline.textContent = p.tagline;
    info.append(name, tagline);

    const arrow = document.createElement('div');
    arrow.className = 'p-arrow';
    arrow.textContent = '›';

    card.append(avatar, info, arrow);
    card.addEventListener('click', () => enterChat(p.id));
    box.append(card);
  });
}

// ── 对话 ──

async function enterChat(botId) {
  const persona = state.personas.find((p) => p.id === botId);
  if (!persona) return;

  if (!state.ageBand) {
    openAgeSheet();
    return;
  }

  state.botId = botId;
  const visit = ++state.chatVisit;
  state.messages = [];
  state.sessionStart = Date.now();
  state.feedbackAllowed = true;
  state.leaveAsked = false;
  state.leaveReported = false;
  state.leaveReasonReported = false;
  state.growSessionId = null;
  state.sessionUserTurns = 0;
  state.historyLoading = true;
  state.reviewRunning = false;
  $('review-btn').disabled = false;
  $('review-btn').textContent = '复盘';
  $('review-status').hidden = true;
  $('review-status').textContent = '';
  $('send').disabled = true;

  $('chat-name').textContent = persona.name;
  $('messages').textContent = '';
  $('messages').append(makeGreeting(persona.greetHint, persona.introNote));

  show('chat');

  // 开场白（含边界声明）常驻顶部，历史接在下面——声明是开场的一部分，不是聊着聊着冒出来的一句
  try {
    // 切换时若上一轮还在返回，先等它落库，避免旧响应混进新角色的视图。
    if (state.chatRequest) await state.chatRequest.catch(() => {});
    const res = await api(`/api/history?botId=${encodeURIComponent(botId)}`);
    if (state.chatVisit !== visit) return;
    state.feedbackAllowed = res.feedbackAllowed !== false;
    if (res.ok && res.messages) {
      res.messages.forEach((m) => appendMessage(m.role, m.content, true, m.turnId, m.safety, m.modelReply, m.feedbackKind));
      scrollToEnd();
    }
  } catch (_) {
    if (state.chatVisit === visit) toast('历史消息没载入，稍后可以重新进入。');
  } finally {
    if (state.chatVisit === visit) {
      state.historyLoading = false;
      $('send').disabled = state.sending || !$('input').value.trim();
    }
  }
}

async function reviewCurrentBot() {
  const botId = state.botId;
  if (!botId || state.reviewRunning) return;
  const visit = state.chatVisit;
  const button = $('review-btn');
  state.reviewRunning = true;
  if (button) {
    button.disabled = true;
    button.textContent = '复盘中…';
  }
  const status = $('review-status');
  if (status) {
    status.hidden = false;
    status.textContent = '正在复盘：用几轮模拟对话和固定任务检查策略。';
  }
  toast('正在复盘…');
  try {
    const res = await api('/api/grow/review', { method: 'POST', body: JSON.stringify({ botId }) });
    if (!res.ok) {
      const message = res.message || '复盘没完成，稍后再试。';
      if (state.botId === botId && state.chatVisit === visit && status) status.textContent = message;
      toast(message);
      return;
    }
    const summary = res.review || res.lastReview || {};
    const rejected = Array.isArray(summary.rejectedCandidates) ? summary.rejectedCandidates : [];
    const rejectionText = rejected.map((item) => `没过「${item.plain || '未命名策略'}」：${(item.reasons || []).join('；') || '未通过检验'}`).join('\n');
    let message;
    if (summary.promoted) {
      message = `复盘完成：${summary.certified || 0} 条通过三次检查，已加入 ${summary.newVersion || '新版本'}。`;
    } else if (summary.certified) {
      message = `有 ${summary.certified} 条通过三次检查，但整库复检没过，没有升级。${summary.reason || ''}`;
    } else {
      message = `复盘完成：这次没有可晋级的策略。${summary.reason || ''}`;
    }
    if (rejectionText) message += `\n${rejectionText}`;
    if (state.botId === botId && state.chatVisit === visit && status) status.textContent = message;
    toast(message.split('\n')[0]);
  } catch (_) {
    if (state.botId === botId && state.chatVisit === visit && status) status.textContent = '复盘没完成，稍后再试。';
    toast('复盘没完成，稍后再试。');
  } finally {
    if (state.botId === botId && state.chatVisit === visit) state.reviewRunning = false;
    if (button && state.botId === botId && state.chatVisit === visit) {
      button.disabled = false;
      button.textContent = '复盘';
    }
  }
}

// ── 我在成长：只渲染 /api/grow 提供的人话 plain，不读或展示策略规则、语气包 ──

function growthKindLabel(kind) {
  return ({ baseline: '起始版本', seed: '你亲手教的', review: '复盘后学会的', learn: '新版本' })[kind] || '版本';
}

function renderGrowthCard(botId, data) {
  const persona = state.personas.find((p) => p.id === botId);
  const card = document.createElement('article');
  card.className = 'growth-card';

  const title = document.createElement('h3');
  title.textContent = `${persona ? persona.name : botId} · 当前 ${data.active || '未知版本'}`;
  card.append(title);

  const historyTitle = document.createElement('p');
  historyTitle.className = 'growth-label';
  historyTitle.textContent = '版本记录';
  card.append(historyTitle);
  const history = document.createElement('ul');
  history.className = 'growth-history';
  const versions = Array.isArray(data.versions) ? data.versions.slice(-5).reverse() : [];
  versions.forEach((version) => {
    const item = document.createElement('li');
    const date = version.at ? String(version.at).slice(0, 10) : '';
    item.textContent = `${version.id}${version.id === data.active ? '（当前）' : ''} · ${growthKindLabel(version.kind)}${date ? ` · ${date}` : ''}`;
    history.append(item);
  });
  if (!versions.length) {
    const item = document.createElement('li');
    item.textContent = '还没有版本记录。';
    history.append(item);
  }
  card.append(history);

  const strategiesTitle = document.createElement('p');
  strategiesTitle.className = 'growth-label';
  strategiesTitle.textContent = '这版正在用的做法';
  card.append(strategiesTitle);
  const strategies = Array.isArray(data.strategies) ? data.strategies : [];
  if (!strategies.length) {
    const empty = document.createElement('p');
    empty.className = 'growth-empty';
    empty.textContent = '这一版还没有已生效的做法。';
    card.append(empty);
  }
  strategies.forEach((strategy) => {
    const item = document.createElement('div');
    item.className = 'growth-strategy';
    const plain = document.createElement('p');
    plain.className = 'growth-plain';
    plain.textContent = strategy.plain || '这条做法暂时没有说明。';
    item.append(plain);
    const source = document.createElement('p');
    source.className = 'growth-source';
    source.textContent = strategy.source || '来源未注明';
    item.append(source);
    if (strategy.sourceNote) {
      const note = document.createElement('p');
      note.className = 'growth-note';
      note.textContent = strategy.sourceNote;
      item.append(note);
    }
    card.append(item);
  });

  const pending = Array.isArray(data.pending) ? data.pending : [];
  if (pending.length) {
    const pendingTitle = document.createElement('p');
    pendingTitle.className = 'growth-pending-title';
    pendingTitle.textContent = '还在等你点头（尚未生效）';
    card.append(pendingTitle);
    pending.forEach((strategy) => {
      const item = document.createElement('div');
      item.className = 'growth-pending';
      const plain = document.createElement('p');
      plain.textContent = strategy.plain || '这条候选暂时没有说明。';
      item.append(plain);
      const source = document.createElement('p');
      source.textContent = `${strategy.source || '来源未注明'}${strategy.sourceNote ? ` · ${strategy.sourceNote}` : ''} · 未生效`;
      item.append(source);
      card.append(item);
    });
  }

  if (data.canRollback) {
    const rollback = document.createElement('button');
    rollback.type = 'button';
    rollback.className = 'btn-ghost growth-rollback';
    rollback.textContent = '回到上一版本';
    rollback.addEventListener('click', () => rollbackGrowth(botId, data, rollback));
    card.append(rollback);
  }
  return card;
}

async function loadGrowth() {
  const box = $('growth-state');
  if (!box) return;
  const requestId = ++state.growthLoadId;
  box.textContent = '正在看看他们学会了什么……';
  const results = await Promise.all(state.personas.map(async (persona) => {
    try {
      return { botId: persona.id, data: await api(`/api/grow?botId=${encodeURIComponent(persona.id)}`) };
    } catch (_) {
      return { botId: persona.id, data: { ok: false } };
    }
  }));
  if (state.growthLoadId !== requestId) return;
  box.textContent = '';
  results.forEach(({ botId, data }) => {
    if (data && data.ok) {
      box.append(renderGrowthCard(botId, data));
      return;
    }
    const error = document.createElement('p');
    error.className = 'growth-empty';
    error.textContent = '这位伙伴的成长记录暂时没加载出来。';
    box.append(error);
  });
}

async function rollbackGrowth(botId, data, button) {
  const persona = state.personas.find((p) => p.id === botId);
  const name = persona ? persona.name : botId;
  const previous = data.parent ? `（${data.parent}）` : '';
  if (!confirm(`要让${name}回到上一版本${previous}吗？之后学会的做法会暂时不参与对话。`)) return;
  button.disabled = true;
  try {
    const result = await api('/api/grow/rollback', {
      method: 'POST',
      body: JSON.stringify({ botId })
    });
    if (!result.ok) {
      toast(result.message || '没能回到上一版本。');
      return;
    }
    toast('已经回到上一版本。');
    await loadGrowth();
  } catch (_) {
    toast('没能回到上一版本，稍后再试。');
  } finally {
    button.disabled = false;
  }
}

function makeGreeting(text, note) {
  const el = document.createElement('div');
  el.className = 'greeting';
  const hi = document.createElement('div');
  hi.className = 'greeting-hi';
  hi.textContent = text;
  el.append(hi);
  if (note) {
    const n = document.createElement('div');
    n.className = 'greeting-note';
    n.textContent = note;
    el.append(n);
  }
  return el;
}

function appendMessage(role, content, silent, turnId, safety, modelReply, feedbackKind) {
  const row = document.createElement('div');
  row.className = `row row-${role}`;

  const bubble = document.createElement('div');
  bubble.className = `bubble bubble-${role}`;
  bubble.textContent = content;

  row.append(bubble);
  $('messages').append(row);
  state.messages.push({ role, content, turnId, safety });
  if (role === 'assistant' && modelReply && !feedbackKind && turnId && state.feedbackAllowed && !['risk', 'crisis'].includes(safety)) {
    const botId = state.botId;
    const feedback = document.createElement('div');
    feedback.className = 'feedback';
    [['good', '说到心里了'], ['miss', '不太对']].forEach(([kind, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        const buttons = feedback.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
        let res;
        try {
          res = await api('/api/grow/feedback', { method: 'POST', body: JSON.stringify({ botId, turnId, kind }) });
        } catch (_) {
          buttons.forEach((b) => { b.disabled = false; });
          toast('没记下来，稍后再试。');
          return;
        }
        if (res.ok) {
          if (res.ignored) feedback.remove();
          else toast('记下了，谢谢你。');
        } else {
          buttons.forEach((b) => { b.disabled = false; });
          toast(res.message || '没记下来，稍后再试。');
        }
      });
      feedback.append(button);
    });
    $('messages').append(feedback);
  }
  if (!silent) scrollToEnd();
}

function appendCard(card) {
  const wrap = document.createElement('div');
  wrap.className = 'notice';

  const title = document.createElement('div');
  title.className = 'notice-title';
  title.textContent = card.title || '';
  wrap.append(title);

  if (card.type === 'hotline' && Array.isArray(card.items)) {
    card.items.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'hotline';

      const left = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'h-name';
      nm.textContent = h.name;
      const note = document.createElement('div');
      note.className = 'h-note';
      note.textContent = h.note || '';
      left.append(nm, note);

      const right = document.createElement('div');
      right.className = 'h-actions';
      const call = document.createElement('a');
      call.className = 'h-num';
      call.href = `tel:${h.number}`;
      call.textContent = h.number;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'h-copy';
      copy.textContent = '复制';
      copy.setAttribute('aria-label', `复制号码 ${h.number}`);
      copy.addEventListener('click', () => dialTel(h.number));
      right.append(call, copy);

      row.append(left, right);
      wrap.append(row);
    });

    // 危机当下只摆三个号码，省份列表收在面板里，不在这里摊开
    if (card.more) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'notice-more';
      more.textContent = card.more + ' ›';
      more.addEventListener('click', openSosPanel);
      wrap.append(more);
    }
  }

  if (card.type === 'boundary' && Array.isArray(card.body)) {
    card.body.forEach((line) => {
      const p = document.createElement('p');
      p.className = 'notice-line';
      p.textContent = line;
      wrap.append(p);
    });
  }

  $('messages').append(wrap);
  scrollToEnd();
}

function scrollToEnd() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function setTyping(on, name) {
  const existing = document.querySelector('.typing');
  if (existing) existing.remove();
  if (!on) return;
  const el = document.createElement('div');
  el.className = 'typing';
  el.textContent = `${name}正在想…`;
  $('messages').append(el);
  scrollToEnd();
}

async function send(e) {
  if (e) e.preventDefault();
  if (state.sending || state.historyLoading) return;

  const input = $('input');
  const text = input.value.trim();
  if (!text) return;

  if (!state.sessionStart) state.sessionStart = Date.now();

  state.sending = true;
  const botId = state.botId;
  const visit = state.chatVisit;
  if (state.leaveReported) state.growSessionId = null;
  state.leaveReported = false;
  state.leaveReasonReported = false;
  savePendingLeave({ botId, sessionId: state.growSessionId || undefined });
  $('send').disabled = true;
  input.value = '';

  // 开场白不再在发第一句时移除：边界声明就在里面，得一直看得见

  appendMessage('user', text);
  const persona = state.personas.find((p) => p.id === state.botId);
  setTyping(true, persona ? persona.name : '他');

  try {
    state.chatRequest = api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        text,
        sessionStartedAt: state.sessionStart
      })
    });
    const res = await state.chatRequest;

    if (res.growSessionId) savePendingLeave({ botId, sessionId: res.growSessionId });
    if (state.chatVisit !== visit) {
      if (res.growSessionId && !res.feedbackBlocked) sendLeave({ botId, sessionId: res.growSessionId });
      return;
    }
    setTyping(false);

    if (res.needAgeBand) {
      openAgeSheet();
      return;
    }

    if (!res.ok) {
      appendMessage('assistant', res.message || '没发出去。你再说一遍？');
      return;
    }

    // 卡片插在回复之前，顺序上更自然：先给号码，再说话
    if (res.card) appendCard(res.card);
    if (res.feedbackBlocked || ['risk', 'crisis'].includes(res.safety)) {
      state.feedbackAllowed = false;
      document.querySelectorAll('.feedback').forEach((el) => el.remove());
    }
    if (res.growSessionId) {
      if (state.growSessionId !== res.growSessionId) {
        state.sessionUserTurns = 0;
        state.leaveAsked = false;
      }
      state.growSessionId = res.growSessionId;
      state.sessionUserTurns += 1;
      if (document.hidden || document.body.dataset.view !== 'chat') {
        state.leaveReported = false;
        reportLeave();
      }
    }
    appendMessage('assistant', res.reply || '', false, res.turnId, res.safety, res.modelReply);
  } catch (err) {
    if (state.chatVisit === visit) {
      setTyping(false);
      appendMessage('assistant', '这边网好像断了。你再说一遍？');
    }
  } finally {
    state.sending = false;
    state.chatRequest = null;
    $('send').disabled = state.historyLoading || !$('input').value.trim();
  }
}

// ── 离开反馈：只问一次，不阻止关闭页面 ──

function savePendingLeave(item) {
  try { sessionStorage.setItem(`guian-grow-leave-${item.botId}`, JSON.stringify(item)); } catch (_) { /* 无存储权限时仍能 beacon */ }
}

function reportLeave(reason) {
  if (!state.botId || !state.feedbackAllowed || (!state.growSessionId && !state.sending)) return;
  if (state.leaveReported && (!reason || state.leaveReasonReported)) return;
  state.leaveReported = true;
  if (reason) state.leaveReasonReported = true;
  const item = { botId: state.botId, sessionId: state.growSessionId || undefined, reason: reason || undefined };
  sendLeave(item);
}

function sendLeave(item) {
  savePendingLeave(item);
  const body = JSON.stringify(item);
  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon && navigator.sendBeacon('/api/grow/leave', blob)) return;
  fetch('/api/grow/leave', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body, keepalive: true
  }).catch(() => {});
}

function maybeAskLeave(target) {
  if (state.leaveAsked || !state.feedbackAllowed || !state.sessionUserTurns) return false;
  state.leaveAsked = true;
  state.leaveTarget = target;
  const persona = state.personas.find((p) => p.id === state.botId);
  $('leave-desc').textContent = persona.leavePrompt;
  $('leave-sheet').hidden = false;
  return true;
}

function finishLeave(reason) {
  $('leave-sheet').hidden = true;
  reportLeave(reason);
  const target = state.leaveTarget || 'home';
  state.leaveTarget = null;
  show(target);
}

// ── 年龄 ──

function openAgeSheet() {
  $('age-sheet').hidden = false;
}

async function chooseAge(band) {
  const res = await api('/api/age', { method: 'POST', body: JSON.stringify({ ageBand: band }) });
  if (!res.ok) {
    alert(res.message || '设置失败');
    return;
  }
  state.ageBand = band;
  $('age-sheet').hidden = true;
  if (res.notice) alert(res.notice);
}

// ── 清除 ──

async function clearAll() {
  const ok = confirm('他们会忘了你说过的事。聊天记录也会清掉。这个操作不能撤销。');
  if (!ok) return;

  const res = await api('/api/clear', { method: 'POST', body: JSON.stringify({ all: true }) });
  if (res.ok) {
    state.chatVisit += 1;
    state.personas.forEach((p) => {
      try { sessionStorage.removeItem(`guian-grow-leave-${p.id}`); } catch (_) { /* 无存储权限 */ }
    });
    state.messages = [];
    state.botId = null;
    $('messages').textContent = '';
    alert('清干净了。');
    show('home');
  } else {
    alert(res.message || '没清成功');
  }
}

// ── 轻提示 ──

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = String(msg || '');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ── 热线：拨打与复制 ──
// 桌面浏览器没有拨号能力，点「拨打」什么都不会发生，用户也没有「长按复制」
// 这个触屏动作可用。所以桌面一律改成复制 + 明确提示，保证一定拿得到号。

function isDesktop() {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function copyTel(tel) {
  const s = String(tel || '');
  if (!s) return;
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 浏览器不给复制，号码仍显示在界面上 */ }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(s).catch(fallback);
  } else {
    fallback();
  }
}

function dialTel(tel) {
  const raw = String(tel || '');
  if (!raw) return;
  const clean = raw.replace(/[^\d+]/g, '');
  if (isDesktop()) {
    copyTel(raw);
    toast(`已复制 ${raw}，用手机拨打`);
    return;
  }
  try { window.location.href = `tel:${clean}`; } catch (e) { copyTel(raw); }
  toast(`正在呼叫 ${raw} …`);
}

// ── 热线面板 ──

function openSosPanel() {
  $('sos-panel').hidden = false;
  renderSosNation();
}
// 解压渲染器的弹层是全屏 fixed，会把页面上的求助按钮盖住；
// 它自己内部有一个 SOS，会回调到这里。这条全局是它的第二重兜底。
window.__JN_OPEN_SOS = openSosPanel;

function closeSosPanel() {
  $('sos-panel').hidden = true;
}

function makeHotlineCard(h, primary) {
  const card = document.createElement('div');
  // 首选号码单独一张大卡，其余排成紧凑行。
  // 七张同样大的卡会把 31 个省份按钮推到两屏之外，而慌的时候没人愿意滚那么久。
  card.className = primary ? 'sos-hcard primary' : 'sos-hrow';

  const num = document.createElement('div');
  num.className = 'sos-num';
  num.textContent = h.number;

  const meta = document.createElement('div');
  meta.className = 'sos-meta';
  const nm = document.createElement('div');
  nm.className = 'sos-name';
  nm.textContent = h.name;
  const note = document.createElement('div');
  note.className = 'sos-note';
  note.textContent = h.note || '';
  meta.append(nm, note);

  const actions = document.createElement('div');
  actions.className = 'sos-actions';
  const call = document.createElement('button');
  call.type = 'button';
  call.className = 'sos-btn';
  call.textContent = '拨打';
  call.addEventListener('click', () => dialTel(h.number));
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'sos-btn ghost';
  copy.textContent = '复制';
  copy.addEventListener('click', () => { copyTel(h.number); toast(`已复制 ${h.number}`); });
  actions.append(call, copy);

  card.append(num, meta, actions);
  return card;
}

function renderSosNation() {
  $('sos-title').textContent = '现在能打的电话';
  $('sos-advice').textContent = state.hotlineGuide
    ? state.hotlineGuide.advice
    : '优先拨打 12356（全国统一、24 小时、免费）。';

  const box = $('sos-content');
  box.textContent = '';

  const lead = document.createElement('div');
  lead.className = 'sos-section-t';
  lead.textContent = '全国通用';
  box.append(lead);

  // 31 个省份在列表下方。不让人为了找本地号码先滚过七张卡。
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'sos-jump';
  jump.textContent = '直接看各省本地号码 ↓';
  jump.addEventListener('click', () => {
    const g = document.querySelector('.sos-grid');
    if (g) g.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  box.append(jump);

  state.hotlines.forEach((h) => box.append(makeHotlineCard(h, Boolean(h.primary))));

  const local = document.createElement('div');
  local.className = 'sos-section-t';
  local.textContent = '或者，看你所在省份的本地号码';
  box.append(local);

  const grid = document.createElement('div');
  grid.className = 'sos-grid';
  state.provinceHotlines.forEach((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sos-prov';
    b.textContent = p.region;
    b.addEventListener('click', () => renderSosProvince(p.region));
    grid.append(b);
  });
  box.append(grid);

  $('sos-source').textContent = state.hotlineGuide ? state.hotlineGuide.asOf : '';
  const sheet = $('sos-panel').querySelector('.sos-sheet');
  if (sheet) sheet.scrollTop = 0;
}

function renderSosProvince(region) {
  const item = state.provinceHotlines.find((p) => p.region === region);
  if (!item) return;

  $('sos-title').textContent = `${region} · 心理援助热线`;
  $('sos-advice').textContent = '先打 12356。本地号码打不通或占线时，仍然回到 12356。';

  const box = $('sos-content');
  box.textContent = '';

  const primary = state.hotlines.find((h) => h.primary) || state.hotlines[0];
  if (primary) {
    const first = document.createElement('div');
    first.className = 'sos-section-t';
    first.textContent = '首选 · 全国统一';
    box.append(first, makeHotlineCard(primary, true));
  }

  const local = document.createElement('div');
  local.className = 'sos-section-t';
  local.textContent = `${region} 本地补充`;
  box.append(local);

  box.append(makeHotlineCard({
    number: item.number,
    name: item.org,
    note: item.h24 ? '原资料标注 24 小时' : `可接通时间：${item.time}`
  }, false));

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'sos-back';
  back.textContent = '‹ 返回全部省份';
  back.addEventListener('click', renderSosNation);
  box.append(back);

  $('sos-source').textContent = state.hotlineGuide
    ? state.hotlineGuide.asOf
    : '号码以当地最新公布为准';
  const sheet = $('sos-panel').querySelector('.sos-sheet');
  if (sheet) sheet.scrollTop = 0;
}

// ── 解压 ──

function mountRelief() {
  if (state.reliefMounted) return;
  const box = $('relief-box');
  if (!box) return;

  if (state.reliefNotice) {
    $('relief-title').textContent = state.reliefNotice.title;
    $('relief-body').textContent = state.reliefNotice.body;
    $('relief-disclaimer').textContent = state.reliefNotice.disclaimer;
  }

  if (!Array.isArray(state.reliefData) || !state.reliefData.length) {
    box.textContent = '练习没加载出来，回到首页再进一次试试。';
    return;
  }
  if (typeof window.GuianReliefUI === 'undefined') {
    box.textContent = '练习界面没加载出来，刷新一下页面。';
    return;
  }

  try {
    window.GuianReliefUI.mount(
      box,
      { RELIEF_EXERCISES: state.reliefData },
      { onSos: openSosPanel }
    );
    state.reliefMounted = true;
  } catch (e) {
    box.textContent = '练习暂时打不开，刷新一下再试。';
  }
}

// ── 关于页热线 ──

function renderHotlines() {
  const box = $('hotlines');
  box.textContent = '';
  const guide = $('hotline-guide');
  if (guide) {
    guide.textContent = state.hotlineGuide ? state.hotlineGuide.advice : '';
  }
  state.hotlines.forEach((h) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `tel:${h.number}`;
    a.textContent = `${h.name}　${h.number}`;
    const note = document.createElement('span');
    note.className = 'h-note';
    note.textContent = h.note ? `　${h.note}` : '';
    li.append(a, note);
    box.append(li);
  });
}

/**
 * 用 file:// 直接双击 index.html 打开时的提示。
 *
 * 这个页面没有后端就跑不了——对方不是静态网页，它要跟本机的服务说话。
 * 但用户看到界面正常显示，会以为已经打开了，然后点「开始」什么也没发生，
 * 只会觉得「这东西坏了」。所以这里把话说清楚，而不是让他猜。
 */
function showFileProtocolNotice() {
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'background:#fbf8f3', 'color:#2e2a26',
    'padding:8vh 6vw', 'box-sizing:border-box',
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'line-height:1.9', 'overflow:auto'
  ].join(';');

  const h = document.createElement('h1');
  h.textContent = '需要从「启动归岸.cmd」打开';
  h.style.cssText = 'font-size:26px;margin:0 0 18px;font-weight:600';

  const p1 = document.createElement('p');
  p1.textContent = '你现在是直接双击网页文件打开的，这种打开方式没有后端，所以发不出消息。';
  p1.style.cssText = 'margin:0 0 22px;font-size:16px';

  const p2 = document.createElement('p');
  p2.textContent = '正确做法：关掉这个页面，回到「归岸」文件夹，双击「启动归岸.cmd」。窗口起来后浏览器会自动打开，那个才是能聊的。';
  p2.style.cssText = 'margin:0 0 22px;font-size:16px';

  const p3 = document.createElement('p');
  p3.textContent = '如果还没有配置模型密钥，先双击「设置模型密钥.cmd」。不配也能跑，但要用演示模式，回复是假的。';
  p3.style.cssText = 'margin:0;font-size:16px;color:#6b6259';

  wrap.append(h, p1, p2, p3);
  document.body.append(wrap);
}

// ── 初始化 ──

async function boot() {
  const [p, me, r] = await Promise.all([
    api('/api/personas'),
    api('/api/me'),
    api('/api/relief')
  ]);

  if (p.ok) {
    state.personas = p.personas || [];
    state.hotlines = p.hotlines || [];
    state.provinceHotlines = p.provinceHotlines || [];
    state.hotlineGuide = p.hotlineGuide || null;
    renderCards();
    renderHotlines();
    // 关闭时 beacon 可能未送达；下次进入只重送 bot/会话标识，不缓存对话原文。
    await Promise.all(state.personas.map(async (persona) => {
      try {
        const key = `guian-grow-leave-${persona.id}`;
        const raw = sessionStorage.getItem(key);
        if (!raw) return;
        const item = JSON.parse(raw);
        if (item.botId !== persona.id) return;
        const res = await api('/api/grow/leave', { method: 'POST', body: JSON.stringify(item) });
        if (res.ok && sessionStorage.getItem(key) === raw) sessionStorage.removeItem(key);
      } catch (_) { /* 下次再试，不影响进入 */ }
    }));
  } else {
    $('cards').textContent = '加载失败，刷新一次试试。';
  }

  // 解压数据加载失败不拖累对话：只在进入那一页时给一句人话
  if (r.ok) {
    state.reliefData = r.exercises || [];
    state.reliefNotice = r.notice || null;
  }

  state.ageBand = (me && me.ageBand) || null;
  if (!state.ageBand) openAgeSheet();

  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => show(btn.dataset.goto));
  });

  document.querySelectorAll('[data-age]').forEach((btn) => {
    btn.addEventListener('click', () => chooseAge(btn.dataset.age));
  });

  $('composer').addEventListener('submit', send);
  $('review-btn').addEventListener('click', reviewCurrentBot);
  $('input').addEventListener('input', (e) => {
    $('send').disabled = !e.target.value.trim() || state.sending || state.historyLoading;
  });
  $('clear-all').addEventListener('click', clearAll);
  document.querySelectorAll('[data-leave-reason]').forEach((btn) => {
    btn.addEventListener('click', () => finishLeave(btn.dataset.leaveReason));
  });
  $('leave-skip').addEventListener('click', () => finishLeave());
  $('leave-sheet').addEventListener('click', (e) => {
    if (e.target === $('leave-sheet')) finishLeave();
  });

  // 求助入口：常驻按钮、关于页、解压页、解压练习弹层内的 SOS，全部指向同一个面板
  $('sos-fab').addEventListener('click', openSosPanel);
  $('about-sos').addEventListener('click', openSosPanel);
  $('relief-sos').addEventListener('click', openSosPanel);
  $('sos-close').addEventListener('click', closeSosPanel);
  $('sos-panel').addEventListener('click', (e) => {
    if (e.target === $('sos-panel')) closeSosPanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sos-panel').hidden) closeSosPanel();
    if (e.key === 'Escape' && !$('leave-sheet').hidden) finishLeave();
  });

  // 页面隐藏即结束本次会话。回来时重新计时——
  // 否则「连续使用时长」会把离开的时间也算进去。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      reportLeave();
      state.sessionStart = null;
    }
  });
  window.addEventListener('pagehide', () => reportLeave());
}

if (location.protocol === 'file:') {
  // 双击 html 打开的情况：不初始化，直接把原因和正确做法摆出来
  showFileProtocolNotice();
} else {
  show('home');
  boot();
}
