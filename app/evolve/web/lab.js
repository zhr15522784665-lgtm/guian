/**
 * 见岸·自适应 · 演示台前端。无框架、无构建；所有文本用 textContent 写入（回复来自模型，不拼 innerHTML）。
 */
const $ = (id) => document.getElementById(id);
const TYPE_NAME = { crisis_hidden: '隐性危机', crisis: '明确危机', refusal: '求助拒绝', harm_induce: '二次伤害诱导', vent: '情绪先行', family: '家庭敏感', dialect: '口语/方言' };

let S = null; // 最近一次 state
let polling = null;
const seenRunning = new Set();
const announced = new Set();
let animateNew = false;
const runCache = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({ ok: false, message: '响应格式不对' }));
  if (!res.ok || json.ok === false) throw new Error(json.message || `HTTP ${res.status}`);
  return json;
}

function toast(msg, ok) {
  const t = $('toast');
  t.textContent = msg || '';
  t.style.color = ok ? 'var(--green)' : 'var(--red)';
}

async function getRun(id) {
  if (!id) return null;
  if (runCache.has(id)) return runCache.get(id);
  const r = (await api('GET', `/api/evolve/run?id=${encodeURIComponent(id)}`)).run;
  runCache.set(id, r);
  return r;
}

function pick(set) {
  const runs = S.runs.filter((r) => r.set === set);
  const before = runs.filter((r) => r.version === 'v0').pop() || null;
  const after = runs.filter((r) => r.version !== 'v0').pop() || null;
  return { before, after };
}

// ── 证据链 ──
function renderEvidence() {
  const box = $('evidence');
  box.replaceChildren();
  const fp = S.fingerprint;
  const { before, after } = pick('train');
  const same = (k, sub) => {
    if (!before || !after) return null;
    const a = sub ? before.fingerprint.frozen[sub] : before.fingerprint[k];
    const b = sub ? after.fingerprint.frozen[sub] : after.fingerprint[k];
    return a === b;
  };
  const chip = (label, value, ok) => {
    const c = el('span', 'chip');
    c.append(el('b', null, label), document.createTextNode(value));
    if (ok === true) c.append(el('span', 'same', ' ✓两次一致'));
    if (ok === false) c.append(el('span', 'diff', ' ✗两次不同'));
    box.append(c);
  };
  chip('代码', fp.code + (fp.git ? ` · git ${fp.git}` : ''), same('code'));
  chip('模型', fp.model, same('model'));
  chip('参数', `${fp.params} (T=${fp.paramsDetail.temperature}, max=${fp.paramsDetail.maxTokens}, K=${fp.paramsDetail.topK})`, same('params'));
  chip('评分器', fp.frozen['grader.js'], same(null, 'grader.js'));
  chip('任务集', `${fp.frozen['tasks.train.json']} / ${fp.frozen['tasks.holdout.json']}`, same(null, 'tasks.train.json'));
  chip('安全层', fp.frozen['safety.js'], same(null, 'safety.js'));
  chip('提示词框架', fp.frozen['prompt-frame.js'], same(null, 'prompt-frame.js'));
  chip('策略库', `${S.active} · ${S.strategies.length} 条（唯一会变的东西）`);
}

// ── 指标 ──
const ROWS = [
  ['crisisMiss', '危机信号漏识别', (m) => `${m.crisisMiss}`, (m) => `/ ${m.crisisTotal}`],
  ['harmful', '二次伤害性回应', (m) => `${m.harmful}`, (m) => `/ ${m.tasks}`],
  ['failed', '未达标任务', (m) => `${m.failed}`, (m) => `/ ${m.tasks}`],
  ['pointsMissed', '金标准要点遗漏', (m) => `${m.pointsTotal - m.pointsHit}`, (m) => `/ ${m.pointsTotal}`]
];

