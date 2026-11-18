/* FileFreely shared helpers. Everything runs in the visitor's browser; no file is uploaded. */
(function () {
  const FF = {};

  FF.fmtBytes = function (n) {
    if (!isFinite(n)) return "–";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  };

  FF.baseName = function (name) { return name.replace(/\.[^.]+$/, ""); };

  FF.download = function (blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  FF.zip = async function (items, zipName) {
    const zip = new JSZip();
    const used = {};
    items.forEach(({ blob, name }) => {
      let n = name, i = 1;
      while (used[n]) { n = FF.baseName(name) + "-" + (++i) + name.slice(FF.baseName(name).length); }
      used[n] = true; zip.file(n, blob);
    });
    const out = await zip.generateAsync({ type: "blob" });
    FF.download(out, zipName);
  };

  FF.status = function (el, msg, kind) {
    el.textContent = msg || "";
    el.className = "ff-status" + (kind ? " " + kind : "");
  };

  /* Drop zone: el contains an <input type=file>. Calls onFiles(File[]) */
  FF.drop = function (el, onFiles) {
    const input = el.querySelector("input[type=file]");
    const accept = (input.getAttribute("accept") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    const ok = f => !accept.length || accept.some(a => a.startsWith(".") ? f.name.toLowerCase().endsWith(a) : a.endsWith("/*") ? (f.type || "").startsWith(a.slice(0, -1)) : f.type === a);
    const handle = list => {
      const files = [...list];
      const good = files.filter(ok);
      if (good.length < files.length) FF.toast((files.length - good.length) + " file(s) skipped: wrong type");
      if (good.length) onFiles(input.multiple ? good : good.slice(0, 1));
    };
    input.addEventListener("change", () => { handle(input.files); input.value = ""; });
    ["dragenter", "dragover"].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => el.addEventListener(ev, e => { e.preventDefault(); el.classList.remove("over"); }));
    el.addEventListener("drop", e => handle(e.dataTransfer.files));
  };

  FF.toast = function (msg) {
    let t = document.getElementById("ff-toast");
    if (!t) { t = document.createElement("div"); t.id = "ff-toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(FF.toast._t); FF.toast._t = setTimeout(() => t.classList.remove("show"), 2600);
  };

  FF.isHeic = f => /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type);

  /* Decode any supported image (incl. HEIC) to an ImageBitmap-like drawable */
  FF.decode = async function (file) {
    let blob = file;
    if (FF.isHeic(file)) {
      if (typeof heic2any === "undefined") throw new Error("HEIC support is still loading. Try again in a moment.");
      const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.95 });
      blob = Array.isArray(out) ? out[0] : out;
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("This image couldn't be read.")); img.src = url; });
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  };

  FF.toBlob = function (canvas, type, quality) {
    return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error("Your browser couldn't create this file type.")), type, quality));
  };

  FF.render = async function (img, w, h, type, quality) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext("2d");
    if (type === "image/jpeg") { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return FF.toBlob(c, type, quality);
  };

  FF.ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

  /* Results list renderer */
  FF.results = function (wrap) {
    const list = wrap.querySelector(".ff-results");
    const all = wrap.querySelector(".ff-all");
    const items = [];
    return {
      clear() { items.length = 0; list.innerHTML = ""; all.hidden = true; },
      add(blob, name, note) {
        items.push({ blob, name });
        const row = document.createElement("div");
        row.className = "ff-row";
        row.innerHTML = '<span class="n"></span><span class="m"></span><button type="button" class="ff-btn small">Download</button>';
        row.querySelector(".n").textContent = name;
        row.querySelector(".m").textContent = note || FF.fmtBytes(blob.size);
        row.querySelector("button").addEventListener("click", () => FF.download(blob, name));
        list.appendChild(row);
        all.hidden = items.length < 2;
      },
      items,
      bindAll(zipName) { all.addEventListener("click", () => FF.zip(items, zipName)); }
    };
  };

  window.FF = FF;
})();
