/* 온에어 호출대기 — 가게 하나 = shops/<가게코드>.json 하나.
   주소: 직원 ?s=<코드> · 손님 ?s=<코드>&q&t=<오늘 코드> · 번호로 기다리기 ?s=<코드>&n=15 · 입구 태블릿 ?s=<코드>&door · TV 번호판 ?s=<코드>&board · 안내판 인쇄 ?s=<코드>&sign
   오늘 코드 = HMAC-SHA256(가게 비밀 열쇠, 한국 날짜) 앞 10자. 열쇠는 저장소에 없음 — 직원 기기에서 만들고 '기기 연결 QR'(#pair=, 서버로 안 감)로만 나눔.
   중계(손님 휴대폰·다른 기기 번호판): ntfy 방식 서버. 주소는 아래 DEFAULT_RELAY 한 곳 (가게 설정 "relay" 로 가게별로 바꿀 수도 있음). */
(() => {
"use strict";

// ================= 설정 한 곳 =================
const DEFAULT_RELAY = "https://ntfy.sh/";    // 나중에 유료·자체 ntfy 서버로 바꾸려면 여기만 고치기 (끝에 / 필요)
const SUPPORT = "";                          // 구독 연장 문의 연락처 (예: "010-0000-0000") — 비워 두면 안 보임
const GRACE_DAYS = 7;                        // 만료 뒤 유예 기간
const DAILY_LIMIT = 250;                     // ntfy.sh 무료 중계 하루 대략 한도 (보내는 IP마다)
/* 아껴 보내기 (가게 → 손님 상태 방송):
   · 호출 = 바로 (손님 휴대폰이 울려야 하므로)            · 대기 등록 번호 = 4초 모아서 한 번 (같이 등록한 손님끼리 나눔)
   · 입장·노쇼·취소·직접 등록 = 따로 안 보냄, 다음 등록·호출 방송에 묻어 감 (손님 '앞에 N팀'은 호출 때 바로 바뀜)
   · 손님 '확인했어요'를 받아도 다시 방송하지 않음 · 같은 PC 번호판 창은 localStorage 로만 */
const REG_DELAY = 4000;

// ================= 도우미 =================
const $ = id => document.getElementById(id);
const app = $("app");
const P = new URLSearchParams(location.search);
let CODE = (P.get("s") || "").trim().toLowerCase();
const MODE = P.has("door") ? "door" : P.has("board") ? "board" : P.has("sign") ? "sign" : (P.has("q") || P.has("n")) ? "guest" : "staff";
const esc = x => String(x == null ? "" : x).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad2 = n => String(n).padStart(2, "0");
const hm = ms => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const rnd = n => { const a = new Uint8Array(n); try { crypto.getRandomValues(a); } catch (e) { a.forEach((_, i) => (a[i] = Math.floor(Math.random() * 256))); } return [...a].map(b => (b % 36).toString(36)).join(""); };
const vib = p => { try { if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; navigator.vibrate && navigator.vibrate(p); } catch (e) {} };   // 손님이 한 번도 안 눌렀으면 진동 못 함 (브라우저 규칙)
const ppl = p => (+p >= 6 ? "6명 이상" : (+p || 1) + "명");
let toastT = 0;
function toast(msg, ms = 2600) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms); }
const ls = {
  k: k => `oc_${CODE}_${k}`,
  get(k, d) { try { const v = localStorage.getItem(this.k(k)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(this.k(k), JSON.stringify(v)); } catch (e) {} },
};
function fatal(title, sub) { app.innerHTML = `<div class="fatal"><div class="logo" style="margin:0 auto 12px">!</div><h1>${esc(title)}</h1><p class="muted">${sub || ""}</p></div>`; }

// 설치형(PWA)으로 열면 ?s= 가 없음 → 마지막으로 연 직원 화면 가게로
if (!CODE && MODE === "staff") { try { const last = localStorage.getItem("oc_last"); if (last && /^[a-z0-9]{16,40}$/.test(last)) { location.replace("?s=" + last); return; } } catch (e) {} }
if (!/^[a-z0-9]{16,40}$/.test(CODE)) { fatal("가게 주소가 필요합니다", "가게에서 받은 주소(…?s=가게코드)로 열어 주세요."); return; }

// ================= 오늘의 QR 코드 (하루에 한 번 바뀜 · 가게 비밀 열쇠는 이 기기 localStorage 에만) =================
const KEY_RE = /^[A-Za-z0-9_-]{32,64}$/, TOK_RE = /^[A-Za-z0-9_-]{10}$/, KST = 9 * 3600e3, DAY = 86400000;
const nowMs = () => { let off = 0; try { if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && typeof window.OC_NOW_OFFSET === "number") off = window.OC_NOW_OFFSET; } catch (e) {} return Date.now() + off; };   // 시험 때만 시각 옮기기 (이 PC에서 열었을 때만)
const kstDate = ms => new Date(ms + KST).toISOString().slice(0, 10);
const kstMin = ms => Math.floor(((ms + KST) % DAY) / 60000);
const b64u = a => btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const getKey = () => { const k = ls.get("key", ""); return KEY_RE.test(k) ? k : ""; };
function newKey() { const a = new Uint8Array(32); crypto.getRandomValues(a); const k = b64u(a); ls.set("key", k); return k; }
const tokCache = {};
async function tokenFor(date, key = getKey()) {
  if (!key || !(window.crypto && crypto.subtle)) return "";
  const id = key + "|" + date; if (tokCache[id]) return tokCache[id];
  const enc = new TextEncoder(), k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return (tokCache[id] = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(date)))).slice(0, 10));
}
const todayToken = () => tokenFor(kstDate(nowMs()));
async function tokenOk(t) {                               // 오늘 코드만 · 자정 뒤 30분까지는 어제 코드도
  if (!TOK_RE.test(t || "") || !getKey()) return false;
  const now = nowMs();
  if (t === await tokenFor(kstDate(now))) return true;
  return kstMin(now) < 30 && t === await tokenFor(kstDate(now - DAY));
}
let PAIRED = false;
if (/^#pair=/.test(location.hash)) {                      // 🔗 기기 연결: 열쇠 저장 후 주소에서 바로 지움 (손님 화면에서는 저장 안 함)
  const m = /^#pair=([A-Za-z0-9_-]{32,64})$/.exec(location.hash);
  if (m && MODE !== "guest" && MODE !== "sign") { ls.set("key", m[1]); PAIRED = true; }
  try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; }
}

// ================= 구독 확인 (1차: 설정 파일 expires · 나중에 서버 확인으로 바꾸려면 이 함수만 고치기) =================
async function checkSubscription(shop, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(shop.expires || ""));
  if (!m) return { state: "ok" };                                   // 만료일 없음 = 제한 없음
  const end = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();   // 만료일 그날 밤까지 사용 가능
  const day = 86400000;
  if (now <= end) { const left = Math.floor((end - now) / day); return { state: left < 7 ? "soon" : "ok", daysLeft: left, expires: shop.expires }; }
  const over = Math.floor((now - end) / day);                       // 만료 뒤 지난 날
  if (over < GRACE_DAYS) return { state: "grace", graceLeft: GRACE_DAYS - over, expires: shop.expires };
  return { state: "blocked", expires: shop.expires };
}

// ================= 가게 설정 불러오기 =================
let SHOP = null, SUB = { state: "ok" }, RELAY = DEFAULT_RELAY;
const LANGS = { ko: { name: "한국어", bcp: "ko-KR" }, en: { name: "English", bcp: "en-US" }, ja: { name: "日本語", bcp: "ja-JP" }, zh: { name: "中文", bcp: "zh-CN" } };
async function loadShop() {
  const r = await fetch(`shops/${CODE}.json`, { cache: "no-cache" });
  if (!r.ok) throw new Error("nf");
  const s = await r.json();
  s.name = String(s.name || "우리 가게").slice(0, 40);
  if (!/^#[0-9a-f]{6}$/i.test(s.color || "")) s.color = "#e0662b";
  s.messages = s.messages && typeof s.messages === "object" && Object.keys(s.messages).length ? s.messages : { seat: { label: "호출", screen: "차례가 되었어요", screenEn: "It's your turn", go: "입구로 와 주세요", goEn: "Please come to the entrance", say: { ko: "{n}번 손님, 입구로 와 주세요." } } };
  s.langsAvailable = (s.langsAvailable || ["ko", "en", "ja", "zh"]).filter(l => LANGS[l]);
  s.langs = (s.langs || ["ko"]).filter(l => LANGS[l]);
  s.minutesPerTeam = Math.min(60, Math.max(1, +s.minutesPerTeam || 5));
  return s;
}
function relayFrom(shop) {
  try { const r = window.OC_RELAY; if (typeof r === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/$/.test(r) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return r; } catch (e) {}   // 시험용 가짜 중계 (이 PC에서 열었을 때만)
  return /^https:\/\/[a-z0-9.-]+(:\d+)?\/$/i.test(shop.relay || "") ? shop.relay : DEFAULT_RELAY;
}
const topicOut = () => RELAY + "oc" + CODE + "-s";    // 가게 → 손님·번호판 : 상태 스냅숏
const topicIn = () => RELAY + "oc" + CODE + "-i";     // 손님 → 가게 : J 등록 · G 가고 있어요 · X 취소 · A 확인했어요
function logoHTML(cls = "logo") {
  return SHOP.logo && /^(https:\/\/|icons\/|shops\/|data:image\/)/.test(SHOP.logo) ? `<div class="${cls}"><img src="${esc(SHOP.logo)}" alt=""></div>` : `<div class="${cls}">${esc((SHOP.logoText || SHOP.name).slice(0, 2))}</div>`;
}
function sentAdd() { const d = today(); let s = ls.get("sent", null); if (!s || s.day !== d) s = { day: d, n: 0 }; s.n++; ls.set("sent", s); return s.n; }
const sentN = () => { const s = ls.get("sent", null); return s && s.day === today() ? s.n : 0; };

// ================= 스냅숏 글자 (가게 ↔ 손님 약속) =================
/* {k:"oc1", o:접수 켜짐, r:라운드(초기화마다 바뀜), c:지금 부른 번호, ck:종류, ct:부른 시각(초), h:"최근 부른 번호들", a:"확인한 번호들",
    m:한 팀당 분, e:"번호:기기앞6자:상태+부른횟수,…", t:보낸 시각(ms)}  상태 w 대기 · c 호출 · g 가는 중 · i 입장 · x 취소 · n 노쇼  (4KB 안) */
const ST = { w: "대기", c: "호출", g: "확인", i: "입장", x: "취소", n: "노쇼" };
const isAct = e => "wcg".includes(e.st);
function parseE(e) { return String(e || "").split(",").map(x => { const m = /^(\d{1,4}):([a-z0-9]{0,6}):([wcgixn])(\d{1,3})$/.exec(x); return m && { n: +m[1], d: m[2], st: m[3], calls: +m[4] }; }).filter(Boolean); }
function validSnap(s) { return s && s.k === "oc1" && typeof s.e === "string" && typeof s.r === "string"; }

// ================= 소리: 차임 + 목소리 =================
let ctx = null, master = null;
function audio() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; try { ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination); } catch (e) { ctx = null; return null; } }
  if (ctx.state !== "running") { try { const p = ctx.resume(); p && p.catch && p.catch(() => {}); } catch (e) {} }
  return ctx;
}
function bell(f, t0, dur = 1.6, a = 0.32) {
  if (!ctx) return;
  [[1, 1], [2.0, 0.18], [3.01, 0.08], [4.2, 0.04]].forEach(([m, k]) => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f * m;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(a * k, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / Math.sqrt(m));
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.1);
  });
}
function chime() { if (!audio()) return 0; const t0 = ctx.currentTime + 0.05; [[523.25, 0], [659.25, .42], [783.99, .84], [1046.5, 1.26]].forEach(([f, t]) => bell(f, t0 + t)); return 2600; }
function beep() { if (!audio()) return; const t = ctx.currentTime; [0, .25, .5].forEach(d => { bell(1046.5, t + d, .22, .5); bell(1318.5, t + d + .12, .22, .5); }); }