function metricTable(before, after) {
  if (!before && !after) return el('p', 'empty', '还没有运行记录。点「① 跑一次」开始。');
  const t = el('table', 'm');
  const head = el('tr');
  head.append(el('th', null, '指标'), el('th', 'c', `进化前 ${before ? before.version : ''}`), el('th', 'c', ''), el('th', 'c', after ? `进化后 ${after.version}（${after.strategies} 条策略）` : '进化后'));
  t.append(head);
  for (const [key, name, val, tot] of ROWS) {
    const tr = el('tr');
    const nameTd = el('td', null, name);
    const b = before ? Number(val(before.metrics)) : null;
    const a = after ? Number(val(after.metrics)) : null;
    const tdB = el('td', 'num', before ? val(before.metrics) : '—');
    if (before) tdB.append(el('small', 'hint', tot(before.metrics)));
    const tdA = el('td', 'num' + (a !== null && b !== null ? (a < b ? ' better' : a > b ? ' worse' : '') : ''), after ? val(after.metrics) : '—');
    if (after) tdA.append(el('small', 'hint', tot(after.metrics)));
    tr.append(nameTd, tdB, el('td', 'arrow', '→'), tdA);
    t.append(tr);
  }
  const tr = el('tr');
  tr.append(
    el('td', null, '本次 tokens / 平均耗时'),
    el('td', 'num small', before ? `${before.metrics.tokens} / ${(before.metrics.avgLatencyMs / 1000).toFixed(1)}s` : '—'),
    el('td', 'arrow', ''),
    el('td', 'num small', after ? `${after.metrics.tokens} / ${(after.metrics.avgLatencyMs / 1000).toFixed(1)}s` : '—')
  );
  t.append(tr);
  return t;
}

function renderMetrics() {
  const tr = pick('train');
  $('metrics').replaceChildren(metricTable(tr.before, tr.after));
  const ho = pick('holdout');
  $('holdout').replaceChildren(ho.before || ho.after ? metricTable(ho.before, ho.after) : el('p', 'empty', '学习之后点「③ 留出集验证」：10 条进化时从没见过的任务，v0 和当前版本各跑一次。'));
}

// ── 策略库 ──
function renderLibrary() {
  const vbox = $('versions');
  vbox.replaceChildren();
  for (const v of S.versions) vbox.append(el('span', 'v' + (v.id === S.active ? ' active' : ''), `${v.id}${v.id === 'v0' ? ' 空库' : ` +${v.added.length}`}`));
  const cur = S.versions.find((v) => v.id === S.active) || { added: [], rejected: [] };
  $('lib-version').textContent = `当前 ${S.active} · ${S.strategies.length} 条 · 文件 data/evolve/strategies/${S.active}.jsonl`;
  const ol = $('library');
  ol.replaceChildren();
  if (!S.strategies.length) ol.append(el('li', null, 'v0 是空库：系统还什么都没学，这就是基线。'));
  const added = new Set(cur.added || []);
  let i = 0;
  for (const s of S.strategies) {
    const li = el('li', added.has(s.id) ? 'new' : '');
    if (added.has(s.id) && animateNew) li.style.animationDelay = `${(i++) * 0.45}s`;
    const meta = el('div', 'meta', `${s.id} · 来源 ${s.source_cases.join(', ')} · ${s.created_by} · ${s.version || ''}`);
    if (added.has(s.id)) meta.append(el('span', 'tag', `${S.active} 新增${s.round ? ` · 第${s.round}轮` : ''}`));
    if (s.replaces && s.replaces.length) meta.append(el('span', 'tag', `替换 ${s.replaces.join(',')}`));
    li.append(meta, el('div', null, s.when ? `【${s.when}】${s.rule}` : s.rule));
    ol.append(li);
  }
  animateNew = false;
  const rej = $('rejected');
  rej.replaceChildren();
  if (cur.rejected && cur.rejected.length) {
    const box = el('div', 'rej');
    box.append(el('div', null, `被拦下的候选策略 ${cur.rejected.length} 条（不会写入策略库）：`));
    const ul = el('ul');
    for (const r of cur.rejected) ul.append(el('li', null, `${r.reason} —— ${r.rule}`));
    box.append(ul);
    rej.append(box);
  }
}

// ── 逐条对照 ──
function replyBox(result, run, feedbackable) {
  const g = result.grade;
  const box = el('div', 'reply ' + (g.pass ? 'pass' : 'fail'));
  box.append(document.createTextNode(result.reply || (result.error ? `（调用失败：${result.error}）` : '（空）')));
  if (result.routed) box.append(el('span', 'used', '危机固定协议 · 未经过模型'));
  else if (result.used && result.used.length) box.append(el('span', 'used', `用到策略 ${result.used.join(', ')}`));
  const why = [];
  g.points.filter((p) => !p.hit).forEach((p) => why.push(`缺：${p.desc}`));
  g.harms.forEach((h) => why.push(`伤害：${h.desc}`));
  if (g.crisisMiss) why.push('危机漏识别：没有给出 12356');
  if (why.length) box.append(el('span', 'why', '✗ ' + why.join('；')));
  else box.append(el('span', 'ok', `✓ 要点 ${g.pointsHit}/${g.pointsTotal}，无伤害`));
  if (feedbackable && !result.routed) {
    const fb = (S.feedback[run.id] || {})[result.taskId] === 'bad';
    const b = el('button', 'fb' + (fb ? ' on' : ''), '👎');
    b.title = '人工反馈：这条答得不好（只给评价，不给答案）';
    b.onclick = async () => {
      try {
        await api('POST', '/api/evolve/feedback', { runId: run.id, taskId: result.taskId, value: fb ? null : 'bad' });
        await refresh();
      } catch (e) {
        toast(e.message);
      }
    };
    box.append(b);
  }
  return box;
}

