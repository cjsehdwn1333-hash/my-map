"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random().toString(16).slice(2));
const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
const MAX_PHOTOS = 6, MIN_ADD_ZOOM = 14, LABEL_ZOOM = 15, BUCKET = "place-photos";

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
const norm = (r) => ({ ...r, photos: Array.isArray(r.photos) ? r.photos : [], createdAt: Date.parse(r.created_at) || Date.now(), updatedAt: Date.parse(r.updated_at) || Date.now() });
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
  const ids = new Set(places.map((p) => p.id));
  [...markers.keys()].forEach((id) => { if (!ids.has(id)) removeMarker(id); });
  places.forEach((p) => { const m = markers.get(p.id); if (!m || m._sig !== sig(p)) addMarker(p); });
  if (sheetKind === "detail" && curDetail) markSelected(curDetail);
  if (draft && !draft.isNew) { const om = markers.get(draft.id); if (om) om.setOpacity(0); }
}
const sig = (p) => p.updated_at + "|" + p.name + "|" + p.owner;
let reloadT = null, channel = null;
const reloadSoon = () => { clearTimeout(reloadT); reloadT = setTimeout(load, 300); };
function subscribe() {
  if (channel) return;
  channel = sb.channel("map-live");
  ["places", "profiles"].forEach((t) => channel.on("postgres_changes", { event: "*", schema: "public", table: t }, reloadSoon));
  channel.subscribe();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && me) load(); });

// ───────── 지도 ─────────
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const view0 = lsGet("map_view", { lat: 37.5665, lng: 126.978, z: 12 });
const map = L.map("map", { zoomControl: false, zoomSnap: 0.5, zoomDelta: 1, worldCopyJump: true }).setView([view0.lat, view0.lng], view0.z);
map.attributionControl.setPosition("bottomleft");
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
const cartoUrl = (dark) => `https://{s}.basemaps.cartocdn.com/rastertiles/${dark ? "dark_all" : "voyager"}/{z}/{x}/{y}{r}.png`;
const LAYERS = {
  osm: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  simple: L.tileLayer(cartoUrl(darkMQ.matches), { subdomains: "abcd", maxZoom: 20, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OSM</a> © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>' }),
};
let layerKey = lsGet("map_layer", "osm"); if (!LAYERS[layerKey]) layerKey = "osm";
LAYERS[layerKey].addTo(map);
if (darkMQ.addEventListener) darkMQ.addEventListener("change", (e) => LAYERS.simple.setUrl(cartoUrl(e.matches)));
$("bLayer").onclick = () => {
  map.removeLayer(LAYERS[layerKey]); layerKey = layerKey === "osm" ? "simple" : "osm"; LAYERS[layerKey].addTo(map); lsSet("map_layer", layerKey);
  toast(layerKey === "osm" ? "지도 스타일: 표준" : "지도 스타일: 단순");
};
$("bZi").onclick = () => map.zoomIn(); $("bZo").onclick = () => map.zoomOut();
map.on("moveend", () => { const c = map.getCenter(); lsSet("map_view", { lat: c.lat, lng: c.lng, z: map.getZoom() }); });
function syncLabels() { $("map").classList.toggle("z-labels", map.getZoom() >= LABEL_ZOOM); }
map.on("zoomend", syncLabels); syncLabels();

// ───────── 핀 (내가 저장한 곳은 빨강, 다른 사람이 저장한 곳은 주황) ─────────
const markers = new Map();
const pinHtml = (name, cls = "") => `<div class="pinw ${cls}"><i></i>${name ? `<span>${esc(name)}</span>` : ""}</div>`;
const pinIcon = (p, sel) => L.divIcon({ className: "pinicon", html: pinHtml(p.name, (sel ? "sel " : "") + (isMine(p) ? "" : "other")), iconSize: [44, 44], iconAnchor: [22, 22] });
function addMarker(p) {
  removeMarker(p.id);
  const m = L.marker([p.lat, p.lng], { icon: pinIcon(p, false), title: p.name, keyboard: true, riseOnHover: true }).addTo(map);
  m._sig = sig(p);
  m.on("click", (ev) => {
    // 작성 중이면 점을 눌러도 상세로 넘어가지 않고, 누른 자리로 핀만 옮김
    if (sheetKind === "form" && draft && draftDirty()) { const ll = map.mouseEventToLatLng(ev.originalEvent); moveDraft(ll.lat, ll.lng); return; }
    openDetail(p.id);
  });
  markers.set(p.id, m);
}
const restoreMarkers = () => markers.forEach((m) => m.setOpacity(1));
function removeMarker(id) { const m = markers.get(id); if (m) { map.removeLayer(m); markers.delete(id); } }
let selId = null;
function markSelected(id) { selId = id; markers.forEach((m, k) => { const p = places.find((x) => x.id === k); if (p) m.setIcon(pinIcon(p, k === id)); }); }
let draftMarker = null;
function setDraftMarker(lat, lng) {
  if (draftMarker) map.removeLayer(draftMarker);
  draftMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "pinicon", html: pinHtml("", "draft"), iconSize: [44, 44], iconAnchor: [22, 22] }), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(map);
}
function clearDraftMarker() { if (draftMarker) { map.removeLayer(draftMarker); draftMarker = null; } }

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
    const sh = sheet.offsetHeight, vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const top = 76, bottom = vh - sh - 24;
    const p = map.latLngToContainerPoint([lat, lng]);
    if (bottom < top + 40) { map.panBy([0, p.y - top], { animate: true }); return; }
    if (p.y > bottom || p.y < top) map.panBy([0, p.y - (top + bottom) / 2], { animate: true });
  });
}
const armDelete = (btn, label, fn) => { btn.onclick = () => {
  if (btn.classList.contains("arm")) { fn(); return; }
  btn.classList.add("arm"); btn.textContent = "한 번 더 누르면 삭제됩니다";
  setTimeout(() => { if (btn.isConnected) { btn.classList.remove("arm"); btn.textContent = label; } }, 3500);
}; };

