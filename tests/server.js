// 시험용: 앱 정적 서버 + 가짜 ntfy 중계 (POST 저장 · /<topic>/sse 내보내기)
// 시험용 가게코드: tst… = 보통, exp… = 만료 10일 지남(막힘), grc… = 만료 2일 지남(유예)
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const day = (d) => { const t = new Date(Date.now() + d * 86400000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
function fixture(code) {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "shop.json"), "utf8"));
  if (code.startsWith("exp")) base.expires = day(-10);
  else if (code.startsWith("grc")) base.expires = day(-2);
  else base.expires = day(60);
  return JSON.stringify(base);
}
function startApp(port) {
  return new Promise(ok => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname);
      const m = /^\/shops\/([a-z0-9]+)\.json$/.exec(p);
      if (m && /^(tst|exp|grc)/.test(m[1]) && !fs.existsSync(path.join(ROOT, p))) { res.writeHead(200, { "Content-Type": TYPES[".json"] }); res.end(fixture(m[1])); return; }
      if (p.endsWith("/")) p += "index.html";
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" }); fs.createReadStream(f).pipe(res);
    });
    s.listen(port, "127.0.0.1", () => ok(s));
  });
}
function startRelay(port) {
  const msgs = [], subs = []; let seq = 0;
  return new Promise(ok => {
    const s = http.createServer((req, res) => {
      const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
      const u = new URL(req.url, "http://x"), parts = u.pathname.split("/").filter(Boolean);
      if (req.method === "POST" && parts.length === 1) {
        let body = ""; req.on("data", c => body += c); req.on("end", () => {
          const m = { id: "m" + (++seq), time: Math.floor(Date.now() / 1000), event: "message", topic: parts[0], message: body };
          msgs.push(m); subs.filter(x => x.topic === m.topic).forEach(x => x.res.write(`data: ${JSON.stringify(m)}\n\n`));
          res.writeHead(200, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(m));
        });
        return;
      }
      if (req.method === "GET" && parts.length === 2 && parts[1] === "sse") {
        res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ event: "open", topic: parts[0] })}\n\n`);
        const since = u.searchParams.get("since"), mine = msgs.filter(m => m.topic === parts[0]);
        const old = since === "latest" ? mine.slice(-1) : mine.filter(m => m.time >= (+since || 0));
        old.forEach(m => res.write(`data: ${JSON.stringify(m)}\n\n`));
        const sub = { topic: parts[0], res }; subs.push(sub); req.on("close", () => subs.splice(subs.indexOf(sub), 1));
        return;
      }
      res.writeHead(404, cors); res.end();
    });
    s.listen(port, "127.0.0.1", () => ok({ server: s, msgs }));
  });
}
module.exports = { startApp, startRelay };
if (require.main === module) { startApp(8731).then(() => console.log("app http://127.0.0.1:8731/")); startRelay(8732).then(() => console.log("relay http://127.0.0.1:8732/")); }
