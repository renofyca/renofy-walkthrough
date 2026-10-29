(function () {
  "use strict";
  window.__walkBooted = true;

  var VIDEO_URL = "assets/walkthrough.mp4?v=6";
  var video = document.getElementById("walkVideo");
  var canvas = document.getElementById("walkCanvas");
  var ctx = canvas.getContext("2d");
  var walk = document.getElementById("walk");
  var stage = walk.querySelector(".walk-stage");
  var steps = Array.prototype.slice.call(document.querySelectorAll(".step"));
  var counter = document.getElementById("walkCounter");
  var progressFill = document.getElementById("progressFill");
  var loader = document.getElementById("loader");
  var loaderFill = document.getElementById("loaderFill");
  var loaderPct = document.getElementById("loaderPct");
  var loaderSub = loader.querySelector(".loader-sub");

  var STEP_COUNT = steps.length;
  var duration = 0;
  var shownTime = 0;
  var rafId = null;
  var inView = false;
  var activeStep = -1;
  var loaderDone = false;
  var videoReady = false;
  var posterImg = null;
  var posterReady = false;

  /* ---------------- Loader ---------------- */
  function setLoader(p) {
    var pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    loaderFill.style.width = pct + "%";
    loaderPct.textContent = pct + "%";
  }
  function hideLoader() {
    if (loaderDone) return;
    loaderDone = true;
    setLoader(1);
    setTimeout(function () {
      loader.classList.add("done");
      setTimeout(function () { if (loader.parentNode) loader.remove(); }, 800);
    }, 150);
  }

  /* ---------------- Canvas ---------------- */
  function sizeCanvas() {
    var r = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(2, Math.round(r.width * dpr));
    var h = Math.max(2, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      drawCurrent();
    }
  }
  window.addEventListener("resize", sizeCanvas);

  function drawCover(img, iw, ih) {
    var cw = canvas.width, ch = canvas.height;
    if (!iw || !ih || !cw || !ch) return;
    var scale = Math.max(cw / iw, ch / ih);
    var dw = iw * scale, dh = ih * scale;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }
  function drawCurrent() {
    if (videoReady && video.readyState >= 2 && video.videoWidth) {
      drawCover(video, video.videoWidth, video.videoHeight);
    } else if (posterReady) {
      drawCover(posterImg, posterImg.naturalWidth, posterImg.naturalHeight);
    }
  }

  // Poster paints the stage while the video downloads.
  posterImg = new Image();
  posterImg.onload = function () { posterReady = true; drawCurrent(); };
  posterImg.src = "assets/poster.jpg";
  sizeCanvas();

  /* ---------------- Video loading ----------------
     Fetch the file with a streaming reader so the loader shows true
     byte-level progress on every browser (iOS webviews don't report
     <video> buffered progress reliably). Then hand the completed blob
     to the video element: full-range scrubbing with zero network lag. */
  function attachVideo(src, isBlob) {
    video.src = src;
    video.load();
    if (isBlob) {
      // Watchdog: if the blob source never becomes playable (some
      // webviews are picky), fall back to streaming the file directly.
      setTimeout(function () {
        if (!videoReady) attachVideo(VIDEO_URL, false);
      }, 6000);
    }
  }
  function fallbackDirect() {
    if (loaderSub) loaderSub.textContent = "Loading the walkthrough";
    attachVideo(VIDEO_URL, false);
    video.addEventListener("canplay", hideLoader);
    setTimeout(hideLoader, 9000);
  }
  function fetchWithProgress() {
    if (!window.fetch || !window.ReadableStream || !window.Response) {
      fallbackDirect();
      return;
    }
    fetch(VIDEO_URL).then(function (res) {
      if (!res.ok || !res.body || !res.headers.get("content-length")) {
        fallbackDirect();
        return null;
      }
      var total = parseInt(res.headers.get("content-length"), 10);
      var received = 0;
      var chunks = [];
      var reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var blob = new Blob(chunks, { type: "video/mp4" });
            attachVideo(URL.createObjectURL(blob), true);
            return;
          }
          chunks.push(r.value);
          received += r.value.length;
          setLoader(received / total);
          return pump();
        });
      }
      return pump();
    }).catch(function () { fallbackDirect(); });
  }

  function onMeta() {
    if (video.duration && isFinite(video.duration)) {
      duration = video.duration;
    }
  }
  if (video.readyState >= 1) onMeta();
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("loadeddata", function () {
    videoReady = true;
    drawCurrent();
  });
  video.addEventListener("canplay", function () {
    videoReady = true;
    drawCurrent();
    hideLoader();
  });
  video.addEventListener("seeked", function () { if (videoReady) drawCurrent(); });

  fetchWithProgress();
  setTimeout(hideLoader, 20000); // absolute failsafe: never trap the visitor

  /* ---------------- Scroll -> time ---------------- */
  function scrollProgress() {
    var rect = walk.getBoundingClientRect();
    var total = walk.offsetHeight - window.innerHeight;
    if (total <= 0) return 0;
    var p = -rect.top / total;
    return Math.max(0, Math.min(1, p));
  }
  function setStep(idx) {
    if (idx === activeStep) return;
    activeStep = idx;
    for (var i = 0; i < steps.length; i++) {
      steps[i].classList.toggle("active", i === idx);
    }
    counter.textContent = ("0" + (idx + 1)) + " / 0" + STEP_COUNT;
  }
  function tick() {
    if (!inView) { rafId = null; return; }
    var p = scrollProgress();
    progressFill.style.width = (p * 100).toFixed(2) + "%";
    setStep(Math.min(STEP_COUNT - 1, Math.floor(p * STEP_COUNT)));
    if (duration > 0 && videoReady) {
      var targetTime = p * duration;
      var diff = targetTime - shownTime;
      if (Math.abs(diff) > 0.0005) {
        shownTime += diff * 0.16; // eased approach = buttery scrub, both directions
        if (Math.abs(targetTime - shownTime) <= 0.0005) shownTime = targetTime;
        if (Math.abs(video.currentTime - shownTime) > 0.01) {
          try { video.currentTime = shownTime; } catch (e) { /* seek mid-flight */ }
        }
      }
    }
    drawCurrent();
    rafId = requestAnimationFrame(tick);
  }
  var io = new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    if (inView && rafId === null) rafId = requestAnimationFrame(tick);
  }, { rootMargin: "60% 0px 60% 0px" });
  io.observe(stage);
})();