// ───────── 입력 폼 (새 장소 / 수정) ─────────
let draft = null;
const draftDirty = () => !!draft && (draft.name.trim() || draft.memo.trim() || draft.photos.length || !draft.isNew);

function openForm(lat, lng, existing) {
  releaseUrls();
  draft = existing
    ? { id: existing.id, lat: existing.lat, lng: existing.lng, name: existing.name, memo: existing.memo || "", photos: existing.photos.map((path) => ({ path, url: null })), removed: [], isNew: false, busy: 0, saving: false }
    : { id: uid(), lat, lng, name: "", memo: "", photos: [], removed: [], isNew: true, busy: 0, saving: false };
  showSheet(`<div class="sh"><button class="lnk mut" id="fCancel">취소</button><h2>${draft.isNew ? "새 장소" : "장소 수정"}</h2><button class="lnk b" id="fSave">저장</button></div>
   <div class="grp"><div class="fr"><input id="fName" type="text" placeholder="가게 이름" maxlength="60" autocomplete="off" aria-label="가게 이름" value="${esc(draft.name)}"></div></div>
   <div class="lbl"><span>사진</span><span id="pcnt"></span></div>
   <div class="pgrid" id="pgrid"></div>
   <input id="fFile" class="vh" type="file" accept="image/*" multiple tabindex="-1">
   <div class="grp"><div class="fr col"><textarea id="fMemo" placeholder="메모 (선택)" maxlength="500" aria-label="메모">${esc(draft.memo)}</textarea></div></div>
   <p class="note" id="fLoc"></p>
   <div class="err" id="fErr" hidden></div>
   ${draft.isNew ? "" : `<button class="btn del" id="fDel">이 장소 삭제</button>`}`, "form");
  setDraftMarker(draft.lat, draft.lng); markSelected(null);
  if (existing) { const om = markers.get(existing.id); if (om) om.setOpacity(0); } // 수정 중에는 원래 점을 숨겨서 핀과 겹치지 않게
  renderPhotos(); updLoc(); reveal(draft.lat, draft.lng);
  const d0 = draft;
  if (existing && existing.photos.length) signedUrls(existing.photos).then((us) => { if (draft !== d0) return; d0.photos.forEach((p, i) => { if (p.path && !p.url) p.url = us[existing.photos.indexOf(p.path)] || null; }); renderPhotos(); });
  $("fName").oninput = (e) => (draft.name = e.target.value);
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
  const er = $("fErr"), fail = (m) => { er.textContent = m; er.hidden = false; };
  const name = d.name.trim();
  if (!name) { fail("가게 이름을 입력하세요."); $("fName").focus(); return; }
  if (d.busy) { fail("사진을 처리하는 중입니다. 잠시 뒤 다시 눌러 주세요."); return; }
  d.saving = true; er.hidden = true; $("fSave").disabled = true; $("fSave").textContent = "저장 중…";
  const uploaded = [];
  let saved;
  try {
    for (const p of d.photos) {
      if (!p.blob) continue;
      const path = `${me.id}/${d.id}/${uid()}.jpg`;
      const r = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
      if (r.error) throw r.error;
      uploaded.push({ path, ref: p });
    }
    const photoPaths = d.photos.map((p) => p.path || uploaded.find((u) => u.ref === p).path);
    const row = { lat: d.lat, lng: d.lng, name, memo: d.memo.trim(), photos: photoPaths };
    const r = d.isNew
      ? await sb.from("places").insert({ id: d.id, ...row }).select().single()
      : await sb.from("places").update({ ...row, updated_at: new Date().toISOString() }).eq("id", d.id).select().single();
    if (r.error) throw r.error;
    saved = r.data;
  } catch (e) {
    if (uploaded.length) sb.storage.from(BUCKET).remove(uploaded.map((u) => u.path)).catch(() => {}); // 올리다 실패한 사진 정리
    d.saving = false;
    if (draft === d && $("fSave")) { $("fSave").disabled = false; $("fSave").textContent = "저장"; fail("저장하지 못했습니다. 네트워크와 로그인 상태를 확인하고, 내가 만든 장소만 수정할 수 있습니다."); }
    return;
  }
  if (d.removed.length) sb.storage.from(BUCKET).remove(d.removed).catch(() => {}); // 지운 사진 파일 정리
  const rec = norm(saved), i = places.findIndex((x) => x.id === rec.id);
  if (i >= 0) places[i] = rec; else places.push(rec);
  updCount(); addMarker(rec);
  if (draft === d) hideSheet();
  toast(d.isNew ? "저장했습니다" : "수정했습니다");
  if (d.isNew) { markSelected(rec.id); setTimeout(() => { if (selId === rec.id && !sheetKind) markSelected(null); }, 1600); }
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
  const mine = isMine(p);
  showSheet(`<div class="sh"><button class="lnk mut" id="dClose">닫기</button><h2>장소</h2>${mine ? `<button class="lnk" id="dEdit">수정</button>` : `<span style="width:44px"></span>`}</div>
   ${p.photos.length ? `<div class="strip${p.photos.length === 1 ? " one" : ""}" id="strip">${p.photos.map((path, i) => `<button data-ph="${i}" aria-label="사진 ${i + 1} 크게 보기"><img data-path="${esc(path)}" alt="${esc(p.name)} 사진 ${i + 1}"></button>`).join("")}</div>` : ""}
   <h3 class="dname">${esc(p.name)}</h3>
   <div class="who">${mine ? "내가 저장한 장소" : esc(nameOf(p.owner)) + "님이 저장한 장소"}</div>
   ${p.memo ? `<p class="dmemo" style="margin-top:10px">${esc(p.memo)}</p>` : ""}
   <div class="meta" style="margin-top:8px">저장 ${fmtDate(p.createdAt)}${p.updatedAt - p.createdAt > 60000 ? ` · 수정 ${fmtDate(p.updatedAt)}` : ""}<br>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div>
   <a class="btn sub" id="dOpen" href="https://maps.apple.com/?ll=${p.lat},${p.lng}&q=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">지도 앱에서 열기</a>
   ${mine ? `<button class="btn del" id="dDel">삭제</button>` : `<p class="note" style="margin-top:12px">다른 사람이 만든 장소는 수정하거나 삭제할 수 없습니다.</p>`}`, "detail");
  curDetail = id; markSelected(id); reveal(p.lat, p.lng);
  $("dClose").onclick = hideSheet;
  if (mine) { $("dEdit").onclick = () => openForm(p.lat, p.lng, p); armDelete($("dDel"), "삭제", () => doDelete(id)); }
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
  if (!me) return;
  if (sheetKind === "form" && draft) { moveDraft(ll.lat, ll.lng); return; } // 작성 중이면 위치만 옮김
  if (sheetKind) { hideSheet(); return; } // 상세·목록·설정은 닫기
  if (map.getZoom() < MIN_ADD_ZOOM) {
    map.flyTo(ll, 17, { duration: 0.6 }); toast("확대했습니다. 저장할 위치를 다시 터치하세요.");
    return;
  }
  openForm(ll.lat, ll.lng, null);
}
// 더블탭 확대의 첫 번째 탭에서 입력창이 열리지 않게 잠깐 기다렸다가 처리
let tapTimer = null;
map.on("click", (e) => { hideResults(); clearTimeout(tapTimer); tapTimer = setTimeout(() => handleTap(e.latlng), 260); });
map.on("dblclick zoomstart", () => clearTimeout(tapTimer));
// iOS에서 길게 누르기는 contextmenu로 들어옴: 같은 동작으로 처리
map.on("contextmenu", (e) => { clearTimeout(tapTimer); hideResults(); handleTap(e.latlng); });

