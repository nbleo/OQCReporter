/* OQCRporter 云备份 —— 私有仓库同步
   ---------------------------------------------------------------
   架构（与 FairRecorder 一致）：
     · 公开仓库/pages 只放程序，不存任何业务数据；
     · 每个用户在设置里绑定「自己的私有仓库」+ 自己的 GitHub 令牌；
     · 数据走 Git Data API（blob → tree → commit → ref），不用 Contents API，
       因为照片动辄几百 KB，Contents API 单文件 1 MB 不适合；
     · 只推变化的部分：记录按 updatedAt 增量，照片按远端 tree 里是否已有该路径跳过；
     · 合并策略「后写者胜、只升不降」：远端 updatedAt 比本地新才覆盖本地；
     · 删除用墓碑（deletedAt），别的设备拉到后删除本地副本；
     · 可选 AES-GCM-256 加密（PBKDF2-SHA256 / 10 万轮），口令只在内存里，不落盘。

   私有仓库里的目录：
     users/<login>/oqc/manifest.json                 明文索引（统计/墓碑/照片清单）
     users/<login>/oqc/records/<id>.json             单张检验单（开启加密后为密文）
     users/<login>/oqc/photos/<id>/<pid>.jpg         照片原图（开启加密后为密文）
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var API_BASE = (window.OQC_API_BASE || "https://api.github.com").replace(/\/+$/, "");
  var CFG_KEY = "oqc.gh";
  var LAYOUT = "oqc/per-user/v1";
  var ITER = 100000;
  var NET_TIMEOUT = 30000;

  /* 程序本体所在的公开仓库：禁止把数据写进去 */
  var PUBLIC_CODE_REPOS = [{ owner: "nbleo", repo: "OQCRporter" }];

  var DEFAULTS = {
    owner: "", repo: "", branch: "main", root: "users",
    token: "", login: "", namespace: "",
    encrypt: false, salt: "",
    repoPrivate: null, lastPushAt: 0, known: []
  };

  var S = loadCfg();
  var pass = "";                                  // 加密口令：只在本次会话内存里
  var busy = false;

  /* ---------------- 配置 ---------------- */
  function loadCfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}") || {}; } catch (e) { c = {}; }
    var o = {};
    for (var k in DEFAULTS) o[k] = (c[k] === undefined ? DEFAULTS[k] : c[k]);
    return o;
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(S)); } catch (e) {}
  }
  function configured() { return !!(S.token && S.owner && S.repo); }
  function ready() { return configured() && (!S.encrypt || !!pass); }

  /* ---------------- 小工具 ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function cleanSeg(s) { return String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-"); }
  function shortErr(msg) { var s = String(msg || ""); return s.length > 160 ? s.slice(0, 157) + "…" : s; }
  function cleanToken(v) { return String(v || "").replace(/\s+/g, "").trim(); }
  function badChar(v) {
    for (var i = 0; i < v.length; i++) { var c = v.charCodeAt(i); if (c < 32 || c > 126) return true; }
    return false;
  }

  function log(msg) {
    var el = document.getElementById("cloudLog");
    if (!el) return;
    var line = document.createElement("div");
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.childNodes.length > 120) el.removeChild(el.firstChild);
  }

  function b64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(u8) {
    var out = "", CH = 0x8000, i;
    for (i = 0; i < u8.length; i += CH) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(out);
  }

  /* ---------------- GitHub API ---------------- */
  async function api(method, path, body) {
    if (!S.token) throw new Error("还没有填 GitHub 令牌");
    if (badChar(S.token) || badChar(S.owner) || badChar(S.repo) || badChar(S.branch)) {
      throw new Error("仓库/令牌里有不可见字符，请重新粘贴");
    }
    var url = API_BASE + path + (method === "GET" ? (path.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now() : "");
    var headers = {
      Authorization: "Bearer " + S.token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (body) headers["Content-Type"] = "application/json";

    var tries = method === "GET" ? 3 : 1;
    var lastErr = null;
    for (var attempt = 0; attempt < tries; attempt++) {
      var ctl = new AbortController();
      var tm = setTimeout(function () { ctl.abort(); }, NET_TIMEOUT);
      var res;
      try {
        res = await fetch(url, {
          method: method, headers: headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: ctl.signal, cache: "no-store"
        });
      } catch (e) {
        clearTimeout(tm);
        lastErr = (e && e.name === "AbortError")
          ? new Error("请求超时（" + NET_TIMEOUT / 1000 + "s），检查网络")
          : new Error("连不上 GitHub（" + ((e && e.message) || "网络错误") + "）");
        if (e && e.name === "AbortError") throw lastErr;
        if (attempt === tries - 1) throw lastErr;
        await sleep(600 * (attempt + 1));
        continue;
      }
      clearTimeout(tm);

      var txt = await res.text();
      var data = null;
      if (txt) { try { data = JSON.parse(txt); } catch (e2) { data = { raw: txt }; } }
      if (res.ok) return data;
      if (res.status === 204) return null;

      var msg = (data && (data.message || data.raw)) || (res.status + " " + res.statusText);
      var err = new Error(shortErr(msg));
      err.status = res.status;
      err.data = data;
      if (res.status === 401) err.message = "令牌无效或已过期（401）";
      if (res.status === 403) err.message = "没有权限或触发频率限制（403）：" + shortErr(msg);
      if (res.status === 404) err.message = "仓库/分支不存在，或令牌没有该仓库的权限（404）";
      throw err;
    }
    throw lastErr || new Error("请求失败");
  }

  /* ---------------- 路径 ---------------- */
  function who() { return cleanSeg(S.login || S.namespace); }
  function userRoot() { return String(S.root || "users").replace(/^\/+|\/+$/g, "") + "/" + who(); }
  function base() { return userRoot() + "/oqc"; }
  function manifestPath() { return base() + "/manifest.json"; }
  function recPath(id) { return base() + "/records/" + id + ".json"; }
  function photoPath(id, pid) { return base() + "/photos/" + id + "/" + pid + ".jpg"; }

  /* ---------------- 身份 / 仓库校验 ---------------- */
  async function ensureIdentity() {
    if (who()) return who();
    var me = await api("GET", "/user");
    S.login = me && me.login || "";
    saveCfg();
    if (!who()) throw new Error("拿不到 GitHub 登录名，请填“命名空间”");
    return who();
  }

  async function checkRepo() {
    if (!S.token) throw new Error("还没有填 GitHub 令牌");
    if (!S.owner || !S.repo) throw new Error("还没有填数据仓库 owner / repo");
    for (var i = 0; i < PUBLIC_CODE_REPOS.length; i++) {
      var p = PUBLIC_CODE_REPOS[i];
      if (p.owner.toLowerCase() === S.owner.toLowerCase() && p.repo.toLowerCase() === S.repo.toLowerCase()) {
        throw new Error("这是公开的程序仓库，不能存检验数据；请绑定一个私有仓库");
      }
    }
    var info = await api("GET", "/repos/" + S.owner + "/" + S.repo);
    if (!info || info.private !== true) {
      throw new Error("这个仓库是公开的：检验数据和照片会被人看到，请改用私有仓库");
    }
    S.repoPrivate = true; saveCfg();
    return info;
  }

  /* ---------------- tree / blob ---------------- */
  async function fetchTree() {
    var p = "/repos/" + S.owner + "/" + S.repo + "/git/trees/" + encodeURIComponent(S.branch) + "?recursive=1";
    try {
      var t = await api("GET", p);
      var map = new Map();
      (t.tree || []).forEach(function (e) { if (e.type === "blob") map.set(e.path, e); });
      return { map: map, empty: false };
    } catch (e) {
      // 空仓库：refs 还不存在
      if (e.status === 404 || e.status === 409 || e.status === 422) return { map: new Map(), empty: true };
      throw e;
    }
  }
  async function readBlobBytes(sha) {
    var b = await api("GET", "/repos/" + S.owner + "/" + S.repo + "/git/blobs/" + sha);
    return b64ToBytes(b.content);
  }
  async function putBlobBytes(bytes) {
    var b = await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/blobs",
      { content: bytesToB64(bytes), encoding: "base64" });
    return b.sha;
  }

  /* ---------------- 提交（四步法，422 重试） ---------------- */
  async function commitFiles(files, message, emptyRepo) {
    if (emptyRepo) {
      var tree0 = await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/trees", { tree: files });
      var c0 = await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/commits",
        { message: message, tree: tree0.sha, parents: [] });
      await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/refs",
        { ref: "refs/heads/" + S.branch, sha: c0.sha });
      return c0.sha;
    }
    var lastErr = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        var ref = await api("GET", "/repos/" + S.owner + "/" + S.repo + "/git/ref/heads/" + S.branch);
        var parentSha = ref.object.sha;
        var parent = await api("GET", "/repos/" + S.owner + "/" + S.repo + "/git/commits/" + parentSha);
        var t = await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/trees",
          { base_tree: parent.tree.sha, tree: files });
        var c = await api("POST", "/repos/" + S.owner + "/" + S.repo + "/git/commits",
          { message: message, tree: t.sha, parents: [parentSha] });
        await api("PATCH", "/repos/" + S.owner + "/" + S.repo + "/git/refs/heads/" + S.branch, { sha: c.sha });
        return c.sha;
      } catch (e) {
        // 期间别的设备推进过分支 → 422 not a fast forward，重建 tree/commit 即可（blob 已传）
        if (e.status !== 422 || attempt === 3) throw e;
        lastErr = e;
        log("提交撞车，重试 " + (attempt + 1) + " …");
        await sleep(500 * (attempt + 1));
      }
    }
    throw lastErr || new Error("提交失败");
  }

  /* ---------------- 加密（可选） ---------------- */
  function newSalt() { var u = new Uint8Array(16); crypto.getRandomValues(u); return bytesToB64(u); }
  async function deriveKey(password, saltB64) {
    var baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
      "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBytes(saltB64), iterations: ITER, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encBytes(bytes, key) {
    var iv = new Uint8Array(12); crypto.getRandomValues(iv);
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, bytes));
    var out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return out;
  }
  async function decBytes(bytes, key) {
    var iv = bytes.subarray(0, 12), ct = bytes.subarray(12);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct));
    } catch (e) {
      throw new Error("解密失败：口令不对（或这份备份不是用这个口令加密的）");
    }
  }
  async function encJSON(obj, key, salt) {
    var iv = new Uint8Array(12); crypto.getRandomValues(iv);
    var ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key,
      new TextEncoder().encode(JSON.stringify(obj))));
    return { enc: 1, alg: "AES-GCM-256", kdf: "PBKDF2-SHA256", iter: ITER, salt: salt,
             iv: bytesToB64(iv), ct: bytesToB64(ct) };
  }
  async function decJSON(payload, key) {
    if (!payload || payload.enc !== 1) return payload;
    try {
      var pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(payload.iv) },
        key, b64ToBytes(payload.ct));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      throw new Error("解密失败：口令不对（或这份备份不是用这个口令加密的）");
    }
  }
  async function getKey(salt) {
    if (!S.encrypt) return null;
    if (!pass) throw new Error("这个备份已开启加密：请先在上面填“加密口令”");
    var s = salt || S.salt;
    if (!s) throw new Error("云端缺少 salt，无法解密（可能是别的设备用了不同口令）");
    return deriveKey(pass, s);
  }

  /* ---------------- 本地读写（不改 updated 时间戳） ---------------- */
  function putRecRaw(obj) {
    var clean = JSON.parse(JSON.stringify(obj));
    if (Store.mode === "idb") return Store._idbSet("recs", null, clean);
    if (Store.mode === "ls") {
      var a = Store.lsRecs(), i = a.findIndex(function (x) { return x.id === clean.id; });
      if (i >= 0) a[i] = clean; else a.push(clean);
      return Store.lsSetRecs(a);
    }
    var j = memRecs.findIndex(function (x) { return x.id === clean.id; });
    if (j >= 0) memRecs[j] = clean; else memRecs.push(clean);
    return Promise.resolve();
  }

  function recPayload(r) {
    return {
      id: r.id, index: r.index || 1, created: r.created || 0, updated: r.updated || 0,
      f: r.f || {}, v: r.v || {}, c: r.c || {}, ph: r.ph || {},
      sign: r.sign || null, remark: r.remark || ""
    };
  }
  function pidsOf(r) {
    var ph = r.ph || {}, out = [];
    for (var k in ph) if (ph[k]) out.push(ph[k]);
    if (r.sign) out.push(r.sign);
    return out;
  }

  /* ---------------- 上传 ---------------- */
  async function push(opts) {
    opts = opts || {};
    await ensureIdentity();
    await checkRepo();

    var st = await fetchTree();
    var remote = null;
    if (st.map.has(manifestPath())) {
      var raw = await readBlobBytes(st.map.get(manifestPath()).sha);
      try { remote = JSON.parse(new TextDecoder().decode(raw)); } catch (e) { remote = null; }
    }

    var entries = new Map();
    if (remote && remote.records) {
      remote.records.forEach(function (x) { entries.set(x.id, Object.assign({}, x)); });
    }
    // 先记下远端原样，后面要拿它判断“有没有真变化”（entries 里的对象是浅拷贝，改它不影响这里）
    var remoteSig = remote ? JSON.stringify(remote.records || []) : "";
    var remoteEnc = remote ? !!remote.encrypted : false;
    var remoteLayout = remote ? remote.layout : "";

    var local = await Store.listRecs();
    var localIds = new Set(local.map(function (r) { return r.id; }));
    var known = Array.isArray(S.known) ? S.known : [];

    // 1) 本地删掉的、之前同步过的 → 墓碑
    var tomb = known.filter(function (id) { return !localIds.has(id); });
    // 2) 本地已有但还没记入 known 的（导入过别人的包）
    localIds.forEach(function (id) { if (known.indexOf(id) < 0) known.push(id); });

    var key = null;
    if (S.encrypt) {
      // 云端已经加密：沿用云端的 salt，否则旧记录用新 salt 解不开
      if (remote && remote.encrypted && remote.salt && remote.salt !== S.salt) {
        S.salt = remote.salt; saveCfg();
        log("沿用云端的 salt（换了设备也解不坏旧记录）");
      }
      if (!S.salt) { S.salt = newSalt(); saveCfg(); }
      key = await getKey(S.salt);
    }
    // 明文↔密文切换：已有文件全部重传，否则会混着两种格式
    var encChanged = remote ? (!!remote.encrypted !== !!key) : false;
    if (encChanged) log("加密设置变了，正在重传全部文件…");

    var files = [], recs = 0, photos = 0;
    var since = S.lastPushAt || 0;

    for (var i = 0; i < local.length; i++) {
      var r = local[i];
      var prev = entries.get(r.id);
      var isDirty = encChanged || !prev || (r.updated || 0) > (prev.updatedAt || 0) || (r.updated || 0) > since;

      if (isDirty) {
        var payload = recPayload(r);
        var bytes;
        if (key) bytes = new TextEncoder().encode(JSON.stringify(await encJSON(payload, key, S.salt)));
        else bytes = new TextEncoder().encode(JSON.stringify(payload));
        var sha = await putBlobBytes(bytes);
        files.push({ path: recPath(r.id), mode: "100644", type: "blob", sha: sha });
        recs++;
      }

      // 照片：远端已有该路径就跳过（增量）
      var pids = pidsOf(r);
      for (var j = 0; j < pids.length; j++) {
        var pid = pids[j];
        var p = photoPath(r.id, pid);
        if (!encChanged && st.map.has(p)) continue;
        var blob = await Store.getBlob(pid);
        if (!blob) continue;
        var pb = new Uint8Array(await blob.arrayBuffer());
        if (key) pb = await encBytes(pb, key);
        var psha = await putBlobBytes(pb);
        files.push({ path: p, mode: "100644", type: "blob", sha: psha });
        photos++;
        if (photos % 5 === 0) log("已上传照片 " + photos + " 张…");
      }

      entries.set(r.id, {
        id: r.id, updatedAt: r.updated || Date.now(), photos: pids,
        summary: {
          po: (r.f && r.f.po) || "", item: (r.f && r.f.item) || "",
          date: (r.f && r.f.date) || "", inspector: (r.f && r.f.inspector) || ""
        }
      });
    }

    for (var t = 0; t < tomb.length; t++) {
      var e = entries.get(tomb[t]) || { id: tomb[t], photos: [] };
      e.deletedAt = Date.now();
      e.photos = [];
      entries.set(tomb[t], e);
    }

    var manifest = {
      layout: LAYOUT, updatedAt: Date.now(), encrypted: !!key, salt: S.salt || null,
      records: Array.from(entries.values())
    };
    var mChanged = !remote || remoteLayout !== LAYOUT || remoteEnc !== !!key ||
      remoteSig !== JSON.stringify(manifest.records);

    if (!files.length && !mChanged) {
      S.lastPushAt = Date.now(); saveCfg(); renderState();
      return { recs: 0, photos: 0, noop: true };
    }

    var mb = new TextEncoder().encode(JSON.stringify(manifest));
    var msha = await putBlobBytes(mb);
    files.push({ path: manifestPath(), mode: "100644", type: "blob", sha: msha });

    var sha = await commitFiles(files,
      "oqc: " + recs + " record(s), " + photos + " photo(s)" + (tomb.length ? ", " + tomb.length + " deleted" : ""),
      st.empty);

    S.lastPushAt = Date.now();
    S.known = known.filter(function (id) { return localIds.has(id); });
    saveCfg(); renderState();
    return { recs: recs, photos: photos, deleted: tomb.length, sha: sha };
  }

  /* ---------------- 恢复 ---------------- */
  async function pull(opts) {
    opts = opts || {};
    await ensureIdentity();
    await checkRepo();

    var st = await fetchTree();
    if (!st.map.has(manifestPath())) return { recs: 0, photos: 0, none: true };

    var raw = await readBlobBytes(st.map.get(manifestPath()).sha);
    var manifest = JSON.parse(new TextDecoder().decode(raw));
    if (manifest.layout !== LAYOUT) throw new Error("云端布局不匹配（" + (manifest.layout || "?") + "）");

    var key = null;
    if (manifest.encrypted) {
      if (!S.encrypt) throw new Error("云端这份备份是加密的：请勾选“加密上传”并填相同口令");
      key = await getKey(manifest.salt);
    }

    var localList = await Store.listRecs();
    var lmap = new Map(localList.map(function (r) { return [r.id, r]; }));
    var recs = 0, photos = 0, dels = 0, skipped = 0;

    for (var i = 0; i < (manifest.records || []).length; i++) {
      var e = manifest.records[i];
      var cur = lmap.get(e.id);

      if (e.deletedAt) {
        if (cur && (cur.updated || 0) <= (e.deletedAt || 0)) { await Store.delRec(e.id); dels++; }
        continue;
      }
      if (cur && (cur.updated || 0) >= (e.updatedAt || 0)) { skipped++; continue; }

      var ent = st.map.get(recPath(e.id));
      if (!ent) continue;

      var bytes = await readBlobBytes(ent.sha);
      var obj;
      try { obj = JSON.parse(new TextDecoder().decode(bytes)); }
      catch (err) {
        if (!key) throw new Error("记录 " + e.id + " 读不出来（可能是加密记录）");
        obj = bytes;
      }
      if (key) obj = await decJSON(obj, key);

      for (var j = 0; j < (e.photos || []).length; j++) {
        var pid = e.photos[j];
        var have = await Store.getBlob(pid);
        if (have) continue;
        var pent = st.map.get(photoPath(e.id, pid));
        if (!pent) continue;
        var pb = await readBlobBytes(pent.sha);
        if (key) pb = await decBytes(pb, key);
        await Store.putBlob(pid, new Blob([pb], { type: "image/jpeg" }));
        photos++;
      }
      await putRecRaw(obj);
      recs++;
    }

    S.known = Array.from(new Set((S.known || []).concat(localList.map(function (r) { return r.id; }))));
    saveCfg();
    await refreshUI();
    renderState();
    return { recs: recs, photos: photos, deleted: dels, skipped: skipped };
  }

  async function syncNow() {
    var out = {};
    try { out.pull = await pull(); } catch (e) { out.pullErr = shortErr(e.message); }
    out.push = await push();
    return out;
  }

  async function refreshUI() {
    try { await renderHistory(); } catch (e) {}
    try {
      if (rec) {
        var cur = await Store.getRec(rec.id);
        if (cur) { rec = cur; rec.c = rec.c || {}; await loadURLs(rec); renderAll(); }
      }
    } catch (e) {}
  }

  /* ---------------- 测试连接 ---------------- */
  async function test() {
    var me = await api("GET", "/user");
    S.login = me.login; saveCfg();
    var info = await checkRepo();
    var p = "/repos/" + S.owner + "/" + S.repo + "/git/trees/" + encodeURIComponent(S.branch) + "?recursive=1";
    var files = 0;
    try { var t = await api("GET", p); files = (t.tree || []).length; } catch (e) { files = 0; }
    return { login: me.login, repo: info.full_name, private: info.private, branch: S.branch, files: files };
  }

  /* ---------------- UI ---------------- */
  var FIELD = [
    ["owner", "仓库 owner（账号名）", "nbleo"],
    ["repo", "私有数据仓库名", "oqc-data"],
    ["branch", "分支", "main"],
    ["namespace", "命名空间（可留空，默认用登录名）", ""]
  ];

  function boxHTML() {
    var f = FIELD.map(function (x) {
      return '<div class="fld"><label>' + x[1] + '</label>' +
        '<input data-cfg="' + x[0] + '" value="' + esc(S[x[0]] || "") + '" placeholder="' + x[2] + '"' +
        (x[0] === "owner" || x[0] === "repo" ? ' autocapitalize="off" autocorrect="off" spellcheck="false"' : '') + '></div>';
    }).join("");

    return '<h3>云备份 · 私有仓库</h3>' +
      '<div class="sub">数据只写进<strong>你自己的私有仓库</strong>；公开的 Pages 只放程序。' +
      '令牌只存在这台设备上，别用别人的手机登录。</div>' +
      '<div class="row2">' + f + '</div>' +
      '<div class="fld"><label>GitHub 令牌（PAT，需要该私有仓库的 Contents 读写）</label>' +
      '<input data-cfg="token" type="password" autocomplete="off" spellcheck="false" ' +
      'placeholder="' + (S.token ? "已保存（留空＝沿用）" : "ghp_… / github_pat_…") + '" value=""></div>' +
      '<div class="chk"><input type="checkbox" id="cfgEnc"' + (S.encrypt ? " checked" : "") + '>' +
      '<label for="cfgEnc" style="margin:0">加密上传（AES-GCM，口令不保存）</label></div>' +
      '<div class="fld"' + (S.encrypt ? "" : ' style="display:none"') + ' id="passWrap">' +
      '<label>加密口令（每次同步都要填；忘了就无法解密）</label>' +
      '<input id="cfgPass" type="password" autocomplete="off" spellcheck="false" placeholder="口令" value=""></div>' +
      '<div class="cacts">' +
      '<button data-act="save">保存配置</button>' +
      '<button data-act="test">测试连接</button>' +
      '<button data-act="sync" class="primary">双向同步</button>' +
      '<button data-act="up">只上传</button>' +
      '<button data-act="down">只恢复</button>' +
      '<button data-act="close">关闭</button>' +
      '</div>' +
      '<div id="cloudLog"></div>';
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openPanel() {
    var ov = document.getElementById("cloudOv");
    var box = document.getElementById("cloudBox");
    if (!ov || !box) return;
    box.innerHTML = boxHTML();
    ov.classList.add("on");
    bindPanel(box);
    if (S.encrypt) { var p = document.getElementById("cfgPass"); if (p) p.value = pass; }
    renderState();
  }
  function closePanel() {
    var ov = document.getElementById("cloudOv");
    if (ov) ov.classList.remove("on");
  }

  function readPanel() {
    var box = document.getElementById("cloudBox");
    if (!box) return;
    var inputs = box.querySelectorAll("input[data-cfg]");
    for (var i = 0; i < inputs.length; i++) {
      var k = inputs[i].dataset.cfg;
      var v = inputs[i].value;
      if (k === "token") { if (v.trim()) S.token = cleanToken(v); }
      else S[k] = v.trim();
    }
    var chk = document.getElementById("cfgEnc");
    S.encrypt = !!(chk && chk.checked);
    var p = document.getElementById("cfgPass");
    if (p) pass = p.value;
    if (S.token && badChar(S.token)) S.token = cleanToken(S.token);
    saveCfg();
  }

  function setBusy(on, label) {
    var box = document.getElementById("cloudBox");
    if (!box) return;
    var btns = box.querySelectorAll(".cacts button");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !!on;
    var act = box.querySelector('[data-act="' + (label || "sync") + '"]');
    if (on && act) act.textContent = "处理中…";
  }

  function bindPanel(box) {
    var enc = box.querySelector("#cfgEnc");
    if (enc) enc.addEventListener("change", function () {
      var w = box.querySelector("#passWrap");
      if (w) w.style.display = this.checked ? "" : "none";
    });

    box.addEventListener("click", async function (e) {
      var b = e.target.closest("button[data-act]");
      if (!b) return;
      var act = b.dataset.act;
      if (act === "close") { closePanel(); return; }
      if (busy) return;

      readPanel();
      if (act === "save") {
        renderState();
        log("已保存配置" + (configured() ? "：" + S.owner + "/" + S.repo : "（还没填全）"));
        return;
      }

      busy = true; setBusy(true, act);
      try {
        if (act === "test") {
          log("测试连接…");
          var t = await test();
          log("✔ 已连接 " + t.login + " · " + t.repo + "（私有=" + t.private + "，云端文件 " + t.files + " 个）");
        } else if (act === "up") {
          log("上传中…");
          var u = await push();
          log(u.noop ? "没有变化，无需提交" :
            "✔ 上传完成：记录 " + u.recs + " 条、照片 " + u.photos + " 张" + (u.deleted ? "、删除 " + u.deleted + " 条" : ""));
        } else if (act === "down") {
          log("读取云端…");
          var d = await pull();
          log(d.none ? "云端还没有备份" :
            "✔ 恢复完成：新记录 " + d.recs + " 条、照片 " + d.photos + " 张、删掉 " + d.deleted + " 条（跳过 " + d.skipped + " 条已是最新）");
        } else if (act === "sync") {
          log("同步中…");
          var s = await syncNow();
          if (s.pullErr) log("云端读取失败：" + s.pullErr + "（继续上传）");
          else if (s.pull && !s.pull.none) log("↓ 拉取：记录 " + s.pull.recs + "、照片 " + s.pull.photos + "、删除 " + s.pull.deleted);
          if (s.push && !s.push.noop) log("↑ 上传：记录 " + s.push.recs + "、照片 " + s.push.photos);
          log("✔ 双向同步完成");
        }
      } catch (err) {
        log("✖ " + shortErr((err && err.message) || err));
        console.warn("[OQC sync]", err);
      } finally {
        busy = false;
        setBusy(false);
        renderState();
      }
    });
  }

  function renderState() {
    var el = document.getElementById("cloudState");
    var txt, cls = "";
    if (!configured()) txt = "未配置 · 点上面的按钮绑定私有仓库";
    else if (!ready()) txt = "已配置，但缺加密口令";
    else {
      txt = "✔ <b>" + esc(S.owner + "/" + S.repo) + "</b>";
      if (S.lastPushAt) txt += " · 上次同步 " + new Date(S.lastPushAt).toLocaleString();
      else txt += " · 还没同步过";
    }
    if (el) { el.innerHTML = txt; el.className = "cloud-state" + (cls ? " " + cls : ""); }
    var pill = document.getElementById("tbCloud");
    if (pill) pill.setAttribute("aria-label", configured() ? "云备份已配置" : "云备份未配置");
  }

  /* ---------------- 入口 ---------------- */
  function bindEntry() {
    ["btnCloud", "btnCloud2"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("click", openPanel);
    });
    var bar = document.getElementById("topbar");
    if (bar) {
      var pill = document.createElement("button");
      pill.className = "tb-btn";
      pill.id = "tbCloud";
      pill.title = "云备份";
      pill.textContent = "☁";
      pill.addEventListener("click", openPanel);
      var newBtn = document.getElementById("btnNew");
      bar.insertBefore(pill, newBtn || null);
    }
    var ov = document.getElementById("cloudOv");
    if (ov) ov.addEventListener("click", function (e) { if (e.target === ov) closePanel(); });
    renderState();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindEntry);
  else bindEntry();

  window.OQCCloud = {
    open: openPanel, push: push, pull: pull, sync: syncNow, test: test,
    cfg: function () { return S; },
    setPass: function (p) { pass = p || ""; renderState(); },
    setCfg: function (o) { Object.assign(S, o || {}); saveCfg(); renderState(); },
    reset: function () { localStorage.removeItem(CFG_KEY); S = loadCfg(); renderState(); },
    _putRecRaw: putRecRaw,
    get busy() { return busy; }
  };
})();