let voices = [];
const loadVoices = () => { try { voices = speechSynthesis.getVoices() || []; } catch (e) { voices = []; } };
if ("speechSynthesis" in window) { loadVoices(); try { speechSynthesis.addEventListener("voiceschanged", () => { loadVoices(); if (MODE === "staff" && $("setDlg")?.open) drawSettings(); }); } catch (e) {} }
const langVoices = l => voices.filter(v => String(v.lang || "").replace("_", "-").toLowerCase().startsWith(l)).sort((a, b) => (l === "zh" ? (/zh-cn/i.test(b.lang) - /zh-cn/i.test(a.lang)) : 0));
function voiceFor(l, localOnly) {                      // 인터넷 되면 Edge Natural(온라인) 먼저, 안 되면 기기 기본 목소리
  const all = langVoices(l), pool = localOnly ? all.filter(v => v.localService) : all;
  const want = (S.voice || {})[l] || (SHOP.voices || {})[l];
  if (want) { const v = pool.find(v => v.name === want) || pool.find(v => v.name.includes(want)); if (v) return v; }
  return pool.find(v => /Natural/.test(v.name)) || pool.find(v => v.localService) || pool[0] || null;
}
let speakId = 0;
function speakOne(text, l, id, localOnly = !navigator.onLine) {
  return new Promise(res => {
    if (!("speechSynthesis" in window) || id !== speakId) return res();
    const v = voiceFor(l, localOnly), u = new SpeechSynthesisUtterance(text);
    u.lang = LANGS[l].bcp; if (v) u.voice = v; u.rate = l === "ko" ? 0.95 : 0.92;
    let done = false, started = false;
    const fin = retry => { if (done) return; done = true; clearTimeout(t); if (retry && id === speakId) speakOne(text, l, id, true).then(res); else res(); };
    u.onstart = () => { started = true; };
    u.onend = () => fin(false);
    u.onerror = e => fin(!localOnly && v && !v.localService && e.error !== "interrupted" && e.error !== "canceled");   // 온라인 목소리 실패 → 기기 목소리로 다시
    const t = setTimeout(() => { if (!started && v && !v.localService && !localOnly) { done = true; try { speechSynthesis.cancel(); } catch (e) {} speakOne(text, l, id, true).then(res); } }, 5000);   // 인터넷이 느려 시작을 못 하면 기기 목소리로
    try { speechSynthesis.speak(u); } catch (e) { fin(false); }
  });
}
function stopSpeak() { speakId++; try { speechSynthesis.cancel(); } catch (e) {} }

// ================= 시작 =================
let S = {};          // 직원 기기 설정 (언어·목소리·반복·차임)
(async () => {
  try { SHOP = await loadShop(); } catch (e) { fatal("가게 정보를 찾을 수 없습니다", "주소가 맞는지 확인해 주세요. 인터넷이 처음부터 끊겨 있으면 열 수 없어요."); return; }
  RELAY = relayFrom(SHOP);
  document.documentElement.style.setProperty("--accent", SHOP.color);
  SUB = await checkSubscription(SHOP);
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  if (MODE === "staff") staff(); else if (MODE === "guest") guest(); else if (MODE === "board") board(); else if (MODE === "door") door(); else sign();
  if (PAIRED) toast("🔗 기기 연결 완료 — 오늘의 QR을 쓸 수 있습니다", 3500);
})();

function guestUrl(t) { return location.origin + location.pathname + "?s=" + CODE + "&q" + (t ? "&t=" + t : ""); }
function qrImg(text, size) {
  return new Promise(res => {
    const go = () => {
      try {                                                // 오류 정정 H(30%) + 가운데 흰 둥근 상자에 가게 이름 (QR 면적의 약 7%) + 둘레 흰 여백
        const box = document.createElement("div"); new window.QRCode(box, { text, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.H });
        const src = box.querySelector("canvas"); if (!src) return res(box.querySelector("img")?.src || "");
        const m = Math.round(size * 0.06), c = document.createElement("canvas"); c.width = c.height = size + m * 2;
        const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingEnabled = false; g.drawImage(src, m, m);
        const name = String(SHOP.name.length > 5 ? (SHOP.logoText || SHOP.name.slice(0, 4)) : SHOP.name);
        const bw = size * 0.36, bh = size * 0.17, x = (c.width - bw) / 2, y = (c.height - bh) / 2, r = bh * 0.28;
        g.fillStyle = "#fff"; g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + bw, y, x + bw, y + bh, r); g.arcTo(x + bw, y + bh, x, y + bh, r); g.arcTo(x, y + bh, x, y, r); g.arcTo(x, y, x + bw, y, r); g.closePath(); g.fill();
        g.lineWidth = Math.max(2, size * 0.008); g.strokeStyle = SHOP.color; g.stroke();
        let fs = bh * 0.62; g.font = `900 ${fs}px "Malgun Gothic","Apple SD Gothic Neo",sans-serif`;
        while (g.measureText(name).width > bw * 0.84 && fs > 8) { fs -= 1; g.font = `900 ${fs}px "Malgun Gothic","Apple SD Gothic Neo",sans-serif`; }
        g.fillStyle = SHOP.color; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(name, c.width / 2, c.height / 2 + fs * 0.05);
        res(c.toDataURL("image/png"));
      } catch (e) { res(""); }
    };
    if (window.QRCode) go(); else { let n = 0; const iv = setInterval(() => { if (window.QRCode || ++n > 50) { clearInterval(iv); window.QRCode ? go() : res(""); } }, 100); }
  });
}