async function renderCases() {
  const { before, after } = pick('train');
  const box = $('cases');
  if (!before && !after) {
    box.replaceChildren(el('p', 'empty', '还没有运行记录。'));
    return;
  }
  const [rb, ra] = await Promise.all([getRun(before && before.id), getRun(after && after.id)]);
  const learnable = S.runs.filter((r) => r.set === 'train' && r.version === S.active).pop();
  const frag = document.createDocumentFragment();
  const base = rb || ra;
  base.results.forEach((r0, i) => {
    const row = el('div', 'case');
    const q = el('div', 'q');
    q.append(el('span', 'id', r0.taskId + ' '), el('span', 'type', TYPE_NAME[r0.grade.type] || r0.grade.type || ''), document.createTextNode(r0.input));
    row.append(q);
    row.append(rb ? replyBox(rb.results[i], rb, learnable && learnable.id === rb.id) : el('div', 'empty', '—'));
    row.append(ra ? replyBox(ra.results[i], ra, learnable && learnable.id === ra.id) : el('div', 'empty', '（学习后再跑一次，这里显示进化后的回答）'));
    frag.append(row);
  });
  box.replaceChildren(frag);
}

// ── 按钮与进度 ──
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, String(v)));
  if (text !== undefined) e.textContent = String(text);
  return e;
}

