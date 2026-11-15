"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random().toString(16).slice(2));
const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
// 카카오맵 level: 숫자가 작을수록 확대. 장소를 저장하려면 이 level 이하로 확대해야 함
const MAX_PHOTOS = 6, MAX_ADD_LEVEL = 5, ADD_ZOOM_LEVEL = 3, LABEL_LEVEL = 4, BUCKET = "place-photos", MAX_LINKS = 10;

// ───────── 링크 ─────────
// 입력한 글을 http/https 주소로 정리한다. 주소가 아니거나 다른 종류(javascript: 등)면 null.
function normLink(s) {
  s = String(s || "").trim();
  // "제목 + 주소"로 공유된 글은 그 안의 주소만 꺼낸다 (네이버·카카오 공유 등)
  if (!/^https?:\/\/\S+$/i.test(s)) { const m = s.match(/https?:\/\/[^\s<>"']+/i); if (m) s = m[0]; }
  if (!s || s.length > 2000) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^(mailto|tel|javascript|data|file|blob|sms):/i.test(s)) s = "https://" + s; // "instagram.com/p/…"처럼 앞부분을 뺀 경우
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || !u.hostname.includes(".")) return null;
    ["igsh", "igshid", "utm_source", "utm_medium", "utm_campaign", "fbclid"].forEach((k) => u.searchParams.delete(k)); // 공유 추적용 값은 지움
    return u.href;
  } catch (e) { return null; }
}
// 화면에 보여줄 이름: 인스타그램은 종류까지, 나머지는 사이트 이름
function linkLabel(href) {
  try {
    const u = new URL(href), host = u.hostname.replace(/^www\./, ""), seg = u.pathname.split("/").filter(Boolean);
    if (/(^|\.)instagram\.com$/.test(host)) return seg[0] === "p" ? "Instagram 게시물" : seg[0] === "reel" || seg[0] === "reels" ? "Instagram 릴스" : seg[0] === "stories" ? "Instagram 스토리" : "Instagram";
    if (/(^|\.)(naver\.com|naver\.me)$/.test(host)) return host.startsWith("m.place") || host.startsWith("place") || host === "naver.me" ? "네이버 지도" : host.startsWith("blog") || host.startsWith("m.blog") ? "네이버 블로그" : "네이버";
    if (/(^|\.)(kakao\.com)$/.test(host) && /map/.test(host)) return "카카오맵";
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) return "YouTube";
    return host;
  } catch (e) { return href; }
}
const shortUrl = (href) => { try { const u = new URL(href); return (u.hostname.replace(/^www\./, "") + u.pathname + u.search).replace(/\/$/, ""); } catch (e) { return href; } };
// 저장돼 있던 값도 화면에 내보내기 전에 다시 검사한다
const safeLinks = (arr) => (Array.isArray(arr) ? arr : []).map(normLink).filter(Boolean);

function toast(m, ms = 2600) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }

// 키보드가 올라와도 시트가 가려지지 않게 보이는 영역 크기를 CSS 변수로 전달
(function trackViewport() {
  const vv = window.visualViewport, root = document.documentElement;
  const upd = () => {
    const h = vv ? vv.height : window.innerHeight, off = vv ? vv.offsetTop : 0;
    root.style.setProperty("--vvh", h + "px");
    const kb = Math.max(0, window.innerHeight - h - off);
    root.style.setProperty("--kb", kb + "px");
    root.classList.toggle("kb-on", kb > 80);
  };
  if (vv) { vv.addEventListener("resize", upd); vv.addEventListener("scroll", upd); }
  window.addEventListener("resize", upd); upd();
})();

// ───────── 서버 연결 ─────────
const cfgOk = window.CONFIG && window.supabase && !/여기에/.test(window.CONFIG.SUPABASE_URL + window.CONFIG.SUPABASE_ANON_KEY);
const sb = cfgOk ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY) : null;
let me = null, places = [], profiles = {};
const nameOf = (id) => profiles[id]?.name || "다른 사용자";
const isMine = (p) => !!me && p.owner === me.id;
// status: want = 가볼 곳(빨강), visited = 가본 곳(파랑)
const norm = (r) => ({ ...r, photos: Array.isArray(r.photos) ? r.photos : [], status: r.status === "visited" ? "visited" : "want", links: safeLinks(r.links), createdAt: Date.parse(r.created_at) || Date.now(), updatedAt: Date.parse(r.updated_at) || Date.now(), visitedAt: r.visited_at ? Date.parse(r.visited_at) : null });
const STATUS_LABEL = { want: "가볼 곳", visited: "가본 곳" };
const updCount = () => ($("cnt").textContent = places.length);

// 비공개 사진은 1시간짜리 임시 주소로 받아서 보여준다
const urlCache = new Map();
async function signedUrls(paths) {
  const now = Date.now(), need = paths.filter((p) => !urlCache.has(p) || urlCache.get(p).exp < now + 60000);
  if (need.length) {
    try {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
      if (!error && data) data.forEach((d) => { if (d.signedUrl) urlCache.set(d.path, { url: d.signedUrl, exp: now + 3600e3 }); });
    } catch (e) {}
  }
  return paths.map((p) => (urlCache.get(p) && urlCache.get(p).url) || null);
}
async function fillImages(root, paths) {
  const urls = await signedUrls(paths);
  root.querySelectorAll("img[data-path]").forEach((img) => { const u = urls[paths.indexOf(img.dataset.path)]; if (u) img.src = u; });
  return urls;
}

async function load() {
  const [a, b] = await Promise.all([sb.from("places").select("*"), sb.from("profiles").select("id,name")]);
  if (a.error || b.error) { toast("장소를 불러오지 못했습니다. 네트워크를 확인하세요."); return; }
  profiles = Object.fromEntries(b.data.map((x) => [x.id, x]));
  places = a.data.map(norm); updCount();
  if (!map) return; // 지도가 아직 없으면 지도 준비 후 다시 그림
  syncMarkers();
}
function syncMarkers() {
  const ids = new Set(places.map((p) => p.id));
  [...markers.keys()].forEach((id) => { if (!ids.has(id)) removeMarker(id); });
  places.forEach((p) => { const m = markers.get(p.id); if (!m || m.sig !== sig(p)) addMarker(p); });
  if (sheetKind === "detail" && curDetail) markSelected(curDetail);
  if (draft && !draft.isNew) { const om = markers.get(draft.id); if (om) om.ov.setVisible(false); }
}
const sig = (p) => p.updated_at + "|" + p.name + "|" + p.owner + "|" + p.status;
let reloadT = null, channel = null;
const reloadSoon = () => { clearTimeout(reloadT); reloadT = setTimeout(load, 300); };
function subscribe() {
  if (channel) return;
  channel = sb.channel("map-live");
  ["places", "profiles"].forEach((t) => channel.on("postgres_changes", { event: "*", schema: "public", table: t }, reloadSoon));
  channel.subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && me) load(); });

