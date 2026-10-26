// 아이콘 만들기 (한 번만): node tests/make_icons.js
const path = require("path");
const PW = process.env.PW || "C:/Users/ds5yr/OneDrive/문서/GitHub/IERP-V2260821/e2e/node_modules/playwright";
const { chromium } = require(PW);
(async () => {
  const b = await chromium.launch();
  for (const s of [192, 512]) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<body style="margin:0"><div style="width:${s}px;height:${s}px;background:#14110f;display:grid;place-items:center">
      <div style="width:${s * .78}px;height:${s * .78}px;border-radius:${s * .2}px;background:#e0662b;display:grid;place-items:center;color:#fff;font:900 ${s * .3}px 'Malgun Gothic',sans-serif;letter-spacing:-.04em">호출</div></div></body>`);
    await p.screenshot({ path: path.join(__dirname, "..", "icons", `icon-${s}.png`) });
  }
  await b.close();
})();
