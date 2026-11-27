// Firebase 연결: 가입 없이(익명) 들어와 이름으로 권한 요청 → 소유자가 관리자/보기로 승인
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, query, orderBy, limit, onSnapshot,
  setDoc, deleteDoc, getDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const done = (v) => window.fbResolve && window.fbResolve(v);

if (!window.FIREBASE_CONFIG) {
  console.error("config.js 에 FIREBASE_CONFIG 가 없습니다.");
  done(null);
} else {
  start().catch((e) => { console.error(e); done(null); });
}

async function start() {
  const app = initializeApp(window.FIREBASE_CONFIG);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  if (!auth.currentUser) await signInAnonymously(auth);
  const user = await new Promise((r) => { const u = onAuthStateChanged(auth, (x) => { if (x) { u(); r(x); } }); });
  const uid = user.uid;

  // 소유자 링크(#owner): 설치 직후 처음 연 브라우저 한 곳이 소유자가 돼요
  let ownerUid = null;
  try { const m = await getDoc(doc(fs, "meta", "owner")); if (m.exists()) ownerUid = m.data().uid; } catch (e) {}
  if (/(^|[#&])owner/.test(location.hash)) {
    if (!ownerUid) {
      try { await setDoc(doc(fs, "meta", "owner"), { uid, at: serverTimestamp() }); ownerUid = uid; } catch (e) {}
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  const firstOwner = ownerUid === uid;

  let me = await memberOf(fs, uid);
  if (!me) me = firstOwner ? await ownerName(fs, uid) : await requestAccess(fs, uid);
  const owner = firstOwner || me.role === "owner";

  const role = owner ? "owner" : me.role;
  if (!firstOwner) watchMyRole(fs, uid, me.role);
  startPresence(fs, uid, role, me.name);
  if (owner) startAdmin(fs);
  done({ db: adapter(fs), role: role === "viewer" ? "viewer" : "admin", owner, uid, name: me.name });
}

async function memberOf(fs, uid) {
  try { const s = await getDoc(doc(fs, "members", uid)); return s.exists() ? s.data() : null; } catch (e) { return null; }
}
const cleanName = (v) => String(v || "").replace(/[<>&"'`\/]/g, "").replace(/^\.+|\.+$/g, "").trim().slice(0, 20);
const SAME_NAME = (n) => `'${n}' 이름이 이미 있어요(동명이인). 이름 뒤에 B를 붙여서 다시 요청해 주세요. 예: ${n}B`;

// 이름 중복 막기: names/{이름} 문서를 먼저 차지한 사람만 그 이름을 씀
async function claimName(fs, uid, name, forUid) {
  const owner = forUid || uid;
  try {
    const s = await getDoc(doc(fs, "names", name));
    if (s.exists()) return s.data().uid === owner;
    await setDoc(doc(fs, "names", name), { uid: owner });
    return true;
  } catch (e) { return false; }
}
async function releaseName(fs, uid, name) {
  if (!name) return;
  try { const s = await getDoc(doc(fs, "names", name)); if (s.exists() && s.data().uid === uid) await deleteDoc(doc(fs, "names", name)); } catch (e) {}
}

function showGate(msg, btnText, wait) {
  $("gate").hidden = false; $("gateMsg").textContent = msg; $("gateBtn").textContent = btnText;
  $("gateWait").hidden = !wait; $("gateWait").textContent = wait || "";
}

// 소유자는 이름만 적으면 바로 시작
function ownerName(fs, uid) {
  return new Promise((resolve) => {
    showGate("소유자로 확인됐어요. 접속자 목록에 보일 이름을 적어 주세요.", "시작하기");
    const go = async () => {
      const name = cleanName($("gateName").value); if (!name) return $("gateName").focus();
      if (!(await claimName(fs, uid, name))) { $("gateWait").hidden = false; $("gateWait").textContent = SAME_NAME(name); return; }
      const m = { name, role: "owner", at: serverTimestamp() };
      await setDoc(doc(fs, "members", uid), m);
      $("gate").hidden = true; resolve(m);
    };
    $("gateBtn").onclick = go; $("gateName").onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
}

// 처음 온 사람: 이름(정자)으로 권한 요청 → 승인될 때까지 기다림
async function requestAccess(fs, uid) {
  let sent = null;
  try { const s = await getDoc(doc(fs, "requests", uid)); if (s.exists()) sent = s.data(); } catch (e) {}
  const waitMsg = (n) => `${n} 님의 권한 요청을 보냈어요. 승인되면 이 화면이 자동으로 열려요.`;
  showGate("이름을 정자로 적고 권한을 요청해 주세요. 가입은 필요 없어요.", sent ? "이름 고쳐서 다시 요청" : "권한 요청", sent ? waitMsg(sent.name) : "");
  if (sent) $("gateName").value = sent.name;
  const send = async () => {
    const name = cleanName($("gateName").value); if (!name) return $("gateName").focus();
    $("gateBtn").disabled = true;
    try {
      if (!(await claimName(fs, uid, name))) {
        $("gateWait").hidden = false; $("gateWait").textContent = SAME_NAME(name);
        $("gateName").value = name + "B"; $("gateBtn").disabled = false; $("gateName").focus(); return;
      }
      if (sent && sent.name !== name) await releaseName(fs, uid, sent.name);
      await setDoc(doc(fs, "requests", uid), { name, at: serverTimestamp() });
      sent = { name };
      $("gateBtn").textContent = "이름 고쳐서 다시 요청"; $("gateWait").hidden = false; $("gateWait").textContent = waitMsg(name);
    } catch (e) { $("gateWait").hidden = false; $("gateWait").textContent = "요청을 보내지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요."; }
    $("gateBtn").disabled = false;
  };
  $("gateBtn").onclick = send; $("gateName").onkeydown = (e) => { if (e.key === "Enter") send(); };
  return new Promise((resolve) => {
    const un = onSnapshot(doc(fs, "members", uid), (s) => {
      if (s.exists()) { un(); $("gate").hidden = true; resolve(s.data()); }
    }, () => {});
  });
}

// 소유자가 권한을 바꾸거나 회수하면 그 사람 화면을 새로 고침
function watchMyRole(fs, uid, role) {
  onSnapshot(doc(fs, "members", uid), (s) => {
    if (!s.exists() || s.data().role !== role) location.reload();
  }, () => {});
}

// 페이지 코드가 쓰는 doc()/collection() 모양에 맞춘 얇은 연결부
function wrap(s) {
  return { id: s.id, exists: s.exists(), data: () => s.data(), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } };
}
function mkQ(ref, cons) {
  return {
    orderBy: (f, d) => mkQ(ref, [...cons, orderBy(f, d || "asc")]),
    limit: (n) => mkQ(ref, [...cons, limit(n)]),
    onSnapshot: (next, err) => onSnapshot(cons.length ? query(ref, ...cons) : ref,
      (qs) => next({ docs: qs.docs.map(wrap), size: qs.size, empty: qs.empty, metadata: qs.metadata }), err),
  };
}
function adapter(fs) {
  return {
    doc: (p) => ({
      set: (d) => setDoc(doc(fs, p), d),
      delete: () => deleteDoc(doc(fs, p)),
      onSnapshot: (next, err) => onSnapshot(doc(fs, p), (s) => next(wrap(s)), err),
    }),
    collection: (p) => mkQ(collection(fs, p), []),
  };
}

// ===== 권한 관리(소유자만) =====
function startAdmin(fs) {
  const st = { requests: [], members: [] };
  const push = () => window.onPermData && window.onPermData(st);
  const ms = (v) => (v && v.toMillis ? v.toMillis() : Date.now());
  onSnapshot(collection(fs, "requests"), (qs) => {
    st.requests = qs.docs.map((d) => ({ uid: d.id, name: cleanName(d.data().name) || "이름 없음", at: ms(d.data().at) })).sort((a, b) => a.at - b.at);
    push();
  }, () => {});
  let backfilled = false;
  onSnapshot(collection(fs, "members"), (qs) => {
    st.members = qs.docs.map((d) => ({ uid: d.id, name: cleanName(d.data().name) || "이름 없음", role: d.data().role })).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    if (!backfilled) { backfilled = true; st.members.forEach((m) => claimName(fs, null, m.name, m.uid)); }
    push();
  }, () => {});
  window.PERM = {
    approve: async (uid, name, role) => {
      const b = writeBatch(fs);
      b.set(doc(fs, "members", uid), { name: cleanName(name), role, at: serverTimestamp() });
      b.delete(doc(fs, "requests", uid));
      await b.commit();
    },
    reject: async (uid, name) => { await deleteDoc(doc(fs, "requests", uid)); await releaseName(fs, uid, name); },
    setRole: (uid, name, role) => setDoc(doc(fs, "members", uid), { name: cleanName(name), role, at: serverTimestamp() }),
    revoke: async (uid, name) => { await deleteDoc(doc(fs, "members", uid)); await releaseName(fs, uid, name); },
  };
  push();
}

// ===== 접속 중인 사람 =====
const ALIVE_MS = 75000;
function startPresence(fs, uid, role, name) {
  const meRef = doc(fs, "presence", uid);
  const beat = () => setDoc(meRef, { name, role, lastSeen: serverTimestamp() }).catch(() => {});
  beat();
  setInterval(beat, 25000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") beat(); });
  window.addEventListener("pagehide", () => { deleteDoc(meRef).catch(() => {}); });
  const RL = { owner: "소유자", admin: "관리자", viewer: "보기" };
  let last = [];
  const draw = () => {
    const now = Date.now();
    const rank = (r) => (r === "owner" ? 0 : r === "admin" ? 1 : 2);
    const live = last.filter((p) => now - p.ts < ALIVE_MS).sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name, "ko"));
    const box = $("who"); box.replaceChildren();
    if (!live.length) { const m = document.createElement("span"); m.className = "meta"; m.textContent = "없음"; box.append(m); return; }
    const c = document.createElement("b"); c.textContent = live.length + "명"; c.style.fontSize = "13px"; box.append(c);
    live.forEach((p) => {
      const e = document.createElement("span");
      e.className = "p" + (p.role !== "viewer" ? " adm" : "") + (p.id === uid ? " me" : "");
      e.append(document.createElement("i"), document.createTextNode(`${p.name} · ${RL[p.role] || "보기"}${p.id === uid ? " (나)" : ""}`));
      box.append(e);
    });
  };
  onSnapshot(collection(fs, "presence"), (qs) => {
    last = qs.docs.map((d) => { const v = d.data(); return { id: d.id, name: cleanName(v.name) || "이름 없음", role: v.role, ts: v.lastSeen && v.lastSeen.toMillis ? v.lastSeen.toMillis() : Date.now() }; });
    draw();
  }, () => {});
  setInterval(draw, 15000);
}