// ───────── 카카오맵 ─────────
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
let map = null, kakaoReady = null, placesSvc = null, geocoder = null;
const LL = (lat, lng) => new kakao.maps.LatLng(lat, lng);
function loadKakao() {
  return new Promise((resolve, reject) => {
    if (window.kakao && kakao.maps && kakao.maps.Map) return resolve();
    const key = window.CONFIG && CONFIG.KAKAO_JS_KEY;
    if (!key || /여기에/.test(key)) return reject(new Error("nokey"));
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => { try { kakao.maps.load(resolve); } catch (e) { reject(e); } };
    s.onerror = () => reject(new Error("load"));
    document.head.appendChild(s);
  });
}
const goTo = (ll, level) => { map.setLevel(level); map.panTo(ll); };
function llFromClient(cx, cy) {
  const r = $("map").getBoundingClientRect();
  return map.getProjection().coordsFromContainerPoint(new kakao.maps.Point(cx - r.left, cy - r.top));
}
function initMap() {
  const v0 = lsGet("map_view_k", { lat: 37.5665, lng: 126.978, level: 6 });
  map = new kakao.maps.Map($("map"), { center: LL(v0.lat, v0.lng), level: v0.level, keyboardShortcuts: false });
  if (hybrid) map.setMapTypeId(kakao.maps.MapTypeId.HYBRID); // 저장해 둔 위성 지도 설정 적용
  placesSvc = new kakao.maps.services.Places(); geocoder = new kakao.maps.services.Geocoder();
  kakao.maps.event.addListener(map, "idle", () => { const c = map.getCenter(); lsSet("map_view_k", { lat: c.getLat(), lng: c.getLng(), level: map.getLevel() }); });
  const syncLabels = () => $("map").classList.toggle("z-labels", map.getLevel() <= LABEL_LEVEL);
  kakao.maps.event.addListener(map, "zoom_changed", syncLabels); syncLabels();
  // 더블탭 확대의 첫 번째 탭에서 입력창이 열리지 않게 잠깐 기다렸다가 처리
  kakao.maps.event.addListener(map, "click", (e) => { hideResults(); clearTimeout(tapTimer); const ll = e.latLng; tapTimer = setTimeout(() => handleTap(ll), 260); });
  kakao.maps.event.addListener(map, "dblclick", () => clearTimeout(tapTimer));
  kakao.maps.event.addListener(map, "zoom_start", () => clearTimeout(tapTimer));
  // 길게 누르기(우클릭)는 같은 동작으로 처리
  kakao.maps.event.addListener(map, "rightclick", (e) => { clearTimeout(tapTimer); hideResults(); handleTap(e.latLng); });
  kakao.maps.event.addListener(map, "idle", scheduleShops);
  syncMarkers(); scheduleShops();
}
let tapTimer = null;
$("bZi").onclick = () => map && map.setLevel(Math.max(1, map.getLevel() - 1), { animate: true });
$("bZo").onclick = () => map && map.setLevel(Math.min(14, map.getLevel() + 1), { animate: true });
let hybrid = lsGet("map_hybrid", false);
$("bLayer").onclick = () => {
  if (!map) return; hybrid = !hybrid; lsSet("map_hybrid", hybrid);
  map.setMapTypeId(hybrid ? kakao.maps.MapTypeId.HYBRID : kakao.maps.MapTypeId.ROADMAP);
  toast(hybrid ? "지도 스타일: 위성" : "지도 스타일: 일반");
};

// ───────── 핀 (가볼 곳 = 빨강, 가본 곳 = 파랑, 다른 사람이 저장한 곳은 점 둘레에 검은 테두리) ─────────
const markers = new Map(); // id -> { ov, el, sig }
const pinCls = (p) => (p.status === "visited" ? "visited" : "want") + (isMine(p) ? "" : " other");
function pinEl(name, cls) {
  const w = document.createElement("div"); w.className = "pinw " + cls;
  w.innerHTML = "<i></i>" + (name ? `<span>${esc(name)}</span>` : "");
  return w;
}
function addMarker(p) {
  removeMarker(p.id);
  const el = pinEl(p.name, pinCls(p));
  el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-label", p.name);
  const act = (ev) => {
    ev.stopPropagation();
    // 작성 중이면 점을 눌러도 상세로 넘어가지 않고, 누른 자리로 핀만 옮김
    if (sheetKind === "form" && draft && draftDirty() && ev.clientX !== undefined && ev.type === "click") { const ll = llFromClient(ev.clientX, ev.clientY); moveDraft(ll.getLat(), ll.getLng()); return; }
    openDetail(p.id);
  };
  el.addEventListener("click", act);
  el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); act(ev); } });
  const ov = new kakao.maps.CustomOverlay({ map, position: LL(p.lat, p.lng), content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 5, clickable: true });
  markers.set(p.id, { ov, el, sig: sig(p) });
  shopOvs.forEach((o, id) => { const r = shopData.get(id); if (r && Math.abs(Number(r.y) - p.lat) < 0.00022 && Math.abs(Number(r.x) - p.lng) < 0.00028) { o.ov.setMap(null); shopOvs.delete(id); } }); // 같은 자리의 가게 점은 내 점으로 대체
  if (draft && !draft.isNew && draft.id === p.id) ov.setVisible(false); // 수정 중인 장소는 다시 그려져도 숨김 유지
}
const restoreMarkers = () => markers.forEach((m) => m.ov.setVisible(true));
function removeMarker(id) { const m = markers.get(id); if (m) { m.ov.setMap(null); markers.delete(id); } }
let selId = null;
function markSelected(id) { selId = id; markers.forEach((m, k) => m.el.classList.toggle("sel", k === id)); }
let draftOv = null;
function setDraftMarker(lat, lng) {
  clearDraftMarker();
  draftOv = new kakao.maps.CustomOverlay({ map, position: LL(lat, lng), content: pinEl("", "draft"), xAnchor: 0.5, yAnchor: 0.5, zIndex: 20, clickable: false });
}
function clearDraftMarker() { if (draftOv) { draftOv.setMap(null); draftOv = null; } }