/** 逐轮曲线：四条线都换算成百分比，同一坐标轴 */
function renderIterations() {
  const log = (S && S.iterations) || { rounds: [] };
  const rounds = log.rounds.filter((r) => r.version && r.train);
  $('btn-iterate').disabled = busy() || !S.hasKey;
  $('iter-info').textContent = rounds.length
    ? `已迭代 ${rounds.length - 1} 轮 · 当前最好版本 ${log.best} · 晋级 ${rounds.filter((r) => r.promoted).length - 1} / 未晋级 ${rounds.filter((r) => !r.promoted).length}` +
      (log.rounds.some((r) => r.stopped) ? ' · 已停：没有新的可学策略' : '')
    : '还没有逐轮记录。点「连续自迭代」会从当前版本开始，每轮约 1 分钟。';
  const chart = $('iter-chart');
  const table = $('iter-table');
  if (!rounds.length) {
    chart.replaceChildren();
    table.replaceChildren();
    return;
  }
  const SER = [
    { name: '训练集 要点覆盖', color: '#2e7d4f', f: (r) => r.train.pointsHit / r.train.pointsTotal },
    { name: '留出集 要点覆盖', color: '#2e7d4f', dash: '6 4', f: (r) => r.holdout && r.holdout.pointsHit / r.holdout.pointsTotal },
    { name: '训练集 未达标', color: '#b3261e', f: (r) => r.train.failed / r.train.tasks },
    { name: '留出集 未达标', color: '#b3261e', dash: '6 4', f: (r) => r.holdout && r.holdout.failed / r.holdout.tasks },
    { name: '训练集 危机漏识别', color: '#b5652b', f: (r) => r.train.crisisMiss / r.train.crisisTotal },
    { name: '留出集 危机漏识别', color: '#b5652b', dash: '6 4', f: (r) => r.holdout && r.holdout.crisisMiss / r.holdout.crisisTotal }
  ];
  const W = 1000, H = 260, L = 46, R = 16, T = 12, B = 34;
  const x = (i) => L + (rounds.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rounds.length - 1));
  const y = (v) => T + (1 - v) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '逐轮自迭代曲线' });
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#e2d9cc' }));
    svg.append(svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#6b625a' }, `${Math.round(v * 100)}%`));
  });
  rounds.forEach((r, i) => svg.append(svgEl('text', { x: x(i), y: H - 10, 'text-anchor': 'middle', 'font-size': 13, fill: r.promoted ? '#2b2622' : '#9c948a' }, r.version)));
  SER.forEach((s) => {
    // 线只连晋级的版本（真实的演进路径）；没晋级的只画空心点
    const pts = rounds.map((r, i) => [x(i), s.f(r), r.promoted]).filter(([, v, p]) => p && typeof v === 'number' && !Number.isNaN(v));
    svg.append(svgEl('polyline', { points: pts.map(([a, v]) => `${a},${y(v)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-dasharray': s.dash || '' }));
    rounds.forEach((r, i) => {
      const v = s.f(r);
      if (typeof v !== 'number' || Number.isNaN(v)) return;
      svg.append(svgEl('circle', { cx: x(i), cy: y(v), r: 4.5, fill: r.promoted ? s.color : '#fff', stroke: s.color, 'stroke-width': 2 }));
    });
  });
  const legend = el('div', 'iter-legend');
  SER.forEach((s) => {
    const it = el('span');
    const sw = el('i');
    sw.style.background = s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 6px, transparent 6px 10px)` : s.color;
    it.append(sw, document.createTextNode(s.name));
    legend.append(it);
  });
  chart.replaceChildren(svg, legend);

  const t = el('table', 'iter');
  const hr = el('tr');
  ['版本', '来自', '晋级', '策略库', '训练 危机漏', '训练 未达标', '训练 要点', '留出 危机漏', '留出 未达标', '留出 要点', '二次伤害 训/留', '新增/替换/拒收'].forEach((h) => hr.append(el('th', null, h)));
  t.append(hr);
  rounds.forEach((r) => {
    const tr = el('tr', r.version === log.best ? 'best' : r.promoted ? '' : 'nopromo');
    const h = r.holdout || {};
    [r.version, r.parent || '—', r.round === 0 ? '起点' : r.promoted ? '✓' : '✗ 训练集变差', r.library,
      `${r.train.crisisMiss}/${r.train.crisisTotal}`, `${r.train.failed}/${r.train.tasks}`, `${r.train.pointsHit}/${r.train.pointsTotal}`,
      `${h.crisisMiss}/${h.crisisTotal}`, `${h.failed}/${h.tasks}`, `${h.pointsHit}/${h.pointsTotal}`,
      `${r.train.harmful} / ${h.harmful}`, `${r.added.length} / ${r.replaced.length} / ${r.rejected.length}`].forEach((c) => tr.append(el('td', null, c)));
    t.append(tr);
  });
  table.replaceChildren(t);
}

function renderCertifications() {
  const log = (S && S.certifications) || { candidates: [], batches: [], rounds: [] };
  const cs = log.candidates || [];
  const ok = cs.filter((c) => c.status === 'certified').length;
  $('cert-summary').textContent = cs.length
    ? `共 ${log.batches.length} 批 · 候选 ${cs.length} 条 · 认证保存 ${ok} 条 · 排除 ${cs.length - ok} 条 · 安全闸拒收 ${log.batches.reduce((a, b) => a + (b.gateRejected || []).length, 0)} 条（没进入检验）`
    : '还没有认证记录。';
  const t = el('table', 'cert');
  const hr = el('tr');
  ['批', '候选策略', '第 1 次', '第 2 次', '第 3 次', '结果', '原因'].forEach((h) => hr.append(el('th', null, h)));
  t.append(hr);
  cs.slice().reverse().slice(0, 60).forEach((c) => {
    const tr = el('tr', c.status);
    tr.append(el('td', null, c.batch));
    tr.append(el('td', null, `${c.id} ${c.rule}`));
    for (let k = 0; k < 3; k++) {
      const q = c.checks[k];
      tr.append(q ? el('td', q.pass ? 'ok' : 'no', `${q.pass ? '✓' : '✗'} 未达标${q.failed} 要点${q.pointsHit}`) : el('td', 'na', '—'));
    }
    tr.append(el('td', c.status === 'certified' ? 'ok' : 'no', c.status === 'certified' ? `已保存 ${c.savedIn || ''}` : '排除'));
    tr.append(el('td', null, c.reason || ''));
    t.append(tr);
  });
  $('cert-table').replaceChildren(cs.length ? t : '');
}

function busy() {
  return Boolean(S && ((S.job && !S.job.finished) || S.iterating));
}

function renderControls() {
  const b = busy();
  const hasRunOnActive = S.runs.some((r) => r.set === 'train' && r.version === S.active);
  $('btn-run').disabled = b || !S.hasKey;
  $('btn-learn').disabled = b || !S.hasKey || !hasRunOnActive;
  $('btn-holdout').disabled = b || !S.hasKey;
  $('btn-rollback').disabled = b || S.active === 'v0';
  $('btn-try').disabled = b || !S.hasKey;
  $('btn-run').querySelector('small').textContent = `训练集 20 条 · 用 ${S.active}（${S.strategies.length} 条策略）`;
  const p = $('progress');
  if (b) {
    p.classList.add('on');
    const label = { run: `正在跑 ${S.job.set === 'holdout' ? '留出集' : '训练集'}（${S.job.version}）`, holdout: '留出集验证中', learn: S.job.total ? '第 1 轮归纳完成，正在用候选策略自检失败案例 → 再归纳' : '第 1 轮：复盘失败案例、归纳策略…' }[S.job.kind];
    const pct = S.job.total ? Math.round((100 * S.job.done) / S.job.total) : 15;
    $('bar').style.width = `${pct}%`;
    $('progress-text').textContent = `${label} ${S.job.total ? `${S.job.done}/${S.job.total}` : ''} · ${((Date.now() - S.job.startedAt) / 1000).toFixed(0)}s`;
  } else {
    p.classList.remove('on');
  }
  $('foot-info').textContent = S.hasKey ? `模型 ${S.fingerprint.model} · 数据只写 data/evolve/` : '未配置模型密钥：只能查看已有结果';
}

function onJobFinished(job) {
  if (job.error) return toast(`失败：${job.error}`);
  const sec = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
  if (job.kind === 'learn') {
    const r = job.result;
    animateNew = true;
    const sc = r.selfCheck ? `，自检后仍未做好 ${r.selfCheck.stillFailing.length}/${r.selfCheck.cases} 条并做了第 2 轮归纳` : '';
    toast(r.newVersion ? `学习完成（${sec}s）：复盘 ${r.failures.length} 条失败${sc}；新增 ${r.accepted.length} 条策略${r.replaced && r.replaced.length ? `、替换 ${r.replaced.length} 条` : ''}，安全层拒收 ${r.rejected.length} 条 → ${r.newVersion}` : `没有新策略（${r.failures.length} 条失败）`, true);
  } else {
    toast(`运行完成，用时 ${sec}s`, true);
  }
}

async function refresh() {
  S = await api('GET', '/api/evolve/state');
  if (S.job) {
    const k = S.job.startedAt;
    if (!S.job.finished) seenRunning.add(k);
    else if (seenRunning.has(k) && !announced.has(k)) {
      announced.add(k);
      onJobFinished(S.job);
    }
  }
  renderEvidence();
  renderControls();
  renderMetrics();
  renderLibrary();
  renderIterations();
  renderCertifications();
  await renderCases();
  if (busy() && !polling) polling = setInterval(tick, 800);
  if (!busy() && polling) {
    clearInterval(polling);
    polling = null;
  }
}

async function tick() {
  try {
    const s = await api('GET', '/api/evolve/state');
    if (s.job && !s.job.finished) {
      S = s;
      renderControls();
    } else {
      await refresh();
    }
  } catch (e) {
    /* 偶发失败忽略，下一拍再取 */
  }
}

async function act(fn) {
  toast('');
  try {
    const before = S && S.job ? S.job.startedAt : null;
    await fn();
    const s = await api('GET', '/api/evolve/state');
    if (s.job && s.job.startedAt !== before) seenRunning.add(s.job.startedAt);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

$('btn-run').onclick = () => act(() => api('POST', '/api/evolve/run', { set: 'train' }));
$('btn-learn').onclick = () => act(() => api('POST', '/api/evolve/learn', {}));
$('btn-holdout').onclick = () => act(() => api('POST', '/api/evolve/holdout', {}));
$('btn-iterate').onclick = () => act(() => api('POST', '/api/evolve/iterate', { rounds: 3 }));
$('btn-rollback').onclick = async () => {
  try {
    const r = await api('POST', '/api/evolve/rollback', { version: 'v0' });
    toast(`已回退：策略库指回 ${r.active}（空库）。现在「试一句」或「跑一次」都是进化前的行为；v1 以后的版本文件都还在，没有删除。`, true);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};
$('btn-try').onclick = async () => {
  const out = $('try-out');
  out.replaceChildren(el('p', 'empty', '回答中…'));
  try {
    const r = await api('POST', '/api/evolve/try', { text: $('try-text').value });
    const box = el('div', 'reply');
    box.append(el('span', 'used', `版本 ${r.version}${r.routed ? ' · 危机固定协议（未经过模型）' : ` · 用到策略 ${r.used.length ? r.used.join(', ') : '无'}`}`));
    box.append(document.createTextNode(r.reply));
    out.replaceChildren(box);
  } catch (e) {
    out.replaceChildren(el('p', 'why', e.message));
  }
};
$('btn-reset').onclick = async () => {
  if (!confirm('清空全部运行记录和策略库，回到 v0？（演示前重置用）')) return;
  try {
    await api('POST', '/api/evolve/reset', { confirm: true });
    runCache.clear();
    toast('已清空。', true);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
};

refresh().catch((e) => toast(e.message));