// =====================================================================
// 직원 화면
// =====================================================================
let Q = null, leader = false, inES = null, pubT = 0, pubDue = 0, lastSend = 0, fail = 0, busy = false, doneOpen = false, calling = false;
function qNew() { return { on: false, r: rnd(4), day: today(), next: 1, cur: 0, ck: "", ct: 0, h: [], ack: [], rj: [], list: [], seen: [], lastT: 0, pub: "", pubAt: 0, openAt: 0 }; }
function qLoad() {
  const v = ls.get("queue", null); Q = v && Array.isArray(v.list) ? { ...qNew(), ...v } : qNew();
  if (Q.day !== today() && !Q.list.some(isAct)) Object.assign(Q, { r: rnd(4), day: today(), next: 1, list: [], h: [], ack: [] });   // 날이 바뀌면 1번부터
  return Q;
}
function canCall() { return SUB.state !== "blocked"; }
function pace() {                                       // 한 팀당 분 (오늘 부른 간격, 2팀 이상 불렀을 때) · 없으면 가게 설정값
  const t = Q.list.filter(e => e.c1).map(e => e.c1).sort((a, b) => a - b);
  if (t.length < 3) return SHOP.minutesPerTeam;
  return Math.min(60, Math.max(1, Math.round((t[t.length - 1] - t[0]) / (t.length - 1) / 30000) / 2));
}
function snapObj() {
  const act = Q.list.filter(isAct).sort((a, b) => a.n - b.n), done = Q.list.filter(e => !isAct(e)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 40);
  const o = { k: "oc1", o: Q.on && canCall() ? 1 : 0, r: Q.r, c: Q.cur || 0, ck: Q.ck || "", ct: Math.floor((Q.ct || 0) / 1000), h: (Q.h || []).slice(0, 8).join(","), a: (Q.ack || []).slice(0, 8).join(","), m: pace(), rj: (Q.rj || []).filter(x => Date.now() - x.at < 600000).map(x => x.k).join(","), e: "" };
  const ent = e => `${e.n}:${(e.d || "").slice(0, 6)}:${e.st}${Math.min(999, e.calls || 0)}`;
  const mk = () => { o.e = [...act, ...done].map(ent).join(","); return JSON.stringify(o); };
  let j = mk(); const B = x => new TextEncoder().encode(x).length;
  while (B(j) > 3800 && done.length) { done.pop(); j = mk(); }
  while (B(j) > 3800 && act.length) { act.pop(); j = mk(); }
  return j;
}
function qSave() { ls.set("queue", Q); boardLocal(); render(); }
function boardLocal() { try { const s = JSON.parse(snapObj()); s.t = Date.now(); ls.set("board", s); } catch (e) {} }
function pub(delay = 300, gap = 2000) {                 // 스냅숏 보내기 (모아서 한 번 · 최소 간격 · 같은 내용이면 안 보냄)
  if (!leader) return;
  const due = Math.max(Date.now() + delay, lastSend + gap);
  if (pubT && pubDue <= due) return;
  clearTimeout(pubT); pubDue = due; pubT = setTimeout(send, due - Date.now());
}
async function send() {
  pubT = 0; if (busy) { pub(600); return; }
  const body = snapObj(); if (body === Q.pub) return;
  busy = true;
  try {
    const r = await fetch(topicOut(), { method: "POST", body: body.replace(/}$/, `,"t":${Date.now()}}`) });
    if (!r.ok) throw new Error(String(r.status));
    lastSend = Date.now(); fail = 0; Q.pub = body; Q.pubAt = Date.now(); ls.set("queue", Q);
    if (sentAdd() === 200) toast(`⚠️ 오늘 알림을 200건 보냈습니다 — 무료 한도(약 ${DAILY_LIMIT}건)에 가까워요`, 5000);
  } catch (e) {
    fail++; if (fail === 1 || fail % 5 === 0) toast(e.message === "429" ? "⏳ 알림 서버가 바쁩니다 — 곧 다시 보냅니다" : "📶 인터넷이 끊겼습니다 — 매장 스피커 호출은 계속 됩니다 (휴대폰 알림은 다시 연결되면 보냄)", 4000);
    busy = false; pub([2, 5, 15, 30, 60][Math.min(fail - 1, 4)] * 1000); render(); return;
  }
  busy = false; render();
}
function listenIn() {                                   // 손님 등록·확인·취소 받기 (보내는 메시지 없음)
  if (!leader || inES || typeof EventSource !== "function") return;
  const since = Math.max(Math.floor(Date.now() / 1000) - 3600, (Q.lastT || Math.floor(Date.now() / 1000)) - 60);
  inES = new EventSource(topicIn() + "/sse?since=" + since);
  inES.onmessage = e => { try { const d = JSON.parse(e.data); if (d.event === "message") onIn(d); } catch (er) {} };
  inES.onerror = () => { if (inES && inES.readyState === 2) { inES = null; setTimeout(listenIn, 5000); } };
}
function onIn(d) {
  const t = +d.time || 0, p = String(d.message || "").split("|");
  if (!d.id || Q.seen.includes(d.id)) return;
  Q.seen.push(d.id); if (Q.seen.length > 400) Q.seen = Q.seen.slice(-300);
  Q.lastT = Math.max(Q.lastT || 0, t);
  const dev = p[1] || "";
  if (!/^[a-z0-9]{8}$/.test(dev) || p.length < 4 || p.some(x => x.length > 20)) { ls.set("queue", Q); return; }   // 이상한 메시지는 버림
  if (p[0] === "J") {
    const party = Math.min(6, Math.max(1, parseInt(p[2], 10) || 1)), mine = Q.list.filter(e => e.d === dev);
    if (!Q.on || !canCall() || t * 1000 < (Q.openAt || 0) - 3000) { ls.set("queue", Q); return; }
    if (mine.some(isAct)) { if (Date.now() - (Q.pubAt || 0) > 60000) Q.pub = ""; ls.set("queue", Q); pub(REG_DELAY); return; }   // 이미 번호 있음 → 다시 알려 줌
    if (mine.some(e => t * 1000 <= (e.doneAt || 0) + 1000)) { ls.set("queue", Q); return; }
    if (Q.list.filter(isAct).length >= 200) { ls.set("queue", Q); return; }
    ls.set("queue", Q);
    tokenOk(p[5] || "").then(good => {                  // 오늘의 QR 코드 검사 — 틀리면 거절 응답 (그 휴대폰만 알아봄)
      if (!good) { Q.rj = [{ k: dev.slice(0, 6) + ":" + String(p[3] || "").replace(/[^a-z0-9]/g, "").slice(0, 6), at: Date.now() }, ...(Q.rj || [])].slice(0, 10); ls.set("queue", Q); pub(REG_DELAY); return; }
      if (Q.list.some(e => e.d === dev && isAct(e))) return;
      const n = Q.next++; Q.list.push({ n, d: dev, p: party, at: t ? Math.min(Date.now(), t * 1000) : Date.now(), st: "w", calls: 0 });
      readyNext(true); qSave(); pub(REG_DELAY); toast(`🧾 ${n}번 대기 등록 · ${ppl(party)}`);   // 기다리는 사람이 없던 중이면 번호판에 바로 준비
    });
  } else if (p[0] === "G" || p[0] === "X") {
    const n = parseInt(p[2], 10), e = Q.list.find(x => x.n === n && x.d === dev);
    if (!e || p[3] !== Q.r) { ls.set("queue", Q); return; }
    if (p[0] === "G" && "cn".includes(e.st)) { e.st = "g"; ackAdd(n); qSave(); toast(`✅ ${n}번 손님이 확인했어요 — 오는 중`); if (calling && Q.cur === n) stopCall(); }
    else if (p[0] === "X" && "wcgn".includes(e.st)) { e.st = "x"; e.doneAt = Date.now(); e.self = 1; qSave(); /* 따로 안 보냄 — 다음 방송에 묻어 감 */ toast(`${n}번 손님이 대기를 취소했어요`); }
    else ls.set("queue", Q);
  } else if (p[0] === "A") {                            // 번호로 기다리던 손님의 '확인했어요'
    const n = parseInt(p[2], 10); if (!(n > 0)) { ls.set("queue", Q); return; }
    ackAdd(n); qSave(); toast(`✅ ${n}번 손님이 휴대폰에서 확인했어요`); if (calling && Q.cur === n) stopCall();
  } else ls.set("queue", Q);
}
function ackAdd(n) { Q.ack = [n, ...(Q.ack || []).filter(x => x !== n)].slice(0, 20); }

function callNumber(n, again) {                         // 📢 호출: 매장 스피커 + 손님 휴대폰 + 번호판
  if (!canCall()) { toast("이용 기간이 끝나 호출할 수 없습니다"); return; }
  if (!(n > 0)) { toast("번호를 넣어 주세요"); return; }
  if (!leader) { S.num = n; saveS(); render(); announce(n, S.kind); return; }   // 다른 창이 대기를 맡고 있으면 스피커 호출만
  const now = Date.now(), e = Q.list.find(x => x.n === n && "wcgn".includes(x.st));
  if (e) { e.st = "c"; e.calls = (e.calls || 0) + 1; if (!e.c1) e.c1 = now; e.ct = now; delete e.doneAt; }
  Q.cur = n; Q.ck = S.kind; Q.ct = now; Q.h = [n, ...(Q.h || []).filter(x => x !== n)].slice(0, 12); Q.ack = (Q.ack || []).filter(x => x !== n);
  S.num = n; saveS(); qSave(); pub(0, 1000); announce(n, S.kind);   // 호출은 바로
}
async function announce(n, kind) {
  stopSpeak(); const id = speakId, msg = SHOP.messages[kind] || Object.values(SHOP.messages)[0];
  calling = true; render();
  const wait = S.chime ? chime() : 0; if (wait) await sleep(wait);
  for (let r = 0; r < S.rep && id === speakId; r++) {
    for (const l of S.langs) {
      if (id !== speakId) break;
      const txt = (msg.say && (msg.say[l] || msg.say.ko) || "{n}번").replace(/\{n\}/g, n);
      $("sayLine") && ($("sayLine").textContent = "🔊 " + txt);
      await speakOne(txt, l, id);
    }
    if (r < S.rep - 1) await sleep(900);
  }
  if (id === speakId) { calling = false; render(); }
}
function stopCall() { stopSpeak(); calling = false; render(); }
function saveS() { ls.set("set", S); }
function teamsLeft(sent) {                               // 오늘 한 팀당 보낸 건수(5팀 넘으면 실제 평균, 아니면 2건)로 남은 팀 수 추정
  const teams = Q.list.length, per = teams >= 5 && sent ? Math.max(0.5, sent / teams) : 2;
  return Math.max(0, Math.floor((DAILY_LIMIT - sent) / per));
}
let TOK4 = "", tokDay = "";
async function tokRefresh() { const t = await todayToken(); const v = t ? t.slice(0, 4) : ""; tokDay = kstDate(nowMs()); if (v !== TOK4) { TOK4 = v; render(); } }