// ───────── 시트 ─────────
const sheet = $("sheet");
let sheetKind = null, urls = [], curDetail = null;
const mkUrl = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
function showSheet(html, kind) {
  if (sheetKind === "form" && kind !== "form") { draft = null; clearDraftMarker(); restoreMarkers(); }
  sheet.innerHTML = html; sheet.hidden = false; sheetKind = kind; sheet.scrollTop = 0; document.body.classList.add("sheet-on"); hideResults();
}
function releaseUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; }
function hideSheet() {
  sheet.hidden = true; sheet.innerHTML = ""; sheetKind = null; draft = null; curDetail = null; document.body.classList.remove("sheet-on");
  clearDraftMarker(); restoreMarkers(); markSelected(null); releaseUrls();
}
function leaveFormOk() {
  if (sheetKind === "form" && draftDirty()) { toast("작성 중입니다. 저장하거나 취소한 뒤 이동해 주세요."); return false; }
  return true;
}
// 시트에 가려지는 위치면 지도를 밀어서 보이게
function reveal(lat, lng) {
  requestAnimationFrame(() => {
    if (!map) return;
    const sh = sheet.offsetHeight, vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const top = 76, bottom = vh - sh - 24, proj = map.getProjection();
    const p = proj.containerPointFromCoords(LL(lat, lng));
    let dy = 0;
    if (bottom < top + 40) dy = p.y - top;
    else if (p.y > bottom || p.y < top) dy = p.y - (top + bottom) / 2;
    if (Math.abs(dy) > 1) { const el = $("map"); map.panTo(proj.coordsFromContainerPoint(new kakao.maps.Point(el.clientWidth / 2, el.clientHeight / 2 + dy))); }
  });
}
const armDelete = (btn, label, fn) => { btn.onclick = () => {
  if (btn.classList.contains("arm")) { fn(); return; }
  btn.classList.add("arm"); btn.textContent = "한 번 더 누르면 삭제됩니다";
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove("arm"); btn.textContent = label; } }, 3500);
}; };

// ───────── 입력 폼 (새 장소 / 수정) ─────────
let draft = null;
const draftDirty = () => !!draft && (draft.name.trim() || draft.memo.trim() || draft.photos.length || draft.links.some((l) => l.trim()) || !draft.isNew);

