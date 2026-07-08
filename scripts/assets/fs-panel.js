// Filesystem panel: live tree when the box is up, latest-snapshot tree when it
// is down. Click a file -> viewer dialog (pdf / image / table editors / code
// editor). Drag-and-drop upload onto any folder (live box only).
// Loaded as an ES module; the inline page script exposes window.__optiboxFs.
const $ = (id) => document.getElementById(id);
const panel = $("fsPanel");

let FileTree = null;
let tree = null;
let treePaths = [];
let entryByPath = new Map();
let fsLive = false;
let fsState = "none";
let refreshTimer = null;
let refreshing = false;
const uploading = new Set();

function ctx() {
  const c = window.__optiboxFs && window.__optiboxFs.ctx ? window.__optiboxFs.ctx() : {};
  return { userId: c.userId || "user-a", apiKeys: c.apiKeys || {} };
}

async function api(path, body, asBytes) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ctx(), ...body }),
  });
  if (asBytes) {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
    return { bytes: new Uint8Array(await res.arrayBuffer()), live: res.headers.get("x-fs-live") === "1" };
  }
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.message || res.statusText);
  return json;
}

function setStatus(text, cls) {
  const el = $("fsStatus");
  if (el) { el.textContent = text; el.className = "fsStatus" + (cls ? " " + cls : ""); }
}

// ---------------------------------------------------------------- tree

async function init() {
  setStatus("loading…");
  try {
    ({ FileTree } = await import("https://esm.sh/@pierre/trees@1.0.0-beta.5"));
  } catch (e) {
    setStatus("tree library failed to load: " + e.message);
    return;
  }
  refresh(true);
  refreshTimer = setInterval(() => refresh(false), 4000);
  // The chat page pokes on lifecycle events (billing/exec/turn.done) so the
  // live/snapshot flip shows within a second instead of a poll interval.
  const host = (window.__optiboxFs = window.__optiboxFs || {});
  let pokePending = false;
  host.poke = () => {
    if (pokePending) return;
    pokePending = true;
    setTimeout(() => { pokePending = false; refreshNow().catch(() => {}); }, 400);
  };
  panel.addEventListener("dragover", onDragOver);
  panel.addEventListener("dragleave", () => panel.classList.remove("fsDrop"));
  panel.addEventListener("drop", onDrop);
}

/** Refresh that waits out an in-flight poll instead of silently skipping. */
async function refreshNow() {
  while (refreshing) await new Promise((r) => setTimeout(r, 100));
  await refresh(false);
}

async function refresh(first) {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api("/api/fs/tree", {});
    fsLive = Boolean(data.live);
    fsState = data.state || "none";
    setStatus(
      fsState === "none" ? "no machine yet" : fsLive ? "live" : "snapshot" + (data.treeAvailable === false ? " (tree unavailable)" : ""),
      fsLive ? "live" : "",
    );
    const entries = data.entries || [];
    entryByPath = new Map(entries.map((e) => [e.path, e]));
    const paths = entries.map((e) => (e.kind === "dir" ? e.path + "/" : e.path)).filter((p) => p && p !== "/");
    const changed = paths.length !== treePaths.length || paths.some((p, i) => p !== treePaths[i]);
    if (changed || first) {
      treePaths = paths;
      renderTree(paths);
    }
  } catch (e) {
    if (first) setStatus("unavailable: " + e.message);
  } finally {
    refreshing = false;
  }
}

