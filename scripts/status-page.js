#!/usr/bin/env node
// Writes work/status/index.html: every milestone card's status, open bugs and the Later list, read
// from docs/TODO.md, docs/BUGS.md, docs/DEVLOG.md and git. A post-commit hook reruns it, --watch
// reruns it on every docs/ or todo.md change; the page reloads itself every 30 s while it's visible.
// Usage: npm run status [-- --watch]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'work', 'status');
const outFile = path.join(outDir, 'index.html');
const read = (p) => {
  try { return fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n'); }
  catch { return ''; }
};

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

function git(args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function kind(status) {
  const s = status.toLowerCase();
  if (s.startsWith('verified')) return 'done';
  if (s.startsWith('implemented')) return 'built';
  if (s.startsWith('in progress')) return 'active';
  if (s.startsWith('needs aya')) return 'aya';
  if (s.startsWith('blocked')) return 'blocked';
  return 'todo';
}
const LABEL = { done: 'Verified', built: 'Built, checking', active: 'Building', aya: 'Needs you', blocked: 'Blocked', todo: 'To do' };

function parseTodo(text) {
  const lines = text.split('\n');
  const milestones = new Map();
  const waiting = [];
  const checks = [];
  const later = [];
  let section = null;
  let ms = null;
  let card = null;
  let goal = false;
  for (const line of lines) {
    const h2 = /^## (.*)$/.exec(line);
    if (h2) {
      section = h2[1];
      card = null;
      const m = /(M\d+|MT)\s+—\s+(.*)$/.exec(section);
      ms = m ? { id: m[1], title: m[2], heading: section, goal: '', cards: [] } : null;
      if (ms) milestones.set(ms.id, ms);
      continue;
    }
    // The milestone's "Goal (who, when): ..." paragraph, up to the first blank line.
    if (ms && !card && /^Goal\b.*?: /.test(line)) { ms.goal = line.replace(/^Goal\b.*?: /, ''); goal = true; continue; }
    if (goal && line.trim()) { ms.goal += ` ${line.trim()}`; continue; }
    goal = false;
    const h3 = /^### ((M\d+|MT)\.[\w.]+) (.*?)((?: \[[^\]]+\])*)$/.exec(line);
    if (h3 && ms) {
      card = { id: h3[1], title: h3[3], tags: (h3[4].match(/\[([^\]]+)\]/g) || []).map((t) => t.slice(1, -1)), status: '', story: '' };
      ms.cards.push(card);
      continue;
    }
    if (card && line.startsWith('Status: ')) card.status = line.slice(8);
    else if (card && line.startsWith('Story: ')) card.story = line.slice(7);
    else if (section === 'Waiting on Aya' && line.startsWith('- ')) waiting.push(line.slice(2));
    else if (section === "Aya's checks" && /^\d+\. /.test(line)) checks.push(line.replace(/^\d+\. /, ''));
    else if (section && section.startsWith('Later') && line.startsWith('- ')) later.push(line.slice(2));
  }
  return { milestones, waiting, checks, later };
}

function parseBugs(text) {
  const bugs = [];
  let bug = null;
  for (const line of text.split('\n')) {
    const h3 = /^### (B\d+) (.*)$/.exec(line);
    if (h3) bugs.push((bug = { id: h3[1], title: h3[2], status: '' }));
    else if (bug && line.startsWith('Status: ')) bug.status = line.slice(8);
  }
  return bugs;
}

// There is no docs/PLAN.md here: the roadmap is the milestones in docs/TODO.md, plus any
// "- **M2 Name:** goal" lines for milestones that have no cards yet.
function parseRoadmap(todo, milestones) {
  const rows = [...milestones.values()].map((m) => ({ id: m.id, goal: m.goal.split(/(?<=\.)\s/)[0], time: '' }));
  for (const line of todo.split('\n')) {
    const m = /^- \*\*(M\d+|MT) ([^:]+):\*\* (.*)$/.exec(line);
    if (m && !rows.some((r) => r.id === m[1])) rows.push({ id: m[1], goal: m[3], time: '', name: m[2] });
  }
  const order = (id) => (id === 'MT' ? 1.5 : Number(id.slice(1)));
  return rows.sort((a, b) => order(a.id) - order(b.id));
}

// "**M1.5 film sync (with Lenna, after 0.8.1 installs):** both tick..." -> "M1.5 film sync"
const checkTitle = (c) => ((/^\*\*(.+?)\*\*/.exec(c) || [, c])[1]).replace(/\s*\(.*$|:$/g, '');

function build() {
  const todoText = read('docs/TODO.md');
  const { milestones, waiting, checks, later } = parseTodo(todoText);
  const roadmap = parseRoadmap(todoText, milestones);
  const bugs = parseBugs(read('docs/BUGS.md')).filter((b) => kind(b.status) !== 'done' && !/^(fixed|closed)/i.test(b.status));

  const devlog = /^## (.*)$/m.exec(read('docs/DEVLOG.md'));
  const commits = git(['log', '-10', '--format=%h%x09%cI%x09%s']).split('\n').filter(Boolean).map((l) => {
    const [hash, time, ...subject] = l.split('\t');
    return { hash, time, subject: subject.join('\t') };
  });
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
  const now = new Date();

  const allCards = [...milestones.values()].flatMap((m) => m.cards);
  const active = allCards.filter((c) => ['active', 'built'].includes(kind(c.status)));
  const needsAya = allCards.filter((c) => kind(c.status) === 'aya');

  const cardHtml = (c) => {
    const k = kind(c.status);
    const note = c.status.replace(/^(verified|implemented|in progress|needs Aya|blocked|todo)\s*/i, '').replace(/^\((.*)\)$/, '$1');
    return `<li class="card ${k}"><details><summary><span class="dot"></span><span class="cid">${esc(c.id)}</span><span class="ctitle">${md(c.title)}</span>${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span class="state">${LABEL[k]}</span></summary>${c.story ? `<p>${md(c.story)}</p>` : ''}${note ? `<p class="note">${md(note)}</p>` : ''}</details></li>`;
  };

  const msHtml = roadmap.map((r) => {
    const m = milestones.get(r.id);
    const cards = m ? m.cards : [];
    const done = cards.filter((c) => kind(c.status) === 'done').length;
    const isNow = m && m.heading.startsWith('Now');
    const waitingOnAya = m && /Waiting on Aya/.test(m.heading);
    const state = isNow ? 'now' : waitingOnAya ? 'aya' : cards.length && done === cards.length ? 'done' : 'later';
    const stateLabel = { now: 'Now', aya: 'Waiting on your checks', done: 'Done', later: 'Later' }[state];
    const pct = cards.length ? Math.round((done / cards.length) * 100) : 0;
    return `<section class="ms ${state}">
  <header><span class="mid">${esc(r.id)}</span><div class="mhead"><h2>${md(m ? m.title : r.name || '')}</h2><p class="goal">${md(r.goal)}</p></div><span class="badge">${stateLabel}</span></header>
  ${cards.length ? `<div class="bar"><span style="width:${pct}%"></span></div><p class="count">${done} of ${cards.length} cards verified${r.time ? ` · planned ${esc(r.time)}` : ''}</p><ul class="cards">${cards.map(cardHtml).join('')}</ul>` : `<p class="count">Cards written when it's next${r.time ? ` · planned ${esc(r.time)}` : ''}</p>`}
</section>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watch With Friends Build Status</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=DM+Mono&family=DM+Sans:wght@400;500;600&family=Unbounded:wght@500&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--ground:#191715;--panel:#211e1b;--inset:#2a2622;--ink:#efe6d2;--soft:#c8bfae;--muted:#a9a091;--line:rgba(239,230,210,.10);--accent:#f2b9a0;--tint:rgba(242,185,160,.14);--lavender:#c9bce8;--green:#b9d3ad;--red:#e8968a}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.5 'DM Sans',sans-serif}
main{max-width:980px;margin:0 auto;padding:28px 16px 60px}
h1,h2{font-family:Unbounded,sans-serif;font-weight:500;margin:0}h1{font-size:22px;letter-spacing:-.02em}h2{font-size:15px}
code{font:12px 'DM Mono',monospace;background:var(--inset);padding:1px 5px;border-radius:5px;color:var(--soft)}
.mono,.mid,.cid,.tag,.state,.badge,.count{font-family:'DM Mono',monospace}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.top .sub{color:var(--muted);font-size:12px;margin-top:6px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-bottom:14px}
.panel h3{font:10.5px 'DM Mono',monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px;font-weight:400}
.grid{display:grid;grid-template-columns:1.3fr 1fr;gap:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
.grid .panel{margin:0}.grid{margin-bottom:14px}
.now-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.now-list li{display:flex;gap:10px;align-items:baseline}.now-list .cid{color:var(--accent);font-size:12px;min-width:46px}
.empty{color:var(--muted);font-size:13px}
.aya-list{margin:0;padding-left:18px;font-size:13px;color:var(--soft)}.aya-list li{margin-bottom:6px}
.ms{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:16px 18px;margin-bottom:14px}
.ms.now{border-color:rgba(242,185,160,.45);box-shadow:0 0 0 1px rgba(242,185,160,.12) inset}
.ms.later{opacity:.72}
.ms header{display:flex;gap:14px;align-items:flex-start}
.mid{font-size:13px;color:var(--ground);background:var(--muted);border-radius:8px;padding:3px 8px;flex-shrink:0;margin-top:1px}
.ms.now .mid{background:var(--accent)}.ms.aya .mid{background:var(--lavender)}.ms.done .mid{background:var(--green)}
.mhead{flex:1;min-width:0}.goal{margin:4px 0 0;color:var(--muted);font-size:13px}
.badge{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap;margin-top:3px}
.ms.now .badge{color:var(--accent)}.ms.aya .badge{color:var(--lavender)}.ms.done .badge{color:var(--green)}
.bar{height:6px;border-radius:99px;background:var(--inset);margin:14px 0 6px;overflow:hidden}.bar span{display:block;height:100%;background:var(--green);border-radius:99px}
.count{font-size:11px;color:var(--muted);margin:8px 0 0}
.cards{list-style:none;margin:10px 0 0;padding:0;border-top:1px solid var(--line)}
.card{border-bottom:1px solid var(--line)}.card:last-child{border:0}
.card summary{display:flex;align-items:center;gap:10px;padding:9px 2px;cursor:pointer;list-style:none;flex-wrap:wrap}
.card summary::-webkit-details-marker{display:none}.card summary:hover .ctitle{color:var(--accent)}
.card p{margin:0 0 10px 18px;font-size:13px;color:var(--soft)}.card p.note{color:var(--muted);font-size:12px}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;border:1.5px solid var(--muted)}
.cid{font-size:12px;color:var(--muted);min-width:46px}.ctitle{flex:1;min-width:160px;font-size:14px}
.tag{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:1px 7px}
.state{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);min-width:96px;text-align:right}
.card.done .dot{background:var(--green);border-color:var(--green)}.card.done .state{color:var(--green)}.card.done .ctitle{color:var(--soft)}
.card.active .dot,.card.built .dot{background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 4px var(--tint)}.card.active .state,.card.built .state{color:var(--accent)}.card.active .ctitle,.card.built .ctitle{font-weight:600}
.card.aya .dot{background:var(--lavender);border-color:var(--lavender)}.card.aya .state{color:var(--lavender)}
.card.blocked .dot{background:var(--red);border-color:var(--red)}.card.blocked .state{color:var(--red)}
.commits{list-style:none;margin:0;padding:0;font-size:13px}.commits li{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--line)}.commits li:last-child{border:0}
.commits .h{font:11px 'DM Mono',monospace;color:var(--muted);min-width:56px}.commits time{font:11px 'DM Mono',monospace;color:var(--muted);margin-left:auto;white-space:nowrap;padding-left:8px}
.stale{color:var(--accent)}
</style></head>
<body><main>
<div class="top"><div><h1>Watch With Friends build</h1><p class="sub">${devlog ? md(devlog[1]) : ''}</p></div>
<p class="sub mono">Updated <time data-t="${now.toISOString()}">${now.toLocaleTimeString()}</time> · ${dirty} file${dirty === 1 ? '' : 's'} changed and not committed yet</p></div>
<div class="grid">
<div class="panel"><h3>Building now</h3>${active.length ? `<ul class="now-list">${active.map((c) => `<li><span class="cid">${esc(c.id)}</span><span>${md(c.title)} <span class="mono" style="font-size:10px;color:var(--muted)">· ${LABEL[kind(c.status)]}</span></span></li>`).join('')}</ul>` : '<p class="empty">Nothing in progress.</p>'}</div>
<div class="panel"><h3>Waiting on you</h3>${waiting.length || checks.length || needsAya.length ? `<ul class="aya-list">${waiting.map((w) => `<li>${md((/^\*\*(.+?)\*\*/.exec(w) || [, w])[1])}</li>`).join('')}${checks.map((c) => `<li>${md(checkTitle(c))}</li>`).join('')}</ul><p class="count">${needsAya.length ? `Cards held for you: ${needsAya.map((c) => esc(c.id)).join(', ')} · ` : ''}steps in <code>docs/TODO.md</code> → Aya's checks</p>` : '<p class="empty">Nothing.</p>'}</div>
</div>
${msHtml}
<div class="grid">
<div class="panel"><h3>Open bugs</h3>${bugs.length ? `<ul class="now-list">${bugs.map((b) => `<li><span class="cid">${esc(b.id)}</span><span>${md(b.title)} <span class="mono" style="font-size:10px;color:var(--muted)">· ${LABEL[kind(b.status)]}</span></span></li>`).join('')}</ul>` : '<p class="empty">None open.</p>'}</div>
<div class="panel"><h3>Later, not cards yet</h3>${later.length ? `<ul class="aya-list">${later.map((l) => `<li>${md(l)}</li>`).join('')}</ul>` : '<p class="empty">Nothing filed.</p>'}</div>
</div>
<div class="panel"><h3>Latest commits</h3><ul class="commits">${commits.map((c) => `<li><span class="h">${esc(c.hash)}</span><span>${md(c.subject)}</span><time data-t="${esc(c.time)}"></time></li>`).join('')}</ul></div>
</main>
<script>
function ago(t){const s=Math.round((Date.now()-new Date(t))/1000);if(s<60)return'just now';const m=Math.round(s/60);if(m<60)return m+' min ago';const h=Math.round(m/60);return h<24?h+' h ago':Math.round(h/24)+' d ago';}
document.querySelectorAll('.commits time').forEach(e=>e.textContent=ago(e.dataset.t));
const u=document.querySelector('.top time');u.textContent=u.textContent+' ('+ago(u.dataset.t)+')';
setTimeout(function r(){if(document.visibilityState==='visible')location.reload();else setTimeout(r,30000);},30000);
</script>
</body></html>
`;
  fs.mkdirSync(outDir, { recursive: true });
  const ignore = path.join(outDir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  fs.writeFileSync(outFile, html);
  return outFile;
}

console.log(build());
if (process.argv.includes('--watch')) {
  let timer = null;
  const again = () => { clearTimeout(timer); timer = setTimeout(() => { try { build(); } catch (e) { console.error(e.message); } }, 300); };
  fs.watch(path.join(root, 'docs'), again);
  fs.watch(path.join(root, 'todo.md'), again);
  fs.watch(path.join(root, '.git'), again);
}