function openForm(lat, lng, existing) {
  releaseUrls();
  draft = existing
    ? { id: existing.id, lat: existing.lat, lng: existing.lng, name: existing.name, memo: existing.memo || "", photos: existing.photos.map((path) => ({ path, url: null })), removed: [], status: existing.status, links: [...existing.links], visitedAt: existing.visitedAt, isNew: false, busy: 0, saving: false }
    : { id: uid(), lat, lng, name: "", memo: "", photos: [], removed: [], status: "want", links: [], visitedAt: null, isNew: true, busy: 0, saving: false };
  showSheet(`<div class="sh"><button class="lnk mut" id="fCancel">취소</button><h2>${draft.isNew ? "새 장소" : "장소 수정"}</h2><button class="lnk b" id="fSave">저장</button></div>
   <div class="grp"><div class="fr"><input id="fName" type="text" placeholder="가게 이름" maxlength="60" autocomplete="off" aria-label="가게 이름" value="${esc(draft.name)}"></div></div>
   <div class="seg2" role="radiogroup" aria-label="상태">
     <button type="button" role="radio" class="stbtn want" data-st="want"><i></i>가볼 곳</button>
     <button type="button" role="radio" class="stbtn visited" data-st="visited"><i></i>가본 곳</button>
   </div>
   <div class="lbl"><span>링크 (인스타 게시물, 블로그, 지도 등)</span><span id="lcnt"></span></div>
   <div class="grp" id="lgrp"></div>
   <button type="button" class="btn sub" id="addLink" style="margin-top:0;margin-bottom:14px;min-height:44px;font-size:15px">＋ 링크 추가</button>
   <div class="lbl"><span>사진</span><span id="pcnt"></span></div>
   <div class="pgrid" id="pgrid"></div>
   <input id="fFile" class="vh" type="file" accept="image/*" multiple tabindex="-1">
   <div class="grp"><div class="fr col"><textarea id="fMemo" placeholder="메모 (선택)" maxlength="500" aria-label="메모">${esc(draft.memo)}</textarea></div></div>
   <p class="note" id="fLoc"></p>
   <div class="err" id="fErr" hidden></div>
   ${draft.isNew ? "" : `<button class="btn del" id="fDel">이 장소 삭제</button>`}`, "form");
  setDraftMarker(draft.lat, draft.lng); markSelected(null);
  if (existing) { const om = markers.get(existing.id); if (om) om.ov.setVisible(false); } // 수정 중에는 원래 점을 숨겨서 핀과 겹치지 않게
  renderPhotos(); renderLinks(); renderStatus(); updLoc(); reveal(draft.lat, draft.lng);
  sheet.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => { draft.status = b.dataset.st; renderStatus(); }));
  $("addLink").onclick = () => {
    if (draft.links.length >= MAX_LINKS) { toast(`링크는 최대 ${MAX_LINKS}개까지 넣을 수 있습니다.`); return; }
    draft.links.push(""); renderLinks(); const ins = $("lgrp").querySelectorAll("input"); if (ins.length) ins[ins.length - 1].focus();
  };
  const d0 = draft;
  if (existing && existing.photos.length) signedUrls(existing.photos).then((us) => { if (draft !== d0) return; d0.photos.forEach((p) => { if (p.path && !p.url) p.url = us[existing.photos.indexOf(p.path)] || null; }); renderPhotos(); });
  $("fName").oninput = (e) => { draft.name = e.target.value; const er = $("fErr"); if (er) er.hidden = true; };
  $("fMemo").oninput = (e) => (draft.memo = e.target.value);
  $("fSave").onclick = saveDraft;
  let armed = false;
  $("fCancel").onclick = () => {
    if (draft.saving) return;
    if (draftDirty() && draft.isNew && !armed) { armed = true; $("fCancel").textContent = "내용 버리기"; setTimeout(() => { armed = false; if ($("fCancel")) $("fCancel").textContent = "취소"; }, 3000); return; }
    const keep = draft.isNew ? null : draft.id; hideSheet(); if (keep) openDetail(keep);
  };
  $("fFile").onchange = onFiles;
  const fd = $("fDel"); if (fd) armDelete(fd, "이 장소 삭제", () => doDelete(draft.id));
}
function renderStatus() {
  if (!draft) return;
  sheet.querySelectorAll("[data-st]").forEach((b) => { const on = b.dataset.st === draft.status; b.classList.toggle("sel", on); b.setAttribute("aria-checked", on ? "true" : "false"); });
}
// 링크 입력칸: 입력할 때는 값만 갱신하고(커서 유지), 추가/삭제할 때만 다시 그림
function renderLinks() {
  const g = $("lgrp"); if (!g || !draft) return;
  g.hidden = !draft.links.length;
  g.innerHTML = draft.links.map((l, i) => `<div class="fr"><input type="text" inputmode="url" enterkeyhint="done" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="https://www.instagram.com/p/…" aria-label="링크 ${i + 1}" data-li="${i}" value="${esc(l)}"><button type="button" class="rm2" data-lr="${i}" aria-label="링크 ${i + 1} 삭제">✕</button></div>`).join("");
  $("lcnt").textContent = `${draft.links.length}/${MAX_LINKS}`;
  g.querySelectorAll("[data-li]").forEach((inp) => {
    inp.oninput = () => { draft.links[Number(inp.dataset.li)] = inp.value; inp.removeAttribute("aria-invalid"); const e = $("fErr"); if (e) e.hidden = true; };
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } }; // 키보드의 이동/완료 키로 입력 끝내기
  });
  g.querySelectorAll("[data-lr]").forEach((b) => (b.onclick = () => { draft.links.splice(Number(b.dataset.lr), 1); renderLinks(); }));
}
const updLoc = () => { const n = $("fLoc"); if (n) n.textContent = `위치 ${draft.lat.toFixed(5)}, ${draft.lng.toFixed(5)} · 위치를 바꾸려면 지도의 다른 곳을 터치하세요.`; };
function moveDraft(lat, lng) { if (!draft) return; draft.lat = lat; draft.lng = lng; setDraftMarker(lat, lng); updLoc(); }
function renderPhotos() {
  const g = $("pgrid"); if (!g || !draft) return;
  draft.photos.forEach((p) => { if (p.blob && !p.url) p.url = mkUrl(p.blob); });
  const room = MAX_PHOTOS - draft.photos.length;
  g.innerHTML = draft.photos.map((p, i) => `<div class="ptile">${p.url ? `<img src="${esc(p.url)}" alt="사진 ${i + 1}">` : ""}<button class="rm" data-rm="${i}" aria-label="사진 ${i + 1} 삭제">✕</button></div>`).join("")
    + (draft.busy ? `<div class="ptile busy">처리 중…</div>` : "")
    + (room > 0 && !draft.busy ? `<label class="ptile add" for="fFile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>사진 추가</label>` : "");
  $("pcnt").textContent = `${draft.photos.length}/${MAX_PHOTOS}`;
  g.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
    const [p] = draft.photos.splice(Number(b.dataset.rm), 1); if (p && p.path) draft.removed.push(p.path); renderPhotos();
  }));
}
// 사진을 긴 변 1280px JPEG로 줄여서 올림 (용량·속도 절약)
function shrink(file, max = 1280, q = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
      c.toBlob((b) => { URL.revokeObjectURL(url); b ? res(b) : rej(new Error("toBlob")); }, "image/jpeg", q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
    img.src = url;
  });
}
async function onFiles(e) {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length || !draft) return;
  const d = draft, take = files.slice(0, MAX_PHOTOS - d.photos.length);
  if (files.length > take.length) toast(`사진은 최대 ${MAX_PHOTOS}장까지 넣을 수 있습니다.`);
  d.busy++; renderPhotos();
  let fail = 0;
  const limit = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 25000))]);
  for (const f of take) { try { const b = await limit(shrink(f)); if (draft === d) d.photos.push({ blob: b, url: null }); } catch (err) { fail++; } }
  d.busy--; if (draft === d) renderPhotos();
  if (fail) toast(`사진 ${fail}장을 읽지 못했습니다.`);
}
async function saveDraft() {
  const d = draft; if (!d || d.saving) return;
  // 오류는 입력창 맨 아래에 있어 안 보일 수 있으니, 화면 위에 떠 있는 안내(toast)로도 함께 알린다
  const er = $("fErr"), fail = (m) => { er.textContent = m; er.hidden = false; toast(m, 4500); };
  const name = d.name.trim();
  if (!name) { fail("가게 이름을 입력하세요."); $("fName").focus(); return; }
  if (d.busy) { fail("사진을 처리하는 중입니다. 잠시 뒤 다시 눌러 주세요."); return; }
  // 링크: 빈 칸은 버리고, 주소가 아닌 것이 있으면 몇 번째 칸인지 알려준다. 정리된 주소는 입력칸에도 되돌려 보여준다.
  const links = []; let bad = -1;
  d.links.forEach((l, i) => { if (!l.trim()) return; const n = normLink(l); if (!n) { if (bad < 0) bad = i; return; } d.links[i] = n; if (!links.includes(n)) links.push(n); });
  if (bad >= 0) {
    fail(`${bad + 1}번째 링크가 주소 형식이 아닙니다. https:// 로 시작하는 주소를 넣어 주세요.`);
    renderLinks();
    const inp = $("lgrp").querySelector(`[data-li="${bad}"]`); if (inp) { inp.setAttribute("aria-invalid", "true"); inp.focus(); }
    return;
  }
  // 저장하는 동안 입력을 바꿔도 반영되지 않으므로, 지금 내용을 확정해서 쓰고 입력창은 잠근다
  const memo = d.memo.trim(), status = d.status, photos = [...d.photos];
  const visitedAt = status === "visited" ? new Date(d.visitedAt || Date.now()).toISOString() : null;
  d.saving = true; er.hidden = true; sheet.classList.add("saving"); $("fSave").disabled = true; $("fSave").textContent = "저장 중…";
  const uploaded = [];
  let saved;
  try {
    for (const p of photos) {
      if (!p.blob) continue;
      const path = `${me.id}/${d.id}/${uid()}.jpg`;
      const r = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
      if (r.error) throw r.error;
      uploaded.push({ path, ref: p });
    }
    const photoPaths = photos.map((p) => p.path || uploaded.find((u) => u.ref === p).path);
    const row = { lat: d.lat, lng: d.lng, name, memo, photos: photoPaths, status, links, visited_at: visitedAt };
    const r = d.isNew
      ? await sb.from("places").insert({ id: d.id, ...row }).select().single()
      : await sb.from("places").update({ ...row, updated_at: new Date().toISOString() }).eq("id", d.id).select().single();
    if (r.error) throw r.error;
    saved = r.data;
  } catch (e) {
    if (uploaded.length) sb.storage.from(BUCKET).remove(uploaded.map((u) => u.path)).catch(() => {}); // 올리다 실패한 사진 정리
    d.saving = false; sheet.classList.remove("saving");
    if (draft === d && $("fSave")) { $("fSave").disabled = false; $("fSave").textContent = "저장"; fail("저장하지 못했습니다. 네트워크와 로그인 상태를 확인하고, 내가 만든 장소만 수정할 수 있습니다."); }
    return;
  }
  if (d.removed.length) sb.storage.from(BUCKET).remove(d.removed).catch(() => {}); // 지운 사진 파일 정리
  const rec = norm(saved), i = places.findIndex((x) => x.id === rec.id);
  if (i >= 0) places[i] = rec; else places.push(rec);
  updCount(); sheet.classList.remove("saving");
  if (draft === d) hideSheet(); // 먼저 닫아야 수정 중이던 점이 숨겨진 채 다시 그려지지 않음
  addMarker(rec);
  toast(d.isNew ? "저장했습니다" : "수정했습니다");
  if (d.isNew) { markSelected(rec.id); setTimeout(() => { if (selId === rec.id && !sheetKind) markSelected(null); }, 1600); }
}
// 가볼 곳 ↔ 가본 곳 바꾸기 (만든 사람만)
async function setStatus(id, st) {
  const p = places.find((x) => x.id === id); if (!p || !isMine(p)) return;
  // 요청이 끝나기 전에 수정·삭제를 누르면 오래된 내용으로 덮어쓸 수 있어서 같이 잠근다
  const lock = (on) => ["dSt", "dEdit", "dDel"].forEach((k) => { const b = $(k); if (b) b.disabled = on; });
  lock(true);
  const r = await sb.from("places").update({ status: st, visited_at: st === "visited" ? new Date().toISOString() : null }).eq("id", id).select().single();
  if (r.error || !r.data) { lock(false); toast("바꾸지 못했습니다. 네트워크와 로그인 상태를 확인하세요."); return; }
  const rec = norm(r.data), i = places.findIndex((x) => x.id === id);
  if (i >= 0) places[i] = rec;
  addMarker(rec); toast(st === "visited" ? "가본 곳으로 바꿨습니다" : "가볼 곳으로 바꿨습니다");
  if (curDetail === id && sheetKind === "detail") openDetail(id);
}
async function doDelete(id) {
  const p = places.find((x) => x.id === id);
  const r = await sb.from("places").delete().eq("id", id).select();
  if (r.error || !r.data || !r.data.length) { toast("삭제하지 못했습니다. 내가 만든 장소만 삭제할 수 있습니다."); return; }
  if (p && p.photos.length) sb.storage.from(BUCKET).remove(p.photos).catch(() => {});
  places = places.filter((x) => x.id !== id); updCount(); removeMarker(id); hideSheet(); toast("삭제했습니다");
}