function renderTree(paths) {
  const mount = $("fsTree");
  if (!mount) return;
  if (!paths.length) {
    if (tree) { try { tree.cleanUp(); } catch {} tree = null; }
    mount.innerHTML = '<div class="fsEmpty">' + (fsState === "none" ? "The machine appears after your first message." : "No files.") + "</div>";
    return;
  }
  if (tree) {
    try { tree.resetPaths(paths); return; } catch {}
    try { tree.cleanUp(); } catch {}
    tree = null;
  }
  mount.innerHTML = "";
  tree = new FileTree({
    paths,
    initialExpansion: "collapsed",
    flattenEmptyDirectories: true,
    search: true,
    stickyFolders: true,
    // Monochrome minimal icons: the colored per-filetype set brings a palette
    // the app doesn't use anywhere else.
    icons: { set: "minimal", colored: false },
    onSelectionChange: (selected) => {
      const p = selected && selected[0];
      if (!p) return;
      const entry = entryByPath.get(String(p).replace(/\/$/, ""));
      if (entry && entry.kind === "file") {
        openViewer(entry.path, entry.size);
        // Deselect so clicking the same file again re-opens it.
        try { const h = tree.getItem(p); h && h.deselect(); } catch {}
      }
    },
    renderRowDecoration: (c) => (uploading.has(c.row.path) ? { text: "uploading…", title: "upload in progress" } : null),
    unsafeCSS: `
      * { font-family: inherit; }
      button[data-type='item'] { border-radius: 7px; }
    `,
  });
  tree.render({ containerWrapper: mount });
}

// ---------------------------------------------------------------- upload

function onDragOver(e) {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  // Machine off -> snapshots are read-only: refuse the drop outright (no
  // preventDefault means the browser shows the blocked cursor).
  if (!fsLive) { panel.classList.remove("fsDrop"); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  panel.classList.add("fsDrop");
}

function dropTargetDir(e) {
  // Resolve the folder under the cursor (tree rows live in a shadow root, so
  // walk the composed path); fall back to the selected folder, then home.
  for (const el of e.composedPath ? e.composedPath() : []) {
    if (!(el instanceof Element)) continue;
    const p = el.getAttribute && (el.getAttribute("data-path") || el.getAttribute("data-item-path"));
    if (p) {
      const clean = String(p).replace(/^\/+|\/+$/g, "");
      const entry = entryByPath.get(clean);
      if (entry) return entry.kind === "dir" ? clean : clean.split("/").slice(0, -1).join("/");
    }
  }
  const sel = tree && tree.getSelectedPaths && tree.getSelectedPaths()[0];
  if (sel) {
    const clean = String(sel).replace(/^\/+|\/+$/g, "");
    const entry = entryByPath.get(clean);
    if (entry) return entry.kind === "dir" ? clean : clean.split("/").slice(0, -1).join("/");
  }
  return ""; // home directory root
}

async function onDrop(e) {
  panel.classList.remove("fsDrop");
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  // Capture files AND target synchronously: the browser neuters dataTransfer
  // as soon as this handler yields, so anything read after an await is empty.
  const files = Array.from(e.dataTransfer.files);
  const dir = dropTargetDir(e);
  // fsLive can be stale; re-check before the optimistic row so a just-stopped
  // machine rejects cleanly instead of flashing a row.
  try { await refreshNow(); } catch {}
  if (!fsLive) { setStatus("machine is off — uploads need a running machine"); return; }
  for (const file of files) {
    const dest = (dir ? dir + "/" : "") + file.name;
    uploading.add(dest);
    entryByPath.set(dest, { path: dest, kind: "file", size: file.size });
    try { tree && tree.add(dest); } catch { renderTree([...treePaths, dest]); }
    (async () => {
      try {
        const b64 = await fileToB64(file);
        await api("/api/fs/write", { path: dest, contentB64: b64 });
      } catch (err) {
        setStatus("upload failed: " + err.message);
        try { tree && tree.remove(dest); } catch {}
      } finally {
        uploading.delete(dest);
        refresh(false);
      }
    })();
  }
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- viewer

let dialog = null;
let saveHandler = null;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement("div");
  dialog.className = "fsViewerBackdrop";
  dialog.innerHTML =
    '<div class="fsViewer" role="dialog" aria-modal="true">' +
    '<div class="fsViewerHead"><span class="fsViewerTitle"></span><button class="fsViewerClose" aria-label="Close">×</button></div>' +
    '<div class="fsViewerBody"></div>' +
    '<button class="fsViewerSave" title="Save (Ctrl+S)">save</button>' +
    "</div>";
  document.body.appendChild(dialog);
  dialog.addEventListener("mousedown", (e) => { if (e.target === dialog) closeViewer(); });
  dialog.querySelector(".fsViewerClose").addEventListener("click", closeViewer);
  dialog.querySelector(".fsViewerSave").addEventListener("click", () => saveHandler && saveHandler());
  window.addEventListener("keydown", (e) => {
    if (dialog.style.display !== "flex") return;
    if (e.key === "Escape") closeViewer();
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveHandler && saveHandler(); }
  });
  return dialog;
}

