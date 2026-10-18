const fs = require("fs");
const p = "AGENTS.md";
const s = fs.readFileSync(p, "utf8");
const lines = s.split("\n");
const ins = fs.readFileSync(".tmp-s1111.txt", "utf8").trim();
const anchor = "- **拒绝后翻案（Guardian post-denial 规则；用户 2026-10-17";
let done = 0;
const out = [];
for (const line of lines) {
  out.push(line);
  if (line.startsWith(anchor)) { out.push(""); out.push(ins); done += 1; }
}
fs.writeFileSync(p, out.join("\n"));
console.log("inserted:", done);
if (done !== 1) process.exit(1);