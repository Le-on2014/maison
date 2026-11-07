// Ecran d'accueil des teles (port 8091, /accueil) : choix du profil puis l'ecran du profil.
// Chaque profil (PROFILES) a un style (luxe, hacker ou colore), ses applis, le compte a prendre dans
// chaque appli (affiche sur la tuile : on ne peut pas choisir le compte a la place de l'appli) et
// l'etat de la maison connectee ou non.
// La page lit /accueil.json (meteo + pieces Hue) et ne peut que lancer les applis de APPS sur la tele
// qui l'affiche (/accueil/lancer). Telecommande : fleches + OK, fleche haut pour revenir au choix du profil.

// Identifiants Samsung des applis installees sur la tele du salon (verifies avec /api/v2/applications/<id>)
const APPS = {
    youtube: { id: '111299001912', label: '▶ YouTube', bg: '#ff0000', fg: '#fff' },
    netflix: { id: '3201907018807', label: 'NETFLIX', bg: '#000', fg: '#e50914' },
    molotov: { id: '3201611011210', label: 'molotov', bg: '#ffd400', fg: '#111' },
    canal: { id: '3202010022094', label: 'CANAL+', bg: '#000', fg: '#fff' },
    prime: { id: '3201910019365', label: 'prime video', bg: '#00a8e1', fg: '#fff' },
    disney: { id: '3201901017640', label: 'Disney+', bg: '#0b1a45', fg: '#fff' },
    appletv: { id: '3201807016597', label: 'Apple TV', bg: '#111', fg: '#fff' },
    spotify: { id: '3201606009684', label: 'Spotify', bg: '#1db954', fg: '#000' },
    plex: { id: '3201512006963', label: 'plex', bg: '#1f2326', fg: '#e5a00d' },
    rakuten: { id: '3201511006428', label: 'Rakuten TV', bg: '#bf0000', fg: '#fff' },
};
const PROFILES = {
    leon: { name: 'Léon', initial: 'L', avatar: 'leon.png', style: 'luxe', maison: true,
        apps: ['molotov', 'youtube', 'netflix', 'canal', 'prime', 'disney', 'appletv'], accounts: { youtube: 'Gilles' } },
    henri: { name: 'Henri', initial: 'H', style: 'luxe', maison: false,
        apps: ['youtube', 'netflix', 'molotov', 'canal', 'prime', 'disney', 'appletv'], accounts: { youtube: 'Henri' } },
    parents: { name: 'Parents', initial: 'P', style: 'luxe', maison: false,
        apps: ['netflix', 'molotov', 'canal', 'prime', 'disney', 'appletv'], accounts: {} },
};

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maison</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;700&family=JetBrains+Mono:wght@400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;500;700&display=swap" rel="stylesheet">
<style>
:root{--gold:#d8b46a;--green:#3bff7a}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:#000;color:#fff;font-family:Inter,"Segoe UI",Arial,sans-serif}
.screen{position:fixed;inset:0;display:none}
.screen.on{display:block}
canvas,.fx{position:absolute;inset:0;width:100%;height:100%}

/* ----- animation de demarrage ----- */
#intro{position:fixed;inset:0;z-index:10;background:#000;transition:opacity .9s ease}
#intro.out{opacity:0;pointer-events:none}
#intro .word{position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);text-align:center;font:400 8vw "Playfair Display",Georgia,serif;
  letter-spacing:.35em;padding-left:.35em;color:transparent;
  background:linear-gradient(100deg,#7a5f2e 0,#f6e2b0 45%,#fff8e6 50%,#f6e2b0 55%,#7a5f2e 100%);background-size:300% 100%;
  -webkit-background-clip:text;background-clip:text}
#intro .word span{display:inline-block;opacity:0;transform:translateY(2vw) scale(1.3);filter:blur(1vw)}
#intro.go .word span{animation:letter .9s cubic-bezier(.2,.8,.2,1) forwards}
#intro.go .word{animation:sheen 2.4s ease-in-out 1.6s forwards}
#intro .sub{position:absolute;top:62%;width:100%;text-align:center;font:300 1.3vw Inter,sans-serif;letter-spacing:.8em;color:#8f7a50;opacity:0}
#intro.go .sub{animation:fadein 1s ease 2.2s forwards}
@keyframes letter{to{opacity:1;transform:none;filter:blur(0)}}
@keyframes sheen{from{background-position:100% 0}to{background-position:0 0}}
@keyframes fadein{to{opacity:1}}

/* ----- choix du profil (luxe) ----- */
#pick{background:radial-gradient(ellipse at 50% 35%,#1b1712,#050505 70%);font-family:"Playfair Display",Georgia,serif}
#pick h1{position:absolute;top:14vh;width:100%;text-align:center;margin:0;font-weight:400;font-style:italic;font-size:3.4vw;color:var(--gold)}
#tiles{position:absolute;top:32vh;left:0;right:0;display:flex;justify-content:center;gap:5vw}
.tile{text-align:center;transition:transform .25s}
.tile .av{width:16vw;height:16vw;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:7vw;color:var(--gold);
  background:radial-gradient(circle at 35% 30%,#2a241b,#0b0a08);border:.15vw solid rgba(216,180,106,.35);transition:border-color .25s,box-shadow .25s}
.tile .av img{width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:50% 20%}
.tile .nm{margin-top:2.5vh;font-size:2.4vw;color:#8f8573;transition:color .25s}
.tile.sel{transform:scale(1.08)}
.tile.sel .av{border-color:var(--gold);box-shadow:0 0 4vw rgba(216,180,106,.35)}
.tile.sel .nm{color:#f3ead8}
#pick .hint{position:absolute;bottom:8vh;width:100%;text-align:center;font-family:Inter,sans-serif;font-weight:300;letter-spacing:.2em;text-transform:uppercase;color:#6d6555;font-size:1.1vw}

/* ----- ecran d'un profil : structure commune ----- */
.layer{position:absolute;inset:0;padding:7vh 6vw;display:flex;flex-direction:column}
.back{position:absolute;top:3vh;right:3vw;font-size:1.1vw;opacity:.45}
.apps{display:flex;flex-wrap:wrap;gap:1.4vw}
.app{width:12vw;text-align:center}
.app .logo{height:6.7vw;border-radius:.9vw;display:flex;align-items:center;justify-content:center;font:700 1.6vw Inter,Arial,sans-serif;
  border:.25vw solid transparent;transition:transform .2s,border-color .2s,box-shadow .2s}
.app .acc{margin-top:.8vh;font-size:1.1vw;min-height:1.4vw;opacity:.75}
.app.sel .logo{transform:scale(1.1);border-color:#fff;box-shadow:0 0 3vw rgba(255,255,255,.35)}
.rooms{display:flex;flex-wrap:wrap;gap:1.2vw}
.room{padding:1vw 1.4vw;border-radius:5vw;display:flex;align-items:center;gap:.9vw;font-size:1.3vw}
.room .dot{width:.8vw;height:.8vw;border-radius:50%}
.room .pc{opacity:.7;font-size:1.1vw}
.wx .ic{margin-right:1vw}

/* luxe */
.luxe{background:radial-gradient(ellipse at 50% 35%,#1b1712,#050505 70%);color:#f3ead8;font-family:"Playfair Display",Georgia,serif}
.luxe .fx{background:linear-gradient(115deg,transparent 40%,rgba(216,180,106,.07) 50%,transparent 60%);background-size:250% 100%;animation:shine 14s linear infinite}
@keyframes shine{from{background-position:150% 0}to{background-position:-100% 0}}
.luxe .frame{position:absolute;inset:4vh 3vw;border:.12vw solid rgba(216,180,106,.35)}
.luxe .layer{align-items:center;text-align:center;padding-top:9vh}
.luxe .hello{font-style:italic;font-size:2.4vw;color:var(--gold)}
.luxe .clock{font-size:11vw;line-height:1;margin-top:1vh}
.luxe .rule{width:12vw;height:.12vw;background:var(--gold);margin:2.5vh auto}
.luxe .date{font-size:2.2vw;font-style:italic;color:var(--gold);text-transform:capitalize}
.luxe .wx{margin-top:2vh;font-family:Inter,sans-serif;font-weight:300;font-size:1.5vw;letter-spacing:.15em;text-transform:uppercase;color:#cbbfa8}
.luxe .wx b{font-family:"Playfair Display",serif;font-weight:400;font-size:2.6vw;letter-spacing:0;color:#f3ead8;margin-right:.8vw}
.luxe .apps{justify-content:center;margin-top:auto}
.luxe .app .acc{font-family:Inter,sans-serif;font-weight:300;letter-spacing:.1em;color:var(--gold)}
.luxe .app.sel .logo{border-color:var(--gold);box-shadow:0 0 3vw rgba(216,180,106,.45)}
.luxe .rooms{justify-content:center;margin-top:3vh}
.luxe .room{border:.1vw solid rgba(216,180,106,.35);font-family:Inter,sans-serif;font-weight:300;color:#cbbfa8}
.luxe .room .dot{background:var(--gold);box-shadow:0 0 .8vw var(--gold)}
.luxe .room.off{opacity:.5}
.luxe .room.off .dot{background:#3a3326;box-shadow:none}

/* hacker */
.hacker{background:#000;color:var(--green);font-family:"JetBrains Mono",Consolas,monospace}
.hacker .layer{background:linear-gradient(90deg,rgba(0,0,0,.85),rgba(0,0,0,.55) 55%,rgba(0,0,0,.2))}
.hacker .clock{font-size:11vw;font-weight:700;line-height:1;text-shadow:0 0 2vw rgba(59,255,122,.6)}
.hacker .hello:before{content:"$ whoami → "}
.hacker .wx{font-size:2vw;margin-top:2vh}
.hacker .apps{margin-top:auto}
.hacker .app.sel .logo{border-color:var(--green);box-shadow:0 0 3vw rgba(59,255,122,.5)}
.hacker .rooms{margin-top:3vh}
.hacker .room{border:.15vw solid rgba(59,255,122,.35);background:rgba(0,30,10,.75)}
.hacker .room .dot{background:var(--green)}
.hacker .room.off{opacity:.45}

/* colore */
.colore{background:#1a0b3d;font-family:Fredoka,"Segoe UI",sans-serif}
.colore .fx{background:radial-gradient(circle at 15% 20%,#ff4f9a 0,transparent 40%),radial-gradient(circle at 85% 30%,#ffb347 0,transparent 40%),
  radial-gradient(circle at 50% 100%,#3fd0ff 0,transparent 45%);background-size:140% 140%;animation:drift 20s ease-in-out infinite alternate}
@keyframes drift{from{background-position:0 0}to{background-position:100% 100%}}
.colore .hello{font-size:3vw;font-weight:700}
.colore .clock{font-size:12vw;font-weight:700;line-height:1}
.colore .date{font-size:2.4vw;text-transform:capitalize}
.colore .wx{margin-top:2vh;font-size:2.2vw}
.colore .apps{margin-top:auto}
.colore .rooms{margin-top:3vh}
.colore .room{background:rgba(255,255,255,.2)}
.colore .room .dot{background:#fff36b}
.colore .room.off{opacity:.5}
</style></head><body>

<div id="intro"><canvas id="dust"></canvas><div class="word"></div><div class="sub">BIENVENUE</div></div>

<div id="pick" class="screen">
  <h1>Qui regarde ?</h1>
  <div id="tiles"></div>
  <div class="hint">◀ ▶ pour choisir · OK pour entrer</div>
</div>

<div id="prof" class="screen"><canvas id="rain"></canvas><div class="fx"></div><div class="frame"></div><div class="layer">
  <div class="back">▲ changer de profil</div>
  <div class="hello"></div>
  <div class="clock hm"></div>
  <div class="rule"></div>
  <div class="date"></div>
  <div class="wx"></div>
  <div class="rooms"></div>
  <div class="apps"></div>
</div></div>

<script>
var APPS = __APPS__, PROFILES = __PROFILES__, KEYS = Object.keys(PROFILES);
__HOST__
var sel = 0, current = null, data = null, appSel = 0;
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
function pad(n) { return (n < 10 ? '0' : '') + n; }

$('#tiles').innerHTML = KEYS.map(function (k) {
  // Avatar absent (pas dans le depot git) : on garde l'initiale
  var p = PROFILES[k], av = p.avatar ? '<img src="' + HOST.avatar(p.avatar) + '" alt="" onerror="this.parentNode.textContent=\\'' + esc(p.initial) + '\\'">' : esc(p.initial);
  return '<div class="tile" data-p="' + k + '"><div class="av">' + av + '</div><div class="nm">' + esc(p.name) + '</div></div>';
}).join('');
$$('.tile').forEach(function (t) { t.addEventListener('click', function () { enter(t.getAttribute('data-p')); }); });
$('.back').addEventListener('click', toPick);

function toPick() {
  if (current) sel = KEYS.indexOf(current);
  current = null; store('profil', null); stopRain();
  $$('.tile').forEach(function (t, i) { t.classList.toggle('sel', i === sel); });
  $('#prof').classList.remove('on'); $('#pick').classList.add('on');
}
function enter(k) {
  var p = PROFILES[k]; if (!p) return toPick();
  current = k; appSel = 0; store('profil', k);
  var s = $('#prof'); s.className = 'screen on ' + p.style; $('#pick').classList.remove('on');
  $('.hello', s).textContent = (new Date().getHours() >= 18 ? 'Bonsoir ' : 'Bonjour ') + p.name;
  if (p.style === 'hacker') startRain(); else stopRain();
  drawApps(); render();
}
function drawApps() {
  var p = PROFILES[current], box = $('#prof .apps');
  box.innerHTML = p.apps.map(function (k, i) {
    var a = APPS[k], acc = p.accounts[k];
    return '<div class="app' + (i === appSel ? ' sel' : '') + '" data-i="' + i + '"><div class="logo" style="background:' + a.bg + ';color:' + a.fg + '">'
      + esc(a.label) + '</div><div class="acc">' + (acc ? 'compte ' + esc(acc) : '') + '</div></div>';
  }).join('');
  $$('.app', box).forEach(function (el) { el.addEventListener('click', function () { appSel = +el.getAttribute('data-i'); drawApps(); launch(); }); });
}
function launch() { HOST.launch(PROFILES[current].apps[appSel]); }

document.addEventListener('keydown', function (e) {
  var k = e.keyCode;
  if (!current) {
    if (k === 37) sel = (sel + KEYS.length - 1) % KEYS.length; else if (k === 39) sel = (sel + 1) % KEYS.length;
    else if (k === 13) return enter(KEYS[sel]);
    $$('.tile').forEach(function (t, i) { t.classList.toggle('sel', i === sel); });
  } else if (k === 38 || k === 10009 || k === 8 || k === 27) { e.preventDefault(); toPick(); }
  else {
    var n = PROFILES[current].apps.length;
    if (k === 37) { appSel = (appSel + n - 1) % n; drawApps(); }
    else if (k === 39) { appSel = (appSel + 1) % n; drawApps(); }
    else if (k === 13) launch();
  }
});

function render() {
  if (!current) return;
  var p = PROFILES[current], s = $('#prof'), d = new Date();
  $('.hm', s).textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  $('.date', s).textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  var w = data && data.weather, wx = $('.wx', s);
  if (!w) wx.textContent = '';
  else if (w.error) wx.textContent = w.error;
  else if (p.style === 'luxe') wx.innerHTML = '<b>' + w.temp + '°</b> Paris · ' + esc(w.label) + ' · ' + w.low + '° / ' + w.high + '°';
  else if (p.style === 'hacker') wx.textContent = '> paris: ' + w.temp + '°C ' + w.label.toLowerCase() + ' | min ' + w.low + '° max ' + w.high + '°';
  else wx.innerHTML = '<span class="ic">' + w.icon + '</span>' + w.temp + '° · ' + esc(w.label);
  var rooms = $('.rooms', s);
  if (!p.maison || !data) rooms.innerHTML = '';
  else if (data.hueError) rooms.innerHTML = '<div class="room off">Lumières indisponibles</div>';
  else rooms.innerHTML = data.rooms.map(function (r) {
    return '<div class="room' + (r.on ? '' : ' off') + '"><span class="dot"></span>' + esc(r.name) + '<span class="pc">' + (r.on ? r.brightness + '%' : 'éteint') + '</span></div>';
  }).join('');
}
function load() { HOST.load(function (d) { data = d; render(); }); }

// ----- pluie de code (style hacker) -----
var raf = null, cols = [], cv = $('#rain'), ctx = cv.getContext('2d'), FS = 18, lastT = 0;
function startRain() {
  cv.style.display = 'block'; cv.width = innerWidth; cv.height = innerHeight; FS = Math.max(14, Math.round(innerWidth / 90));
  cols = []; for (var i = 0; i < Math.ceil(cv.width / FS); i++) cols.push(Math.random() * cv.height / FS);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!raf) raf = requestAnimationFrame(drawRain);
}
function stopRain() { if (raf) cancelAnimationFrame(raf); raf = null; cv.style.display = 'none'; }
function drawRain(t) {
  raf = requestAnimationFrame(drawRain);
  if (t - lastT < 50) return; lastT = t;
  ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.font = FS + 'px "JetBrains Mono",monospace';
  for (var i = 0; i < cols.length; i++) {
    ctx.fillStyle = Math.random() < .05 ? '#d8ffe4' : '#1fdc5c';
    ctx.fillText(String.fromCharCode(0x30A0 + Math.random() * 96 | 0), i * FS, cols[i] * FS);
    if (cols[i] * FS > cv.height && Math.random() > .975) cols[i] = 0;
    cols[i]++;
  }
}

// ----- animation de demarrage : poussiere d'or qui converge en anneau, puis MAISON -----
function intro(done) {
  var box = $('#intro'), c = $('#dust'), g = c.getContext('2d'), W = c.width = innerWidth, H = c.height = innerHeight;
  $('.word', box).innerHTML = 'MAISON'.split('').map(function (ch, i) { return '<span style="animation-delay:' + (1 + i * .12) + 's">' + ch + '</span>'; }).join('');
  var R = Math.min(W, H) * .36, cx = W / 2, cy = H / 2, parts = [], t0 = null, ended = false;
  for (var i = 0; i < 420; i++) {
    var a = Math.random() * Math.PI * 2, d = Math.max(W, H) * (.6 + Math.random() * .6);
    parts.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, a: (i / 420) * Math.PI * 2, s: .6 + Math.random() * 1.8, k: .03 + Math.random() * .04 });
  }
  function frame(t) {
    if (t0 === null) t0 = t;
    var e = (t - t0) / 1000;
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 0, W, H);
    var spin = e * .35, r = R * (e < 2.6 ? 1 : 1 + (e - 2.6) * 1.8);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], tx = cx + Math.cos(p.a + spin) * r, ty = cy + Math.sin(p.a + spin) * r * .38;
      p.x += (tx - p.x) * p.k; p.y += (ty - p.y) * p.k;
      g.fillStyle = 'rgba(' + (230 + Math.random() * 25 | 0) + ',' + (190 + Math.random() * 40 | 0) + ',120,' + (e < 3.4 ? .9 : Math.max(0, 1 - (e - 3.4))) + ')';
      g.fillRect(p.x, p.y, p.s, p.s);
    }
    if (e < 4.3) requestAnimationFrame(frame); else finish();
  }
  function finish() { if (ended) return; ended = true; box.classList.add('out'); done(); setTimeout(function () { box.style.display = 'none'; }, 1000); }
  box.classList.add('go'); requestAnimationFrame(frame);
  document.addEventListener('keydown', function skip() { document.removeEventListener('keydown', skip, true); finish(); }, true);
  setTimeout(finish, 6000);
}

var m = /[?&]p=(\\w+)/.exec(location.search), saved = m ? m[1] : null;
intro(function () { if (PROFILES[saved]) { sel = KEYS.indexOf(saved); enter(saved); } else toPick(); });
load(); setInterval(load, 20000); setInterval(render, 1000);
</script></body></html>`;

// HOST : ce qui change entre la page servie par le dashboard et l'appli installee sur la tele
// (avatar(fichier) -> URL, launch(cleAppli), load(cb) -> cb({ weather, rooms, hueError }))
const HOST_SERVER = `var HOST = {
  avatar: function (f) { return '/accueil/avatar/' + f; },
  launch: function (k) { var x = new XMLHttpRequest(); x.open('POST', '/accueil/lancer?app=' + k); x.send(); },
  load: function (cb) {
    var x = new XMLHttpRequest(); x.open('GET', '/accueil.json?' + Date.now());
    x.onload = function () { try { cb(JSON.parse(x.responseText)); } catch (e) {} }; x.send();
  }
};`;

// Appli Tizen : lance les applis avec tizen.application, lit Open-Meteo et le pont Hue (API v1 en http) directement
function hostApp(hue) {
    return `var HUE = ${JSON.stringify(hue)};
var WMO = [[[0], '☀️', 'Dégagé'], [[1], '🌤', 'Peu nuageux'], [[2], '⛅', 'Nuageux'], [[3], '☁️', 'Couvert'], [[45, 48], '🌫', 'Brouillard'],
  [[51, 53, 55, 56, 57], '🌦', 'Bruine'], [[61, 63, 65, 66, 67], '🌧', 'Pluie'], [[71, 73, 75, 77], '❄️', 'Neige'], [[80, 81, 82], '🌧', 'Averses'],
  [[85, 86], '🌨', 'Averses de neige'], [[95, 96, 99], '⛈', 'Orage']];
function getJson(url, cb) {
  var x = new XMLHttpRequest(); x.open('GET', url); x.timeout = 6000;
  x.onload = function () { try { cb(JSON.parse(x.responseText)); } catch (e) { cb(null); } };
  x.onerror = x.ontimeout = function () { cb(null); }; x.send();
}
var lastData = { weather: null, rooms: [], hueError: false };
var HOST = {
  avatar: function (f) { return 'avatars/' + f; },
  launch: function (k) { try { tizen.application.launch(APPS[k].id); } catch (e) {} },
  load: function (cb) {
    var left = 2, out = { weather: lastData.weather, rooms: [], hueError: true };
    function done() { if (--left === 0) { lastData = out; cb(out); } }
    getJson('https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current=temperature_2m,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=Europe%2FParis&forecast_days=1', function (j) {
      if (j && j.current) {
        var w = WMO.filter(function (x) { return x[0].indexOf(j.current.weather_code) >= 0; })[0] || [[], '🌡', 'Inconnu'];
        out.weather = { temp: Math.round(j.current.temperature_2m), label: w[2], icon: w[1], wind: Math.round(j.current.wind_speed_10m),
          high: Math.round(j.daily.temperature_2m_max[0]), low: Math.round(j.daily.temperature_2m_min[0]),
          sunrise: j.daily.sunrise[0].slice(11, 16), sunset: j.daily.sunset[0].slice(11, 16) };
      } else if (!out.weather) out.weather = { error: 'Météo indisponible' };
      done();
    });
    getJson('http://' + HUE.ip + '/api/' + HUE.user + '/groups', function (g) {
      if (g && !g.length) {
        out.hueError = false;
        out.rooms = Object.keys(g).map(function (id) { return g[id]; }).filter(function (r) { return r.type === 'Room' || r.type === 'Zone'; })
          .map(function (r) { return { name: r.name, on: !!r.state.any_on, brightness: Math.round((r.action.bri || 0) / 2.54) }; });
      }
      done();
    });
  }
};
// Touche retour sur le choix du profil : quitter l'appli
document.addEventListener('keydown', function (e) {
  if (e.keyCode === 10009 && !current) { try { tizen.application.getCurrentApplication().exit(); } catch (x) {} }
});`;
}

const fill = host => PAGE.replace('__APPS__', JSON.stringify(APPS)).replace('__PROFILES__', JSON.stringify(PROFILES)).replace('__HOST__', host);
// Page de l'appli Tizen (voir ../tv-app/build.js)
const appPage = hue => fill(hostApp(hue));

// json() : { weather, rooms, hueError } pour /accueil.json ; launch(appKey, ip) : lance une appli de APPS
// sur la tele d'adresse ip (openApp(ip, appId) fourni par server.js)
function create({ hueState, weather, openApp }) {
    const page = fill(HOST_SERVER);
    async function launch(appKey, ip) {
        const app = APPS[appKey];
        if (!app) throw new Error('Appli inconnue');
        await openApp(ip, app.id);
    }
    async function json() {
        const [w, rooms] = await Promise.all([
            weather().then(r => r.paris).catch(() => ({ error: 'Météo indisponible' })),
            hueState().catch(() => null),
        ]);
        return {
            weather: w,
            hueError: !rooms,
            rooms: (rooms || []).map(r => ({ name: r.name, on: r.on, brightness: r.brightness })),
        };
    }
    return { page, json, launch };
}

module.exports = { create, appPage, PROFILES, APPS };