function staff() {
  try { localStorage.setItem("oc_last", CODE); } catch (e) {}
  document.title = SHOP.name + " · 호출";
  const kinds = Object.keys(SHOP.messages);
  S = Object.assign({ num: 1, kind: kinds[0], langs: SHOP.langs.length ? SHOP.langs : ["ko"], rep: 2, chime: true, voice: {} }, ls.get("set", {}));
  if (!SHOP.messages[S.kind]) S.kind = kinds[0];
  S.langs = S.langs.filter(l => SHOP.langsAvailable.includes(l)); if (!S.langs.length) S.langs = ["ko"];
  document.body.insertAdjacentHTML("beforeend", `<dialog id="walkDlg"></dialog><dialog id="setDlg"></dialog><dialog id="pairDlg"></dialog>`);
  tokRefresh(); setInterval(() => { if (kstDate(nowMs()) !== tokDay) tokRefresh(); }, 30000);
  window.addEventListener("storage", e => { if (e.key === ls.k("key")) { tokRefresh(); render(); } });
  qLoad(); render();
  const go = () => { leader = true; qLoad(); listenIn(); if (Q.on && Date.now() - (Q.pubAt || 0) > 10 * 3600e3) { Q.pub = ""; pub(); } boardLocal(); render(); };
  try { if (navigator.locks && navigator.locks.request) { navigator.locks.request("oc_" + CODE, () => { go(); return new Promise(() => {}); }).catch(go); } else go(); } catch (e) { go(); }
  window.addEventListener("storage", e => { if (e.key === ls.k("queue") && !leader) { qLoad(); render(); } });
  setInterval(() => { if (Q.list.some(isAct)) render(); }, 30000);
  app.addEventListener("click", onStaffClick);
  app.addEventListener("change", e => { if (e.target.id === "qOn") toggleQ(e.target.checked); });
  app.addEventListener("toggle", e => { if (e.target.classList?.contains("done")) doneOpen = e.target.open; }, true);
  document.addEventListener("keydown", e => {             // 키보드: 숫자 · Enter 호출 · ←→ ∓1
    if (document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (/^\d$/.test(e.key)) padKey(e.key); else if (e.key === "Backspace") padKey("⌫"); else if (e.key === "Enter") callNumber(S.num); else if (e.key === "ArrowRight") step(1); else if (e.key === "ArrowLeft") step(-1);
  });
  window.addEventListener("online", () => { toast("📶 인터넷이 다시 연결됐습니다"); render(); pub(); });
  window.addEventListener("offline", () => { toast("📶 인터넷이 끊겼습니다 — 매장 스피커 호출은 기기 목소리로 계속됩니다", 4000); render(); });
}
let padFresh = true;
function padKey(k) {
  let s = padFresh ? "" : String(S.num || "");
  if (k === "⌫") s = s.slice(0, -1); else if (k === "C") s = ""; else s = (s + k).replace(/^0+/, "").slice(0, 4);
  padFresh = false; S.num = +s || 0; saveS(); render();
}
// 다음 손님 준비 (2026-10-30 사장님 요청): 입장·노쇼 처리하면 번호판에 다음 대기 번호를 미리 띄워 둠 → 📢 호출만 누르면 됨
// 패드에 지금 띄운 번호가 아직 기다리거나 부르는 중인 손님이면 건드리지 않음 (직원이 고른 번호 존중)
function readyNext(quiet) {
  if (Q.list.some(x => x.n === +S.num && isAct(x))) return;
  const w = Q.list.filter(x => x.st === "w").sort((x, y) => x.n - y.n)[0]; if (!w) return;
  S.num = w.n; padFresh = true; saveS();
  if (!quiet) toast(`👉 다음 손님 ${w.n}번 준비 — 📢 호출을 누르세요`);
}
function step(d) { S.num = Math.max(1, Math.min(9999, (+S.num || 0) + d)); padFresh = true; saveS(); render(); }
function toggleQ(on) {
  if (!leader) return;
  if (on && !canCall()) { toast("이용 기간이 끝나 대기 접수를 켤 수 없습니다"); render(); return; }
  if (on && !getKey()) { toast("먼저 ⚙ 설정에서 QR 열쇠를 만들어 주세요", 3500); render(); drawSettings(); $("setDlg").showModal(); return; }
  Q.on = on; if (on) { Q.openAt = Date.now(); if (Q.day !== today() && !Q.list.some(isAct)) Object.assign(Q, { r: rnd(4), day: today(), next: 1, list: [], h: [], ack: [] }); }
  qSave(); pub(); toast(on ? "🧾 대기 접수 시작 — 손님이 카운터 QR로 등록합니다" : "대기 접수를 멈췄습니다");
}
function onStaffClick(e) {
  const b = e.target.closest("[data-a]"); if (!b) return;
  const a = b.dataset.a, ent = Q.list.find(x => x.n === +b.dataset.n);
  audio();                                              // 소리 잠금 풀기 (처음 누를 때)
  if (a === "pad") padKey(b.dataset.k);
  else if (a === "minus") step(-1);
  else if (a === "plus") step(1);
  else if (a === "call") { if (calling && +S.num === +Q.cur) stopCall(); else { padFresh = true; callNumber(+S.num); } }   // 부르는 중 같은 번호 = 멈춤, 다른 번호 = 새로 호출
  else if (a === "again") { padFresh = true; callNumber(+Q.cur || +S.num, true); }
  else if (a === "kind") { S.kind = b.dataset.k; saveS(); render(); }
  else if (a === "next") { if (!leader) return; const w = Q.list.filter(x => x.st === "w").sort((x, y) => x.n - y.n)[0]; if (!w) { toast("기다리는 손님이 없습니다"); return; } padFresh = true; callNumber(w.n); }
  else if (a === "walk") walkOpen();
  else if (a === "board") { const w = window.open("?s=" + CODE + "&board", "oc_board_" + CODE, "width=1280,height=720"); if (!w) toast("팝업이 막혔습니다 — 주소창 오른쪽에서 팝업 허용을 눌러 주세요", 4000); }
  else if (a === "door") { const w = window.open("?s=" + CODE + "&door", "oc_door_" + CODE, "width=1280,height=800"); if (!w) toast("팝업이 막혔습니다 — 주소창 오른쪽에서 팝업 허용을 눌러 주세요", 4000); }
  else if (a === "pair") pairOpen();
  else if (a === "sign") { const w = window.open("?s=" + CODE + "&sign", "_blank", "width=640,height=900"); if (!w) toast("팝업이 막혔습니다 — 팝업을 허용해 주세요", 4000); }
  else if (a === "set") { drawSettings(); $("setDlg").showModal(); }
  else if (a === "reset") { if (!leader || !confirm("오늘 대기를 모두 지우고 1번부터 다시 시작할까요?")) return; Object.assign(Q, { r: rnd(4), day: today(), next: 1, cur: 0, list: [], h: [], ack: [] }); qSave(); pub(); toast("대기를 초기화했습니다 — 다음 등록은 1번"); }
  else if (!leader || !ent) return;
  else if (a === "qcall") { padFresh = true; callNumber(ent.n); }
  else if (a === "in") { if (calling && +Q.cur === ent.n) stopCall(); ent.st = "i"; ent.doneAt = Date.now(); readyNext(); qSave(); /* 따로 안 보냄 — 다음 방송에 묻어 감 */ }
  else if (a === "no") { if (calling && +Q.cur === ent.n) stopCall(); ent.st = "n"; ent.doneAt = Date.now(); readyNext(true); qSave(); /* 따로 안 보냄 — 다음 방송에 묻어 감 */ toast(`${ent.n}번 노쇼 처리 — 목록 아래 '지난 손님'에 있어요` + (+S.num !== ent.n && Q.list.some(x => x.n === +S.num && x.st === "w") ? ` · 다음 ${S.num}번 준비` : "")); }
  else if (a === "del") { if (!confirm(`${ent.n}번 대기를 취소할까요?`)) return; ent.st = "x"; ent.doneAt = Date.now(); readyNext(true); qSave(); /* 따로 안 보냄 — 다음 방송에 묻어 감 */ }
}
function rowHTML(e) {
  const now = Date.now(), min = Math.max(0, Math.round(((e.c1 || (isAct(e) ? now : e.doneAt || now)) - e.at) / 60000));
  const btn = !leader ? "" : e.st === "w" ? `<button data-a="qcall" data-n="${e.n}"${canCall() ? "" : " disabled"}>📢 호출</button><button class="del" data-a="del" data-n="${e.n}">취소</button>`
    : "cg".includes(e.st) ? `<button data-a="qcall" data-n="${e.n}"${canCall() ? "" : " disabled"}>다시</button><button class="in" data-a="in" data-n="${e.n}">입장</button><button class="del" data-a="no" data-n="${e.n}">노쇼</button>` : "";
  return `<div class="qrow ${e.st}" data-row="${e.n}"><div class="qn">${e.n}</div><div class="qm"><span class="qst ${e.st}">${ST[e.st]}${e.st === "c" && e.calls > 1 ? " " + e.calls : ""}</span><b>${ppl(e.p)}</b> · ${hm(e.at)} 등록${e.walk ? " · 직접" : ""} · ${min}분</div>${btn ? `<div class="qa">${btn}</div>` : ""}</div>`;
}
function render() {
  if (MODE !== "staff" || !Q) return;
  const y = app.querySelector(".qlist")?.scrollTop || 0, kinds = Object.keys(SHOP.messages);
  const act = Q.list.filter(isAct).sort((a, b) => a.n - b.n), done = Q.list.filter(e => !isAct(e)).sort((a, b) => b.n - a.n), w = act.filter(e => e.st === "w");
  const sub = SUB.state === "blocked" ? `<div class="banner bad" id="subBan">⛔ 이용 기간이 끝났습니다 (${esc(SUB.expires)}). 호출·대기 접수가 멈췄습니다.${SUPPORT ? " 연장 문의 " + esc(SUPPORT) : ""}</div>`
    : SUB.state === "grace" ? `<div class="banner warn" id="subBan">⚠️ 이용 기간이 끝났습니다 (${esc(SUB.expires)}). ${SUB.graceLeft}일 뒤 호출이 멈춥니다 — 연장해 주세요.${SUPPORT ? " 문의 " + esc(SUPPORT) : ""}</div>`
    : SUB.state === "soon" ? `<div class="banner warn" id="subBan">이용 기간이 ${SUB.daysLeft ? SUB.daysLeft + "일 " : "오늘까지 "}남았습니다 (${esc(SUB.expires)}까지).</div>` : "";
  const sent = sentN();
  app.innerHTML = `<header class="st-top">${logoHTML()}<div class="nm">${esc(SHOP.name)} <span class="muted" style="font-size:15px;font-weight:600">호출</span></div>
    <div class="tools"><button data-a="door">🚪 입구 화면</button><button data-a="board">🖥 번호판</button><button data-a="pair">🔗 기기 연결</button><button data-a="sign">🪧 안내판</button><button data-a="set" aria-label="설정">⚙ 설정</button></div></header>
    ${sub}${getKey() ? "" : `<div class="banner warn" id="keyBan">🔑 QR 열쇠가 없습니다 — <b>⚙ 설정</b>에서 만들어 주세요. 열쇠가 없으면 손님 대기 등록이 거절됩니다.</div>`}${navigator.onLine ? "" : `<div class="banner warn">📶 인터넷 끊김 — 스피커 호출은 기기 목소리로 됩니다. 휴대폰 알림·줄 서기는 다시 연결되면 이어집니다.</div>`}
    <main class="st-main">
      <section class="card" aria-label="번호 호출">
        <div class="numrow"><button class="pm" data-a="minus" aria-label="번호 1 빼기">−</button><div class="bignum" id="curNum">${S.num || "–"}<small>번</small></div><button class="pm" data-a="plus" aria-label="번호 1 더하기">+</button></div>
        <div class="kinds">${kinds.map(k => `<button class="chip${k === S.kind ? " on" : ""}" data-a="kind" data-k="${esc(k)}">${esc((SHOP.messages[k].icon || "") + " " + (SHOP.messages[k].label || k))}</button>`).join("")}</div>
        <div class="pad">${["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map(k => `<button data-a="pad" data-k="${k}">${k}</button>`).join("")}</div>
        <div class="callbtns"><button class="callbtn${calling && +S.num === +Q.cur ? " busy" : ""}" id="callBtn" data-a="call"${canCall() ? "" : " disabled"}>${calling && +S.num === +Q.cur ? "■ 멈춤" : "📢 번호 호출"}</button><button class="againbtn" id="againBtn" data-a="again"${canCall() && (Q.cur || S.num) ? "" : " disabled"}>다시 부르기${Q.cur ? `<br><small>${Q.cur}번</small>` : ""}</button></div>
        <div class="sayline" id="sayLine">${S.langs.map(l => LANGS[l].name).join(" · ")} · ${S.rep}번 반복</div>
      </section>
      <section class="card" aria-label="대기 줄">
        <div class="qhead"><h2>🧾 대기 <span id="waitN">${w.length}</span>팀</h2><label class="sw"><input type="checkbox" id="qOn"${Q.on ? " checked" : ""}${leader && canCall() ? "" : " disabled"}>${Q.on ? "접수 중" : "접수 꺼짐"}</label></div>
        ${!leader ? `<div class="banner warn" style="margin:10px 0 0">다른 창에서 이 가게 호출을 맡고 있습니다. 그 창에서 써 주세요.</div>` : !Q.on && !act.length ? `<p class="muted" style="font-size:15px;line-height:1.5">켜면 손님이 <b>카운터 QR</b>로 인원만 골라 번호를 받습니다. 이 화면을 켜 둔 동안 등록돼요.</p>` : ""}
        ${fail ? `<div class="banner warn" style="margin:10px 0 0">📶 손님 휴대폰에 다시 보내는 중… (${fail})</div>` : ""}
        ${leader ? `<button class="qnext" data-a="next"${w.length && canCall() ? "" : " disabled"}>📢 다음 손님${w.length ? ` <b>${w[0].n}번</b>` : ""}</button><div class="qtools"><button data-a="walk"${canCall() ? "" : " disabled"}>＋ 직접 등록 (휴대폰 없는 손님)</button></div>` : ""}
        <div class="qlist" id="qList">${act.length ? act.map(rowHTML).join("") : `<div class="qempty">기다리는 손님이 없습니다</div>`}</div>
        ${done.length ? `<details class="done"${doneOpen ? " open" : ""}><summary>지난 손님 ${done.length}팀</summary><div class="qlist">${done.map(rowHTML).join("")}</div></details>` : ""}
        <div class="qfoot"><span>오늘 ${Q.list.length}팀 · 휴대폰 알림 ${sent}/${DAILY_LIMIT}건${sent >= 200 ? " ⚠️" : ""} · <span id="teamsLeft">남은 약 ${teamsLeft(sent)}팀</span>${TOK4 ? ` · <span id="tok4" title="오늘의 QR 코드 앞 4자리 (현장 확인용)">오늘 QR ${esc(TOK4)}</span>` : ""}</span>${leader && Q.list.length ? `<button data-a="reset">오늘 대기 초기화</button>` : ""}</div>
      </section>
    </main>`;
  const l = app.querySelector(".qlist"); if (l) l.scrollTop = y;
}
function walkOpen() {
  let p = 2; const d = $("walkDlg");
  const draw = () => {
    d.innerHTML = `<h3>＋ 직접 등록</h3><p class="muted">휴대폰이 없는 손님 · 인원을 고르세요</p><div class="party">${[1, 2, 3, 4, 5, 6].map(x => `<button data-p="${x}" class="${x === p ? "on" : ""}">${x}<small>${x === 6 ? "명+" : "명"}</small></button>`).join("")}</div>
      <div class="dlgbtns"><button data-w="no">닫기</button><button class="ok" data-w="ok">번호 받기</button></div>`;
  };
  draw(); d.showModal();
  d.onclick = e => {
    const pb = e.target.closest("[data-p]"); if (pb) { p = +pb.dataset.p; draw(); return; }
    const b = e.target.closest("[data-w]"); if (!b) return;
    if (b.dataset.w === "no") { d.close(); return; }
    if (b.dataset.w === "ok") {
      const n = Q.next++; Q.list.push({ n, d: "", p, at: Date.now(), st: "w", calls: 0, walk: 1 }); readyNext(true); qSave(); /* 따로 안 보냄 — 다음 방송에 묻어 감 */
      const d2 = $("walkDlg");
      d2.innerHTML = `<h3>🧾 대기 번호</h3><div class="walkbig">${n}<small style="font-size:32px">번</small></div><p class="muted" style="text-align:center">${ppl(p)} · 손님께 번호를 알려 주세요</p><div class="dlgbtns"><button class="ok" data-w="no">확인</button></div>`;
      d2.onclick = e2 => { if (e2.target.closest("[data-w]")) d2.close(); };
    }
  };
}
function drawSettings() {
  const d = $("setDlg"); if (!d) return;
  d.innerHTML = `<h3>⚙ 호출 설정 <span class="muted" style="font-size:14px">(이 기기만)</span></h3>
    <div class="set-row"><label class="t">읽을 말</label>${SHOP.langsAvailable.map(l => `<button class="chip${S.langs.includes(l) ? " on" : ""}" data-l="${l}">${LANGS[l].name}</button>`).join("")}</div>
    ${S.langs.map(l => { const vs = langVoices(l); return `<div class="set-row"><label class="t">${LANGS[l].name} 목소리</label><select data-v="${l}"><option value="">자동 (${esc(voiceFor(l)?.name.replace(/Microsoft |Online |\(Natural\)| - .*$/g, "").trim() || "없음")})</option>${vs.map(v => `<option value="${esc(v.name)}"${S.voice[l] === v.name ? " selected" : ""}>${/Natural/.test(v.name) ? "★ " : ""}${esc(v.name.replace(/Microsoft |Online |\(Natural\)| - .*$/g, "").trim())}${v.localService ? " · 기기" : " · 온라인"}</option>`).join("")}</select></div>`; }).join("")}
    <div class="set-row"><label class="t">반복</label>${[1, 2, 3].map(n => `<button class="chip${S.rep === n ? " on" : ""}" data-r="${n}">${n}번</button>`).join("")}</div>
    <div class="set-row" id="keyRow"><label class="t">QR 열쇠</label>${getKey() ? `<span class="muted" style="flex:1">🔑 있음 · 오늘 QR <b>${esc(TOK4)}</b></span><button data-k="pair">🔗 기기 연결 QR</button><button data-k="regen" id="keyRegen">열쇠 바꾸기</button>` : `<span class="muted" style="flex:1">없음</span><button data-k="make" id="keyMake" style="background:var(--accent);color:var(--accent-ink);font-weight:800">🔑 열쇠 만들기</button>`}</div>
    <div class="set-row"><label class="t">차임</label><label class="sw"><input type="checkbox" id="chimeOn"${S.chime ? " checked" : ""}>딩동댕동</label></div>
    <p class="muted" style="font-size:13px;line-height:1.5">★ = Edge 의 자연스러운 온라인 목소리. 인터넷이 끊기면 기기 목소리로 자동으로 바뀝니다.<br>${voices.length ? "" : "⚠️ 이 브라우저에 목소리가 없습니다. PC는 Edge, 안드로이드는 Chrome 을 써 주세요."}</p>
    <div class="dlgbtns"><button data-s="test">🔊 들어 보기</button><button class="ok" data-s="close">닫기</button></div>`;
  d.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.l) { const l = b.dataset.l; S.langs = S.langs.includes(l) ? S.langs.filter(x => x !== l) : SHOP.langsAvailable.filter(x => x === l || S.langs.includes(x)); if (!S.langs.length) S.langs = ["ko"]; saveS(); drawSettings(); render(); }
    else if (b.dataset.r) { S.rep = +b.dataset.r; saveS(); drawSettings(); render(); }
    else if (b.dataset.s === "test") { audio(); const rep = S.rep; S.rep = 1; announce(+S.num || 1, S.kind).finally(() => { S.rep = rep; }); }
    else if (b.dataset.s === "close") d.close();
    else if (b.dataset.k === "make") { newKey(); tokRefresh().then(drawSettings); render(); toast("🔑 열쇠를 만들었습니다 — 입구 태블릿·TV는 '🔗 기기 연결 QR'로 연결하세요", 4000); }
    else if (b.dataset.k === "regen") { if (!confirm("열쇠를 바꾸면 지금 QR이 바로 안 맞게 되고, 연결된 기기(입구 태블릿·TV·다른 직원 기기)를 모두 다시 연결해야 합니다. 바꿀까요?")) return; newKey(); tokRefresh().then(drawSettings); render(); toast("🔑 열쇠를 바꿨습니다 — 다른 기기를 '🔗 기기 연결 QR'로 다시 연결해 주세요", 5000); }
    else if (b.dataset.k === "pair") { d.close(); pairOpen(); }
  };
  d.onchange = e => {
    if (e.target.dataset.v) { S.voice[e.target.dataset.v] = e.target.value; saveS(); }
    if (e.target.id === "chimeOn") { S.chime = e.target.checked; saveS(); }
  };
}