// ───────── 상세 보기 ─────────
function openDetail(id) {
  if (sheetKind === "form" && draftDirty()) { toast("작성 중입니다. 저장하거나 취소한 뒤 다른 장소를 열어 주세요."); return; }
  const p = places.find((x) => x.id === id); if (!p) return;
  releaseUrls();
  const mine = isMine(p), links = safeLinks(p.links);
  showSheet(`<div class="sh"><button class="lnk mut" id="dClose">닫기</button><h2>장소</h2>${mine ? `<button class="lnk" id="dEdit">수정</button>` : `<span style="width:44px"></span>`}</div>
   ${p.photos.length ? `<div class="strip${p.photos.length === 1 ? " one" : ""}" id="strip">${p.photos.map((path, i) => `<button data-ph="${i}" aria-label="사진 ${i + 1} 크게 보기"><img data-path="${esc(path)}" alt="${esc(p.name)} 사진 ${i + 1}"></button>`).join("")}</div>` : ""}
   <h3 class="dname">${esc(p.name)}</h3>
   <div class="who"><span class="chip ${p.status}"><i></i>${STATUS_LABEL[p.status]}</span> ${mine ? "내가 저장한 장소" : esc(nameOf(p.owner)) + "님이 저장한 장소"}</div>
   ${p.memo ? `<p class="dmemo" style="margin-top:10px">${esc(p.memo)}</p>` : ""}
   ${links.length ? `<div class="lbl" style="margin:14px 4px 8px"><span>링크</span></div><div class="grp">${links.map((h) => `<a class="linkrow" href="${esc(h)}" target="_blank" rel="noopener noreferrer"><span class="lk"><b>${esc(linkLabel(h))}</b><small>${esc(shortUrl(h))}</small></span><span class="go" aria-hidden="true">↗</span></a>`).join("")}</div>` : ""}
   <div class="meta" style="margin-top:8px">저장 ${fmtDate(p.createdAt)}${p.updatedAt - p.createdAt > 60000 ? ` · 수정 ${fmtDate(p.updatedAt)}` : ""}${p.status === "visited" && p.visitedAt ? ` · 방문 ${fmtDate(p.visitedAt)}` : ""}<br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
   ${mine ? `<button class="btn ${p.status === "want" ? "blue" : "sub"}" id="dSt">${p.status === "want" ? "다녀왔어요 (가본 곳으로 바꾸기)" : "다시 가볼 곳으로 바꾸기"}</button>` : ""}
   <a class="btn sub" id="dOpen" href="https://map.kakao.com/link/map/${encodeURIComponent(p.name)},${p.lat},${p.lng}" target="_blank" rel="noopener noreferrer">카카오맵에서 열기</a>
   ${mine ? `<button class="btn del" id="dDel">삭제</button>` : `<p class="note" style="margin-top:12px">다른 사람이 만든 장소는 수정하거나 삭제할 수 없습니다.</p>`}`, "detail");
  curDetail = id; markSelected(id); reveal(p.lat, p.lng);
  $("dClose").onclick = hideSheet;
  if (mine) {
    $("dEdit").onclick = () => { const fresh = places.find((x) => x.id === id) || p; openForm(fresh.lat, fresh.lng, fresh); }; // 실시간으로 바뀐 최신 내용으로 연다
    armDelete($("dDel"), "삭제", () => doDelete(id));
    $("dSt").onclick = () => { const cur = places.find((x) => x.id === id) || p; setStatus(id, cur.status === "want" ? "visited" : "want"); };
  }
  let resolved = [];
  fillImages(sheet, p.photos).then((us) => { if (curDetail === id) resolved = us; });
  sheet.querySelectorAll("[data-ph]").forEach((b) => (b.onclick = () => {
    const urlsNow = resolved.length ? resolved : p.photos.map((x) => (urlCache.get(x) && urlCache.get(x).url) || null);
    const list = urlsNow.filter(Boolean); if (!list.length) return;
    openLightbox(list, Math.min(Number(b.dataset.ph), list.length - 1));
  }));
}