// ───────── 목록 ─────────
$("bList").onclick = openList;
function openList() {
  if (!leaveFormOk()) return;
  releaseUrls();
  showSheet(`<div class="sh"><span style="width:44px"></span><h2>저장한 장소 ${places.length}</h2><button class="lnk b" id="lDone">완료</button></div>
   ${places.length ? `<input id="lFil" class="fil" type="search" placeholder="이름·메모·작성자 검색" aria-label="저장한 장소 검색"><div id="lList"></div>`
     : `<div class="empty"><b>아직 저장한 장소가 없습니다</b>지도를 확대해서 저장할 위치를 터치하면<br>가게 이름과 사진을 남길 수 있어요.</div>`}`, "list");
  $("lDone").onclick = hideSheet;
  if (!places.length) return;
  const draw = () => {
    const q = ($("lFil").value || "").trim().toLowerCase();
    const rows = places.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.memo || "").toLowerCase().includes(q) || nameOf(p.owner).toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
    $("lList").innerHTML = rows.length ? rows.map((p) => `<button class="lrow" data-id="${esc(p.id)}"><span class="lth">${p.photos[0] ? `<img alt="" data-path="${esc(p.photos[0])}">` : "<i></i>"}</span><span class="lmn"><b>${esc(p.name)}</b><small>${isMine(p) ? "내가 저장" : esc(nameOf(p.owner))} · ${fmtDate(p.createdAt)}${p.photos.length ? ` · 사진 ${p.photos.length}` : ""}</small></span></button>`).join("") : `<div class="empty">검색 결과가 없습니다</div>`;
    $("lList").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => goPlace(b.dataset.id)));
    const firsts = rows.map((p) => p.photos[0]).filter(Boolean);
    if (firsts.length) fillImages($("lList"), firsts);
  };
  $("lFil").oninput = draw; draw();
}
function goPlace(id) {
  const p = places.find((x) => x.id === id); if (!p) return;
  if (!leaveFormOk()) return;
  hideSheet(); map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 17), { duration: 0.6 });
  map.once("moveend", () => openDetail(id)); setTimeout(() => { if (sheetKind !== "detail") openDetail(id); }, 900);
}

