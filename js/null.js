/* null — a psql session over PumpSwap.
   Every number on this page is read live from Solana (names and prices from DexScreener). No keys here: the server
   builds transactions, your wallet signs them. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const S = { cfg: { ttlHours: 72, shares: { creator: 6000, pool: 3000, void: 1000 } }, rec: null, pool: null, tab: 'add', slip: 2, pct: 100, toSol: true, busy: false, positions: null, amt: '', hostSort: 'fees', hostAll: false, dev: 0, kp: null };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };

  /* ---------------- utils ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  function compact(n) {
    n = Number(n); if (!isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
    if (a >= 100) return n.toFixed(0);
    if (a >= 1) return n.toFixed(2);
    if (a === 0) return '0';
    return n.toPrecision(3);
  }
  const usd = n => n ? '$' + compact(n) : '—';
  function fsol(n, d) { n = Number(n) || 0; if (d != null) return n.toFixed(d); const a = Math.abs(n); return a >= 1000 ? compact(n) : a >= 1 ? n.toFixed(2) : a >= 0.01 ? n.toFixed(3) : a > 0 ? n.toFixed(5) : '0'; }
  const coinAmt = (raw, dec) => Number(BigInt(raw || '0')) / Math.pow(10, dec || 6);
  const pctTxt = (x, d = 2) => (x * 100).toFixed(d) + '%';
  const nowS = () => Date.now() / 1000;
  const TTL = () => (S.cfg.ttlHours || 72) * 3600;
  function dur(s) { s = Math.max(0, Math.floor(s)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`; }
  const ago = t => t ? dur(nowS() - t) + ' ago' : '—';
  const hms = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };
  const msTxt = ms => (Number(ms) || 0).toFixed(3) + ' ms';
  const ttlOf = c => c && c.lastAt ? Math.max(0, TTL() - (nowS() - c.lastAt)) : null;
  const stateOf = c => !c ? 'unknown' : (c.state === 'declared' || c.stage === 'declared' || c.stage === 'graduating') ? 'declared' : c.lastAt ? (ttlOf(c) > 0 ? 'alive' : 'null') : (c.state || 'unknown');
  const tag = c => c.symbol ? '$' + c.symbol : short(c.mint);
  function av(c) {
    const letter = esc(((c.symbol || c.name || '?')[0] || '?').toUpperCase());
    const img = c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">` : '';
    return `<span class="av">${letter}${img}</span>`;
  }
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  async function api(path, body) {
    const t0 = performance.now();
    const opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch('/api/' + path, opt);
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok || !j || j.ok === false) { const e = new Error((j && j.error) || ('request failed (' + r.status + ')')); e.logs = j && j.logs; throw e; }
    j._ms = performance.now() - t0;
    return j;
  }
  const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
  const ease = t => 1 - Math.pow(1 - t, 3);

  /* ---------------- film grain ---------------- */
  (() => {
    const c = document.createElement('canvas'); c.width = c.height = 180; const x = c.getContext('2d'); const d = x.createImageData(180, 180);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255 | 0; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0); $('.grain').style.backgroundImage = `url(${c.toDataURL()})`;
  })();

  /* ---------------- nav ---------------- */
  const nav = $('#nav');
  function onScroll() {
    nav.classList.toggle('solid', scrollY > 40);
    let cur = null; for (const a of $$('#links a')) { const s = document.getElementById(a.getAttribute('href').slice(1)); if (s && s.getBoundingClientRect().top < innerHeight * 0.42) cur = a; }
    $$('#links a').forEach(a => a.classList.toggle('on', a === cur));
  }
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------------- hero: the word ---------------- */
  const word = $('#word'), wordTxt = $('#wordTxt');
  function boot() {
    if (reduce) { $('#tag').classList.add('in'); $('#psql').classList.add('in'); return; }
    wordTxt.textContent = '';
    const w = 'null'; let i = 0;
    const step = () => { wordTxt.textContent = w.slice(0, ++i); if (i < w.length) setTimeout(step, 95 + Math.random() * 70); else { setTimeout(() => $('#tag').classList.add('in'), 250); setTimeout(() => $('#psql').classList.add('in'), 520); } };
    setTimeout(step, 260);
  }
  boot();
  function glitch() {
    if (!reduce && !document.hidden) {
      const r = () => (Math.random() * 80).toFixed(0) + '%';
      word.style.setProperty('--a', r()); word.style.setProperty('--b', (Math.random() * 40).toFixed(0) + '%');
      word.style.setProperty('--c', r()); word.style.setProperty('--d', (Math.random() * 40).toFixed(0) + '%');
      word.style.setProperty('--dx', ((Math.random() - .5) * .12).toFixed(3) + 'em'); word.style.setProperty('--dy', ((Math.random() - .5) * .12).toFixed(3) + 'em');
      word.classList.add('gl'); setTimeout(() => word.classList.remove('gl'), 120 + Math.random() * 160);
    }
    setTimeout(glitch, 2600 + Math.random() * 4800);
  }
  setTimeout(glitch, 2200);

  /* ---------------- hero: the horizon (every point is a real coin) ---------------- */
  const HZ = { cv: $('#horizon'), pts: new Map(), hover: null, w: 0, h: 0, on: true, mx: -1, my: -1 };
  const hctx = HZ.cv.getContext('2d');
  function hzSize() { const r = HZ.cv.getBoundingClientRect(); HZ.w = r.width; HZ.h = r.height; HZ.cv.width = Math.round(r.width * DPR); HZ.cv.height = Math.round(r.height * DPR); }
  function geo() {
    const w = HZ.w, h = HZ.h, L = Math.max(22, w * 0.06);
    return { L, R: w - L, top: h * 0.665, line: h * 0.86, bot: h * 0.955 };
  }
  const H168 = 168 * 3600;
  function hzPos(p, g, t) {
    const age = Math.max(0, t - (p.bornAt || t)), sil = p.lastAt ? Math.max(0, t - p.lastAt) : 0, T = TTL();
    const x = g.L + Math.sqrt(Math.min(1, age / H168)) * (g.R - g.L) + (p.seed - .5) * 8;
    let y;
    if (sil < T) y = g.top + Math.sqrt(sil / T) * (g.line - g.top - 6) + (p.seed2 - .5) * 6;
    else y = g.line + 8 + Math.pow(Math.min(1, (sil - T) / (H168 - T)), .7) * (g.bot - g.line - 12);
    return { x, y: Math.max(g.top - 4, y), dead: sil >= T };
  }
  function hzAdd(list, src) {
    const t = performance.now(); let k = 0;
    for (const c of list || []) {
      if (!c || !c.mint || !c.bornAt) continue;
      const old = HZ.pts.get(c.mint);
      if (old) { Object.assign(old, c); continue; }
      HZ.pts.set(c.mint, { ...c, seed: hashStr(c.mint), seed2: hashStr(c.mint + 'y'), t0: t + (k++) * 22, src });
    }
  }
  const TICKS = [[6, '6h'], [24, '1d'], [48, '2d'], [72, '3d'], [120, '5d'], [168, '7d']];
  function hzDraw(ts) {
    requestAnimationFrame(hzDraw);
    if (!HZ.on || document.hidden) return;
    const x = hctx, w = HZ.w, h = HZ.h, g = geo(), t = nowS();
    x.setTransform(DPR, 0, 0, DPR, 0, 0); x.clearRect(0, 0, w, h);
    // grid
    x.fillStyle = 'rgba(232,230,225,.07)';
    for (let gx = g.L; gx <= g.R + 1; gx += 22) for (let gy = g.top; gy <= g.bot; gy += 22) x.fillRect(Math.round(gx), Math.round(gy), 1, 1);
    // age ticks
    x.font = '10px SM, monospace'; x.textAlign = 'center';
    for (const [hh, lb] of TICKS) {
      const tx = g.L + Math.sqrt(hh / 168) * (g.R - g.L);
      x.fillStyle = 'rgba(232,230,225,.10)'; for (let yy = g.top; yy < g.bot; yy += 4) x.fillRect(Math.round(tx), yy, 1, 1);
      x.fillStyle = '#4c4b4d'; x.fillText(lb, tx, g.bot + 14);
    }
    // null zone + the line
    const gr = x.createLinearGradient(0, g.line, 0, g.bot + 20); gr.addColorStop(0, 'rgba(255,61,87,.045)'); gr.addColorStop(1, 'rgba(255,61,87,0)');
    x.fillStyle = gr; x.fillRect(0, g.line, w, g.bot - g.line + 20);
    x.save(); x.shadowColor = 'rgba(232,230,225,.6)'; x.shadowBlur = 10; x.fillStyle = 'rgba(232,230,225,.62)'; x.fillRect(0, Math.round(g.line), w, 1); x.restore();
    x.textAlign = 'left'; x.fillStyle = '#6a696b'; x.fillText('ttl 72h', g.L, g.line - 8);
    x.fillStyle = 'rgba(255,61,87,.55)'; x.fillText('null', g.L, g.line + 16);
    x.textAlign = 'right'; x.fillStyle = '#4c4b4d';
    if (HZ.pts.size) x.fillText(`${HZ.pts.size} coins · live`, g.R, g.line - 8);
    // sweep while the census measures
    if (!C.census.data) {
      const sx = g.L + ((ts / 2600) % 1) * (g.R - g.L);
      const sg = x.createLinearGradient(sx - 120, 0, sx, 0); sg.addColorStop(0, 'rgba(232,230,225,0)'); sg.addColorStop(1, 'rgba(232,230,225,.10)');
      x.fillStyle = sg; x.fillRect(sx - 120, g.top - 10, 120, g.bot - g.top + 10); x.fillStyle = 'rgba(232,230,225,.5)'; x.fillRect(Math.round(sx), g.top - 10, 1, g.bot - g.top + 10);
      x.textAlign = 'left'; x.fillStyle = '#6a696b'; x.fillText('measuring pumpswap…', g.L, g.top - 16);
    }
    // points
    const now = performance.now(); let best = null, bd = 18 * 18;
    for (const p of HZ.pts.values()) {
      const q = hzPos(p, g, t);
      let k = reduce ? 1 : Math.min(1, Math.max(0, (now - p.t0) / 900));
      if (k <= 0) continue;
      const e = ease(k), y = q.y - (1 - e) * 60;
      x.globalAlpha = e;
      if (q.dead) {
        const fl = (Math.sin(ts / 700 + p.seed * 40) + 1) / 2;
        x.strokeStyle = `rgba(139,138,134,${.35 + fl * .25})`; x.lineWidth = 1; x.strokeRect(Math.round(q.x) - 2.5, Math.round(y) - 2.5, 5, 5);
      } else {
        const sil = p.lastAt ? t - p.lastAt : 0, period = 1.1 + Math.min(5, sil / 3600 * .35);
        const ph = ((ts / 1000) / period + p.seed) % 1;
        if (!reduce) { x.strokeStyle = `rgba(232,230,225,${Math.pow(1 - ph, 2) * .45})`; x.lineWidth = 1; x.beginPath(); x.arc(q.x, y, 2 + ph * 13, 0, Math.PI * 2); x.stroke(); }
        const fresh = t - p.bornAt < 7200;
        x.fillStyle = fresh ? '#ffffff' : '#e8e6e1'; const s = fresh ? 4 : 3;
        x.fillRect(Math.round(q.x - s / 2), Math.round(y - s / 2), s, s);
      }
      x.globalAlpha = 1;
      const dx = q.x - HZ.mx, dy = q.y - HZ.my, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { p, q }; }
    }
    // hover crosshair
    const tip = $('#hzTip');
    if (best) {
      const { p, q } = best;
      x.strokeStyle = 'rgba(232,230,225,.35)'; x.setLineDash([2, 3]); x.beginPath(); x.moveTo(q.x, q.y); x.lineTo(q.x, g.bot); x.moveTo(q.x, q.y); x.lineTo(0, q.y); x.stroke(); x.setLineDash([]);
      x.strokeStyle = '#e8e6e1'; x.strokeRect(q.x - 6, q.y - 6, 12, 12);
      if (HZ.hover !== p) {
        HZ.hover = p;
        const st = stateOf(p);
        tip.innerHTML = `<b>${esc(tag(p))}</b> <span>${st} · born ${ago(p.bornAt)} · ${p.lastAt ? 'beat ' + ago(p.lastAt) : ''}</span>`;
        tip.hidden = false;
      }
      const tw = (tip.offsetWidth || 240) / 2 + 8; tip.style.left = Math.min(w - tw, Math.max(tw, q.x)) + 'px'; tip.style.top = q.y + 'px';
      HZ.cv.style.cursor = 'pointer';
    } else if (HZ.hover) { HZ.hover = null; tip.hidden = true; HZ.cv.style.cursor = ''; }
  }
  HZ.cv.addEventListener('pointermove', e => { const r = HZ.cv.getBoundingClientRect(); HZ.mx = e.clientX - r.left; HZ.my = e.clientY - r.top; });
  HZ.cv.addEventListener('pointerleave', () => { HZ.mx = HZ.my = -1e4; });
  HZ.cv.addEventListener('click', () => { if (HZ.hover) openRec(HZ.hover.mint); });
  new IntersectionObserver(es => { HZ.on = es[0].isIntersecting; }).observe($('#top'));
  hzSize(); addEventListener('resize', hzSize); requestAnimationFrame(hzDraw);

  /* ---------------- the psql prompt ---------------- */
  const CMDS = ['help', 'census', 'births', 'check ', 'host ', 'launch ', 'void', 'man null', 'whoami', 'clear', 'select * from births;', 'select * from void;'];
  const out = $('#out'), cmd = $('#cmd'), ghost = $('#ghost');
  const hist = []; let hi = -1;
  const say = html => { out.innerHTML = html; };
  const jump = id => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); };
  function suggest() {
    const v = cmd.value; ghost.innerHTML = '';
    if (!v || isAddr(v)) return '';
    const m = CMDS.find(c => c.startsWith(v.toLowerCase()) && c !== v.toLowerCase());
    if (!m) return '';
    ghost.style.left = (cmd.offsetLeft) + 'px';
    ghost.innerHTML = `<b>${esc(v)}</b>${esc(m.slice(v.length))}`;
    return m;
  }
  cmd.addEventListener('input', suggest);
  cmd.addEventListener('keydown', e => {
    if ((e.key === 'Tab' || (e.key === 'ArrowRight' && cmd.selectionStart === cmd.value.length)) && ghost.textContent) { const m = suggest(); if (m) { e.preventDefault(); cmd.value = m; ghost.innerHTML = ''; } }
    else if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); hi = Math.min(hist.length - 1, hi + 1); cmd.value = hist[hist.length - 1 - hi]; suggest(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.max(-1, hi - 1); cmd.value = hi < 0 ? '' : hist[hist.length - 1 - hi]; suggest(); }
    else if (e.key === 'Escape') { cmd.value = ''; ghost.innerHTML = ''; say(''); }
  });
  $('#psql').addEventListener('submit', e => {
    e.preventDefault();
    const raw = cmd.value.trim(); if (!raw) return;
    hist.push(raw); hi = -1; cmd.value = ''; ghost.innerHTML = '';
    exec(raw);
  });
  function exec(raw) {
    const v = raw.replace(/;+\s*$/, '').trim(), lo = v.toLowerCase(), parts = v.split(/\s+/);
    if (isAddr(v)) { say(`checking <b>${short(v)}</b>…`); openRec(v); return; }
    if (lo === 'help' || lo === '\\?' || lo === '?') {
      say(`<b>&lt;mint&gt;</b>               check a coin
<b>launch</b> &lt;name&gt; &lt;ticker&gt;  stage a launch
<b>host</b> &lt;mint&gt;          host a coin
census  births  check  host  launch  void  man null  whoami  clear`); return;
    }
    if (lo === 'clear' || lo === '\\c') { say(''); return; }
    if (lo === 'null') { say('null is not zero.'); return; }
    if (lo === '0' || lo === 'zero') { say('0 is not null.'); return; }
    if (lo === '\\q' || lo === 'exit' || lo === 'quit') { say('there is no exit. only silence.'); return; }
    if (lo === 'whoami') { say(W.acct ? esc(W.acct.address) : 'anonymous. <a href="#" data-act="connect">connect</a>'); return; }
    if (/^(man|\\! man)\b/.test(lo)) { say(''); jump('man'); return; }
    if (parts[0].toLowerCase() === 'launch' && parts.length > 1) {
      const sym = parts.length > 2 ? parts[parts.length - 1] : '', name = (parts.length > 2 ? parts.slice(1, -1) : parts.slice(1)).join(' ');
      $('#lName').value = name.slice(0, 32); if (sym) $('#lSym').value = sym.replace(/^\$/, '').toUpperCase().slice(0, 10);
      say(`INSERT staged: <b>${esc(name)}</b>${sym ? ' $' + esc(sym.replace(/^\$/, '').toUpperCase()) : ''}`); jump('launch'); return;
    }
    if (parts[0].toLowerCase() === 'host' && parts[1] && isAddr(parts[1])) { say(''); openRec(parts[1], 'add'); return; }
    if (parts[0].toLowerCase() === 'check' && parts[1] && isAddr(parts[1])) { $('#checkIn').value = parts[1]; say(''); jump('check'); runCheck(parts[1]); return; }
    const m = lo.match(/\bfrom\s+([a-z_.]+)/);
    const target = m ? m[1].split('.').pop() : lo.split(' ')[0];
    const map = { census: 'census', graduations: 'census', births: 'births', coins: 'check', check: 'check', pools: 'host', host: 'host', launch: 'launch', void: 'void', man: 'man' };
    if (map[target]) { say(''); jump(map[target]); return; }
    say(`<span class="e">ERROR:</span>  relation "${esc(target.slice(0, 40))}" does not exist. try <b>help</b>`);
  }
  out.addEventListener('click', e => { const a = e.target.closest('[data-act="connect"]'); if (a) { e.preventDefault(); connect(); } });
  addEventListener('keydown', e => {
    if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); cmd.focus({ preventScroll: true }); }
  });

  /* ---------------- cells: the query types itself, then the real result prints ---------------- */
  const C = {}; ['census', 'births', 'check', 'host', 'launch', 'void', 'man'].forEach(n => C[n] = { typed: false, data: null, err: null, loading: false, t0: 0, rendered: false });
  function prepType(sqlEl) {
    const items = [];
    const walk = n => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) { if (c.textContent.length) { items.push({ t: c, s: c.textContent }); c.textContent = ''; } }
        else if (c.classList && c.classList.contains('slot')) { items.push({ slot: c }); c.classList.add('pre'); }
        else walk(c);
      }
    };
    walk(sqlEl); sqlEl._items = items;
  }
  function typeIn(sqlEl, done) {
    const items = sqlEl._items || []; let i = 0, j = 0;
    sqlEl.classList.add('typing');
    const step = () => {
      let budget = 2 + (Math.random() * 3 | 0);
      while (budget-- > 0 && i < items.length) {
        const it = items[i];
        if (it.slot) { it.slot.classList.remove('pre'); i++; continue; }
        it.t.textContent = it.s.slice(0, ++j);
        if (j >= it.s.length) { i++; j = 0; }
      }
      if (i < items.length) setTimeout(step, 14 + Math.random() * 26);
      else { sqlEl.classList.remove('typing'); done(); }
    };
    step();
  }
  const sqlEls = $$('.cell .sql');
  if (!reduce) sqlEls.forEach(prepType);
  const typedObs = new IntersectionObserver(es => es.forEach(en => {
    if (!en.isIntersecting) return;
    const cell = en.target.closest('.cell'), name = cell.dataset.cell; typedObs.unobserve(en.target);
    const fin = () => { C[name].typed = true; paint(name); };
    reduce ? fin() : typeIn(en.target, fin);
  }), { threshold: 0.6, rootMargin: '0px 0px -12% 0px' });
  sqlEls.forEach(el => typedObs.observe(el));

  const RES = { census: '#censusRes', births: '#birthsRes', check: '#checkRes', host: '#hostRes', launch: '#launchRes', void: '#voidIn', man: '#manRes' };
  const runHtml = t0 => `<div class="run"><span class="spin" data-spin>|</span> running… <b data-el="${t0}">0.0s</b></div>`;
  const errHtml = (e, retry) => `<div class="err pr-in">ERROR:  ${esc(e.message || e)}${retry ? `<button type="button" data-retry="${retry}">\\r retry</button>` : ''}</div>`;
  function paint(name) {
    const c = C[name], el = $(RES[name]);
    if (!c.typed || !el) return;
    if (name === 'check') return checkPainted();
    if (name === 'launch') return renderLaunch();
    if (name === 'man') return renderMan();
    if (c.err) { el.innerHTML = errHtml(c.err, name); return; }
    if (!c.data) { el.innerHTML = runHtml(c.t0); return; }
    R[name](c.data, el, !c.rendered); c.rendered = true;
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-retry]'); if (b) load(b.dataset.retry); });
  const LOAD = { census: () => api('census'), births: () => api('births'), host: () => api('pools'), void: () => api('void') };
  function load(name) {
    const c = C[name]; if (c.loading) return;
    c.loading = true; c.err = null; if (!c.data) c.t0 = performance.now();
    paint(name);
    return LOAD[name]().then(j => { c.data = j; c.ms = j._ms; c.at = Date.now(); after(name, j); }).catch(e => { if (!c.data) c.err = e; }).finally(() => { c.loading = false; paint(name); });
  }
  function after(name, j) {
    if (name === 'census') hzAdd(j.points, 'census');
    if (name === 'births') { hzAdd(j.births, 'births'); autoCheck(); }
  }
  // spinner + elapsed
  const SP = '|/-\\'; let spk = 0;
  setInterval(() => { spk++; $$('[data-spin]').forEach(s => s.textContent = SP[spk % 4]); $$('[data-el]').forEach(b => b.textContent = ((performance.now() - +b.dataset.el) / 1000).toFixed(1) + 's'); }, 110);

  // count up
  function countUp(el, to, fmt, ms = 1300) {
    if (reduce || !isFinite(to)) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const f = t => { const k = Math.min(1, (t - t0) / ms); el.textContent = fmt(to * ease(k)); if (k < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }

  const R = {};
  /* ---- census ---- */
  R.census = (j, el, first) => {
    const rate = j.nullRate, SEG = innerWidth < 600 ? 20 : 32;
    el.innerHTML = `
      <div class="big pr-in">
        <div><div class="n"><span id="cPer">${j.perDay ? '≈' + j.perDay.toLocaleString() : '—'}</span></div><div class="l">graduations a day <span class="mute">· est. from ${j.migrationTxs.toLocaleString()} migrations in ${j.coveredHours}h</span></div></div>
        <div><div class="n"><span id="cRate">${rate == null ? '—' : Math.round(rate * 100) + '%'}</span></div><div class="l">of coins 3+ days old returned null <span class="mute">· sample n=${j.oldSampled}</span></div></div>
      </div>
      <div class="bars">${j.cohorts.map(c => {
        const n = c.sampled, a = n ? Math.round(c.alive / n * SEG) : 0, z = n ? SEG - a : 0;
        const cells = Array.from({ length: SEG }, (_, i) => `<i class="${i < a ? '' : i < a + z ? 'z' : 'o'}"></i>`).join('');
        return `<div class="bar${c.covered && n ? '' : ' off'}"><span class="lb">${esc(c.label)}</span><span class="seg">${cells}</span><span class="ct">${n ? `<b>${c.null}</b>/${n} null` : '—'}</span></div>`;
      }).join('')}</div>
      <div class="foot"><span>(${j.sampled} rows)</span><span>Time: ${msTxt(C.census.ms)}</span><span>measured ${ago(j.updated / 1000)}</span></div>`;
    if (first) {
      if (j.perDay) countUp($('#cPer'), j.perDay, v => '≈' + Math.round(v).toLocaleString());
      if (rate != null) countUp($('#cRate'), rate * 100, v => Math.round(v) + '%');
    }
    $$('.bar', el).forEach((b, bi) => { $$('.seg i', b).forEach((c, ci) => { if (reduce) c.classList.add('on'); else setTimeout(() => c.classList.add('on'), 300 + bi * 110 + ci * 18); }); });
  };

  /* ---- births ---- */
  let lastBirths = new Set();
  R.births = (j, el, first) => {
    const list = j.births || [], prev = lastBirths; lastBirths = new Set(list.map(c => c.mint));
    el.innerHTML = `
      <table class="tbl"><thead><tr><th>coin</th><th>born</th><th class="hide-m">heartbeat</th><th class="r">ttl</th><th class="r hide-m">mcap</th></tr></thead>
      <tbody>${list.map((c, i) => {
        const st = stateOf(c), rate = Math.max(.75, 2.6 - Math.log10((c.txns24 || 0) + 1) * .62);
        return `<tr data-mint="${esc(c.mint)}" class="${!first && !prev.has(c.mint) ? 'new' : ''}" style="${first && !reduce ? `animation:printin .5s steps(12) ${i * 45}ms both` : ''}">
          <td><span class="coin">${av(c)}<b>${esc(tag(c))}</b><em class="hide-m">${esc(c.name || '')}</em></span></td>
          <td class="dim" data-born="${c.bornAt || ''}">${c.bornAt ? dur(nowS() - c.bornAt) : '—'}</td>
          <td class="hide-m"><canvas class="ecg" width="${130 * DPR}" height="${22 * DPR}" data-period="${rate.toFixed(2)}" data-seed="${hashStr(c.mint).toFixed(3)}" data-dead="${st === 'null' ? 1 : 0}"></canvas></td>
          <td class="r ttl" data-last="${c.lastAt || ''}">${c.lastAt ? hms(ttlOf(c)) : '—'}</td>
          <td class="r hide-m">${usd(c.mcap)}</td></tr>`;
      }).join('')}</tbody></table>
      <div class="foot"><span>(${list.length} rows)</span><span>Time: ${msTxt(C.births.ms)}</span><span>\\watch 30s <span class="tick"><i id="watchBar"></i></span></span></div>`;
  };
  $('#birthsRes').addEventListener('click', e => { const r = e.target.closest('tr[data-mint]'); if (r) openRec(r.dataset.mint); });
  setInterval(() => { if (!document.hidden) load('births'); }, 30000);

  // the heartbeat traces
  function ecgY(p) {
    if (p < .08) return 0;
    if (p < .14) return -Math.sin((p - .08) / .06 * Math.PI) * .12;
    if (p < .18) return 0;
    if (p < .20) return (p - .18) / .02 * .15;
    if (p < .225) return .15 - (p - .20) / .025 * 1.15;
    if (p < .25) return -1 + (p - .225) / .025 * 1.3;
    if (p < .28) return .3 - (p - .25) / .03 * .3;
    if (p < .38) return 0;
    if (p < .50) return -Math.sin((p - .38) / .12 * Math.PI) * .22;
    return 0;
  }
  let ecgOn = false, ecgLast = 0;
  new IntersectionObserver(es => { ecgOn = es[0].isIntersecting; }).observe($('#births'));
  function ecgLoop(ts) {
    requestAnimationFrame(ecgLoop);
    if (!ecgOn || document.hidden || ts - ecgLast < 33) return; ecgLast = ts;
    const t = ts / 1000, WIN = 2.6;
    for (const cv of $$('#birthsRes canvas.ecg')) {
      const x = cv.getContext('2d'), w = cv.width, h = cv.height, mid = h * .58, amp = h * .44;
      const period = +cv.dataset.period, seed = +cv.dataset.seed, dead = cv.dataset.dead === '1';
      x.clearRect(0, 0, w, h);
      x.lineWidth = DPR; x.strokeStyle = dead ? '#3a393b' : 'rgba(232,230,225,.75)'; x.beginPath();
      for (let px = 0; px <= w; px += DPR) {
        const tt = t - (1 - px / w) * WIN, ph = ((tt / period + seed) % 1 + 1) % 1;
        const y = dead ? mid + Math.sin(tt * 40 + seed * 9) * .4 : mid + ecgY(ph) * amp;
        px ? x.lineTo(px, y) : x.moveTo(px, y);
      }
      x.stroke();
      if (!dead) { const ph = ((t / period + seed) % 1 + 1) % 1; x.fillStyle = '#fff'; x.fillRect(w - 2 * DPR, mid + ecgY(ph) * amp - DPR, 2 * DPR, 2 * DPR); }
    }
  }
  requestAnimationFrame(ecgLoop);

  /* ---- live clocks ---- */
  setInterval(() => {
    $$('[data-born]').forEach(el => { const b = +el.dataset.born; if (b) el.textContent = dur(nowS() - b); });
    $$('[data-last]').forEach(el => { const l = +el.dataset.last; if (!l) return; const left = Math.max(0, TTL() - (nowS() - l)); el.textContent = hms(left); el.classList.toggle('low', left < 6 * 3600); });
    $$('[data-ring]').forEach(el => { const l = +el.dataset.ring; const left = Math.max(0, TTL() - (nowS() - l)); const t = $('b', el); if (t) t.textContent = hms(left); const fg = $('.fg', el); if (fg) fg.style.strokeDashoffset = (fg._len * (1 - left / TTL())).toFixed(2); });
    const wb = $('#watchBar'); if (wb && C.births.at) wb.style.width = Math.min(100, (Date.now() - C.births.at) / 300) + '%';
  }, 1000);

  /* ---- check + the record ---- */
  const STATE_WORD = { alive: 'alive', null: 'null', declared: 'declared', unknown: 'unknown' };
  function recHtml(c) {
    const st = stateOf(c), T = TTL(), left = ttlOf(c);
    const L = 2 * Math.PI * 46;
    const ring = st === 'alive' ? `<div class="ring" data-ring="${c.lastAt}"><svg viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="46"/><circle class="fg" cx="50" cy="50" r="46" stroke-dasharray="${L.toFixed(2)}" stroke-dashoffset="${L.toFixed(2)}" data-to="${(L * (1 - left / T)).toFixed(2)}"/></svg><span><span><b>${hms(left)}</b><small>ttl</small></span></span></div>`
      : st === 'declared' && c.progress != null ? `<div><div class="prog"><i data-w="${(c.progress * 100).toFixed(1)}"></i></div><div class="born">on the curve <b>${(c.progress * 100).toFixed(1)}%</b>${c.curveSol != null ? ` · ${fsol(c.curveSol)} SOL` : ''}</div></div>` : '';
    const kv = st === 'declared'
      ? [['stage', c.stage === 'graduating' ? 'graduating' : 'bonding curve'], ['last trade', c.lastAt ? ago(c.lastAt) : '—'], ['mcap', usd(c.mcap)]]
      : [[st === 'null' ? 'lived' : 'uptime', c.uptime != null ? dur(c.uptime) : (c.bornAt ? dur((st === 'null' ? c.lastAt : nowS()) - c.bornAt) : '—')], ['last beat', c.lastAt ? ago(c.lastAt) : '—'], ['pool', c.poolSol != null ? fsol(c.poolSol) + ' SOL' : '—'], ['mcap', usd(c.mcap)]];
    const sh = c.shares && c.shares.length ? `<div class="born">${c.onNull ? '<b>born on null</b> · ' : ''}fees split ${c.shares.map(s => (s.bps / 100).toFixed(0) + '%').join(' / ')} · ${c.sharesLocked ? 'locked' : 'editable by creator'}</div>` : '';
    const pic = `<div class="pic"><img src="/i/${esc(c.mint)}.png" alt="">${c.image ? `<img src="${esc(c.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>`;
    return `<div class="rec pr-in">${pic}<div>
      <div class="who"><b>${esc(tag(c))}</b><em>${esc(c.name || '')}</em><a href="https://solscan.io/token/${esc(c.mint)}" target="_blank" rel="noopener">${short(c.mint)}</a></div>
      <div class="statebox"><div class="state ${st}">${STATE_WORD[st] || st}</div>${ring}</div>
      <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
      ${sh}
      <div class="acts">
        ${c.stage === 'assigned' && c.solPool ? `<button class="btn inv" type="button" data-host="${esc(c.mint)}">host it</button>` : ''}
        <a class="btn" href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener">pump.fun</a>
        <a class="btn" href="https://dexscreener.com/solana/${esc(c.stage === 'assigned' ? c.pool : c.mint)}" target="_blank" rel="noopener">chart</a>
        <button class="btn" type="button" data-share="${esc(c.mint)}">share card</button>
      </div></div></div>`;
  }
  function animateRec(el) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('.ring .fg', el).forEach(fg => { fg._len = +fg.getAttribute('stroke-dasharray'); fg.style.strokeDashoffset = fg.dataset.to; });
      $$('.prog i', el).forEach(i => { i.style.width = i.dataset.w + '%'; });
    }));
  }
  const RECS = new Map();
  async function runCheck(id) {
    id = String(id || '').trim(); const el = $('#checkRes');
    if (!isAddr(id)) { el.innerHTML = errHtml('invalid input syntax for type mint: "' + id.slice(0, 50) + '"'); return; }
    const t0 = performance.now(); el.innerHTML = runHtml(t0);
    try {
      const j = await api('check?id=' + encodeURIComponent(id)); RECS.set(j.coin.mint, j.coin);
      el.innerHTML = recHtml(j.coin) + `<div class="foot"><span>(1 row)</span><span>Time: ${msTxt(j._ms)}</span></div>`; animateRec(el);
    } catch (e) { el.innerHTML = errHtml(e); }
  }
  let autoDone = false;
  function autoCheck() {
    if (autoDone || !C.check.typed) return;
    const inp = $('#checkIn'); if (inp.value.trim()) return;
    const first = S.cfg.ca || (C.births.data && C.births.data.births && C.births.data.births[0] && C.births.data.births[0].mint);
    if (!first) return;
    autoDone = true; inp.value = first; runCheck(first);
  }
  function checkPainted() { const el = $('#checkRes'); if (!el.innerHTML.trim()) { el.innerHTML = `<div class="foot" style="margin-top:0"><span>(0 rows)</span></div>`; } autoCheck(); }
  $('#checkGo').addEventListener('click', () => runCheck($('#checkIn').value));
  $('#checkIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runCheck($('#checkIn').value); } });
  $('#checkIn').addEventListener('paste', () => setTimeout(() => { const v = $('#checkIn').value.trim(); if (isAddr(v)) runCheck(v); }, 30));
  document.addEventListener('click', e => {
    const h = e.target.closest('[data-host]'); if (h) { openRec(h.dataset.host, 'add'); return; }
    const s = e.target.closest('[data-share]'); if (s) { shareCard(RECS.get(s.dataset.share) || (S.rec && S.rec.mint === s.dataset.share ? S.rec : null)); }
  });

  /* ---- share card (1200x630, drawn from the same live record) ---- */
  async function shareCard(c) {
    if (!c) return;
    try { await document.fonts.load('700 40px SM'); await document.fonts.load('400 20px SM'); } catch (e) { }
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630; const x = cv.getContext('2d');
    x.fillStyle = '#050505'; x.fillRect(0, 0, 1200, 630);
    const img = new Image(); img.src = `/i/${c.mint}.png`;
    try { await img.decode(); x.drawImage(img, 70, 125, 380, 380); } catch (e) { }
    const st = stateOf(c), word = STATE_WORD[st] || st;
    x.textBaseline = 'alphabetic';
    x.fillStyle = '#e8e6e1'; x.font = '700 34px SM, monospace'; x.fillText(tag(c).slice(0, 18), 510, 175);
    x.fillStyle = '#8b8a86'; x.font = '400 22px SM, monospace'; x.fillText((c.name || '').slice(0, 34), 510, 210);
    x.font = '700 150px SM, monospace';
    const wy = 365;
    if (st === 'null') { x.fillStyle = 'rgba(255,61,87,.55)'; x.fillText(word, 504, wy); x.fillStyle = 'rgba(43,217,255,.5)'; x.fillText(word, 516, wy); x.fillStyle = '#3c3b3d'; x.fillText(word, 510, wy); }
    else if (st === 'declared') { x.strokeStyle = '#c9c7c1'; x.lineWidth = 1.5; x.strokeText(word, 510, wy); }
    else { x.fillStyle = 'rgba(255,61,87,.45)'; x.fillText(word, 506, wy); x.fillStyle = 'rgba(43,217,255,.4)'; x.fillText(word, 514, wy); x.fillStyle = '#e8e6e1'; x.fillText(word, 510, wy); }
    x.font = '400 24px SM, monospace'; x.fillStyle = '#c9c7c1';
    const line = st === 'alive' ? `ttl ${hms(ttlOf(c))}  ·  uptime ${dur(c.uptime || 0)}` : st === 'null' ? `lived ${dur(c.uptime || 0)}  ·  silent ${dur(nowS() - c.lastAt)}` : st === 'declared' ? `on the curve  ·  ${c.progress != null ? (c.progress * 100).toFixed(1) + '%' : ''}` : '';
    x.fillText(line, 510, 430);
    x.fillStyle = '#555456'; x.font = '400 20px SM, monospace'; x.fillText(short(c.mint), 510, 470);
    x.fillStyle = '#8b8a86'; x.fillText('null is not zero.', 70, 580);
    x.textAlign = 'right'; x.fillText(location.host, 1130, 580);
    // grain
    const d = x.getImageData(0, 0, 1200, 630); for (let i = 0; i < d.data.length; i += 4) { const n = (Math.random() - .5) * 14; d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n; } x.putImageData(d, 0, 0);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = `null-${(c.symbol || short(c.mint)).replace(/[^A-Za-z0-9]/g, '')}.png`; document.body.appendChild(a); a.click(); a.remove();
    toast('card saved');
  }

  /* ---------------- wallet (Wallet Standard) ---------------- */
  const W = { list: [], w: null, acct: null };
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      const sol = (w.chains || []).some(c => String(c).startsWith('solana:'));
      const can = w.features['standard:connect'] && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
      if (!sol || !can || W.list.some(x => x.name === w.name)) return;
      W.list.push(w);
      if (!W.w && store.get('null:wallet') === w.name && w.accounts && w.accounts.length) use(w, w.accounts[0]);
      if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const walletApi = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(walletApi); } catch (_) { } });
  try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi })); } catch (_) { }
  function use(w, acct) {
    W.w = w; W.acct = acct; store.set('null:wallet', w.name);
    $('#walletBtn').classList.add('on'); $('#walletLabel').textContent = short(acct.address);
    try { w.features['standard:events'] && w.features['standard:events'].on('change', ({ accounts }) => { if (accounts && W.w === w) { if (accounts.length) use(w, accounts[0]); else disconnect(); } }); } catch (e) { }
    loadPositions(); if (S.rec && S.rec.mint && S.pool && S.pool.pool) loadPool(S.pool.pool, true);
    if (C.launch.typed) renderLaunchBtn();
  }
  function disconnect() {
    try { W.w && W.w.features['standard:disconnect'] && W.w.features['standard:disconnect'].disconnect(); } catch (e) { }
    W.w = null; W.acct = null; store.set('null:wallet', '');
    $('#walletBtn').classList.remove('on'); $('#walletLabel').textContent = 'connect';
    S.positions = null; if (C.host.data) paint('host'); if (S.rec) renderHostBox(); if (C.launch.typed) renderLaunchBtn();
  }
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  function renderWallets() {
    const box = $('#wList');
    $('#wTitle').textContent = W.w ? 'wallet' : 'connect';
    if (W.w) {
      box.innerHTML = `<p>${esc(W.w.name)}<br><code>${esc(W.acct.address)}</code></p><button class="wopt" type="button" id="wCopy">copy address</button><button class="wopt" type="button" id="wOut">disconnect</button>`;
      $('#wCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(W.acct.address).then(() => toast('copied')); };
      $('#wOut').onclick = () => { disconnect(); $('#wModal').hidden = true; toast('disconnected'); };
      return;
    }
    if (!W.list.length) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      box.innerHTML = mobile
        ? `<p>open null inside your wallet's browser:</p><a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Phantom</a><a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Solflare</a>`
        : `<p>no Solana wallet in this browser. install one, then reload:</p><a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener">Phantom</a><a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener">Solflare</a><a class="wopt" href="https://backpack.app/download" target="_blank" rel="noopener">Backpack</a>`;
      return;
    }
    box.innerHTML = W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}<small>detected</small></button>`).join('');
  }
  function connect() { renderWallets(); $('#wModal').hidden = false; }
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt[data-i]'); if (!b) return;
    const w = W.list[+b.dataset.i];
    try {
      b.disabled = true;
      const r = await w.features['standard:connect'].connect();
      const acct = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]);
      if (!acct) throw new Error('no account shared');
      $('#wModal').hidden = true; use(w, acct); toast('connected ' + short(acct.address));
    } catch (err) { toast(err && err.message ? err.message : 'cancelled'); }
    finally { b.disabled = false; }
  });
  $('#walletBtn').addEventListener('click', connect);
  $('#wClose').addEventListener('click', () => { $('#wModal').hidden = true; });
  $('#wModal').addEventListener('click', e => { if (e.target.id === 'wModal') $('#wModal').hidden = true; });
  const needWallet = () => { if (!W.w) { connect(); return true; } return false; };

  async function waitFor(sig) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1300));
      try {
        const s = await api('status?sig=' + sig);
        if (s.err) throw Object.assign(new Error('the transaction failed on-chain.'), { chain: s.err });
        if (s.status === 'confirmed' || s.status === 'finalized') return true;
      } catch (e) { if (e.chain) throw e; }
    }
    throw new Error('not confirmed after 90 seconds. check the link before trying again.');
  }
  // bytes: Uint8Array[] (unsigned or partly signed). step(phase, sigs, index)
  async function signSend(bytes, step) {
    const f = W.w.features, chain = 'solana:mainnet', sigs = [];
    if (bytes.length === 1 && f['solana:signAndSendTransaction']) {
      step('sign', sigs, 0);
      const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes[0], options: { commitment: 'confirmed', preflightCommitment: 'processed', maxRetries: 3 } });
      const sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); sigs.push(sig);
      step('confirm', sigs, 0); await waitFor(sig); return sigs;
    }
    if (f['solana:signTransaction']) {
      step('sign', sigs, 0);
      const outs = await f['solana:signTransaction'].signTransaction(...bytes.map(t => ({ account: W.acct, chain, transaction: t })));
      for (let i = 0; i < outs.length; i++) {
        step('send', sigs, i);
        const { sig } = await api('send', { tx: toB64(outs[i].signedTransaction) }); sigs.push(sig);
        step('confirm', sigs, i); await waitFor(sig);
      }
      return sigs;
    }
    for (let i = 0; i < bytes.length; i++) {
      step('sign', sigs, i);
      const [r] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: bytes[i] });
      const sig = typeof r.signature === 'string' ? r.signature : b58(r.signature); sigs.push(sig);
      step('confirm', sigs, i); await waitFor(sig);
    }
    return sigs;
  }
  const cancelled = e => /reject|denied|cancel|declin/i.test(e && e.message || '');

  /* ---------------- the drawer: one coin's record + hosting ---------------- */
  function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#veil').hidden = false; document.documentElement.style.overflow = 'hidden'; }
  function closeDrawer() { if (S.busy) return; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#veil').hidden = true; document.documentElement.style.overflow = ''; S.rec = null; S.pool = null; }
  $('#dClose').addEventListener('click', closeDrawer); $('#veil').addEventListener('click', closeDrawer);
  addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#wModal').hidden) $('#wModal').hidden = true; else if (S.rec) closeDrawer(); } });

  async function openRec(id, tab) {
    S.rec = { mint: id, loading: true }; S.pool = null; S.tab = tab || 'add'; S.amt = ''; renderDrawer(); openDrawer();
    try {
      const j = await api('check?id=' + encodeURIComponent(id));
      if (!S.rec || S.rec.mint !== id) return;
      S.rec = j.coin; RECS.set(j.coin.mint, j.coin); renderDrawer();
      if (j.coin.stage === 'assigned' && j.coin.solPool) loadPool(j.coin.pool);
    } catch (e) { if (S.rec && S.rec.mint === id) { S.rec = { mint: id, error: e.message }; renderDrawer(); } }
  }
  async function loadPool(pool, quiet) {
    try {
      const j = await api('pool?id=' + encodeURIComponent(pool) + (W.acct ? '&user=' + W.acct.address : ''));
      if (S.rec && S.rec.pool === pool) { S.pool = j.pool; if (!quiet || !S.busy) renderHostBox(); }
    } catch (e) { if (S.rec && S.rec.pool === pool && !quiet) { S.pool = { error: e.message }; renderHostBox(); } }
  }
  function renderDrawer() {
    const c = S.rec, el = $('#dIn'); if (!c) return;
    if (c.loading) { el.innerHTML = `<div class="q" style="margin-top:6px"><span class="pr">null=#</span> <code class="sql"><span class="k">SELECT</span> * <span class="k">FROM</span> coins <span class="k">WHERE</span> mint = <span class="s">'${short(c.mint)}'</span>;</code></div><div class="res">${runHtml(performance.now())}</div>`; return; }
    if (c.error) { el.innerHTML = `<div class="res">${errHtml(c.error)}</div>`; return; }
    el.innerHTML = recHtml(c) + `<div id="hostBox"></div>`; animateRec(el);
    renderHostBox();
  }
  function renderHostBox() {
    const box = $('#hostBox'), c = S.rec; if (!box || !c) return;
    if (!(c.stage === 'assigned' && c.solPool)) { box.innerHTML = ''; return; }
    if (!S.pool) { box.innerHTML = `<div class="res">${runHtml(performance.now())}</div>`; return; }
    if (S.pool.error) { box.innerHTML = `<div class="res">${errHtml(S.pool.error)}</div>`; return; }
    const p = S.pool, you = p.you, has = you && BigInt(you.lp || '0') > 0n, f = p.feeBps || { lp: p.lpBps, protocol: 0, creator: 0 };
    box.innerHTML = `
      <div class="tabs"><button type="button" data-t="add" class="${S.tab === 'add' ? 'on' : ''}">host</button><button type="button" data-t="remove" class="${S.tab === 'remove' ? 'on' : ''}">withdraw</button></div>
      <div class="prev" style="margin:0 0 14px">
        <div><span>every trade pays the pool's hosts</span><b>${(f.lp / 100).toFixed(2)}%</b></div>
        <div><span>24h volume · pool</span><b>${p.volSol ? compact(p.volSol) + ' SOL' : '—'} · ${compact(p.tvlSol)} SOL</b></div>
        ${has ? `<div class="hi"><span>your position</span><b>${fsol(you.valueSol)} SOL · ${pctTxt(you.share, 3)}</b></div>` : ''}
      </div>
      <div id="pane"></div><div class="status" id="hSt"></div>`;
    $$('.tabs button', box).forEach(b => b.onclick = () => { if (S.busy) return; S.tab = b.dataset.t; renderHostBox(); });
    S.tab === 'remove' ? paneRemove(p) : paneAdd(p);
  }
  function estimate(p, solIn) {
    try {
      const lamports = BigInt(Math.floor(solIn * 1e9)); if (lamports <= 0n) return null;
      const fee = BigInt(S.cfg.hostFeeBps || 0); const jug = lamports * fee / 10000n; const budget = lamports - jug;
      const Rb = BigInt(p.reserves.coin), Rq = BigInt(p.reserves.solLamports), L = BigInt(p.lpSupply), vq = BigInt(p.reserves.vqr || '0');
      const f = p.feeBps, cd = (a, b) => (a + b - 1n) / b;
      const cost = b => { const q = cd((Rq + vq) * b, Rb - b); const g = bp => cd(q * BigInt(bp), 10000n); return { q, lf: g(f.lp), t: q + g(f.lp) + g(f.protocol) + g(f.creator) }; };
      let lo = 0n, hi = Rb / 2n;
      for (let i = 0; i < 90 && hi - lo > 1n; i++) { const m = (lo + hi) / 2n, c = cost(m); if (c.t >= budget) { hi = m; continue; } const D = budget - c.t; if (m * (Rq + c.q + c.lf) < D * (Rb - m)) lo = m; else hi = m; }
      const c = cost(lo), D = budget - c.t, Rq2 = Rq + c.q + c.lf, Rb2 = Rb - lo;
      let lp = lo * L / Rb2; const lq = D * L / Rq2; if (lq < lp) lp = lq;
      const share = Number(lp) / Number(L + lp);
      return { jug: Number(jug) / 1e9, swap: Number(c.t) / 1e9, coin: Number(lo), dep: Number(D) / 1e9, share, value: share * 2 * Number(Rq2 + D) / 1e9, day: share * p.volSol * p.lpBps / 10000 };
    } catch (e) { return null; }
  }
  const chipsHtml = (id, vals, on, unit) => `<div class="chips" id="${id}">${vals.map(v => `<button class="chip ${on === v ? 'on' : ''}" type="button" data-v="${v}">${v}${unit}</button>`).join('')}</div>`;
  function paneAdd(p) {
    const bal = p.you ? p.you.sol : null, sym = p.symbol ? '$' + p.symbol : 'the coin';
    $('#pane').innerHTML = `
      <div class="field"><div class="r1"><span>you put in</span>${bal != null ? `<button type="button" id="hMax">balance ${fsol(bal)} SOL</button>` : ''}</div>
        <div class="r2"><input id="hAmt" inputmode="decimal" placeholder="0.0" aria-label="SOL amount" value="${esc(S.amt)}"><span class="u">SOL</span></div></div>
      ${chipsHtml('hQuick', [0.1, 0.5, 1, 5], null, ' SOL')}
      <div class="slip"><span>max price move</span>${chipsHtml('hSlip', [1, 2, 5], S.slip, '%')}</div>
      <div class="prev" id="hPrev"></div>
      <button class="btn inv goB" id="hGo" type="button">${W.w ? 'host it' : 'connect wallet'}</button>
      <p class="fine">half is swapped for ${esc(sym)}, both sides go into the pool. LP tokens go to your wallet. a deposit is a heartbeat.</p>`;
    const amt = $('#hAmt');
    const upd = () => {
      S.amt = amt.value; const v = parseFloat(amt.value.replace(',', '.')); const e = v > 0 ? estimate(p, v) : null; const dec = p.decimals || 6;
      $('#hPrev').innerHTML = e ? `
        ${e.jug ? `<div><span>host fee</span><b>${fsol(e.jug, 4)} SOL</b></div>` : ''}
        <div><span>swapped</span><b>${fsol(e.swap)} SOL → ${compact(e.coin / Math.pow(10, dec))} ${esc(sym)}</b></div>
        <div><span>into the pool</span><b>${fsol(e.dep)} SOL + ${compact(e.coin / Math.pow(10, dec))}</b></div>
        <div><span>your share</span><b>${pctTxt(e.share, 3)}</b></div>
        <div class="hi"><span>fees at the last 24h pace</span><b>${p.volSol ? '≈ ' + fsol(e.day) + ' SOL / day' : '—'}</b></div>
        <div><span>if ${esc(sym)} halves</span><b>position ≈ ${fsol(e.value * Math.SQRT1_2)} SOL before fees</b></div>` : '';
    };
    amt.addEventListener('input', upd); upd();
    $('#hQuick').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; amt.value = b.dataset.v; upd(); };
    $('#hSlip').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.slip = +b.dataset.v; $$('#hSlip .chip').forEach(x => x.classList.toggle('on', x === b)); };
    const mx = $('#hMax'); if (mx) mx.onclick = () => { amt.value = Math.max(0, bal - 0.012).toFixed(3); upd(); };
    $('#hGo').onclick = async () => {
      if (needWallet()) return;
      const v = parseFloat(amt.value.replace(',', '.'));
      if (!(v >= 0.01)) { toast('at least 0.01 SOL'); amt.focus(); return; }
      await hostRun('add', { kind: 'add', pool: p.pool, user: W.acct.address, sol: v, slippage: S.slip }, q => `adds ${fsol(q.depositSol)} SOL + ${compact(coinAmt(q.depositCoin, q.decimals))} ${esc(sym)} · ${pctTxt(q.share, 3)} of the pool`);
    };
  }
  function paneRemove(p) {
    const you = p.you, has = you && BigInt(you.lp || '0') > 0n, sym = p.symbol ? '$' + p.symbol : 'the coin';
    if (!W.w || !has) {
      $('#pane').innerHTML = W.w ? `<div class="foot" style="margin-top:4px"><span>(0 rows) no position in this pool.</span></div>` : `<button class="btn inv goB" id="hCw" type="button">connect wallet</button>`;
      const cw = $('#hCw'); if (cw) cw.onclick = connect; return;
    }
    $('#pane').innerHTML = `
      ${chipsHtml('hPcts', [25, 50, 75, 100], S.pct, '%')}
      <label class="toggle"><span>all back as SOL</span><input type="checkbox" id="hToSol" ${S.toSol ? 'checked' : ''}></label>
      <div class="slip"><span>max price move</span>${chipsHtml('hSlip', [1, 2, 5], S.slip, '%')}</div>
      <div class="prev" id="hPrev"></div>
      <button class="btn inv goB" id="hRm" type="button">withdraw</button>
      <p class="fine">withdrawals are free. network fees only.</p>`;
    const upd = () => {
      const fr = S.pct / 100, dec = p.decimals || 6, coin = coinAmt(you.coinInPool, dec) * fr, solv = you.solInPool * fr;
      $('#hPrev').innerHTML = S.toSol
        ? `<div><span>from the pool</span><b>${fsol(solv)} SOL + ${compact(coin)} ${esc(sym)}</b></div><div class="hi"><span>you get about</span><b>${fsol(solv * 2 * (1 - p.totalBps / 10000))} SOL</b></div>`
        : `<div class="hi"><span>you get about</span><b>${fsol(solv)} SOL + ${compact(coin)}</b></div>`;
    };
    upd();
    $('#hPcts').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.pct = +b.dataset.v; $$('#hPcts .chip').forEach(x => x.classList.toggle('on', x === b)); upd(); };
    $('#hToSol').onchange = e => { S.toSol = e.target.checked; upd(); };
    $('#hSlip').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; S.slip = +b.dataset.v; $$('#hSlip .chip').forEach(x => x.classList.toggle('on', x === b)); };
    $('#hRm').onclick = () => hostRun('remove', { kind: 'remove', pool: p.pool, user: W.acct.address, pct: S.pct, toSol: S.toSol, slippage: S.slip }, q => q.toSol ? `withdraws ${q.pct}% and sells the coin side: about ${fsol(q.solOut + q.sellSol)} SOL` : `withdraws ${q.pct}%: about ${fsol(q.solOut)} SOL + ${compact(coinAmt(q.coinOut, q.decimals))} ${esc(sym)}`);
  }
  function stepsHtml(list, cur, err, extra) {
    return `<ol class="steps">${list.map((t, i) => `<li class="${i < cur ? 'done' : i === cur ? (err ? 'fail' : 'now') : ''}">[${i < cur ? 'x' : i === cur ? (err ? '!' : '<span data-spin>|</span>') : ' '}] ${t}</li>`).join('')}</ol>${extra || ''}`;
  }
  const solscan = (sigs, labels) => sigs.map((s, i) => `<a href="https://solscan.io/tx/${s}" target="_blank" rel="noopener">${labels ? labels[i] : 'tx ' + (i + 1)}</a>`).join(' · ');
  async function hostRun(kind, body, describe) {
    if (S.busy) return; S.busy = true;
    const st = $('#hSt'), btn = $(kind === 'add' ? '#hGo' : '#hRm'); if (btn) btn.disabled = true;
    const list = ['build + simulate', 'sign in wallet', 'confirm on Solana'];
    let line = '', sigs = [], cur = 0;
    const draw = err => { st.className = 'status show' + (err ? ' e' : ''); st.innerHTML = (line ? `<div>${line}</div>` : '') + (cur < 3 ? stepsHtml(list, cur, err) : `<div class="ok"><b>${kind === 'add' ? 'UPDATE 1 · you host this coin.' : 'DELETE 1 · withdrawn.'}</b></div>`) + (err ? `<div>${esc(err.message || err)}</div>${err.logs ? `<pre class="logs">${esc(err.logs.join('\n'))}</pre>` : ''}` : '') + (sigs.length ? `<div style="margin-top:6px">${solscan(sigs)}</div>` : ''); };
    try {
      draw();
      const r = await api('tx', body);
      line = describe(r.quote) + (r.txs.length > 1 ? ' · two transactions' : ''); cur = 1; draw();
      await signSend(r.txs.map(t => fromB64(t.tx)), (ph, s) => { sigs = s.slice(); cur = ph === 'sign' ? 1 : 2; draw(); });
      cur = 3; draw(); toast(kind === 'add' ? 'hosted.' : 'withdrawn.');
      setTimeout(() => { if (S.rec && S.rec.pool) loadPool(S.rec.pool, true); loadPositions(); }, 1500);
    } catch (e) { draw(cancelled(e) ? new Error('cancelled in the wallet. nothing was sent.') : e); }
    finally { S.busy = false; if (btn) btn.disabled = false; }
  }

  /* ---- host cell: the pools ---- */
  const HKEY = { fees: p => p.milkPerSolDay, pool: p => p.tvlSol, vol: p => p.volSol };
  R.host = (j, el) => {
    const all = (j.pools || []).slice().sort((a, b) => HKEY[S.hostSort](b) - HKEY[S.hostSort](a));
    const list = S.hostAll ? all : all.slice(0, 12), top = Math.max(...all.map(p => p.milkPerSolDay), 1e-9);
    el.innerHTML = `
      ${W.w ? `<div class="yours" id="yours">${yoursHtml()}</div>` : ''}
      <table class="tbl"><thead><tr><th>coin</th><th class="r sort ${S.hostSort === 'pool' ? 'on' : ''}" data-s="pool">pool</th><th class="r sort hide-m ${S.hostSort === 'vol' ? 'on' : ''}" data-s="vol">24h vol</th><th class="sort ${S.hostSort === 'fees' ? 'on' : ''}" data-s="fees">fees / day per SOL</th><th></th></tr></thead>
      <tbody>${list.map((p, i) => `<tr data-host="${esc(p.mint)}" style="${!reduce ? `animation:printin .45s steps(10) ${Math.min(i, 14) * 35}ms both` : ''}">
        <td><span class="coin">${av(p)}<b>${esc(tag(p))}</b><em class="hide-m">${esc(p.name || '')}</em></span></td>
        <td class="r">${compact(p.tvlSol)} SOL</td>
        <td class="r hide-m">${compact(p.volSol)} SOL</td>
        <td><span class="mb" style="width:${Math.max(3, Math.round(p.milkPerSolDay / top * 90))}px"></span>${pctTxt(p.milkPerSolDay)}</td>
        <td class="r"><span class="dim">host →</span></td></tr>`).join('')}</tbody></table>
      ${all.length > 12 ? `<button class="more" type="button" id="hostMore">${S.hostAll ? 'show 12' : `show all ${all.length}`}</button>` : ''}
      <div class="foot"><span>UPDATE ${all.length}</span><span>Time: ${msTxt(C.host.ms)}</span><span class="dim">fees = last 24h volume × the LP share of each trade ÷ pool size. past pace, not a promise.</span></div>`;
    $$('th.sort', el).forEach(th => th.onclick = () => { S.hostSort = th.dataset.s; R.host(j, el); });
    const m = $('#hostMore', el); if (m) m.onclick = () => { S.hostAll = !S.hostAll; R.host(j, el); };
  };
  function yoursHtml() {
    if (S.positions == null) return runHtml(performance.now());
    if (S.positions.error) return errHtml(S.positions.error);
    if (!S.positions.length) return `<div class="foot" style="margin-top:0"><span>(0 rows) you host nothing yet.</span></div>`;
    return `<h4>yours</h4><table class="tbl"><tbody>${S.positions.map(p => `<tr data-host="${esc(p.mint)}"><td><span class="coin">${av(p)}<b>${esc(tag(p))}</b></span></td><td class="r">${fsol(p.valueSol)} SOL</td><td class="r hide-m">${pctTxt(p.share, 3)}</td><td class="r">${p.volSol ? '≈ ' + fsol(p.milkDaySol) + ' / day' : '—'}</td></tr>`).join('')}</tbody></table>`;
  }
  async function loadPositions() {
    if (!W.w) return;
    S.positions = null; const y = $('#yours'); if (y) y.innerHTML = yoursHtml(); else if (C.host.data && C.host.typed) paint('host');
    try { const j = await api('positions?user=' + W.acct.address); S.positions = j.positions; } catch (e) { S.positions = { error: e.message }; }
    const y2 = $('#yours'); if (y2) y2.innerHTML = yoursHtml(); else if (C.host.data && C.host.typed) paint('host');
  }

  /* ---------------- launch ---------------- */
  let w3p = null;
  function web3() {
    if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
    return w3p || (w3p = new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/js/web3.min.js'; s.async = true; s.onload = () => res(window.solanaWeb3); s.onerror = () => { w3p = null; rej(new Error('could not load the signer')); }; document.head.appendChild(s); }));
  }
  new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { o.disconnect(); web3().then(() => { if (!S.kp) newMint(); }).catch(() => { }); } }, { rootMargin: '900px 0px' }).observe($('#launch'));

  // the sigil: the same picture the server serves at /i/<mint>.png
  async function sigilData(mintS) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('null:' + mintS)));
    const cells = []; let bit = 0;
    for (let y = 0; y < 11; y++) for (let x = 0; x <= 5; x++) { const on = (h[(bit >> 3) % 32] >> (bit & 7)) & 1; bit++; if (on && Math.hypot(x - 5, y - 5) < 5.6) { cells.push([x, y]); cells.push([10 - x, y]); } }
    return { h, cells };
  }
  function sigilBase(x, h) {
    const N = 512, img = x.createImageData(N, N), d = img.data;
    for (let i = 0; i < N * N; i++) { const v = 7 + ((h[i % 32] ^ ((i * 2654435761) >>> 24)) & 7); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    for (let y = 0; y < N; y++) for (let xx = 0; xx < N; xx++) { const dd = Math.hypot(xx - 256, y - 256); if (dd > 193 && dd < 207) { const o = (y * N + xx) * 4, v = dd > 197 && dd < 203 ? [232, 230, 225] : [70, 70, 72]; d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; } }
    return img;
  }
  let sigTok = 0;
  async function drawSigil(cv, mintS) {
    const tok = ++sigTok, { h, cells } = await sigilData(mintS);
    const off = document.createElement('canvas'); off.width = off.height = 512; const ox = off.getContext('2d'); const base = sigilBase(ox, h);
    const x = cv.getContext('2d'); cv.width = cv.height = 512;
    const real = new Set(cells.map(([a, b]) => a + ',' + b));
    const frame = k => {
      ox.putImageData(base, 0, 0); ox.fillStyle = '#e8e6e1';
      for (let gy = 0; gy < 11; gy++) for (let gx = 0; gx < 11; gx++) {
        if (Math.hypot(gx - 5, gy - 5) >= 5.6) continue;
        const isOn = real.has(gx + ',' + gy);
        const show = k >= 1 ? isOn : (Math.random() < (isOn ? .35 + k * .65 : .45 * (1 - k)));
        if (show) ox.fillRect(157 + gx * 18 + 2, 157 + gy * 18 + 2, 14, 14);
      }
      x.drawImage(off, 0, 0);
    };
    if (reduce) { frame(1); return; }
    const t0 = performance.now();
    const loop = t => { if (tok !== sigTok) return; const k = Math.min(1, (t - t0) / 900); frame(k); if (k < 1) setTimeout(() => requestAnimationFrame(loop), 45); };
    requestAnimationFrame(loop);
  }
  async function newMint() {
    try {
      const w3 = await web3(); S.kp = w3.Keypair.generate();
      const m = S.kp.publicKey.toBase58(); const t = $('#mintTxt'); if (t) t.textContent = m;
      const cv = $('#sig'); if (cv) drawSigil(cv, m);
    } catch (e) { const t = $('#mintTxt'); if (t) t.textContent = e.message; }
  }
  let launchDrawn = false;
  function renderLaunch() {
    if (launchDrawn) return; launchDrawn = true;
    const sh = S.cfg.shares || { creator: 6000, pool: 3000, void: 1000 }, P = v => (v / 100).toFixed(0) + '%';
    $('#launchRes').innerHTML = `
      <div class="lgrid pr-in">
        <div><canvas class="sig" id="sig" width="512" height="512" aria-label="this coin's sigil"></canvas>
          <div class="mintline"><code id="mintTxt">${S.kp ? S.kp.publicKey.toBase58() : 'generating mint…'}</code><button type="button" id="reroll">new</button></div></div>
        <div>
          <svg class="split" viewBox="0 0 560 220" aria-label="creator fee split">
            <rect x="0" y="92" width="118" height="36"/><text x="12" y="115">creator fee</text>
            <path d="M118 110 C 200 110, 200 30, 280 30"/><path class="flow" d="M118 110 C 200 110, 200 30, 280 30"/>
            <path d="M118 110 L 280 110"/><path class="flow f2" d="M118 110 L 280 110"/>
            <path d="M118 110 C 200 110, 200 190, 280 190"/><path class="flow f3" d="M118 110 C 200 110, 200 190, 280 190"/>
            <text class="p" x="292" y="38">${P(sh.creator)}</text><text x="368" y="30">you</text><text class="d" x="368" y="46">the creator</text>
            <text class="p" x="292" y="118">${P(sh.pool)}</text><text x="368" y="110">this coin's treasury</text><text class="d" x="368" y="126">back into its own pool</text>
            <text class="p" x="292" y="198">${P(sh.void)}</text><text x="368" y="190">the void</text><text class="d" x="368" y="206">buys $NULL and burns it</text>
          </svg>
          <div class="split-m">${[[sh.creator, 'you', 'the creator'], [sh.pool, "this coin's treasury", 'back into its own pool'], [sh.void, 'the void', 'buys $NULL and burns it']].map(([v, a, b]) => `<div><b>${P(v)}</b><span>${a}<small>${b}</small></span></div>`).join('')}</div>
          <div class="dev"><span>dev buy</span>${[0, 0.25, 0.5, 1, 2].map(v => `<button class="chip ${S.dev === v ? 'on' : ''}" type="button" data-v="${v}">${v}</button>`).join('')}<input id="devIn" inputmode="decimal" placeholder="SOL" aria-label="dev buy in SOL"></div>
          <div class="lgo"><button class="btn inv xl" id="lGo" type="button">INSERT</button><span class="lnote" id="lNote"></span></div>
          <div id="lOut"></div>
        </div>
      </div>`;
    if (S.kp) drawSigil($('#sig'), S.kp.publicKey.toBase58()); else web3().then(() => { if (!S.kp) newMint(); }).catch(e => { $('#mintTxt').textContent = e.message; });
    $('#reroll').onclick = () => { if (!S.busy) newMint(); };
    $('.dev').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; S.dev = +b.dataset.v; $('#devIn').value = ''; $$('.dev .chip').forEach(x => x.classList.toggle('on', x === b)); });
    $('#devIn').addEventListener('input', e => { const v = parseFloat(e.target.value.replace(',', '.')); S.dev = v > 0 ? Math.min(10, v) : 0; $$('.dev .chip').forEach(x => x.classList.toggle('on', !e.target.value && +x.dataset.v === S.dev)); });
    $('#lGo').onclick = doLaunch;
    renderLaunchBtn();
  }
  function renderLaunchBtn() {
    const b = $('#lGo'), n = $('#lNote'); if (!b) return;
    if (!S.cfg.launch) { b.disabled = true; n.textContent = 'launches open when the void wallet is set. everything else here is live.'; return; }
    b.disabled = false; n.textContent = W.w ? `≈ 0.03 SOL in rent and fees${S.dev ? ' + the dev buy' : ''}. you sign every transaction.` : 'connect a wallet to launch.';
  }
  async function doLaunch() {
    if (S.busy) return;
    if (!S.cfg.launch) { renderLaunchBtn(); return; }
    if (needWallet()) return;
    const name = $('#lName').value.trim(), symbol = $('#lSym').value.trim().replace(/^\$/, '').toUpperCase();
    const outEl = $('#lOut');
    if (!/^[\x20-\x7E]{1,32}$/.test(name)) { outEl.innerHTML = errHtml('name: 1–32 plain characters'); $('#lName').focus(); return; }
    if (!/^[A-Za-z0-9$]{1,10}$/.test(symbol)) { outEl.innerHTML = errHtml('ticker: 1–10 letters or numbers'); $('#lSym').focus(); return; }
    if (!S.kp) { await newMint(); if (!S.kp) return; }
    S.busy = true; $('#lGo').disabled = true;
    const list = ['build + simulate', 'sign in wallet', 'create the coin', 'write the fee split'].concat(S.dev ? ['dev buy'] : []);
    let cur = 0, sigs = [];
    const draw = (err, okHtml) => { outEl.innerHTML = okHtml || (stepsHtml(list, cur, err) + (err ? `<div class="err" style="margin-top:8px">${esc(err.message || err)}</div>${err.logs ? `<pre class="logs">${esc(err.logs.join('\n'))}</pre>` : ''}` : '') + (sigs.length ? `<div class="foot">${solscan(sigs, ['create', 'split', 'buy'])}</div>` : '')); };
    try {
      draw();
      const kp = S.kp, mint = kp.publicKey.toBase58();
      const r = await api('launch', { user: W.acct.address, mint, name, symbol, devSol: S.dev });
      const w3 = await web3();
      const txs = r.txs.map(t => w3.VersionedTransaction.deserialize(fromB64(t.tx)));
      txs[0].sign([kp]);
      cur = 1; draw();
      await signSend(txs.map(t => t.serialize()), (ph, s, i) => { sigs = s.slice(); cur = ph === 'sign' ? 1 : 2 + (i || 0); draw(); });
      cur = list.length;
      draw(null, `<div class="ok pr-in"><b>INSERT 0 1</b></div>
        <div class="kv"><div><span>mint</span><b>${esc(mint)}</b></div></div>
        <div class="acts"><a class="btn inv" href="https://pump.fun/coin/${esc(mint)}" target="_blank" rel="noopener">open on pump.fun</a><button class="btn" type="button" data-copy="${esc(location.origin + '/?c=' + mint)}">copy link</button><button class="btn" type="button" id="lCheck">check it</button></div>
        <div class="foot">${solscan(sigs, ['create', 'split', 'buy'])}</div>`);
      $('#lCheck').onclick = () => openRec(mint);
      toast('born on null.'); S.kp = null; newMint(); setTimeout(() => { C.void.data = null; load('void'); }, 4000);
    } catch (e) { draw(cancelled(e) ? new Error('cancelled in the wallet. nothing was sent.') : e); }
    finally { S.busy = false; renderLaunchBtn(); }
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy).then(() => toast('copied')); });
  $('#lSym').addEventListener('input', e => { const p = e.target.selectionStart; e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9$]/g, ''); try { e.target.setSelectionRange(p, p); } catch (_) { } });

  /* ---------------- the void ---------------- */
  R.void = (j, el) => {
    const L = j.launches || [], alive = L.filter(c => stateOf(c) === 'alive').length;
    el.innerHTML = `<div class="pr-in"><div class="vnum${j.void ? '' : ' nil'}">${j.void ? fsol(j.void.sol) : 'null'}</div><div class="vlb">${j.void ? 'SOL in the void' : 'the void is not open yet'}</div></div>`;
    let below = $('#voidList'); if (!below) { below = document.createElement('div'); below.id = 'voidList'; $('#voidRes').after(below); }
    below.innerHTML = `
      <div class="vrow reveal shown">
        <div><div class="vnum">${j.nullToken ? compact(j.nullToken.burned) : '—'}</div><div class="vlb">$NULL burned</div></div>
        <div><div class="vnum">${L.length}</div><div class="vlb">born on null</div></div>
        <div><div class="vnum">${alive}</div><div class="vlb">still alive</div></div>
      </div>
      ${j.void ? `<div class="vaddr" style="text-align:center">void <a href="https://solscan.io/account/${esc(j.void.address)}" target="_blank" rel="noopener">${esc(j.void.address)}</a></div>` : ''}
      <div class="launched">${L.length ? `<table class="tbl"><thead><tr><th>coin</th><th>born</th><th>state</th><th class="r">ttl</th></tr></thead><tbody>${L.map(c => `<tr data-mint="${esc(c.mint)}"><td><span class="coin">${av(c)}<b>${esc(tag(c))}</b><em class="hide-m">${esc(c.name || '')}</em></span></td><td class="dim" data-born="${c.launchedAt || ''}">${c.launchedAt ? dur(nowS() - c.launchedAt) : '—'}</td><td><span class="st ${stateOf(c)}">${stateOf(c)}</span></td><td class="r ttl" ${c.lastAt ? `data-last="${c.lastAt}"` : ''}>${c.lastAt ? hms(ttlOf(c)) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}
      <div class="foot"><span>(${L.length} rows)</span><span>Time: ${msTxt(C.void.ms)}</span></div></div>`;
    $$('tr[data-mint]', below).forEach(r => r.onclick = () => openRec(r.dataset.mint));
    VX.coins = L.map(c => ({ seed: hashStr(c.mint), dead: stateOf(c) === 'null' }));
  };
  const VX = { cv: $('#vortex'), on: false, ps: [], coins: [] };
  (() => {
    const cv = VX.cv, x = cv.getContext('2d'); let w = 0, h = 0, R0 = 0;
    const size = () => { const r = cv.getBoundingClientRect(); w = r.width; h = r.height; cv.width = Math.round(w * DPR); cv.height = Math.round(h * DPR); R0 = Math.min(w, h) * (w < 700 ? 0.27 : 0.17); x.setTransform(DPR, 0, 0, DPR, 0, 0); x.fillStyle = '#050505'; x.fillRect(0, 0, w, h); };
    const N = innerWidth < 700 ? 320 : 760;
    const spawn = (p, fresh) => { p.a = Math.random() * Math.PI * 2; p.r = (fresh ? Math.random() : .85 + Math.random() * .15) * Math.hypot(w, h) * .55 + R0; p.s = .4 + Math.random() * 1.2; p.b = .25 + Math.random() * .75; return p; };
    size(); for (let i = 0; i < N; i++) VX.ps.push(spawn({}, true));
    addEventListener('resize', size);
    new IntersectionObserver(es => { VX.on = es[0].isIntersecting; }).observe(cv);
    let last = 0;
    const loop = ts => {
      requestAnimationFrame(loop);
      if (!VX.on || document.hidden) { last = ts; return; }
      const dt = Math.min(50, ts - last || 16) / 16; last = ts;
      const cx = w / 2, cy = h / 2;
      x.fillStyle = 'rgba(5,5,5,.16)'; x.fillRect(0, 0, w, h);
      for (const p of VX.ps) {
        const pull = (1.2 + 260 / p.r) * p.s * .45 * dt;
        p.r -= pull; p.a += (.9 / Math.sqrt(p.r)) * .16 * dt * p.s;
        if (p.r < R0) { spawn(p); continue; }
        const px = cx + Math.cos(p.a) * p.r, py = cy + Math.sin(p.a) * p.r * .62;
        const near = Math.max(0, 1 - (p.r - R0) / (Math.min(w, h) * .5));
        x.fillStyle = `rgba(232,230,225,${(.15 + near * .75) * p.b})`;
        x.fillRect(px, py, near > .7 ? 1.6 : 1, near > .7 ? 1.6 : 1);
      }
      // coins born on null: alive ones orbit, null ones fall in
      VX.coins.forEach((c, i) => {
        c.a = (c.a == null ? c.seed * 6.28 : c.a) + .004 * dt; c.r = c.r == null ? R0 * (2 + c.seed * 1.4) : c.dead ? Math.max(R0 * .2, c.r - .25 * dt) : c.r;
        const px = cx + Math.cos(c.a) * c.r, py = cy + Math.sin(c.a) * c.r * .62;
        if (c.dead) { x.strokeStyle = 'rgba(139,138,134,.7)'; x.strokeRect(px - 3, py - 3, 6, 6); } else { x.fillStyle = '#fff'; x.fillRect(px - 2.5, py - 2.5, 5, 5); }
      });
      // the horizon
      x.fillStyle = '#050505'; x.beginPath(); x.ellipse(cx, cy, R0, R0 * .62 + R0 * .38, 0, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(232,230,225,.55)'; x.lineWidth = 1; x.beginPath(); x.ellipse(cx, cy, R0 + 1, R0 + 1, 0, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = 'rgba(255,61,87,.25)'; x.beginPath(); x.ellipse(cx - 1.5, cy, R0 + 3, R0 + 3, 0, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = 'rgba(43,217,255,.22)'; x.beginPath(); x.ellipse(cx + 1.5, cy, R0 + 3, R0 + 3, 0, 0, Math.PI * 2); x.stroke();
    };
    requestAnimationFrame(loop);
  })();

  /* ---------------- man null ---------------- */
  let manDrawn = false;
  function renderMan() {
    if (manDrawn) return; manDrawn = true;
    const sh = S.cfg.shares || { creator: 6000, pool: 3000, void: 1000 }, P = v => (v / 100).toFixed(0) + '%', ttl = S.cfg.ttlHours || 72;
    const ca = S.cfg.ca, studio = S.cfg.studio, xh = S.cfg.x ? (String(S.cfg.x).startsWith('http') ? S.cfg.x : 'https://x.com/' + String(S.cfg.x).replace(/^@/, '')) : '';
    $('#manRes').innerHTML = `<div class="man pr-in">
      <div class="hd"><span>NULL(1)</span><span class="hide-m">General Commands Manual</span><span>NULL(1)</span></div>
      <h5>NAME</h5><p>null - a launchpad where a coin lives only while it trades</p>
      <h5>SYNOPSIS</h5><p>declare → graduate → trade | <b>return null</b></p>
      <h5>DESCRIPTION</h5>
      <p>A coin is <b>declared</b> on its pump.fun curve and <b>assigned</b> when it graduates to PumpSwap. It is <b>alive</b> while its pool keeps moving. ${ttl} hours without a single transaction on the pool and it <b>returns null</b>.</p>
      <p>Any transaction on the pool is a heartbeat: a buy, a sell, a deposit. Hosting a coin, adding liquidity to its pool, keeps it beating and pays you its LP fees.</p>
      <h5>FEES</h5>
      <p>Coins born here split their creator fee on-chain with pump.fun fee sharing, written at birth:</p>
      <div class="t"><span>${P(sh.creator)}</span><span>the creator</span><span>${P(sh.pool)}</span><span>the coin's own treasury, put back into its pool</span><span>${P(sh.void)}</span><span>the void, which buys $NULL and burns it</span></div>
      <h5>FILES</h5>
      <div class="t"><span>$NULL</span><span>${ca ? `<a href="https://pump.fun/coin/${esc(ca)}" target="_blank" rel="noopener"><code>${esc(ca)}</code></a>` : 'not yet'}</span><span>studio</span><span>${studio ? `<code>${esc(studio)}</code>` : 'not set'}</span><span>migrator</span><span><a href="https://solscan.io/account/39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg" target="_blank" rel="noopener"><code>39azUYFW…UJjg</code></a> pump.fun</span></div>
      <h5>SEE ALSO</h5><p><a href="https://pump.fun" target="_blank" rel="noopener">pump.fun(1)</a>, <a href="https://swap.pump.fun" target="_blank" rel="noopener">pumpswap(1)</a>, <a href="https://dexscreener.com/solana" target="_blank" rel="noopener">dexscreener(1)</a>${xh ? `, <a href="${esc(xh)}" target="_blank" rel="noopener">x(1)</a>` : ''}</p>
      <h5>BUGS</h5>
      <p>The census is a measured sample, not every coin. Fee shares wait in their treasuries until the studio runs the cycle. Not financial advice.</p>
      <p>null is not zero.</p>
    </div>`;
  }

  /* ---------------- start ---------------- */
  async function loadConfig() { try { const j = await api('config'); S.cfg = Object.assign(S.cfg, j); } catch (e) { } }
  ['census', 'births', 'host', 'void'].forEach(n => load(n));
  loadConfig().then(() => { if (C.launch.typed) renderLaunchBtn(); autoCheck(); });
  const qc = new URLSearchParams(location.search).get('c') || (isAddr(location.hash.slice(1)) ? location.hash.slice(1) : '');
  if (isAddr(qc)) setTimeout(() => openRec(qc), 600);
})();
