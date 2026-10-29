(function () {
  "use strict";

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

  var STEP_COUNT = steps.length;
  var duration = 0;
  var targetTime = 0;
  var shownTime = 0;
  var rafId = null;
  var inView = false;
  var activeStep = -1;
  var loaderDone = false;

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
      setTimeout(function () { loader.remove(); }, 800);
    }, 150);
  }
  function updateBuffered() {
    if (!duration || !video.buffered || video.buffered.length === 0) return;
    try {
      var end = video.buffered.end(video.buffered.length - 1);
      setLoader(end / duration);
      if (end / duration >= 0.95) hideLoader();
    } catch (e) { /* buffered range not ready yet */ }
  }
  video.addEventListener("progress", updateBuffered);
  video.addEventListener("canplaythrough", hideLoader);
  setTimeout(hideLoader, 12000); // failsafe: never trap the visitor

  /* ---------------- Canvas sizing ---------------- */
  function sizeCanvas() {
    var r = stage.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(2, Math.round(r.width * dpr));
    var h = Math.max(2, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  window.addEventListener("resize", sizeCanvas);
  sizeCanvas();

  function drawFrame() {
    if (video.readyState < 2 || !video.videoWidth) return;
    var cw = canvas.width, ch = canvas.height;
    var vw = video.videoWidth, vh = video.videoHeight;
    var scale = Math.max(cw / vw, ch / vh);
    var dw = vw * scale, dh = vh * scale;
    ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

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

    if (duration > 0) {
      targetTime = p * duration;
      var diff = targetTime - shownTime;
      if (Math.abs(diff) > 0.0005) {
        shownTime += diff * 0.16; // eased approach = buttery scrub, both directions
        if (Math.abs(targetTime - shownTime) <= 0.0005) shownTime = targetTime;
        if (video.readyState >= 1 && Math.abs(video.currentTime - shownTime) > 0.01) {
          try { video.currentTime = shownTime; } catch (e) { /* seek mid-flight */ }
        }
      }
    }
    drawFrame();
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  /* Metadata may already be loaded before this script runs — check, don't just listen. */
  function onMeta() {
    if (video.duration && isFinite(video.duration)) {
      duration = video.duration;
      updateBuffered();
      drawFrame();
    }
  }
  if (video.readyState >= 1) onMeta();
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("seeked", drawFrame);
  video.addEventListener("loadeddata", drawFrame);

  var io = new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    if (inView) startLoop();
  }, { rootMargin: "60% 0px 60% 0px" });
  io.observe(stage);

  // First paint even before scrolling: draw frame 0 as soon as it exists.
  var warmup = setInterval(function () {
    if (video.readyState >= 2) { drawFrame(); clearInterval(warmup); }
  }, 120);
  setTimeout(function () { clearInterval(warmup); }, 8000);
})();
