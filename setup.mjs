// 면접 자리 배치 — 한 번에 설치하기
// 하는 일: Firebase 프로젝트 만들기 → 익명 로그인 켜기 → Firestore 만들기 → 보안 규칙 올리기
//          → config.js 채우기 → GitHub 저장소 만들고 올리기 → GitHub Pages 켜기 → 소유자 링크 열기
// 중간에 멈춰도 다시 실행하면 끝난 단계는 건너뜁니다(.setup-state.json 에 기록).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const STATE = ".setup-state.json";
const REPO_DEFAULT = "interview-seat";
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));

const say = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✔ ${m}`);
const stop = (m) => { console.log(`\n✖ ${m}\n`); process.exit(1); };
function run(cmd, { quiet = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", stdio: quiet ? ["inherit", "pipe", "pipe"] : "inherit" });
  if (r.status !== 0 && !allowFail) {
    if (quiet) console.log((r.stdout || "") + (r.stderr || ""));
    stop(`명령이 실패했어요: ${cmd}`);
  }
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const has = (cmd) => spawnSync(cmd, { shell: true, stdio: "ignore" }).status === 0;
const FB = "npx --no-install firebase";
// --json 결과는 stdout 에만 읽음 (stderr 의 경고 문구가 섞이면 JSON이 깨짐)
const fbJson = (args) => {
  const r = spawnSync(`${FB} ${args} --json`, { shell: true, encoding: "utf8" });
  const o = r.stdout || "";
  try { return JSON.parse(o.slice(o.indexOf("{"), o.lastIndexOf("}") + 1)); } catch (e) { return { status: "error", error: o + (r.stderr || "") }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function openUrl(u) {
  const c = process.platform === "win32" ? `start "" "${u}"` : process.platform === "darwin" ? `open "${u}"` : `xdg-open "${u}"`;
  spawnSync(c, { shell: true, stdio: "ignore" });
}

// 0. 필요한 프로그램
say("필요한 프로그램 확인");
const missing = [];
if (!has("git --version")) missing.push("winget install --id Git.Git -e");
if (!has("gh --version")) missing.push("winget install --id GitHub.cli -e");
if (missing.length) stop(`아래 명령으로 설치한 뒤, 터미널을 새로 열고 다시 실행해 주세요.\n  ${missing.join("\n  ")}`);
ok("git, gh, node 준비됨");
if (!fs.existsSync("node_modules/firebase-tools")) { say("Firebase 도구 설치 (1~2분)"); run("npm install --no-audit --no-fund"); }

// 1. Firebase 로그인
say("Firebase(Google) 로그인 — 브라우저가 열리면 로그인하고 허용을 눌러 주세요");
run(`${FB} login`);

// 2. 프로젝트
if (!st.projectId) {
  const id = `interview-seat-${crypto.randomBytes(3).toString("hex")}`;
  say(`Firebase 프로젝트 만들기 (${id}) — 1분 정도 걸려요`);
  const r = run(`${FB} projects:create ${id} -n "Interview Seat"`, { allowFail: true });
  if (r.code !== 0) stop("프로젝트를 만들지 못했어요. https://console.firebase.google.com 을 한 번 열어 약관에 동의한 뒤 다시 실행해 주세요. (프로젝트가 너무 많으면 안 쓰는 프로젝트를 지워 주세요)");
  st.projectId = id; save();
}
const P = st.projectId;
ok(`프로젝트: ${P}`);

// 3. 웹 앱 + config.js
if (!st.sdk) {
  say("웹 앱 등록");
  let apps = fbJson(`apps:list WEB --project ${P}`).result || [];
  if (!apps.length) { run(`${FB} apps:create WEB seat --project ${P}`); apps = fbJson(`apps:list WEB --project ${P}`).result || []; }
  for (let i = 0; i < 5 && !apps.length; i++) { await sleep(5000); apps = fbJson(`apps:list WEB --project ${P}`).result || []; }
  if (!apps.length) stop("웹 앱을 찾지 못했어요. 1분 뒤 다시 실행해 주세요.");
  const cfg = fbJson(`apps:sdkconfig WEB ${apps[0].appId} --project ${P}`);
  const sdk = cfg.result && (cfg.result.sdkConfig || cfg.result);
  if (!sdk || !sdk.apiKey) stop("웹 앱 설정값을 읽지 못했어요. 다시 실행해 주세요.");
  st.sdk = { apiKey: sdk.apiKey, authDomain: sdk.authDomain, projectId: sdk.projectId, storageBucket: sdk.storageBucket, messagingSenderId: sdk.messagingSenderId, appId: sdk.appId };
  save();
}
fs.writeFileSync("config.js", `// 설치 스크립트가 채운 Firebase 웹 앱 정보 (공개돼도 되는 값이에요. 권한은 firestore.rules 가 지켜요)\nwindow.FIREBASE_CONFIG = ${JSON.stringify(st.sdk, null, 2)};\n`);
ok("config.js 채움");