function closeViewer() {
  if (dialog) dialog.style.display = "none";
  saveHandler = null;
}

function viewerParts(title, canSave) {
  const d = ensureDialog();
  d.style.display = "flex";
  d.querySelector(".fsViewerTitle").textContent = title;
  const body = d.querySelector(".fsViewerBody");
  body.innerHTML = "";
  const saveBtn = d.querySelector(".fsViewerSave");
  saveBtn.style.display = canSave ? "block" : "none";
  saveHandler = null;
  return { body, saveBtn, setSave: (fn) => { saveHandler = fn; } };
}

function markSaved(saveBtn, ok, msg) {
  saveBtn.textContent = ok ? "saved" : (msg || "save failed");
  saveBtn.classList.toggle("err", !ok);
  setTimeout(() => { saveBtn.textContent = "save"; saveBtn.classList.remove("err"); }, 1600);
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov|ogv)$/i;
const SHEET_EXT = /\.(xlsx|xls)$/i;
const SQLITE_EXT = /\.(sqlite3?|db)$/i;
const MIME_BY_EXT = { svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4", mov: "video/quicktime", ogv: "video/ogg", png: "image/png", gif: "image/gif", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };
const mimeFor = (name) => MIME_BY_EXT[(name.split(".").pop() || "").toLowerCase()] || "";

async function openViewer(path, size) {
  const name = path.split("/").pop();
  if (size !== undefined && size > 40 * 1024 * 1024) {
    const { body } = viewerParts(name, false);
    body.appendChild(bigNotice("File is " + human(size) + " — too large to open here.", path));
    return;
  }
  const { body } = viewerParts(name, false);
  body.innerHTML = '<div class="fsLoading">loading…</div>';
  let bytes, live;
  try {
    ({ bytes, live } = await api("/api/fs/read", { path }, true));
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(bigNotice("Could not read file: " + e.message, null));
    return;
  }
  const canSave = live;
  if (/\.pdf$/i.test(name)) return showPdf(path, name, bytes);
  if (IMG_EXT.test(name)) return showImage(path, name, bytes);
  if (VIDEO_EXT.test(name)) return showVideo(path, name, bytes);
  if (SHEET_EXT.test(name)) return showSheet(path, name, bytes, canSave);
  if (SQLITE_EXT.test(name)) return showSqlite(path, name, bytes, canSave);
  if (/\.csv$/i.test(name)) return showCsv(path, name, bytes, canSave);
  const text = tryDecodeText(bytes);
  if (text === null) return showBinary(path, name, bytes);
  return showText(path, name, text, canSave);
}

function human(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

function tryDecodeText(bytes) {
  const probe = bytes.subarray(0, 8192);
  for (const b of probe) if (b === 0) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

function blobUrl(bytes, type) {
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function downloadBytes(name, bytes) {
  const a = document.createElement("a");
  a.href = blobUrl(bytes, "application/octet-stream");
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function bigNotice(text, downloadPath) {
  const div = document.createElement("div");
  div.className = "fsNotice";
  div.textContent = text;
  if (downloadPath) {
    const btn = document.createElement("button");
    btn.className = "fsMiniBtn";
    btn.textContent = "download";
    btn.addEventListener("click", async () => {
      const { bytes } = await api("/api/fs/read", { path: downloadPath }, true);
      downloadBytes(downloadPath.split("/").pop(), bytes);
    });
    div.appendChild(document.createElement("br"));
    div.appendChild(btn);
  }
  return div;
}

function showPdf(path, name, bytes) {
  const { body } = viewerParts(name, false);
  const embed = document.createElement("embed");
  embed.type = "application/pdf";
  embed.src = blobUrl(bytes, "application/pdf");
  embed.className = "fsPdf";
  body.appendChild(embed);
  body.appendChild(cornerDownload(name, bytes));
}

function showImage(path, name, bytes) {
  const { body } = viewerParts(name, false);
  const img = document.createElement("img");
  img.className = "fsImage";
  img.src = blobUrl(bytes, mimeFor(name));
  body.appendChild(img);
  body.appendChild(cornerDownload(name, bytes));
}

function showVideo(path, name, bytes) {
  const { body } = viewerParts(name, false);
  const video = document.createElement("video");
  video.className = "fsVideo";
  video.controls = true;
  video.src = blobUrl(bytes, mimeFor(name));
  // Codec the browser can't decode -> fall back to the binary notice.
  video.addEventListener("error", () => { showBinary(path, name, bytes); }, { once: true });
  body.appendChild(video);
  body.appendChild(cornerDownload(name, bytes));
}

function showBinary(path, name, bytes) {
  const { body } = viewerParts(name, false);
  body.appendChild(bigNotice("Binary file (" + human(bytes.length) + ") — not rendered.", null));
  const btn = document.createElement("button");
  btn.className = "fsMiniBtn";
  btn.textContent = "download";
  btn.addEventListener("click", () => downloadBytes(name, bytes));
  body.querySelector(".fsNotice").appendChild(btn);
}

function cornerDownload(name, bytes) {
  const btn = document.createElement("button");
  btn.className = "fsMiniBtn fsCorner";
  btn.textContent = "download";
  btn.addEventListener("click", () => downloadBytes(name, bytes));
  return btn;
}

// -------- table editor (shared by csv / xlsx / sqlite): chunked rendering ----

function tableEditor(body, rows, header, editable) {
  const wrap = document.createElement("div");
  wrap.className = "fsTableWrap";
  const table = document.createElement("table");
  table.className = "fsTable";
  if (header && header.length) {
    const tr = document.createElement("tr");
    for (const h of header) { const th = document.createElement("th"); th.textContent = h == null ? "" : String(h); tr.appendChild(th); }
    table.appendChild(tr);
  }
  let rendered = 0;
  const CHUNK = 200;
  const renderMore = () => {
    const frag = document.createDocumentFragment();
    const end = Math.min(rows.length, rendered + CHUNK);
    for (let i = rendered; i < end; i++) {
      const tr = document.createElement("tr");
      for (let j = 0; j < rows[i].length; j++) {
        const td = document.createElement("td");
        td.textContent = rows[i][j] == null ? "" : String(rows[i][j]);
        if (editable) {
          td.contentEditable = "true";
          td.dataset.r = String(i); td.dataset.c = String(j);
        }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    rendered = end;
    table.appendChild(frag);
  };
  renderMore();
  wrap.addEventListener("scroll", () => {
    if (rendered < rows.length && wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 600) renderMore();
  });
  if (editable) {
    table.addEventListener("input", (e) => {
      const td = e.target.closest ? e.target.closest("td[data-r]") : null;
      if (td) rows[Number(td.dataset.r)][Number(td.dataset.c)] = td.textContent;
    });
  }
  wrap.appendChild(table);
  body.appendChild(wrap);
  if (rows.length > CHUNK) {
    const note = document.createElement("div");
    note.className = "fsRowCount";
    note.textContent = rows.length + " rows";
    body.appendChild(note);
  }
}

// -------- csv ----------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function showCsv(path, name, bytes, canSave) {
  const text = tryDecodeText(bytes);
  if (text === null) return showBinary(path, name, bytes);
  const rows = parseCsv(text);
  const { body, saveBtn, setSave } = viewerParts(name, canSave);
  tableEditor(body, rows, null, canSave);
  setSave(async () => {
    const out = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
    try { await api("/api/fs/write", { path, contentB64: b64encode(new TextEncoder().encode(out)) }); markSaved(saveBtn, true); }
    catch (e) { markSaved(saveBtn, false, e.message); }
  });
}

function b64encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// -------- xlsx (SheetJS, lazy CDN) -------------------------------------------

let xlsxReady = null;
function loadXlsx() {
  xlsxReady ??= import("https://esm.sh/xlsx@0.18.5").then((m) => m.default ?? m);
  return xlsxReady;
}

async function showSheet(path, name, bytes, canSave) {
  const { body, saveBtn, setSave } = viewerParts(name, canSave);
  body.innerHTML = '<div class="fsLoading">loading sheet…</div>';
  let XLSX;
  try { XLSX = await loadXlsx(); } catch { body.innerHTML = ""; return body.appendChild(bigNotice("Sheet library failed to load.", null)), undefined; }
  const wb = XLSX.read(bytes, { type: "array" });
  body.innerHTML = "";
  let sheetName = wb.SheetNames[0];
  const rowsBySheet = {};
  const getRows = (s) => (rowsBySheet[s] ??= XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, defval: "" }));
  const renderSheet = () => {
    body.innerHTML = "";
    if (wb.SheetNames.length > 1) {
      const sel = document.createElement("select");
      sel.className = "fsSheetPick";
      for (const s of wb.SheetNames) { const o = document.createElement("option"); o.value = s; o.textContent = s; if (s === sheetName) o.selected = true; sel.appendChild(o); }
      sel.addEventListener("change", () => { sheetName = sel.value; renderSheet(); });
      body.appendChild(sel);
    }
    tableEditor(body, getRows(sheetName), null, canSave);
  };
  renderSheet();
  setSave(async () => {
    try {
      for (const s of Object.keys(rowsBySheet)) wb.Sheets[s] = XLSX.utils.aoa_to_sheet(rowsBySheet[s]);
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      await api("/api/fs/write", { path, contentB64: b64encode(new Uint8Array(out)) });
      markSaved(saveBtn, true);
    } catch (e) { markSaved(saveBtn, false, e.message); }
  });
}

// -------- sqlite (sql.js, lazy CDN) ------------------------------------------

let sqlReady = null;
function loadSql() {
  sqlReady ??= import("https://esm.sh/sql.js@1.13.0").then(async (m) => {
    const init = m.default ?? m;
    return init({ locateFile: (f) => "https://esm.sh/sql.js@1.13.0/dist/" + f });
  });
  return sqlReady;
}

async function showSqlite(path, name, bytes, canSave) {
  const { body, saveBtn, setSave } = viewerParts(name, canSave);
  body.innerHTML = '<div class="fsLoading">loading database…</div>';
  let SQL;
  try { SQL = await loadSql(); } catch { body.innerHTML = ""; return body.appendChild(bigNotice("SQLite library failed to load.", null)), undefined; }
  let db;
  try { db = new SQL.Database(bytes); } catch (e) { body.innerHTML = ""; return body.appendChild(bigNotice("Not a readable SQLite file: " + e.message, null)), undefined; }
  const tables = (db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0]?.values ?? []).map((v) => v[0]);
  body.innerHTML = "";
  if (!tables.length) return body.appendChild(bigNotice("Empty database.", null)), undefined;
  let table = tables[0];
  const render = () => {
    body.innerHTML = "";
    if (tables.length > 1) {
      const sel = document.createElement("select");
      sel.className = "fsSheetPick";
      for (const t of tables) { const o = document.createElement("option"); o.value = t; o.textContent = t; if (t === table) o.selected = true; sel.appendChild(o); }
      sel.addEventListener("change", () => { table = sel.value; render(); });
      body.appendChild(sel);
    }
    const q = db.exec(`SELECT rowid AS __rid, * FROM "${table.replace(/"/g, '""')}" LIMIT 5000`)[0];
    if (!q) { body.appendChild(bigNotice("Table is empty.", null)); return; }
    const cols = q.columns.slice(1);
    const rids = q.values.map((v) => v[0]);
    const rows = q.values.map((v) => v.slice(1));
    tableEditor(body, rows, cols, canSave);
    if (canSave) {
      body._commit = () => {
        const sets = cols.map((c) => `"${String(c).replace(/"/g, '""')}"=?`).join(",");
        for (let i = 0; i < rows.length; i++) {
          db.run(`UPDATE "${table.replace(/"/g, '""')}" SET ${sets} WHERE rowid=?`, [...rows[i], rids[i]]);
        }
      };
    }
  };
  render();
  setSave(async () => {
    try {
      if (body._commit) body._commit();
      const out = db.export();
      await api("/api/fs/write", { path, contentB64: b64encode(out) });
      markSaved(saveBtn, true);
    } catch (e) { markSaved(saveBtn, false, e.message); }
  });
}

// -------- text / code (CodeMirror 5, lazy CDN) --------------------------------

const CM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16";
const CM_MODE_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "javascript", tsx: "javascript", jsx: "javascript", json: "javascript",
  py: "python", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", markdown: "markdown",
  css: "css", scss: "css", html: "htmlmixed", htm: "htmlmixed", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", sql: "sql", rs: "rust", go: "go", c: "clike", h: "clike", cpp: "clike", java: "clike", toml: "toml", ini: "toml",
};
const CM_MODE_DEPS = { htmlmixed: ["xml", "javascript", "css"] };
let cmCore = null;
const cmModes = new Set();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("script load failed"));
    document.head.appendChild(s);
  });
}