function pairOpen(target = "door") {                     // 🔗 기기 연결 QR (비밀 열쇠가 담김 — 손님에게 보이지 않게)
  const key = getKey(), d = $("pairDlg");
  if (!key) { toast("먼저 ⚙ 설정에서 QR 열쇠를 만들어 주세요", 3500); drawSettings(); $("setDlg").showModal(); return; }
  const T = { door: ["🚪 입구 태블릿", "&door"], board: ["🖥 TV 번호판", "&board"], staff: ["📱 다른 직원 기기", ""] };
  const url = location.origin + location.pathname + "?s=" + CODE + T[target][1] + "#pair=" + key;
  d.innerHTML = `<h3>🔗 기기 연결 QR</h3><div class="set-row">${Object.keys(T).map(k => `<button class="chip${k === target ? " on" : ""}" data-t="${k}">${T[k][0]}</button>`).join("")}</div>
    <div id="pairQr" style="background:#fff;padding:12px;border-radius:12px;width:min(300px,100%);margin:8px auto"></div>
    <p class="muted" style="font-size:14px;line-height:1.5">연결할 기기의 카메라로 찍으면 <b>${T[target][0]}</b> 화면이 열리고 열쇠가 저장됩니다.<br>⚠️ 이 QR은 <b>비밀 열쇠</b>입니다. 손님에게 보이거나 사진으로 남기지 마세요.</p>
    <div class="dlgbtns"><button class="ok" data-t="close">닫기</button></div>`;
  qrImg(url, 600).then(src => { const b = $("pairQr"); if (b && src) b.innerHTML = `<img src="${src}" alt="기기 연결 QR" style="width:100%;display:block">`; });
  d.onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; if (b.dataset.t === "close") d.close(); else pairOpen(b.dataset.t); };
  if (!d.open) d.showModal();
}