// ───────── 검색 (저장한 장소 + 주소/장소 검색) ─────────
const qEl = $("q"), resEl = $("results");
function hideResults() { resEl.hidden = true; resEl.innerHTML = ""; }
qEl.addEventListener("input", () => { $("qclr").hidden = !qEl.value; if (!qEl.value) hideResults(); });
$("qclr").onclick = () => { qEl.value = ""; $("qclr").hidden = true; hideResults(); qEl.focus(); };
let searchSeq = 0;
$("sf").addEventListener("submit", async (e) => {
  e.preventDefault(); const q = qEl.value.trim(); if (!q) return; qEl.blur();
  const seq = ++searchSeq, ql = q.toLowerCase();
  const mine = places.filter((p) => p.name.toLowerCase().includes(ql) || (p.memo || "").toLowerCase().includes(ql)).slice(0, 5);
  const mineHtml = mine.map((p) => `<button class="res" data-mine="${esc(p.id)}"><b><span class="tag">저장됨</span>${esc(p.name)}</b><small>${esc(p.memo || (isMine(p) ? "내가 저장" : nameOf(p.owner)))}</small></button>`).join("");
  resEl.hidden = false; resEl.innerHTML = mineHtml + `<div class="rnone">검색 중…</div>`;
  bindResults();
  let list = [], failed = false;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ko&q=" + encodeURIComponent(q));
    if (!r.ok) throw new Error(r.status); list = await r.json();
  } catch (err) { failed = true; }
  if (seq !== searchSeq) return;
  const geoHtml = list.map((g, i) => { const parts = String(g.display_name).split(", "); return `<button class="res" data-geo="${i}"><b>${esc(parts[0])}</b><small>${esc(parts.slice(1).join(", "))}</small></button>`; }).join("");
  resEl.innerHTML = mineHtml + geoHtml + (!mineHtml && !geoHtml ? `<div class="rnone">${failed ? "검색하지 못했습니다. 네트워크를 확인하세요." : "검색 결과가 없습니다."}</div>` : (failed ? `<div class="rnone">주소 검색은 지금 사용할 수 없습니다.</div>` : ""));
  bindResults(list);
});
function bindResults(list) {
  resEl.querySelectorAll("[data-mine]").forEach((b) => (b.onclick = () => { hideResults(); goPlace(b.dataset.mine); }));
  resEl.querySelectorAll("[data-geo]").forEach((b) => (b.onclick = () => {
    const g = list[Number(b.dataset.geo)]; hideResults(); if (sheetKind && sheetKind !== "form") hideSheet(); // 작성 중인 폼은 그대로 두고 지도만 이동
    const bb = g.boundingbox && g.boundingbox.map(Number);
    if (bb && bb.length === 4 && bb[1] - bb[0] > 0.0008) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17, padding: [30, 30] });
    else map.flyTo([Number(g.lat), Number(g.lon)], 17, { duration: 0.6 });
  }));
}