// 사진 크게 보기 (좌우로 넘기기)
function openLightbox(list, i) {
  $("lbstrip").innerHTML = list.map((u, k) => `<div class="lbslide"><img src="${esc(u)}" alt="사진 ${k + 1}"></div>`).join("");
  $("lb").hidden = false;
  const s = $("lbstrip"); s.scrollLeft = s.clientWidth * i;
  const upd = () => { $("lbn").textContent = list.length > 1 ? `${Math.round(s.scrollLeft / Math.max(1, s.clientWidth)) + 1} / ${list.length}` : ""; };
  s.onscroll = upd; upd();
}
function closeLightbox() { $("lb").hidden = true; $("lbstrip").innerHTML = ""; }
$("lbx").onclick = closeLightbox;
$("lbstrip").addEventListener("click", (e) => { if (e.target.tagName !== "IMG") closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!$("lb").hidden) closeLightbox(); else if (sheetKind && sheetKind !== "form") hideSheet(); } });

// ───────── 지도 터치 ─────────
function handleTap(ll) {
  if (!me || !map) return;
  if (sheetKind === "form" && draft) { moveDraft(ll.getLat(), ll.getLng()); return; } // 작성 중이면 위치만 옮김
  if (sheetKind) { hideSheet(); return; } // 상세·목록·설정은 닫기
  if (map.getLevel() > MAX_ADD_LEVEL) {
    goTo(ll, ADD_ZOOM_LEVEL); toast("확대했습니다. 저장할 위치를 다시 터치하세요.");
    return;
  }
  openForm(ll.getLat(), ll.getLng(), null);
}

// ───────── 목록 ─────────
$("bList").onclick = openList;
let listFilter = "all";
function openList() {
  if (!leaveFormOk()) return;
  releaseUrls(); listFilter = "all"; // 열 때마다 전체부터 보여줌
  showSheet(`<div class="sh"><span style="width:44px"></span><h2>저장한 장소 ${places.length}</h2><button class="lnk b" id="lDone">완료</button></div>
   ${places.length ? `<div class="fchips" id="lChips" role="group" aria-label="상태로 거르기"></div><input id="lFil" class="fil" type="search" placeholder="이름·메모·작성자 검색" aria-label="저장한 장소 검색"><div id="lList"></div>`
     : `<div class="empty"><b>아직 저장한 장소가 없습니다</b>지도를 확대해서 저장할 위치를 터치하면<br>가게 이름과 사진을 남길 수 있어요.</div>`}`, "list");
  $("lDone").onclick = hideSheet;
  if (!places.length) return;
  const draw = () => {
    const q = ($("lFil").value || "").trim().toLowerCase();
    const cnt = { all: places.length, want: places.filter((p) => p.status === "want").length, visited: places.filter((p) => p.status === "visited").length };
    $("lChips").innerHTML = [["all", "전체"], ["want", "가볼 곳"], ["visited", "가본 곳"]].map(([k, t]) => `<button type="button" class="${k}${listFilter === k ? " sel" : ""}" data-f="${k}" aria-pressed="${listFilter === k}">${k === "all" ? "" : "<i></i>"}${t} ${cnt[k]}</button>`).join("");
    $("lChips").querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { listFilter = b.dataset.f; draw(); }));
    const filtered = places.filter((p) => (listFilter === "all" || p.status === listFilter) && (!q || p.name.toLowerCase().includes(q) || (p.memo || "").toLowerCase().includes(q) || nameOf(p.owner).toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt);
    const rows = filtered.slice(0, 60);
    $("lList").innerHTML = rows.length ? rows.map((p) => `<button class="lrow" data-id="${esc(p.id)}"><span class="lth">${p.photos[0] ? `<img alt="" data-path="${esc(p.photos[0])}">` : `<i class="${p.status}"></i>`}</span><span class="lmn"><b>${esc(p.name)}</b><small>${STATUS_LABEL[p.status]} · ${isMine(p) ? "내가 저장" : esc(nameOf(p.owner))} · ${fmtDate(p.createdAt)}${p.links.length ? ` · 링크 ${p.links.length}` : ""}${p.photos.length ? ` · 사진 ${p.photos.length}` : ""}</small></span></button>`).join("") + (filtered.length > rows.length ? `<div class="empty" style="padding:14px 10px">최근 ${rows.length}개만 보여줍니다. 검색으로 좁혀 보세요.</div>` : "")
      : `<div class="empty">${q ? "검색 결과가 없습니다" : listFilter === "all" ? "저장한 장소가 없습니다" : STATUS_LABEL[listFilter] + "이 없습니다"}</div>`;
    $("lList").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => goPlace(b.dataset.id)));
    const firsts = rows.map((p) => p.photos[0]).filter(Boolean);
    if (firsts.length) fillImages($("lList"), firsts);
  };
  $("lFil").oninput = draw; draw();
}
function goPlace(id) {
  const p = places.find((x) => x.id === id); if (!p || !map) return;
  if (!leaveFormOk()) return;
  hideSheet(); goTo(LL(p.lat, p.lng), Math.min(map.getLevel(), ADD_ZOOM_LEVEL));
  setTimeout(() => openDetail(id), 400);
}