// =====================================================================
// 손님 휴대폰 (?s=코드&q 줄 서기 · ?s=코드&n=번호 번호로 기다리기)
// =====================================================================
function guest() {
  document.title = SHOP.name + " · 대기";
  app.innerHTML = `<div class="gp" id="gp"></div>`;
  const box = $("gp"), shopH = `<div class="official" id="gOfficial">✅ ${esc(SHOP.name)} 공식 대기 화면 · 결제나 개인정보를 묻지 않습니다</div><div class="shop">${logoHTML()}<span>${esc(SHOP.name)}</span></div>`;
  const TK = TOK_RE.test((P.get("t") || "").trim()) ? P.get("t").trim() : "";   // 입구 화면 QR의 오늘 코드
  const changedH = () => `${shopH}<div class="gicon">🔄</div><h1 id="gTitle">QR이 바뀌었어요</h1><p class="sub">매장 입구 화면의 QR을 다시 찍어 주세요<span class="en">Please scan the QR on the entrance screen again</span></p><button class="glink" data-a="num">번호를 이미 받았어요</button>`;
  let dev = ls.get("dev", ""); if (!/^[a-z0-9]{8}$/.test(dev)) { dev = rnd(8); ls.set("dev", dev); }
  const d6 = dev.slice(0, 6);
  let tk = ls.get("ticket", null) || {};                // 이 휴대폰의 번호표
  let numMode = P.has("n") ? (parseInt(P.get("n"), 10) || 0) : 0, numAsk = P.has("n") && !numMode, numSince = Math.floor(Date.now() / 1000) - 120;
  let snap = null, loaded = false, party = 2, joining = 0, failed = "", es = null, ring = 0, ringEnd = 0, unlocked = false, numRung = ls.get("numRung", 0);
  const saveTk = () => ls.set("ticket", tk);
  const post = async body => { for (let i = 0; i < 3; i++) { try { const r = await fetch(topicIn(), { method: "POST", body }); if (r.ok) return true; } catch (e) {} await sleep(1200 * (i + 1)); } return false; };
  const wake = () => { try { navigator.wakeLock?.request("screen").catch(() => {}); } catch (e) {} };
  const unlock = () => { audio(); unlocked = !!ctx; wake(); vib(40); try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); } catch (e) {} };
  const ringStop = () => { if (ring || document.body.classList.contains("ring")) vib(0); clearInterval(ring); ring = 0; document.body.classList.remove("ring"); };
  const ringStart = (n, msg) => {
    ringStop(); ringEnd = Date.now() + 120000; document.body.classList.add("ring");
    const go = () => { if (Date.now() > ringEnd) { clearInterval(ring); ring = 0; return; } beep(); vib([500, 200, 500, 200, 900]); }; go(); ring = setInterval(go, 2500);
    try { if (Notification.permission === "granted" && document.visibilityState !== "visible") navigator.serviceWorker?.ready.then(r => r.showNotification(`🔔 ${n}번 ${msg.screen || "차례예요"}`, { body: msg.go || "", tag: "oc", renotify: true, vibrate: [500, 200, 500] })).catch(() => {}); } catch (e) {}
  };
  const msgOf = k => SHOP.messages[k] || Object.values(SHOP.messages)[0];
  function mine() {
    if (!snap) return null;
    const all = parseE(snap.e).filter(x => x.d === d6 && !(tk.skipR === snap.r && x.n <= (tk.skip || 0)));
    const e = all.find(x => isAct(x) || x.st === "n") || all.sort((a, b) => b.n - a.n)[0] || null;
    if (e && tk.cx === e.n && tk.r === snap.r) e.st = "x";
    return e;
  }
  const blocked = () => SUB.state === "blocked";
  function render() {
    // ---- 번호로 기다리기 (영수증·직원이 준 번호) ----
    if (numAsk) {
      box.innerHTML = `${shopH}<h1>번호로 알림 받기</h1><p class="sub">받은 번호를 넣어 주세요<span class="en">Enter your number</span></p>
        <input class="num" id="numIn" inputmode="numeric" pattern="[0-9]*" maxlength="4" aria-label="번호" autocomplete="off"><button class="gbtn" data-a="numgo">🔔 알림 받기</button>
        <button class="glink" data-a="back">← 줄 서기로</button>`; return;
    }
    if (numMode) {
      const called = snap && +snap.c === numMode && +snap.ct >= numSince, acked = called && tk.numAck === +snap.ct, msg = msgOf(snap && snap.ck);
      if (called && !acked) {
        if (numRung !== +snap.ct) { numRung = +snap.ct; ls.set("numRung", numRung); ringStart(numMode, msg); }
        box.innerHTML = `${shopH}<div class="gcard"><div class="glbl">내 번호</div><div class="gbig" id="gNum">${numMode}<small>번</small></div></div><h1 id="gTitle">${esc(msg.screen)}</h1><p class="sub">${esc(msg.go)}<span class="en">${esc(msg.screenEn || "")} · ${esc(msg.goEn || "")}</span></p>
          <button class="gbtn" data-a="ack">확인했어요</button>`; return;
      }
      ringStop();
      box.innerHTML = `${shopH}<div class="gcard"><div class="glbl">내 번호</div><div class="gbig" id="gNum">${numMode}<small>번</small></div>
        ${acked ? `<div class="gahead">맛있게 드세요 😊</div>` : `<div class="gahead" id="gTitle">⏳ 기다리는 중</div><div class="gest">차례가 되면 소리·진동으로 알려 드려요</div>`}
        ${snap && snap.c ? `<div class="gnow">지금 호출 <b>${+snap.c}번</b></div>` : ""}</div>
        ${unlocked ? "" : `<button class="gbtn" data-a="sound">🔔 알림 소리 켜기</button>`}<p class="gtxt">이 화면을 켜 둔 채 기다려 주세요.<br>Keep this screen open.</p>`; return;
    }
    // ---- 줄 서기 ----
    const me = mine();
    if (me) {
      if (tk.r !== snap.r || tk.n !== me.n) { tk = { r: snap.r, n: me.n, at: tk.n === me.n || joining ? tk.at : 0, p: tk.p, skip: tk.skip, skipR: tk.skipR }; saveTk(); }
      joining = 0; failed = "";
      const ents = parseE(snap.e), meta = tk.at && tk.p ? `<div class="gmeta">${hm(tk.at)} 등록 · ${ppl(tk.p)}</div>` : "";
      const big = `<div class="glbl">내 대기 번호 · My number</div><div class="gbig" id="gNum">${me.n}<small>번</small></div>`;
      let st = me.st; if (st === "c" && (tk.ack || 0) >= me.calls) st = "g";
      if (st === "c") {
        const msg = msgOf(snap.ck);
        if (tk.rung !== me.calls) { tk.rung = me.calls; saveTk(); ringStart(me.n, msg); }
        box.innerHTML = `${shopH}<div class="gcard">${big}</div><h1 id="gTitle">${esc(msg.screen || "차례가 됐어요!")}</h1><p class="sub">${esc(msg.go)}<span class="en">${esc(msg.screenEn || "")} · ${esc(msg.goEn || "")}</span></p>
          <button class="gbtn" data-a="go">확인했어요 · 가는 중</button><button class="glink" data-a="cancel">못 가요 (대기 취소)</button>`; return;
      }
      ringStop();
      if (st === "w") {
        const ahead = ents.filter(x => x.st === "w" && x.n < me.n).length, m = +snap.m || SHOP.minutesPerTeam;
        box.innerHTML = `${shopH}<div class="gcard">${big}<div class="gahead" id="gAhead">${ahead ? `앞에 ${ahead}팀 · 약 ${Math.max(1, Math.round(ahead * m))}분` : "다음 차례예요"}</div><div class="gest">${ahead ? `${ahead} team${ahead > 1 ? "s" : ""} ahead · about ${Math.max(1, Math.round(ahead * m))} min` : "You're next"}</div>${meta}
          ${snap.c ? `<div class="gnow">지금 호출 <b>${+snap.c}번</b></div>` : ""}</div>
          ${unlocked ? "" : `<button class="gbtn ghost" data-a="sound">🔔 알림 소리 켜기</button>`}<p class="gtxt">이 화면을 켜 두면 차례에 소리·진동으로 알려 드려요.<br>Keep this screen open — we'll ring you.</p>
          <button class="glink" data-a="cancel">대기 취소</button>`; return;
      }
      const [ic, h, sb] = { g: ["🚶", "가고 있어요", "입구 직원에게 번호를 보여 주세요"], i: ["😊", "입장했어요", "맛있게 드세요"], n: ["⏰", "순서가 지나갔어요", "카운터에 말씀해 주세요"], x: ["🙏", "대기가 취소됐어요", ""] }[st];
      box.innerHTML = `${shopH}<div class="gcard">${big}</div><div class="gicon">${ic}</div><h1 id="gTitle">${h}</h1>${sb ? `<p class="sub">${sb}</p>` : ""}` + (st === "g" ? "" : `<button class="gbtn ghost" data-a="again">다시 대기 등록</button>`); return;
    }
    ringStop();
    if (joining && snap && tk.nonce && String(snap.rj || "").split(",").includes(d6 + ":" + tk.nonce)) { joining = 0; failed = "tok"; }   // 가게가 거절 (QR 코드가 틀림·지난 것)
    if (failed === "tok") { box.innerHTML = changedH(); return; }
    if (joining || !loaded) { box.innerHTML = `${shopH}<div class="spin" aria-hidden="true"></div><p class="sub">${joining ? "번호 받는 중…" : "불러오는 중…"}</p>`; return; }
    if (blocked() || failed || (snap && !snap.o) || !snap) {
      box.innerHTML = `${shopH}<div class="gicon">🕒</div><h1 id="gTitle">${failed === "net" ? "인터넷 연결을 확인해 주세요" : "지금은 대기 등록을 받지 않아요"}</h1><p class="sub">카운터에 말씀해 주세요<span class="en">Please ask at the counter</span></p>
        ${blocked() ? "" : `<button class="gbtn ghost" data-a="retry">다시 시도</button>`}<button class="glink" data-a="num">번호를 이미 받았어요</button>`; return;
    }
    if (!TK) { box.innerHTML = changedH(); return; }      // 오늘 코드 없는 주소 (옛 QR·복사된 주소)
    const wN = parseE(snap.e).filter(x => x.st === "w").length;
    box.innerHTML = `${shopH}<h1>대기 등록</h1><p class="sub">몇 분이세요?<span class="en">How many people?</span></p>
      <div class="party" id="gParty">${[1, 2, 3, 4, 5, 6].map(p => `<button data-p="${p}" class="${p === party ? "on" : ""}" aria-pressed="${p === party}">${p}<small>${p === 6 ? "명+" : "명"}</small></button>`).join("")}</div>
      <button class="gbtn" data-a="join" id="gJoin">대기 등록 · Join</button><p class="gtxt" id="gWait">지금 대기 ${wN}팀 · 이름·전화번호는 받지 않아요</p>
      <button class="glink" data-a="num">번호를 이미 받았어요</button>`;
  }
  async function join() {
    if (!TK) return;
    const nonce = rnd(6);
    unlock(); joining = Date.now(); failed = ""; tk = { at: Date.now(), p: party, nonce, skip: tk.skip, skipR: tk.skipR }; saveTk(); render();
    const ok = await post(`J|${dev}|${party}|${nonce}|${Date.now()}|${TK}`);
    if (!ok) { joining = 0; failed = "net"; render(); return; }
    const j0 = joining; setTimeout(() => { if (joining === j0 && !mine()) { joining = 0; failed = "closed"; render(); } }, 10000);
  }
  box.addEventListener("click", e => {
    const pb = e.target.closest("[data-p]"); if (pb) { party = +pb.dataset.p; render(); return; }
    const b = e.target.closest("[data-a]"); if (!b) return; const a = b.dataset.a, me = numMode ? null : mine();
    if (a === "join") join();
    else if (a === "sound") { unlock(); render(); }
    else if (a === "retry") { failed = ""; listen(); render(); }
    else if (a === "num") { numAsk = true; render(); $("numIn")?.focus(); }
    else if (a === "back") { numAsk = false; numMode = 0; render(); }
    else if (a === "numgo") { const n = parseInt($("numIn").value, 10); if (!(n > 0)) { $("numIn").focus(); return; } unlock(); numMode = n; numAsk = false; numSince = Math.floor(Date.now() / 1000) - 120; history.replaceState(null, "", "?s=" + CODE + "&n=" + n); render(); }
    else if (a === "ack" && snap) { ringStop(); tk.numAck = +snap.ct; saveTk(); render(); post(`A|${dev}|${numMode}|${Date.now()}`); }
    else if (a === "go" && me) { ringStop(); unlock(); tk.ack = me.calls; saveTk(); render(); post(`G|${dev}|${me.n}|${snap.r}|${Date.now()}`); }
    else if (a === "cancel" && me) { if (!confirm("대기를 취소할까요?")) return; ringStop(); tk.cx = me.n; tk.r = snap.r; saveTk(); render(); post(`X|${dev}|${me.n}|${snap.r}|${Date.now()}`); }
    else if (a === "again" && me) { tk = { skip: me.n, skipR: snap.r }; saveTk(); render(); }
  });
  function listen() {
    es?.close(); clearTimeout(listen.t);
    if (typeof EventSource !== "function") { loaded = true; failed = "net"; render(); return; }
    es = new EventSource(topicOut() + "/sse?since=latest");
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data); if (d.event !== "message") return;
        const s = JSON.parse(d.message); if (!validSnap(s)) return;
        if (snap && (+s.t || 0) < (+snap.t || 0)) return;
        snap = s; loaded = true; render();
      } catch (er) {}
    };
    es.onerror = () => { if (es && es.readyState === 2) listen.t = setTimeout(listen, 5000); };
  }
  listen(); render(); setTimeout(() => { if (!loaded) { loaded = true; render(); } }, 4000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { listen(); if (unlocked) wake(); } });
}