// ───────── 내 위치 ─────────
let meMarker = null, meCircle = null;
$("bLoc").onclick = () => {
  if (!navigator.geolocation) { toast("이 브라우저는 위치 기능을 지원하지 않습니다."); return; }
  toast("현재 위치를 찾는 중…", 4000);
  navigator.geolocation.getCurrentPosition((pos) => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (meMarker) map.removeLayer(meMarker); if (meCircle) map.removeLayer(meCircle);
    meCircle = L.circle(ll, { radius: Math.min(pos.coords.accuracy || 30, 500), color: "#0a84ff", weight: 1, fillColor: "#0a84ff", fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: "pinicon", html: pinHtml("", "me"), iconSize: [44, 44], iconAnchor: [22, 22] }), interactive: false, keyboard: false }).addTo(map);
    map.flyTo(ll, Math.max(map.getZoom(), 17), { duration: 0.7 }); $("toast").hidden = true;
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
   <p class="note">내가 저장한 장소는 <b style="color:var(--accent)">빨간 점</b>, 다른 사람이 저장한 장소는 <b style="color:#ff9500">주황 점</b>으로 보입니다. 수정과 삭제는 만든 사람만 할 수 있습니다.</p>
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
  const { data } = await sb.auth.getSession();
  await onSession(data.session);
  sb.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_IN" && me && s && me.id === s.user.id) return; if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") onSession(s); });
})();
