// 시험: node tests/e2e.js [--real]   (--real = 실제 ntfy.sh 로 2건만 보내는 시험 포함)
// 스크린샷 폴더: 환경 변수 SHOTS (없으면 tests/out)
const fs = require("fs"), path = require("path");
const PW = process.env.PW || "C:/Users/ds5yr/OneDrive/문서/GitHub/IERP-V2260821/e2e/node_modules/playwright";
const { chromium } = require(PW);
const { startApp, startRelay } = require("./server");
const SHOTS = process.env.SHOTS || path.join(__dirname, "out"); fs.mkdirSync(SHOTS, { recursive: true });
const APP = 8741, REL = 8742, BASE = `http://127.0.0.1:${APP}/`;
const SHOP = fs.readdirSync(path.join(__dirname, "..", "shops")).find(f => f.endsWith(".json")).replace(".json", "");   // 실제 가게 설정 (가짜 중계로만 씀)
const results = [], errors = [];
const ok = (name, pass, info = "") => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? "통과" : "실패"} · ${name}${info ? " — " + info : ""}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const crypto = require("crypto"), DAY = 86400000, KSTO = 9 * 3600e3;
const kstDate = ms => new Date(ms + KSTO).toISOString().slice(0, 10);
const tok = (key, date) => crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(date).digest("base64url").slice(0, 10);   // 앱과 같은 방식으로 따로 계산
let KEY = "", TODAY = "";
const rnd = n => [...Array(n)].map(() => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join("");

function initScript(relay) {
  return `(() => {
    ${relay ? `window.OC_RELAY = ${JSON.stringify(relay)};` : ""}
    window.__said = [];
    try {
      const ss = window.speechSynthesis;
      ss.speak = u => { window.__said.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name }); setTimeout(() => { u.onstart && u.onstart(); setTimeout(() => u.onend && u.onend(), 20); }, 10); };
      ss.cancel = () => {};
    } catch (e) {}
    window.confirm = () => true;
  })();`;
}
async function ctxNew(browser, vp, relay = `http://127.0.0.1:${REL}/`) {
  const c = await browser.newContext({ viewport: vp, locale: "ko-KR" });
  await c.addInitScript(initScript(relay));
  return c;
}
async function pageNew(c, url, tag) {
  const p = await c.newPage();
  p.on("pageerror", e => errors.push(`[${tag}] ${e.message}`));
  p.on("console", m => { if (m.type() === "error" && !/net::ERR|Failed to load resource|ERR_INTERNET_DISCONNECTED|EventSource/i.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`); });
  await p.goto(BASE + url); return p;
}
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function waitFor(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (e) {} await sleep(150); } return false; }
const txt = async (p, sel) => { try { return (await p.textContent(sel, { timeout: 500 })) || ""; } catch (e) { return ""; } };

(async () => {
  const app = await startApp(APP), relay = await startRelay(REL);
  const browser = await chromium.launch({ args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
  try {
    // ---------- 1. 직원 호출 → 번호판 (두 창) ----------
    const sc = await ctxNew(browser, { width: 1280, height: 800 });
    const staff = await pageNew(sc, `?s=${SHOP}`, "직원");
    await staff.waitForSelector("#callBtn");
    const board = await pageNew(sc, `?s=${SHOP}&board`, "번호판"); await board.setViewportSize({ width: 1920, height: 1080 });
    await board.waitForSelector("#bNum");
    for (const k of ["C", "1", "5"]) await staff.click(`[data-a=pad][data-k="${k}"]`);
    ok("숫자 패드로 15 입력", (await txt(staff, "#curNum")).startsWith("15"));
    await staff.click("#callBtn");
    ok("호출 → 한국어·영어로 읽음", await waitFor(async () => { const s = await staff.evaluate(() => window.__said.map(x => x.text)); return s.some(t => t.startsWith("15번 손님")) && s.some(t => t.startsWith("Number 15")); }), (await staff.evaluate(() => window.__said.map(x => x.text).join(" / "))).slice(0, 120));
    ok("번호판 창에 15번 표시", await waitFor(async () => (await txt(board, "#bNum")).startsWith("15")));
    await staff.click("[data-a=plus]"); ok("+1 → 16", (await txt(staff, "#curNum")).startsWith("16"));
    await staff.click("[data-a=minus]"); await staff.click("[data-a=minus]"); ok("−1 두 번 → 14", (await txt(staff, "#curNum")).startsWith("14"));
    await staff.click('[data-a=kind][data-k="take"]'); await staff.click("#callBtn");
    ok("포장 호출 14 → 번호판 갱신·포장 문구", await waitFor(async () => (await txt(board, "#bNum")).startsWith("14") && (await txt(board, "#bMsg")).includes("포장")));
    await sleep(600); await staff.evaluate(() => (window.__said.length = 0));
    await staff.click("#againBtn");
    ok("다시 부르기 → 14번 다시 읽음", await waitFor(async () => (await staff.evaluate(() => window.__said.map(x => x.text))).some(t => t.startsWith("14번"))));
    ok("번호판 최근 호출에 15", (await txt(board, "#bRecent")).includes("15"));
    await staff.click('[data-a=kind][data-k="seat"]');

    // ---------- 2. 줄 서기 ----------
    ok("열쇠 없음 안내 표시", !!(await staff.$("#keyBan")));
    await staff.click("#qOn"); await sleep(300);
    ok("열쇠 없으면 접수 못 켬 → 설정 열림", !(await staff.isChecked("#qOn")) && await staff.evaluate(() => document.getElementById("setDlg").open));
    await staff.click("#keyMake"); await sleep(300); await staff.click('#setDlg [data-s="close"]');
    KEY = await staff.evaluate(c => JSON.parse(localStorage.getItem("oc_" + c + "_key") || '""'), SHOP); TODAY = tok(KEY, kstDate(Date.now()));
    ok("열쇠 만들기 (이 기기 localStorage)", /^[A-Za-z0-9_-]{43}$/.test(KEY));
    ok("직원 화면 구석에 오늘 QR 앞 4자리", await waitFor(async () => (await txt(staff, "#tok4")).includes(TODAY.slice(0, 4))), await txt(staff, "#tok4"));
    await staff.check("#qOn"); await sleep(400);
    ok("대기 접수 켜짐", await staff.isChecked("#qOn"));
    const g1c = await ctxNew(browser, { width: 390, height: 844 }), g1 = await pageNew(g1c, `?s=${SHOP}&q&t=${TODAY}`, "손님1");
    await g1.waitForSelector("#gJoin", { timeout: 8000 });
    ok("손님 등록 화면 390 넘침 없음", (await overflow(g1)) <= 0);
    await g1.screenshot({ path: path.join(SHOTS, "guest_join_390.png") });
    await g1.click('#gParty [data-p="3"]'); await g1.click("#gJoin");
    ok("손님1 대기 번호 받음", await waitFor(async () => !!(await g1.$("#gNum"))), await txt(g1, "#gNum"));
    const n1 = parseInt(await txt(g1, "#gNum"), 10);
    ok("직원 목록에 손님1 (3명) 표시", await waitFor(async () => (await txt(staff, `[data-row="${n1}"]`)).includes("3명")));
    const g2c = await ctxNew(browser, { width: 390, height: 844 }), g2 = await pageNew(g2c, `?s=${SHOP}&q&t=${TODAY}`, "손님2");
    await g2.waitForSelector("#gJoin"); await g2.click('#gParty [data-p="2"]'); await g2.click("#gJoin");
    ok("손님2 '앞에 1팀 · 약 N분' 표시", await waitFor(async () => /앞에 1팀 · 약 \d+분/.test(await txt(g2, "#gAhead"))), await txt(g2, "#gAhead"));
    ok("손님 대기 화면 390 넘침 없음", (await overflow(g2)) <= 0);
    await g2.screenshot({ path: path.join(SHOTS, "guest_waiting_390.png") });
    await g2.setViewportSize({ width: 320, height: 700 }); ok("손님 대기 화면 320 넘침 없음", (await overflow(g2)) <= 0); await g2.setViewportSize({ width: 390, height: 844 });
    ok("직원 '대기 2팀'", await waitFor(async () => (await txt(staff, "#waitN")) === "2"));
    await staff.screenshot({ path: path.join(SHOTS, "staff_1280x800.png") });
    await staff.click("[data-a=next]");
    ok("다음 손님 → 손님1 휴대폰 알림(번쩍)", await waitFor(async () => (await g1.evaluate(() => document.body.classList.contains("ring"))) && (await txt(g1, "#gTitle")).includes("자리가 준비")));
    await g1.screenshot({ path: path.join(SHOTS, "guest_called_390.png") });
    ok("손님2 화면 '다음 차례예요'", await waitFor(async () => (await txt(g2, "#gAhead")).includes("다음 차례")));
    await g1.click("[data-a=go]");
    ok("손님1 '확인했어요' → 직원 목록 '확인'", await waitFor(async () => (await txt(staff, `[data-row="${n1}"]`)).includes("확인")));
    await staff.click(`[data-a=in][data-n="${n1}"]`);
    ok("입장 처리 → 손님1 '입장했어요'", await waitFor(async () => (await txt(g1, "#gTitle")).includes("입장"), 70000));
    const n2 = parseInt(await txt(g2, "#gNum"), 10);
    await staff.click(`[data-a=qcall][data-n="${n2}"]`); await sleep(500);
    await staff.click(`[data-a=no][data-n="${n2}"]`);
    ok("노쇼 처리 → 손님2 '순서가 지나갔어요'", await waitFor(async () => (await txt(g2, "#gTitle")).includes("지나갔"), 30000));
    await staff.click("[data-a=walk]"); await staff.click('#walkDlg [data-p="4"]'); await staff.click('#walkDlg [data-w="ok"]');
    ok("직접 등록 → 번호 표시", /\d+/.test(await txt(staff, "#walkDlg .walkbig"))); await staff.click('#walkDlg [data-w="no"]');

    // ---------- 3. 번호로 기다리기 (영수증 번호) ----------
    const g3c = await ctxNew(browser, { width: 390, height: 844 }), g3 = await pageNew(g3c, `?s=${SHOP}&n=77`, "손님3");
    await g3.waitForSelector("#gNum"); await sleep(500);
    for (const k of ["C", "7", "7"]) await staff.click(`[data-a=pad][data-k="${k}"]`);
    await staff.click("#callBtn");
    const r77 = await waitFor(async () => g3.evaluate(() => document.body.classList.contains("ring")));
    ok("번호 77 호출 → 손님3 알림", r77, r77 ? "" : `직원 ${await txt(staff, "#curNum")} / 손님 ${(await txt(g3, "#gp")).slice(0, 80)} / 중계 마지막 ${relay.msgs.slice(-1).map(m => m.message.slice(0, 120))}`);
    await g3.click("[data-a=ack]");
    ok("손님3 '확인했어요' → 직원 알림·번호판 ✓", await waitFor(async () => (await txt(staff, "#toast")).includes("77") || (await board.evaluate(() => [...document.querySelectorAll("#bRecent .ack")].map(x => x.textContent).join(","))).includes("77"), 10000));
    await sleep(2500);
    await board.screenshot({ path: path.join(SHOTS, "board_1920x1080.png") });

    // ---------- 4. 오프라인: 스피커 호출은 계속 ----------
    await sc.setOffline(true); await sleep(300); await staff.evaluate(() => (window.__said.length = 0));
    await staff.click("[data-a=plus]"); await staff.click("#callBtn");
    ok("인터넷 끊김에도 스피커 호출(읽기)", await waitFor(async () => (await staff.evaluate(() => window.__said.length)) > 0));
    await staff.reload().catch(() => {}); await sleep(1000);
    ok("인터넷 끊김에서 새로 고침 → 저장본으로 열림(서비스 워커)", !!(await staff.$("#callBtn")));
    await sc.setOffline(false);

    // ---------- 5. 구독 만료 ----------
    const ec = await ctxNew(browser, { width: 1280, height: 800 });
    const ex = await pageNew(ec, `?s=exp${rnd(20)}`, "만료"); await ex.waitForSelector("#callBtn");
    ok("만료 10일 지남 → 호출 버튼 막힘", await ex.isDisabled("#callBtn"));
    ok("만료 안내 표시", (await txt(ex, "#subBan")).includes("끝났"));
    ok("만료 → 대기 접수 스위치 막힘", await ex.isDisabled("#qOn"));
    const gr = await pageNew(ec, `?s=grc${rnd(20)}`, "유예"); await gr.waitForSelector("#callBtn");
    ok("만료 2일 지남(유예) → 호출 가능 + 경고", !(await gr.isDisabled("#callBtn")) && (await txt(gr, "#subBan")).includes("일 뒤"), await txt(gr, "#subBan"));
    const eg = await pageNew(ec, `?s=exp${rnd(20)}&q`, "만료손님"); await eg.setViewportSize({ width: 390, height: 844 });
    ok("만료 가게 손님 → 등록 안 받음", await waitFor(async () => (await txt(eg, "#gp")).includes("받지 않아요")));

    // ---------- 6. 넘침 · 안내판 ----------
    for (const w of [320, 390]) {
      await staff.setViewportSize({ width: w, height: 800 }); await sleep(200);
      ok(`직원 화면 ${w}px 넘침 없음`, (await overflow(staff)) <= 0, String(await overflow(staff)));
      const gn = await pageNew(g3c, `?s=${SHOP}&n`, "번호입력"); await gn.setViewportSize({ width: w, height: 700 }); await gn.waitForSelector("#numIn");
      ok(`번호 입력 화면 ${w}px 넘침 없음`, (await overflow(gn)) <= 0); await gn.close();
    }
    const sg = await pageNew(sc, `?s=${SHOP}&sign&noprint`, "안내판"); await sg.setViewportSize({ width: 620, height: 900 });
    ok("종이 안내판: QR 없이 '입구 화면의 QR' 안내", await waitFor(async () => (await txt(sg, "#signDoor")).includes("입구 화면의 QR")) && !(await sg.$(".pg img")));
    ok("종이 안내판: 결제·개인정보 안내", (await txt(sg, "#signSafe")).includes("결제·개인정보를 묻지 않습니다"));
    await sg.screenshot({ path: path.join(SHOTS, "sign_A5.png"), fullPage: true });
    await sg.setViewportSize({ width: 320, height: 700 }); ok("안내판 320px 넘침 없음", (await overflow(sg)) <= 0);

    // ---------- 8. 오늘의 QR (하루 한 번 바뀌는 코드) ----------
    await staff.setViewportSize({ width: 1280, height: 800 });
    const guestAt = async (t, tag) => { const c = await ctxNew(browser, { width: 390, height: 844 }); return pageNew(c, `?s=${SHOP}&q${t ? "&t=" + t : ""}`, tag); };
    const joinRes = async g => {
      if (!(await waitFor(async () => !!(await g.$("#gJoin")), 8000))) return "등록 버튼 없음";
      await g.click("#gJoin"); let r = "시간 초과";
      await waitFor(async () => { if (await g.$("#gNum")) { r = "허용"; return true; } if ((await txt(g, "#gTitle")).includes("QR이 바뀌었어요")) { r = "거절"; return true; } return false; }, 15000);
      return r;
    };
    const gNo = await guestAt("", "t없음");
    ok("t 없는 주소 → 등록 버튼 대신 'QR이 바뀌었어요'", await waitFor(async () => (await txt(gNo, "#gTitle")).includes("QR이 바뀌었어요")) && !(await gNo.$("#gJoin")));
    ok("손님 화면 맨 위 '공식 대기 화면 · 결제나 개인정보를 묻지 않습니다'", (await txt(gNo, "#gOfficial")).includes("공식 대기 화면") && (await txt(gNo, "#gOfficial")).includes("개인정보"));
    const gBad = await guestAt("AAAAAAAAAA", "틀린t"); const rBad = await joinRes(gBad);
    ok("틀린 t → 거절", rBad === "거절", rBad);
    await gBad.screenshot({ path: path.join(SHOTS, "guest_rejected_390.png") });
    await gBad.setViewportSize({ width: 320, height: 700 }); ok("거절 화면 320px 넘침 없음", (await overflow(gBad)) <= 0);
    const kNow = Date.now() + KSTO, noonOff = Math.floor(kNow / DAY) * DAY + 12 * 3600e3 - kNow;
    await staff.evaluate(o => { window.OC_NOW_OFFSET = o; }, noonOff);
    const rY = await joinRes(await guestAt(tok(KEY, kstDate(Date.now() - DAY)), "어제t"));
    ok("어제 t (낮 12시) → 거절", rY === "거절", rY);
    const rT = await joinRes(await guestAt(TODAY, "오늘t"));
    ok("오늘 t → 허용", rT === "허용", rT);
    const nextMid = (Math.floor(kNow / DAY) + 1) * DAY;
    await staff.evaluate(o => { window.OC_NOW_OFFSET = o; }, nextMid + 10 * 60000 - kNow);
    const rM1 = await joinRes(await guestAt(TODAY, "자정10분"));
    ok("자정 뒤 00:10 · 어제 t → 허용 (30분 유예)", rM1 === "허용", rM1);
    await staff.evaluate(o => { window.OC_NOW_OFFSET = o; }, nextMid + 40 * 60000 - kNow);
    const rM2 = await joinRes(await guestAt(TODAY, "자정40분"));
    ok("자정 뒤 00:40 · 어제 t → 거절", rM2 === "거절", rM2);
    await staff.evaluate(() => { window.OC_NOW_OFFSET = 0; });
    // 열쇠 바꾸기
    await staff.click("[data-a=set]"); await staff.click("#keyRegen"); await sleep(300); await staff.click('#setDlg [data-s="close"]');
    const KEY2 = await staff.evaluate(c => JSON.parse(localStorage.getItem("oc_" + c + "_key") || '""'), SHOP), TODAY2 = tok(KEY2, kstDate(Date.now()));
    ok("열쇠 바꾸기 → 새 열쇠", KEY2 && KEY2 !== KEY);
    const rOld = await joinRes(await guestAt(TODAY, "옛열쇠t"));
    ok("열쇠 바꾼 뒤 옛 token → 거절", rOld === "거절", rOld);
    const rNew = await joinRes(await guestAt(TODAY2, "새열쇠t"));
    ok("새 열쇠 token → 허용", rNew === "허용", rNew);
    ok("번호판(열쇠 있음) QR = 오늘 새 token", await waitFor(async () => (await board.getAttribute("#bQr", "data-t")) === TODAY2, 40000));
    // 기기 연결
    const dc = await ctxNew(browser, { width: 1280, height: 800 });
    const dr = await pageNew(dc, `?s=${SHOP}&door#pair=${KEY2}`, "입구");
    ok("기기 연결: #pair 저장 후 주소에서 지워짐", await waitFor(async () => (await dr.evaluate(() => location.hash)) === "" && (await dr.evaluate(c => JSON.parse(localStorage.getItem("oc_" + c + "_key") || '""'), SHOP)) === KEY2));
    ok("입구 화면: 오늘의 QR (token 일치)", await waitFor(async () => (await dr.getAttribute("#dQr", "data-t")) === TODAY2 && !!(await dr.$("#dQr img")), 10000));
    ok("입구 화면: 지금 호출 · 대기 N팀", /\d/.test(await txt(dr, "#dNum")) && (await txt(dr, "#dWait")).includes("대기"));
    ok("입구 화면 1280x800 넘침 없음", (await overflow(dr)) <= 0);
    await sleep(3800); await dr.screenshot({ path: path.join(SHOTS, "door_1280x800.png") });
    await dr.setViewportSize({ width: 800, height: 1280 }); await sleep(500);
    ok("입구 화면 800x1280 넘침 없음", (await overflow(dr)) <= 0);
    ok("입구 화면 세로: 대기·안내가 화면 안에", await dr.evaluate(() => ["dWait", "dQr"].every(id => document.getElementById(id).getBoundingClientRect().bottom <= innerHeight) && document.querySelector(".dr-safe").getBoundingClientRect().bottom <= innerHeight));
    await dr.screenshot({ path: path.join(SHOTS, "door_800x1280.png") });
    const nk = await ctxNew(browser, { width: 1280, height: 800 });
    const drNo = await pageNew(nk, `?s=${SHOP}&door`, "입구-열쇠없음");
    ok("입구 화면 열쇠 없음 → '기기 연결 QR을 찍어 주세요'", await waitFor(async () => (await txt(drNo, "#dTitle")).includes("기기 연결 QR")));
    const bdNo = await pageNew(nk, `?s=${SHOP}&board`, "번호판-열쇠없음"); await sleep(2500);
    ok("열쇠 없는 번호판 → QR 숨김", await bdNo.evaluate(() => document.getElementById("bQr").hidden));
    const gGuestPair = await pageNew(nk, `?s=${SHOP}&q#pair=${KEY2}`, "손님-pair");
    ok("손님 화면은 #pair 저장 안 함 (주소에서만 지움)", await waitFor(async () => (await gGuestPair.evaluate(() => location.hash)) === "") && !(await gGuestPair.evaluate(c => localStorage.getItem("oc_" + c + "_key"), SHOP)));
    await staff.click("#qOn"); await sleep(300);
    ok("접수 중지 → 입구 화면 '지금은 대기 등록을 받지 않아요'", await waitFor(async () => (await txt(dr, "#dTitle")).includes("받지 않아요"), 10000));

    // ---------- 7. 실제 ntfy.sh (2건만) ----------
    if (process.argv.includes("--real")) {
      const code = "tst" + rnd(21);
      const rs = await ctxNew(browser, { width: 1280, height: 800 }, ""), rg = await ctxNew(browser, { width: 390, height: 844 }, "");
      const rst = await pageNew(rs, `?s=${code}`, "실제-직원"); await rst.waitForSelector("#callBtn");
      const rgu = await pageNew(rg, `?s=${code}&n=5`, "실제-손님"); await rgu.waitForSelector("#gNum"); await sleep(3000);
      for (const k of ["C", "5"]) await rst.click(`[data-a=pad][data-k="${k}"]`);
      await rst.click("#callBtn");                                    // 1건: 스냅숏
      ok("실제 ntfy.sh: 호출 → 손님 휴대폰 알림", await waitFor(async () => rgu.evaluate(() => document.body.classList.contains("ring")), 20000));
      if (await rgu.$("[data-a=ack]")) await rgu.click("[data-a=ack]");  // 2건: 확인
      ok("실제 ntfy.sh: 손님 '확인했어요' → 직원 화면", await waitFor(async () => (await txt(rst, "#toast")).includes("5번"), 20000));
    }
  } catch (e) { ok("시험 중단 (예외)", false, e.message.split("\n")[0]); }
  ok("JS 오류 0", errors.length === 0, errors.slice(0, 5).join(" | "));
  await browser.close(); app.close(); relay.server.close();
  const f = results.filter(r => !r.pass).length;
  console.log(`\n합계 ${results.length - f}/${results.length} 통과`);
  fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify({ results, errors }, null, 2));
  process.exit(f ? 1 : 0);
})();