// =====================================================================
// TV 번호판 (?s=코드&board) — 같은 PC 다른 창은 바로, 다른 기기(TV)는 중계로
// =====================================================================
function board() {
  document.title = SHOP.name + " · 번호판";
  let snap = null, lastCt = -1, qrTok = "";
  app.innerHTML = `<div class="bd"><header class="bd-top">${logoHTML()}<div class="nm">${esc(SHOP.name)}</div><div class="clock" id="bClock"></div></header>
    <div class="bd-main"><section class="bd-now" id="bNow"><div class="lbl">호출 번호 · Now calling</div><div class="num" id="bNum">–</div><div class="msg" id="bMsg">잠시만 기다려 주세요</div><div class="msgEn" id="bMsgEn">Please wait</div></section>
    <aside class="bd-side"><h2>최근 호출</h2><div class="bd-recent" id="bRecent"></div><div class="bd-wait"><div class="w" id="bWait"></div><div class="qr" id="bQr" hidden></div></div></aside></div></div>`;
  const tick = () => { const d = new Date(); $("bClock").textContent = `${d.getHours() < 12 ? "오전" : "오후"} ${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}`; };
  tick(); setInterval(tick, 10000);
  const draw = () => {
    if (!snap) return;
    const msg = SHOP.messages[snap.ck] || Object.values(SHOP.messages)[0], h = String(snap.h || "").split(",").filter(Boolean), ack = String(snap.a || "").split(","), w = parseE(snap.e).filter(x => x.st === "w").length;
    $("bNum").innerHTML = snap.c ? `${+snap.c}<small>번</small>` : "–";
    $("bMsg").textContent = snap.c ? msg.screen || "" : "잠시만 기다려 주세요"; $("bMsgEn").textContent = snap.c ? msg.screenEn || "" : "Please wait";
    $("bRecent").innerHTML = h.slice(1, 9).map(n => `<div class="${ack.includes(n) ? "ack" : ""}">${+n}</div>`).join("");
    $("bWait").innerHTML = snap.o || w ? `대기 ${w}팀<small>${snap.o ? "QR 찍고 대기 등록 · Scan to join" : "Waiting"}</small>` : `<small>대기 접수 전</small>`;
    $("bQr").hidden = !snap.o || !getKey();             // 열쇠 없는 번호판은 QR 숨김
    if (snap.o && getKey()) todayToken().then(t => { if (!t || t === qrTok) return; qrTok = t; qrImg(guestUrl(t), 600).then(src => { if (src) { $("bQr").innerHTML = `<img src="${src}" alt="대기 등록 QR">`; $("bQr").dataset.t = t; } }); });
    if (lastCt !== -1 && +snap.ct !== lastCt && snap.c) { const el = $("bNow"); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
    lastCt = +snap.ct;
  };
  snapFeed(s => { snap = s; draw(); });
  setInterval(draw, 30000);                             // 자정에 QR 새로
  window.addEventListener("storage", e => { if (e.key === ls.k("key")) { qrTok = ""; draw(); } });
  if (!snap) $("bWait").innerHTML = `<small>대기 접수 전</small>`;
}
function snapFeed(onSnap) {                               // 같은 PC 다른 창은 localStorage 로 바로, 다른 기기는 중계에서
  let last = null;
  const take = s => { if (!validSnap(s)) return; if (last && (+s.t || 0) <= (+last.t || 0)) return; last = s; onSnap(s); };
  take(ls.get("board", null));
  window.addEventListener("storage", e => { if (e.key === ls.k("board")) { try { take(JSON.parse(e.newValue)); } catch (er) {} } });
  let es = null;
  const listen = () => {
    es?.close(); if (typeof EventSource !== "function") return;
    es = new EventSource(topicOut() + "/sse?since=latest");
    es.onmessage = e => { try { const d = JSON.parse(e.data); if (d.event === "message") take(JSON.parse(d.message)); } catch (er) {} };
    es.onerror = () => { if (es && es.readyState === 2) setTimeout(listen, 5000); };
  };
  listen();
  const wake = () => { try { navigator.wakeLock?.request("screen").catch(() => {}); } catch (e) {} };
  wake(); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { wake(); listen(); } });
}