async function loadCM(mode) {
  if (!cmCore) {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = CM_BASE + "/codemirror.min.css";
    document.head.appendChild(link);
    cmCore = loadScript(CM_BASE + "/codemirror.min.js");
  }
  await cmCore;
  if (mode && !cmModes.has(mode)) {
    for (const dep of CM_MODE_DEPS[mode] ?? []) {
      if (!cmModes.has(dep)) { await loadScript(`${CM_BASE}/mode/${dep}/${dep}.min.js`).catch(() => {}); cmModes.add(dep); }
    }
    await loadScript(`${CM_BASE}/mode/${mode}/${mode}.min.js`).catch(() => {});
    cmModes.add(mode);
  }
  return window.CodeMirror;
}

async function showText(path, name, text, canSave) {
  const { body, saveBtn, setSave } = viewerParts(name, canSave);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const mode = CM_MODE_BY_EXT[ext];
  let getValue = () => text;
  let CM = null;
  try { CM = await loadCM(mode); } catch {}
  if (CM) {
    const editor = CM((el) => body.appendChild(el), {
      value: text,
      mode: mode || null,
      lineNumbers: true,
      readOnly: canSave ? false : "nocursor",
      viewportMargin: 50,
      lineWrapping: false,
    });
    editor.setSize("100%", "100%");
    getValue = () => editor.getValue();
    setTimeout(() => editor.refresh(), 30);
  } else {
    const ta = document.createElement("textarea");
    ta.className = "fsPlainText";
    ta.value = text;
    ta.readOnly = !canSave;
    body.appendChild(ta);
    getValue = () => ta.value;
  }
  setSave(async () => {
    if (!canSave) { markSaved(saveBtn, false, "read-only"); return; }
    try { await api("/api/fs/write", { path, contentB64: b64encode(new TextEncoder().encode(getValue())) }); markSaved(saveBtn, true); }
    catch (e) { markSaved(saveBtn, false, e.message); }
  });
}

// Kick off last: every top-level binding above is initialized by now.
if (panel) init();
