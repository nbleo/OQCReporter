/* OQCReporter —— 浏览器内 PDF 生成器（零依赖）
   ------------------------------------------------------------------
   为什么不用 html2canvas / jsPDF：
     · 报告版式用的是 CSS Grid，html2canvas 还原不了；
     · jsPDF 要先算排版，等于把 layout 重写一遍。
   做法：把已经排好版的 .sheet DOM 量一遍（位置、颜色、文字行框），
   直接翻译成 PDF 绘图指令：
     · 拉丁文本 → 标准 Helvetica 矢量字，并用 Tz 横向缩放对齐原行宽
     · 中日韩等 WinAnsi 装不下的字 → 该行单独栅格化成小图（无需内嵌字体）
     · 照片 → 原始 JPEG 字节直挂 DCTDecode，不重编码、不掉画质
   对外：window.OQCPdf.build(sheets, {title}) -> Promise<Blob>
   ------------------------------------------------------------------ */
(function () {
  "use strict";

  var PX2PT = 0.75;                  // 96dpi 的 px → PDF pt
  var A4W = 595.276, A4H = 841.89;   // A4，pt

  /* Adobe WinAnsi 里能表示的常见非 ASCII 字符 */
  var WIN = {
    "\u20ac":0x80,"\u201a":0x82,"\u0192":0x83,"\u201e":0x84,"\u2026":0x85,"\u2020":0x86,
    "\u2021":0x87,"\u02c6":0x88,"\u2030":0x89,"\u0160":0x8A,"\u2039":0x8B,"\u0152":0x8C,
    "\u2018":0x91,"\u2019":0x92,"\u201c":0x93,"\u201d":0x94,"\u2022":0x95,"\u2013":0x96,
    "\u2014":0x97,"\u2122":0x99,"\u203a":0x9B,"\u0153":0x9C,
    "\u00b7":0xB7,"\u00b0":0xB0,"\u00d7":0xD7,"\u00f7":0xF7,"\u00b5":0xB5,"\u00b1":0xB1,
    "\u00b2":0xB2,"\u00b3":0xB3,"\u00b9":0xB9,"\u00bc":0xBC,"\u00bd":0xBD,"\u00be":0xBE,
    "\u00a9":0xA9,"\u00ae":0xAE,"\u00a0":0xA0,"\u00a7":0xA7,"\u00b6":0xB6,"\u00a3":0xA3,"\u20ac2":0x80
  };

  var FONT_STACK = 'Calibri,"Segoe UI","Helvetica Neue",Arial,"Microsoft YaHei","PingFang SC",sans-serif';

  /* ---------------- 小工具 ---------------- */
  function nMm(v) { return Math.round(v * 100) / 100; }
  function n2(v) { return (Math.round(v * 100) / 100).toString(); }
  function n1(v) { return (Math.round(v * 10) / 10).toString(); }

  function parseColor(s) {
    if (!s) return null;
    if (s === "transparent") return null;
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(",");
    var a = p.length > 3 ? parseFloat(p[3]) : 1;
    if (!(a > 0.02)) return null;
    return [parseFloat(p[0]) / 255, parseFloat(p[1]) / 255, parseFloat(p[2]) / 255];
  }

  function cIdx(ch) {
    if (ch in WIN) return WIN[ch];
    var c = ch.charCodeAt(0);
    return c;
  }
  /* 能否用 WinAnsi 表示（否则整行走栅格） */
  function canLatin(s) {
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], c = cIdx(ch);
      if (!(c >= 32 && c <= 255)) return false;
      if (c === 0x7F) return false;
    }
    return true;
  }
  function pstr(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = cIdx(s[i]);
      if (c === 0x28 || c === 0x29 || c === 0x5C) out += "\\" + String.fromCharCode(c);
      else if (c >= 32 && c <= 126) out += String.fromCharCode(c);
      else out += "\\" + ("00" + c.toString(8)).slice(-3);
    }
    return out;
  }

  var mcv = document.createElement("canvas");
  var mctx = mcv.getContext("2d");
  function measurePt(str, fsPt, bold) {
    mctx.font = (bold ? "bold " : "") + fsPt + "px Helvetica, Arial, sans-serif";
    return mctx.measureText(str).width;
  }

  /* createImageBitmap 在老 Safari / 部分 WebView 上没有，退回 <img> */
  async function decodeAny(blob) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(blob); } catch (e) { /* 继续兜底 */ }
    }
    var url = URL.createObjectURL(blob);
    try {
      var im = new Image();
      im.src = url;
      await (im.decode ? im.decode() : new Promise(function (res, rej) {
        im.onload = res; im.onerror = rej;
      }));
      return im;
    } finally {
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    }
  }

  /* ---------------- JPEG 头解析（拿宽高与通道数） ---------------- */
  function jpegInfo(b) {
    if (!(b[0] === 0xFF && b[1] === 0xD8)) return null;
    var i = 2, n = b.length;
    while (i + 3 < n) {
      if (b[i] !== 0xFF) { i++; continue; }
      var m = b[i + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
      if (m === 0xD9 || m === 0xDA) break;
      var len = (b[i + 2] << 8) | b[i + 3];
      var isSOF = (m >= 0xC0 && m <= 0xCF) && m !== 0xC4 && m !== 0xC8 && m !== 0xCC;
      if (isSOF) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comp: b[i + 9] };
      }
      i += 2 + len;
    }
    return null;
  }

  /* ---------------- 文字行的基线 ---------------- */
  function baselinePx(rect, fsPx) {
    var h = rect.bottom - rect.top;
    var asc = fsPx * 0.905, desc = fsPx * 0.212;
    if (Math.abs(h - (asc + desc)) < 1.4) return rect.top + asc;       // 量到的是字体盒
    return rect.top + (h - (asc + desc)) / 2 + asc;                    // 量到的是行盒
  }

  /* ---------------- PDF 输出 ---------------- */
  function latin1(s) {
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
    return u;
  }

  function assemble(pages, images, info) {
    var chunks = [], pos = 0;
    function put(x) {
      var b = typeof x === "string" ? latin1(x) : x;
      chunks.push(b); pos += b.length;
    }
    // 先分配对象号
    var id = 1;
    var oCatalog = id++, oPages = id++;
    var oPage = pages.map(function () { return id++; });
    var oCont = pages.map(function () { return id++; });
    var oF1 = id++, oF2 = id++;
    var oImg = images.map(function () { return id++; });
    var oInfo = id++;
    var offsets = new Array(id).fill(0);
    var total = id - 1;

    function obj(num, body) { offsets[num] = pos; put(num + " 0 obj\n" + body + "\nendobj\n"); }
    function stream(num, dict, bytes) {
      offsets[num] = pos;
      put(num + " 0 obj\n<< " + dict + " /Length " + bytes.length + " >>\nstream\n");
      put(bytes);
      put("\nendstream\nendobj\n");
    }

    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    obj(oCatalog, "<< /Type /Catalog /Pages " + oPages + " 0 R >>");
    obj(oPages, "<< /Type /Pages /Count " + pages.length + " /Kids [" +
      oPage.map(function (p) { return p + " 0 R"; }).join(" ") + "] >>");

    var resDict = "<< /Font << /F1 " + oF1 + " 0 R /F2 " + oF2 + " 0 R >>" +
      (oImg.length ? " /XObject << " + oImg.map(function (o, i) { return "/Im" + i + " " + o + " 0 R"; }).join(" ") + " >>" : "") +
      " /ProcSet [/PDF /Text /ImageB /ImageC] >>";

    pages.forEach(function (ops, i) {
      obj(oPage[i], "<< /Type /Page /Parent " + oPages + " 0 R /MediaBox [0 0 " +
        n2(A4W) + " " + n2(A4H) + "] /Resources " + resDict + " /Contents " + oCont[i] + " 0 R >>");
      stream(oCont[i], "", latin1(ops.join("\n")));
    });

    obj(oF1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(oF2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    images.forEach(function (im, i) {
      var cs = im.comp === 1 ? "/DeviceGray" : (im.comp === 4 ? "/DeviceCMYK" : "/DeviceRGB");
      stream(oImg[i], "/Type /XObject /Subtype /Image /Width " + im.w + " /Height " + im.h +
        " /ColorSpace " + cs + " /BitsPerComponent 8 /Filter /DCTDecode", im.bytes);
    });

    var t = (info && info.title) || "OQC Report";
    obj(oInfo, "<< /Title (" + pstr(t) + ") /Producer (OQCReporter) /Creator (OQCReporter) >>");

    var xref = pos;
    var x = "%PDF-1.4\n";
    var lines = ["xref", "0 " + (total + 1), "0000000000 65535 f "];
    for (var k = 1; k <= total; k++) {
      lines.push(("0000000000" + offsets[k]).slice(-10) + " 00000 n ");
    }
    put(lines.join("\n") + "\n");
    put("trailer\n<< /Size " + (total + 1) + " /Root " + oCatalog + " 0 R /Info " + oInfo + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");

    return new Blob(chunks, { type: "application/pdf" });
  }

  /* ---------------- DOM → PDF ---------------- */
  function bgOf(el, stop) {
    var n = el;
    while (n && n !== stop) {
      var c = parseColor(getComputedStyle(n).backgroundColor);
      if (c) return c;
      n = n.parentElement;
    }
    return [1, 1, 1];
  }

  function splitLines(node) {
    var s = node.nodeValue, rng = document.createRange();
    rng.selectNodeContents(node);
    var all = rng.getClientRects();
    var usable = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].width > 0.4 && all[i].height > 0.4) usable.push(all[i]);
    }
    if (usable.length <= 1) {
      if (!usable.length) return [];
      return [{ top: usable[0].top, bottom: usable[0].bottom, left: usable[0].left, right: usable[0].right, s: s }];
    }
    // 多行：逐字分组（只有段落类长文本才会走到这里）
    var out = [], cur = null;
    for (var j = 0; j < s.length; j++) {
      rng.setStart(node, j); rng.setEnd(node, j + 1);
      var rs = rng.getClientRects();
      if (!rs.length || rs[0].width <= 0.2) { if (cur) cur.s += s[j]; continue; }
      var r = rs[0];
      if (!cur || Math.abs(r.top - cur.top) > 1.5) {
        cur = { top: r.top, bottom: r.bottom, left: r.left, right: r.right, s: "" };
        out.push(cur);
      }
      cur.s += s[j];
      if (r.left < cur.left) cur.left = r.left;
      if (r.right > cur.right) cur.right = r.right;
      if (r.bottom > cur.bottom) cur.bottom = r.bottom;
    }
    return out.filter(function (l) { return l.s.trim(); });
  }

  function build(sheets, opts) {
    opts = opts || {};
    var images = [];        // {bytes,w,h,comp}
    var imgCache = new Map();

    var host = document.createElement("div");
    host.className = "doc";
    host.style.cssText = "position:fixed;left:-7000px;top:0;width:210mm;visibility:hidden;" +
      "pointer-events:none;z-index:-1";
    var clones = [];
    for (var i = 0; i < sheets.length; i++) {
      var c = sheets[i].cloneNode(true);
      host.appendChild(c);
      clones.push(c);
    }
    document.body.appendChild(host);

    function progress(msg) { if (typeof opts.onProgress === "function") opts.onProgress(msg); }

    function addImage(bytes, w, h, comp) {
      images.push({ bytes: bytes, w: w, h: h, comp: comp || 3 });
      return "Im" + (images.length - 1);
    }

    /* 同一张照片可能出现在多处，按 src 去重，只挂一份 */
    async function imgName(imgEl) {
      var src = imgEl.currentSrc || imgEl.src;
      if (imgCache.has(src)) return imgCache.get(src);
      var job = (async function () {
        var out = null;
        try {
          var resp = await fetch(src);
          var buf = new Uint8Array(await resp.arrayBuffer());
          var meta = jpegInfo(buf);
          // 原始 JPEG 且不太大 → 直接挂（最佳画质、零重编码）
          if (meta && meta.comp !== 4 && buf.length < 1400000) {
            out = { bytes: buf, w: meta.w, h: meta.h, comp: meta.comp };
          }
        } catch (e) { /* 走下面的栅格兜底 */ }
        if (!out) {
          // PNG（签名等）/ 超大 JPEG → 画到白底再压
          try {
            var blob0 = await (await fetch(src)).blob();
            var bmp = await decodeAny(blob0);
            var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
            var cv = document.createElement("canvas");
            cv.width = Math.max(1, Math.round(bmp.width * scale));
            cv.height = Math.max(1, Math.round(bmp.height * scale));
            var cx = cv.getContext("2d");
            cx.fillStyle = "#fff";
            cx.fillRect(0, 0, cv.width, cv.height);
            cx.drawImage(bmp, 0, 0, cv.width, cv.height);
            var blob = await new Promise(function (r) { cv.toBlob(r, "image/jpeg", 0.86); });
            out = { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height, comp: 3 };
          } catch (e2) { out = null; }
        }
        return out ? addImage(out.bytes, out.w, out.h, out.comp) : null;
      })();
      imgCache.set(src, job);
      return job;
    }

    /* CJK 等 WinAnsi 表示不了的行：栅格成小图贴上去
       注意两点：① 画布必须整块铺底色，否则透明边缘被 JPEG 压成黑线；
                 ② 文字宽度超出原行宽时按比例横向压缩，避免最后一个字被裁掉 */
    async function textAsImage(str, fsPx, bold, color, bg, wPx, hPx, baseOff) {
      var ss = 4;
      var cw = Math.max(4, Math.ceil(wPx * ss)), ch = Math.max(4, Math.ceil(hPx * ss));
      if (cw > 2600) { ss = Math.max(1, 2600 / wPx); cw = Math.ceil(wPx * ss); ch = Math.ceil(hPx * ss); }
      var cv = document.createElement("canvas");
      cv.width = cw; cv.height = ch;
      var cx = cv.getContext("2d");
      var bgCss = "rgb(" + Math.round(bg[0] * 255) + "," + Math.round(bg[1] * 255) + "," + Math.round(bg[2] * 255) + ")";
      var fgCss = "rgb(" + Math.round(color[0] * 255) + "," + Math.round(color[1] * 255) + "," + Math.round(color[2] * 255) + ")";
      cx.fillStyle = bgCss;
      cx.fillRect(0, 0, cw, ch);
      cx.setTransform(ss, 0, 0, ss, 0, 0);
      cx.font = (bold ? "bold " : "") + fsPx + "px " + FONT_STACK;
      cx.textBaseline = "alphabetic";
      var tw = cx.measureText(str).width;
      var k = (tw > wPx - 0.6 && tw > 0.1) ? (wPx - 0.6) / tw : 1;
      cx.fillStyle = fgCss;
      cx.save();
      cx.scale(k, 1);
      cx.fillText(str, 0, baseOff > 0 ? baseOff : hPx * 0.79);
      cx.restore();
      var blob = await new Promise(function (r) { cv.toBlob(r, "image/jpeg", 0.92); });
      if (!blob) return null;
      return addImage(new Uint8Array(await blob.arrayBuffer()), cw, ch, 3);
    }

    async function walk(el, ctx, depth) {
      var cs = getComputedStyle(el);
      if (cs.display === "none") return;
      var r = el.getBoundingClientRect();
      var x = (r.left - ctx.ox) * PX2PT;
      var yTop = (r.top - ctx.oy) * PX2PT;
      var w = r.width * PX2PT, h = r.height * PX2PT;
      if (w <= 0.15 || h <= 0.15) return;
      var yb = A4H - (yTop + h);

      // 背景
      var bg = parseColor(cs.backgroundColor);
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      if (bg) {
        if (radius * PX2PT >= Math.min(w, h) / 2 - 0.3 && Math.abs(w - h) < 1.5) {
          var cx0 = x + w / 2, cy0 = yb + h / 2, rr = Math.min(w, h) / 2, k = rr * 0.5523;
          ctx.ops.push("q " + bg.map(n2).join(" ") + " rg " +
            n2(cx0 + rr) + " " + n2(cy0) + " m " +
            n2(cx0 + rr) + " " + n2(cy0 + k) + " " + n2(cx0 + k) + " " + n2(cy0 + rr) + " " + n2(cx0) + " " + n2(cy0 + rr) + " c " +
            n2(cx0 - k) + " " + n2(cy0 + rr) + " " + n2(cx0 - rr) + " " + n2(cy0 + k) + " " + n2(cx0 - rr) + " " + n2(cy0) + " c " +
            n2(cx0 - rr) + " " + n2(cy0 - k) + " " + n2(cx0 - k) + " " + n2(cy0 - rr) + " " + n2(cx0) + " " + n2(cy0 - rr) + " c " +
            n2(cx0 + k) + " " + n2(cy0 - rr) + " " + n2(cx0 + rr) + " " + n2(cy0 - k) + " " + n2(cx0 + rr) + " " + n2(cy0) + " c f Q");
        } else {
          ctx.ops.push("q " + bg.map(n2).join(" ") + " rg " + n2(x) + " " + n2(yb) + " " + n2(w) + " " + n2(h) + " re f Q");
        }
      }

      // 边框（只画有宽度的四条边）
      var sides = [
        ["borderTopWidth", "borderTopColor", x, yb + h, x + w, yb + h],
        ["borderBottomWidth", "borderBottomColor", x, yb, x + w, yb],
        ["borderLeftWidth", "borderLeftColor", x, yb, x, yb + h],
        ["borderRightWidth", "borderRightColor", x + w, yb, x + w, yb + h]
      ];
      for (var si = 0; si < sides.length; si++) {
        var s = sides[si];
        var bw = (parseFloat(cs[s[0]]) || 0) * PX2PT;
        if (bw <= 0.05) continue;
        var bc = parseColor(cs[s[1]]);
        if (!bc) continue;
        ctx.ops.push("q " + bc.map(n2).join(" ") + " RG " + n2(bw) + " w " +
          n2(s[2]) + " " + n2(s[3]) + " m " + n2(s[4]) + " " + n2(s[5]) + " l S Q");
      }

      if (el.tagName === "IMG") {
        var name = await imgName(el);
        if (name) {
          ctx.ops.push("q " + n2(w) + " 0 0 " + n2(h) + " " + n2(x) + " " + n2(yb) + " cm /" + name + " Do Q");
        }
        return;
      }
      if (el.tagName === "SVG" || el.tagName === "CANVAS") return;

      var kids = el.childNodes;
      for (var ki = 0; ki < kids.length; ki++) {
        var node = kids[ki];
        if (node.nodeType === 3) {
          await textNode(node, cs, ctx, el, x, yTop, w, h);
        } else if (node.nodeType === 1) {
          await walk(node, ctx, depth + 1);
        }
      }
    }

    async function textNode(node, cs, ctx, el, elX, elYTop, elW, elH) {
      var raw = node.nodeValue;
      if (!raw || !raw.trim()) return;
      var lines = splitLines(node);
      if (!lines.length) return;

      var fsPx = parseFloat(cs.fontSize) || 10;
      var bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
      var col = parseColor(cs.color) || [0, 0, 0];
      var tt = cs.textTransform;
      var fsPt = fsPx * PX2PT;

      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        var s = ln.s;
        if (tt === "uppercase") s = s.toUpperCase();
        else if (tt === "lowercase") s = s.toLowerCase();
        if (!s.trim()) continue;

        var lx = (ln.left - ctx.ox) * PX2PT;
        var lw = (ln.right - ln.left) * PX2PT;
        var lh = (ln.bottom - ln.top);
        var by = A4H - (baselinePx(ln, fsPx) - ctx.oy) * PX2PT;
        if (lw <= 0.2) continue;

        if (canLatin(s)) {
          var natural = measurePt(s, fsPt, bold);
          var tz = natural > 0.01 ? (lw / natural) * 100 : 100;
          if (!isFinite(tz)) tz = 100;
          tz = Math.max(45, Math.min(260, tz));
          ctx.ops.push("BT /" + (bold ? "F2" : "F1") + " " + n2(fsPt) + " Tf " +
            n2(col[0]) + " " + n2(col[1]) + " " + n2(col[2]) + " rg " +
            "1 0 0 1 " + n2(lx) + " " + n2(by) + " Tm " + n1(tz) + " Tz (" + pstr(s) + ") Tj ET");
        } else {
          var baseOff = baselinePx(ln, fsPx) - ln.top;
          var name = await textAsImage(s, fsPx, bold, col, bgOf(el, host), lw / PX2PT, lh, baseOff);
          if (name) {
            var imgH = lh * PX2PT;
            ctx.ops.push("q " + n2(lw) + " 0 0 " + n2(imgH) + " " + n2(lx) + " " + n2(A4H - (ln.bottom - ctx.oy) * PX2PT) + " cm /" + name + " Do Q");
          }
        }
      }
    }

    async function run() {
      // 克隆进有布局的容器后，先等照片解码，否则 <img> 量出来是 0 宽
      await Promise.all([].map.call(host.querySelectorAll("img"), function (im) {
        return im.decode ? im.decode().catch(function () {}) : Promise.resolve();
      }));
      var all = [];
      for (var i = 0; i < clones.length; i++) {
        var r = clones[i].getBoundingClientRect();
        if (!r.width) throw new Error("页面未排版，无法导出");
        var ctx = { ox: r.left, oy: r.top, ops: [], idx: i };
        progress("正在生成第 " + (i + 1) + "/" + clones.length + " 页…");
        await walk(clones[i], ctx, 0);
        all.push(ctx.ops);
      }
      progress("正在封装 PDF…");
      return assemble(all, images, { title: opts.title || "OQC Report" });
    }

    return run().finally(function () { host.remove(); });
  }

  window.OQCPdf = { build: build, version: "1.0" };
})();