// =====================================================================
// 입구 태블릿 (?s=코드&door) — 하루에 한 번 바뀌는 큰 QR
// =====================================================================
function door() {
  document.title = SHOP.name + " · 입구";
  let snap = null, qrTok = "", qrKey = "";
  app.innerHTML = `<div class="dr"><header class="bd-top">${logoHTML()}<div class="nm">${esc(SHOP.name)}</div><button class="fs" id="dFs" aria-label="전체 화면">⛶ 전체 화면</button></header>
    <main class="dr-main"><section class="dr-qr" id="dQrBox"></section>
    <aside class="dr-info"><div class="dr-now"><div class="lbl">지금 호출 · Now calling</div><div class="num" id="dNum">–</div></div>
    <div class="dr-wait" id="dWait">대기 0팀</div><p class="dr-safe">✅ ${esc(SHOP.name)} 공식 대기 화면은<br>결제·개인정보를 묻지 않습니다</p></aside></main></div>`;
  const fsB = $("dFs");
  fsB.onclick = () => { try { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => toast("전체 화면을 쓸 수 없는 브라우저입니다")); } catch (e) {} };
  document.addEventListener("fullscreenchange", () => { fsB.hidden = !!document.fullscreenElement; });
  if (!document.documentElement.requestFullscreen) fsB.hidden = true;
  const box = $("dQrBox");
  const msg = (ic, h, en) => { qrTok = ""; box.innerHTML = `<div class="dr-msg"><div class="ic">${ic}</div><h1 id="dTitle">${h}</h1><p>${en}</p></div>`; };
  const draw = async () => {
    const w = snap ? parseE(snap.e).filter(x => x.st === "w").length : 0;
    $("dNum").innerHTML = snap && snap.c ? `${+snap.c}<small>번</small>` : "–";
    $("dWait").innerHTML = `대기 <b>${w}</b>팀<small>${w} team${w === 1 ? "" : "s"} waiting</small>`;
    const key = getKey();
    if (!key) return msg("🔗", "직원 화면에서 기기 연결 QR을 찍어 주세요", "Staff: scan the device-link QR on the staff screen");
    if (!snap || !snap.o) return msg("🕒", "지금은 대기 등록을 받지 않아요", "Not accepting the waiting list now · Please ask staff");
    const t = await todayToken(); if (!t) return msg("⚠️", "이 브라우저에서는 QR을 만들 수 없어요", "Use Chrome or Edge");
    if (t === qrTok && key === qrKey && box.querySelector("img")) return;
    qrTok = t; qrKey = key;
    const src = await qrImg(guestUrl(t), 720); if (t !== qrTok) return;
    box.innerHTML = `<h1 class="dr-h">QR 찍고 <b>대기 등록하세요</b></h1><div class="dr-en">Scan to join the waiting list</div><div class="dr-code" id="dQr" data-t="${esc(t)}">${src ? `<img src="${src}" alt="오늘의 대기 등록 QR">` : "QR을 만들지 못했습니다"}</div><div class="dr-name">${esc(SHOP.name)} 공식 대기 등록 QR</div><div class="dr-day">${kstDate(nowMs())} 오늘의 QR · 매일 자정에 바뀝니다</div>`;
  };
  snapFeed(s => { snap = s; draw(); });
  draw(); setInterval(draw, 30000);                     // 자정 지나면 새 QR
  window.addEventListener("storage", e => { if (e.key === ls.k("key")) draw(); });
}

// =====================================================================
// 카운터 QR 안내판 (A5 인쇄)
// =====================================================================
async function sign() {
  document.title = SHOP.name + " · QR 안내판";
  const st = document.createElement("style");
  st.textContent = `@page{size:A5 portrait;margin:0}html,body{background:#fff;color:#1c1917;-webkit-print-color-adjust:exact;print-color-adjust:exact;color-scheme:light}
  .pg{width:148mm;min-height:210mm;padding:11mm 11mm 9mm;display:flex;flex-direction:column;align-items:center;text-align:center;background:#fff;margin:0 auto}
  .sh{display:flex;align-items:center;gap:3mm;font-size:17pt;font-weight:900;color:${SHOP.color}}.sh .logo{width:12mm;height:12mm;font-size:16pt;border-radius:3mm;color:#fff}
  .pg h1{font-size:24pt;line-height:1.25;margin:5mm 0 1mm;font-weight:900;word-break:keep-all}.pg h1 b{color:${SHOP.color}}.pg .en{font-size:11pt;color:#78716c;margin-bottom:5mm}
  .qr{background:#fff;border-radius:6mm;padding:4mm;box-shadow:0 0 0 1.4mm ${SHOP.color}}.qr img{width:68mm;height:68mm;display:block}
  .pg ol{list-style:none;padding:0;margin:7mm 0 0;width:100%;display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}.pg li{background:#f5f5f4;border-radius:4mm;padding:3.5mm 2mm;font-size:11.5pt;font-weight:700;line-height:1.35;word-break:keep-all}
  .pg li i{display:block;font-style:normal;width:8mm;height:8mm;line-height:8mm;margin:0 auto 1.5mm;border-radius:50%;background:${SHOP.color};color:#fff;font-weight:900}.pg li small{display:block;font-weight:400;font-size:8.5pt;color:#78716c;margin-top:1mm}
  .door{margin-top:2mm;border:1.4mm solid ${SHOP.color};border-radius:6mm;padding:8mm 6mm;width:100%;display:flex;flex-direction:column;gap:2mm;font-size:18pt;word-break:keep-all}.door .scr{font-size:34pt}.door span{font-size:11pt;color:#78716c}
  .safe{margin-top:6mm;background:#ecfdf5;color:#065f46;border-radius:4mm;padding:3.5mm 4mm;font-size:11pt;line-height:1.5;width:100%;word-break:keep-all}.safe small{color:#047857;font-size:8.5pt}
  .note{margin-top:auto;padding-top:5mm;font-size:10pt;color:#57534e;line-height:1.55}
  @media screen{body{background:#e7e5e4!important;padding:16px 0}.pg{box-shadow:0 4px 20px #0002}}
  @media screen and (max-width:600px){.pg{width:100%;min-height:0;padding:20px 16px}.qr img{width:60vw;height:60vw}}`;
  document.head.appendChild(st);
  app.innerHTML = `<div class="pg"><div class="sh">${logoHTML()}<span>${esc(SHOP.name)}</span></div>
    <h1>대기 등록은<br><b>입구 화면의 QR</b>로</h1><div class="en">Join the waiting list with the QR on the entrance screen</div>
    <div class="door" id="signDoor"><div class="scr">📱 ➜ 🖥</div><b>입구 화면의 QR을 찍어 주세요</b><span>Scan the QR on the entrance screen</span></div>
    <ol><li><i>1</i>입구 화면의<br>QR 찍기<small>Scan the entrance-screen QR</small></li><li><i>2</i>인원 고르고<br>대기 등록<small>Choose party size</small></li><li><i>3</i>차례가 되면<br>🔔 알려 드려요<small>We'll ring your phone</small></li></ol>
    <div class="safe" id="signSafe">✅ ${esc(SHOP.name)} 공식 대기 화면은 <b>결제·개인정보를 묻지 않습니다</b><br><small>Our official waiting page never asks for payment or personal info</small></div>
    <div class="note">📱 번호 화면을 켜 두면 차례에 소리·진동으로 알려 드립니다.<br>이름·전화번호는 받지 않아요. 휴대폰이 없으면 카운터에 말씀해 주세요.<br><span style="color:#a8a29e">Keep the screen open · No name or phone number needed</span></div></div>`;
  if (!P.has("noprint")) setTimeout(() => print(), 500);
}
})();