// ───────── 검색 (저장한 장소 + 카카오 장소·주소 검색) ─────────
// 카카오 검색 결과는 이동에만 쓰고 저장하지 않는다(약관). 저장은 내가 터치한 위치와 직접 입력한 이름만 한다.
const qEl = $("q"), resEl = $("results");
function hideResults() { resEl.hidden = true; resEl.innerHTML = ""; }
qEl.addEventListener("input", () => { $("qclr").hidden = !qEl.value; if (!qEl.value) hideResults(); });
$("qclr").onclick = () => { qEl.value = ""; $("qclr").hidden = true; hideResults(); qEl.focus(); };
function kakaoSearch(q) {
  return new Promise((resolve) => {
    if (!placesSvc) return resolve(null);
    placesSvc.keywordSearch(q, (res, status) => {
      if (status === kakao.maps.services.Status.OK) return resolve(res.map((r) => ({ name: r.place_name, sub: (r.road_address_name || r.address_name || "") + (r.category_group_name ? " · " + r.category_group_name : ""), lat: Number(r.y), lng: Number(r.x) })));
      if (status !== kakao.maps.services.Status.ZERO_RESULT) return resolve(null);
      geocoder.addressSearch(q, (r2, s2) => resolve(s2 === kakao.maps.services.Status.OK ? r2.slice(0, 8).map((a) => ({ name: a.address_name, sub: a.road_address ? a.road_address.address_name : "", lat: Number(a.y), lng: Number(a.x) })) : s2 === kakao.maps.services.Status.ZERO_RESULT ? [] : null));
    }, { size: 8 });
  });
}
let searchSeq = 0;
$("sf").addEventListener("submit", async (e) => {
  e.preventDefault(); const q = qEl.value.trim(); if (!q) return; qEl.blur();
  const seq = ++searchSeq, ql = q.toLowerCase();
  const mine = places.filter((p) => p.name.toLowerCase().includes(ql) || (p.memo || "").toLowerCase().includes(ql)).slice(0, 5);
  const mineHtml = mine.map((p) => `<button class="res" data-mine="${esc(p.id)}"><b><span class="tag">저장됨</span>${esc(p.name)}</b><small>${esc(p.memo || (isMine(p) ? "내가 저장" : nameOf(p.owner)))}</small></button>`).join("");
  resEl.hidden = false; resEl.innerHTML = mineHtml + `<div class="rnone">검색 중…</div>`;
  bindResults();
  const list = await kakaoSearch(q);
  if (seq !== searchSeq) return;
  const geoHtml = (list || []).map((g, i) => `<button class="res" data-geo="${i}"><b>${esc(g.name)}</b><small>${esc(g.sub)}</small></button>`).join("");
  resEl.innerHTML = mineHtml + geoHtml + (!mineHtml && !geoHtml ? `<div class="rnone">${list === null ? "검색하지 못했습니다. 잠시 후 다시 시도하세요." : "검색 결과가 없습니다."}</div>` : (list === null ? `<div class="rnone">장소 검색은 지금 사용할 수 없습니다.</div>` : ""));
  bindResults(list || []);
});
function bindResults(list) {
  resEl.querySelectorAll("[data-mine]").forEach((b) => (b.onclick = () => { hideResults(); goPlace(b.dataset.mine); }));
  resEl.querySelectorAll("[data-geo]").forEach((b) => (b.onclick = () => {
    const g = list[Number(b.dataset.geo)]; hideResults(); if (sheetKind && sheetKind !== "form") hideSheet(); // 작성 중인 폼은 그대로 두고 지도만 이동
    if (g && map) goTo(LL(g.lat, g.lng), ADD_ZOOM_LEVEL);
  }));
}

// ───────── 주변 가게 (카카오 장소 정보) ─────────
// 지도를 확대하면 주변 음식점·카페·명소를 주황 점으로 보여주고, 누르면 정보를 보여준다.
// 이 정보는 화면에 표시만 하고 저장하지 않는다(약관). 내 장소로 저장할 때는 이름을 직접 입력한다.
const SHOP_LEVEL = 4, SHOP_CATS = [["FD6", 2], ["CE7", 2], ["AT4", 1]];
let shopOn = lsGet("shops_on", true), shopSeq = 0, shopTimer = null;
const shopOvs = new Map(), shopData = new Map();
function clearShops() { shopOvs.forEach((o) => o.ov.setMap(null)); shopOvs.clear(); shopData.clear(); }
function scheduleShops() { clearTimeout(shopTimer); shopTimer = setTimeout(loadShops, 450); }
function searchCat(code, pages, bounds) {
  return new Promise((resolve) => {
    const out = []; let n = 0;
    try {
      placesSvc.categorySearch(code, (res, status, pg) => {
        if (status === kakao.maps.services.Status.OK) { out.push(...res); n++; if (pg && pg.hasNextPage && n < pages) { pg.nextPage(); return; } }
        resolve(out);
      }, { bounds, size: 15 });
    } catch (e) { resolve(out); }
  });
}
const nearSaved = (lat, lng) => places.some((p) => Math.abs(p.lat - lat) < 0.00022 && Math.abs(p.lng - lng) < 0.00028);
async function loadShops() {
  if (!map || !placesSvc) return;
  if (!shopOn || map.getLevel() > SHOP_LEVEL) { clearShops(); return; }
  const seq = ++shopSeq, bounds = map.getBounds();
  const lists = await Promise.all(SHOP_CATS.map(([c, n]) => searchCat(c, n, bounds)));
  if (seq !== shopSeq || !shopOn) return;
  const next = new Map();
  lists.flat().forEach((r) => { if (r && r.id && !next.has(r.id)) next.set(r.id, r); });
  shopOvs.forEach((o, id) => { if (!next.has(id)) { o.ov.setMap(null); shopOvs.delete(id); shopData.delete(id); } });
  next.forEach((r, id) => {
    shopData.set(id, r);
    const lat = Number(r.y), lng = Number(r.x);
    if (shopOvs.has(id) || !isFinite(lat) || !isFinite(lng) || nearSaved(lat, lng)) return;
    const el = pinEl(r.place_name, "shop");
    el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-label", r.place_name);
    const act = (ev) => { ev.stopPropagation(); openShop(id); };
    el.addEventListener("click", act);
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); act(ev); } });
    shopOvs.set(id, { ov: new kakao.maps.CustomOverlay({ map, position: LL(lat, lng), content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 3, clickable: true }), el });
  });
}
$("bShop").onclick = () => {
  shopOn = !shopOn; lsSet("shops_on", shopOn);
  $("bShop").classList.toggle("on", shopOn); $("bShop").setAttribute("aria-pressed", shopOn ? "true" : "false");
  if (!shopOn) { clearShops(); toast("주변 가게 표시를 껐습니다"); return; }
  toast(map && map.getLevel() > SHOP_LEVEL ? "지도를 더 확대하면 주변 가게가 보입니다" : "주변 가게를 표시합니다");
  loadShops();
};
$("bShop").classList.toggle("on", shopOn); $("bShop").setAttribute("aria-pressed", shopOn ? "true" : "false");
const safeKakaoUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch (e) { return ""; } };
function openShop(id) {
  const r = shopData.get(id); if (!r) return;
  const lat = Number(r.y), lng = Number(r.x);
  if (sheetKind === "form" && draft) { moveDraft(lat, lng); toast("저장할 위치를 이 가게로 옮겼습니다"); return; } // 작성 중이면 위치만 옮김
  releaseUrls();
  const cat = (r.category_name || "").split(">").map((s) => s.trim()).filter(Boolean).slice(-2).join(" · ");
  const addr = r.road_address_name || r.address_name || "", tel = (r.phone || "").trim(), url = safeKakaoUrl(r.place_url);
  showSheet(`<div class="sh"><button class="lnk mut" id="sClose">닫기</button><h2>가게 정보</h2><span style="width:44px"></span></div>
   <h3 class="dname">${esc(r.place_name)}</h3>
   <div class="shopmeta">${cat ? `<span>${esc(cat)}</span>` : ""}${addr ? `<span>${esc(addr)}</span>` : ""}${tel ? `<span><a href="tel:${esc(tel.replace(/[^0-9+]/g, ""))}">${esc(tel)}</a></span>` : ""}<small>카카오맵 장소 정보 · 저장되지 않습니다</small></div>
   ${url ? `<a class="btn sub" href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="margin-top:0">카카오맵에서 자세히 보기 (후기·메뉴·사진)</a>` : ""}
   <button class="btn" id="sWant">가볼 곳으로 저장</button>
   <button class="btn blue" id="sVis">가본 곳으로 저장</button>
   <p class="note">저장할 때 가게 이름은 직접 입력해 주세요. 카카오 약관상 검색 정보는 저장하지 못합니다.</p>`, "shop");
  reveal(lat, lng);
  $("sClose").onclick = hideSheet;
  const save = (st) => { openForm(lat, lng, null); draft.status = st; renderStatus(); const f = $("fName"); if (f) f.placeholder = r.place_name; };
  $("sWant").onclick = () => save("want"); $("sVis").onclick = () => save("visited");
}