async function token() {
  const auth = require("firebase-tools/lib/auth");
  const acct = auth.getGlobalDefaultAccount();
  if (!acct) throw new Error("no account");
  const t = await auth.getAccessToken(acct.tokens.refresh_token, []);
  return typeof t === "string" ? t : t.access_token;
}
async function g(method, url, body, tk) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${tk}`, "x-goog-user-project": P, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, text: await r.text() };
}
// 4. Firestore (필요한 Google API 먼저 켜기)
if (!st.apis) {
  say("필요한 기능 켜기 (Firestore · 보안 규칙 · 로그인)");
  try {
    const tk = await token();
    for (const svc of ["firestore.googleapis.com", "firebaserules.googleapis.com", "identitytoolkit.googleapis.com"]) {
      await g("POST", `https://serviceusage.googleapis.com/v1/projects/${P}/services/${svc}:enable`, {}, tk);
    }
    await sleep(15000);
  } catch (e) {}
  st.apis = true; save();
}
if (!st.firestore) {
  say("Firestore 데이터베이스 만들기 (서울)");
  const r = run(`${FB} firestore:databases:create "(default)" --location asia-northeast3 --project ${P}`, { quiet: true, allowFail: true });
  if (r.code !== 0 && !/already exists|ALREADY_EXISTS/i.test(r.out)) { console.log(r.out); st.apis = false; save(); stop("Firestore를 만들지 못했어요. 1분 뒤 다시 실행해 주세요."); }
  st.firestore = true; save();
}
ok("Firestore 준비됨");

// 5. 익명 로그인 켜기 (가입 없이 들어오게)
if (!st.anon) {
  say("가입 없이 들어오기(익명 로그인) 켜기");
  let done = false;
  try {
    const tk = await token();
    await g("POST", `https://serviceusage.googleapis.com/v1/projects/${P}/services/identitytoolkit.googleapis.com:enable`, {}, tk);
    const patch = () => g("PATCH", `https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config?updateMask=signIn.anonymous.enabled`, { signIn: { anonymous: { enabled: true } } }, tk);
    for (let i = 0; i < 4 && !done; i++) {
      let r = await patch();
      if (!r.ok && /CONFIGURATION_NOT_FOUND/.test(r.text)) {
        await g("POST", `https://identitytoolkit.googleapis.com/v2/projects/${P}/identityPlatform:initializeAuth`, {}, tk);
        r = await patch();
      }
      if (r.ok) done = true; else await sleep(8000);
    }
  } catch (e) {}
  if (!done) {
    console.log(`  자동으로 켜지 못했어요. 지금 열리는 화면에서 [시작하기] → [익명] → [사용 설정] → [저장] 을 눌러 주세요.`);
    openUrl(`https://console.firebase.google.com/project/${P}/authentication/providers`);
    spawnSync(process.platform === "win32" ? "pause" : "read -p '다 했으면 Enter: '", { shell: true, stdio: "inherit" });
  }
  st.anon = true; save();
}
ok("익명 로그인 켜짐");

// 6. 보안 규칙
say("보안 규칙 올리기");
run(`${FB} deploy --only firestore:rules --project ${P} --non-interactive`);
ok("보안 규칙 적용됨");

// 7. GitHub
say("GitHub 로그인 확인");
if (!has("gh auth status")) { console.log("  브라우저가 열리면 GitHub에 로그인하고 코드를 붙여 넣어 주세요."); run("gh auth login --web -h github.com -p https"); }
run("gh auth setup-git", { quiet: true, allowFail: true });
const login = run("gh api user -q .login", { quiet: true }).out.trim();
ok(`GitHub: ${login}`);

if (!fs.existsSync(".git")) run("git init -q -b main");
if (!run("git config user.name", { quiet: true, allowFail: true }).out.trim()) run(`git config user.name "${login}"`);
if (!run("git config user.email", { quiet: true, allowFail: true }).out.trim()) {
  const uid = run("gh api user -q .id", { quiet: true }).out.trim();
  run(`git config user.email "${uid}+${login}@users.noreply.github.com"`);
}
run("git add -A");
run('git commit -q -m "면접 자리 배치 설치"', { allowFail: true, quiet: true });

if (!st.repo) {
  let name = REPO_DEFAULT;
  for (let i = 2; has(`gh repo view ${login}/${name}`); i++) name = `${REPO_DEFAULT}-${i}`;
  say(`GitHub 저장소 만들고 올리기 (${login}/${name})`);
  run(`gh repo create ${name} --public --source . --remote origin --push`);
  st.repo = `${login}/${name}`; save();
} else {
  say(`GitHub에 올리기 (${st.repo})`);
  run("git push -u origin main");
}

// 8. GitHub Pages
say("웹 주소(GitHub Pages) 켜기");
run(`gh api -X POST repos/${st.repo}/pages -f "source[branch]=main" -f "source[path]=/"`, { quiet: true, allowFail: true });
const url = `https://${login.toLowerCase()}.github.io/${st.repo.split("/")[1]}/`;
st.url = url; save();
process.stdout.write("  사이트를 준비하는 중");
for (let i = 0; i < 40; i++) {
  const s = run(`gh api repos/${st.repo}/pages/builds/latest -q .status`, { quiet: true, allowFail: true }).out.trim();
  if (s === "built") break;
  process.stdout.write("."); await sleep(6000);
}
console.log("");

// 9. 소유자 링크 열기
const ownerLink = `${url}#owner`;
if (!st.ownerOpened) {
  say("소유자 등록 — 지금 열리는 페이지에서 이름을 적으면 이 브라우저가 소유자가 돼요");
  openUrl(ownerLink); st.ownerOpened = true; save();
}

console.log(`
==================================================
 설치 끝!

 같이 쓰는 사람에게 보낼 링크:
   ${url}

 처음 들어온 사람은 이름을 적고 권한을 요청해요.
 선생님 화면의 [🔑 권한 관리]에서 관리자/보기로 승인하면 돼요.

 명단 넣기: 페이지에서 [더보기 → 엑셀 명단 불러오기]
           → 이 폴더의 "면접_명단_불러오기용.xlsx"

 ※ 소유자 링크(${ownerLink})는 다른 사람에게 보내지 마세요.
   (이미 소유자가 정해져서 다른 사람이 열어도 소유자가 되진 않아요)
==================================================
`);
