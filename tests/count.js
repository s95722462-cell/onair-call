// 시험: 손님 한 팀당 중계(ntfy) 보내는 건수 세기 — node tests/count.js  (가짜 중계만 씀)
// 입장·노쇼 등은 따로 안 보내고 다음 방송에 묻어 감. 끝에 남은 방송이 다 나갈 때까지 기다린 뒤에 셈 (FLUSH_WAIT, 옛 버전 비교 때 64초).
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const PW = process.env.PW || "C:/Users/ds5yr/OneDrive/문서/GitHub/IERP-V2260821/e2e/node_modules/playwright";
const { chromium } = require(PW);
const { startApp, startRelay } = require("./server");
const SHOTS = process.env.SHOTS || path.join(__dirname, "out"); fs.mkdirSync(SHOTS, { recursive: true });
const APP = 8751, REL = 8752, BASE = `http://127.0.0.1:${APP}/`, LAZY = 8000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = n => [...Array(n)].map(() => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("");
const kstDate = ms => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const tok = (key, date) => crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(date).digest("base64url").slice(0, 10);
async function waitFor(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(150); } return false; }
const txt = async (p, sel) => { try { return (await p.textContent(sel, { timeout: 500 })) || ""; } catch (e) { return ""; } };
const errors = [];

(async () => {
  const app = await startApp(APP), relay = await startRelay(REL);
  const browser = await chromium.launch({ args: ["--mute-audio"] });
  const init = `window.OC_RELAY = "http://127.0.0.1:${REL}/"; window.confirm = () => true;
    try { speechSynthesis.speak = u => setTimeout(() => { u.onstart && u.onstart(); u.onend && u.onend(); }, 10); speechSynthesis.cancel = () => {}; } catch (e) {}`;
  const ctx = async vp => { const c = await browser.newContext({ viewport: vp }); await c.addInitScript(init); return c; };
  const page = async (c, url) => { const p = await c.newPage(); p.on("pageerror", e => errors.push(e.message)); await p.goto(BASE + url); return p; };
  const code = "tst" + rnd(21), topicS = "oc" + code + "-s", topicI = "oc" + code + "-i";
  const sc = await ctx({ width: 1280, height: 800 }), staff = await page(sc, `?s=${code}`);
  await staff.waitForSelector("#callBtn");
  await staff.click("[data-a=set]"); await staff.click("#keyMake"); await sleep(300); await staff.click('#setDlg [data-s="close"]');
  const key = await staff.evaluate(c => JSON.parse(localStorage.getItem("oc_" + c + "_key")), code), T = tok(key, kstDate(Date.now()));
  await staff.check("#qOn"); await sleep(2500);
  const count = () => ({ s: relay.msgs.filter(m => m.topic === topicS).length, i: relay.msgs.filter(m => m.topic === topicI).length });
  const join = async () => { const c = await ctx({ width: 390, height: 844 }), g = await page(c, `?s=${code}&q&t=${T}`); await g.waitForSelector("#gJoin"); await g.click("#gJoin"); return g; };
  const serve = async g => {
    await waitFor(async () => !!(await g.$("#gNum"))); const n = parseInt(await txt(g, "#gNum"), 10);
    const t0 = Date.now(); await staff.click("[data-a=next]");
    const rang = await waitFor(async () => g.evaluate(() => document.body.classList.contains("ring")));
    const ringMs = Date.now() - t0;
    await g.click("[data-a=go]");
    await waitFor(async () => (await txt(staff, `[data-row="${n}"]`)).includes("확인"));
    await staff.click(`[data-a=in][data-n="${n}"]`);
    return { rang, ringMs };
  };
  const rows = [], rings = [];
  // A. 한 팀씩 (등록 → 호출 → 확인 → 입장, 다음 팀은 몇 초 뒤)
  let c0 = count();
  for (let k = 0; k < 3; k++) { const g = await join(); await sleep(1500); const r = await serve(g); rings.push(r); await sleep(2500); }
  await sleep(+process.env.FLUSH_WAIT || LAZY + 3000); let c1 = count();
  rows.push({ name: "한 팀씩 3팀", teams: 3, shop: c1.s - c0.s, guest: c1.i - c0.i });
  // B. 붐빔 (4팀이 한꺼번에 등록 → 차례로 호출)
  c0 = count();
  const gs = await Promise.all([0, 1, 2, 3].map(() => join()));
  for (const g of gs) rings.push(await serve(g));
  await sleep(+process.env.FLUSH_WAIT || LAZY + 3000); c1 = count();
  rows.push({ name: "붐빔 4팀", teams: 4, shop: c1.s - c0.s, guest: c1.i - c0.i });
  await browser.close(); app.close(); relay.server.close();
  let fail = 0;
  for (const r of rows) {
    r.shopPer = +(r.shop / r.teams).toFixed(2); r.allPer = +((r.shop + r.guest) / r.teams).toFixed(2);
    const pass = r.shopPer <= 2 && r.allPer <= 4; if (!pass) fail++;
    console.log(`${pass ? "통과" : "실패"} · ${r.name}: 가게→손님 ${r.shop}건 (팀당 ${r.shopPer}) · 손님→가게 ${r.guest}건 · 합계 팀당 ${r.allPer}`);
  }
  const ringOk = rings.every(r => r.rang), maxRing = Math.max(...rings.map(r => r.ringMs));
  console.log(`${ringOk && maxRing < 3000 ? "통과" : "실패"} · 호출 → 손님 휴대폰 울림 늦지 않음 (가장 늦은 ${maxRing}ms)`); if (!ringOk || maxRing >= 3000) fail++;
  console.log(`${errors.length ? "실패" : "통과"} · JS 오류 0${errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""}`); if (errors.length) fail++;
  fs.writeFileSync(path.join(SHOTS, "count.json"), JSON.stringify({ rows, maxRing, errors }, null, 2));
  process.exit(fail ? 1 : 0);
})();