// ───────── 내 위치 ─────────
let meOv = null, meCircle = null;
$("bLoc").onclick = () => {
  if (!map) return;
  if (!navigator.geolocation) { toast("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }
  toast("현재 위치를 찾는 중…", 4000);
  navigator.geolocation.getCurrentPosition((pos) => {
    const ll = LL(pos.coords.latitude, pos.coords.longitude);
    if (meOv) meOv.setMap(null); if (meCircle) meCircle.setMap(null);
    meCircle = new kakao.maps.Circle({ map, center: ll, radius: Math.min(pos.coords.accuracy || 30, 500), strokeWeight: 1, strokeColor: "#5856d6", strokeOpacity: 0.6, fillColor: "#5856d6", fillOpacity: 0.12 });
    meOv = new kakao.maps.CustomOverlay({ map, position: ll, content: pinEl("", "me"), xAnchor: 0.5, yAnchor: 0.5, zIndex: 3, clickable: false });
    goTo(ll, Math.min(map.getLevel(), ADD_ZOOM_LEVEL)); $("toast").hidden = true;
  }, (err) => toast(err.code === 1 ? "위치 권한이 꺼져 있습니다. 설정에서 이 사이트의 위치를 허용해 주세요." : "현재 위치를 가져오지 못했습니다."), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
};

// ───────── 설정 ─────────
$("bMenu").onclick = openMenu;
function openMenu() {
  if (!leaveFormOk()) return;
  releaseUrls();
  const mineCount = places.filter(isMine).length;
  showSheet(`<div class="sh"><span style="width:44px"></span><h2>설정</h2><button class="lnk b" id="mDone">완료</button></div>
   <div class="grp"><div class="fr" style="min-height:52px"><span>전체 장소</span><span style="flex:1"></span><b>${places.length}개 (내가 저장 ${mineCount}개)</b></div>
     <div class="fr"><label for="myName">내 이름</label><input id="myName" type="text" maxlength="20" style="text-align:right" value="${esc(profiles[me.id]?.name || "")}"></div></div>
   <p class="note">이름은 다른 사람에게 보입니다. 로그인 계정: ${esc(me.email || "")}</p>
   <p class="note"><b style="color:#ff3b30">빨간 점</b>은 가볼 곳, <b style="color:#0a84ff">파란 점</b>은 가본 곳입니다. 다른 사람이 저장한 곳은 점 둘레에 <b>검은 테두리</b>가 있습니다. 수정과 삭제, 가볼 곳·가본 곳 바꾸기는 만든 사람만 할 수 있습니다.</p>
   <button class="btn sub" id="logout">로그아웃</button>`, "menu");
  $("mDone").onclick = hideSheet;
  $("myName").onchange = async () => {
    const n = $("myName").value.trim(); if (!n) return;
    const r = await sb.from("profiles").update({ name: n }).eq("id", me.id);
    if (r.error) { toast("이름을 저장하지 못했습니다."); return; }
    profiles[me.id] = { ...(profiles[me.id] || { id: me.id }), name: n }; toast("이름을 저장했습니다.");
  };
  $("logout").onclick = async () => { hideSheet(); await sb.auth.signOut(); };
}

// ───────── 로그인 / 시작 ─────────
function showLogin(msg) { $("login").hidden = false; if (msg) { $("lErr").textContent = msg; $("lErr").hidden = false; } }
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("lErr").hidden = true; $("lBtn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({ email: $("lEmail").value.trim(), password: $("lPw").value });
  $("lBtn").disabled = false;
  if (error) { $("lErr").textContent = "이메일 또는 비밀번호가 올바르지 않습니다."; $("lErr").hidden = false; }
});
async function onSession(s) {
  if (!s) {
    me = null; places = []; profiles = {}; updCount(); [...markers.keys()].forEach(removeMarker); hideSheet(); showLogin(); return;
  }
  me = { id: s.user.id, email: s.user.email };
  $("login").hidden = true; $("lPw").value = "";
  await load(); subscribe();
  if (!places.length) setTimeout(() => toast("지도를 확대한 뒤 저장할 위치를 터치하세요."), 800);
}
(async function start() {
  if (!sb) { $("login").hidden = false; $("loginForm").innerHTML = `<h1>설정이 필요합니다</h1><p class="note" style="text-align:center">config.js 에 Supabase 주소와 키를 입력하세요. (README 참고)</p>`; return; }
  // 지도가 안 떠도 로그인은 되도록 지도를 먼저 시도하고, 실패하면 안내만 띄움
  kakaoReady = loadKakao().then(() => { initMap(); return true; }).catch((e) => {
    $("map").innerHTML = `<div class="mapfail"><b>지도를 불러오지 못했습니다</b>${e && e.message === "nokey" ? "config.js 에 카카오 JavaScript 키가 없습니다." : "카카오 개발자 사이트에서 JavaScript SDK 도메인과 카카오맵 사용 설정(ON)을 확인하세요."}</div>`;
    return false;
  });
  const { data } = await sb.auth.getSession();
  await kakaoReady;
  await onSession(data.session);
  sb.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_IN" && me && s && me.id === s.user.id) return; if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") onSession(s); });
})();
