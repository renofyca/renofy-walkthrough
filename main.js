(function () {
  "use strict";
  window.__walkBooted = true;

  /* Fallback-video ladder: the first format the browser can actually
     play wins — AV1 (smallest file) → HEVC (Apple / modern Chrome) →
     H.264 1080, the universal floor that plays on every device.
     Probed with canPlayType before anything downloads, so a visitor
     only ever fetches the one file their browser picked. (An H.264
     3840 encode also exists, but at ~120 MB it exceeds the 100 MB
     per-file limit of the Pages host, so the ladder goes straight
     from HEVC to the 1080 floor.) */
  var VIDEO_AV1 = "assets/walkthrough-av1-3840.mp4?v=1";
  var VIDEO_HEVC = "assets/walkthrough-hevc-3840.mp4?v=1";
  var VIDEO_H264_1080 = "assets/walkthrough-h264-1080.mp4?v=1";
  function pickVideoURL() {
    var probe = document.createElement("video");
    if (!probe.canPlayType) return VIDEO_H264_1080;
    try {
      if (probe.canPlayType('video/mp4; codecs="av01.0.08M.08"')) return VIDEO_AV1;
      if (probe.canPlayType('video/mp4; codecs="hvc1.1.6.L150.B0"')) return VIDEO_HEVC;
    } catch (e) { /* fall through to the floor */ }
    return VIDEO_H264_1080;
  }
  var VIDEO_URL = pickVideoURL();
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

  /* Frame-scrub path (primary): the walkthrough video pre-extracted to
     image frames (12 fps, 1920x1080, same footage — a video ladder in
     several codecs stays on the page as the fallback). Scrubbing then
     costs one drawImage of a decoded image per position: no decoder
     seeks at all. */
  var FRAME_FPS = 12, FRAME_COUNT = 840, FRAME_W = 1920, FRAME_H = 1080;
  var FRAME_VER = "3";     // bump when the frame files are re-extracted
  /* Frame format: the set now exists as AVIF (about half the bytes of
     the WebP set at the same quality). A one-pixel AVIF probe image
     decides at runtime; browsers without AVIF (Safari < 16.4 etc.)
     transparently keep loading the WebP set. */
  var FRAME_EXT = "webp";
  var AVIF_PROBE = "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAbAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAjbWRhdAoKAAAAAq//jV8wCDINEADMAhBAggIAAAgBbg==";
  var EARLY_FRAMES = 36;   // give-up threshold if frames cannot load
  /* Anchor-first loading: one anchor frame per second of tour (every
     ANCHOR_STEP-th frame) is fetched before everything else, so the
     WHOLE tour becomes scrubbable almost immediately; the remaining
     frames then fill in around the viewer's position. */
  var ANCHOR_STEP = 12;
  var ANCHORS = [];
  for (var ai = 0; ai < FRAME_COUNT; ai += ANCHOR_STEP) ANCHORS.push(ai);
  var frames = new Array(FRAME_COUNT);
  var frameState = new Uint8Array(FRAME_COUNT); // 0 pending, 1 ok, 2 failed
  var frameRequested = new Uint8Array(FRAME_COUNT);
  var anchorsAttempted = 0, anchorsOK = 0;
  var framesAttempted = 0, framesOK = 0;
  var framesActive = false, framesGaveUp = false, drawnFrame = -1;
  var scrollDir = 1;        // last observed scrub direction (+1 forward)
  var currentFrameIdx = 0;  // lookahead origin for the fill-in order

  var duration = FRAME_COUNT / FRAME_FPS; // 70 s; video metadata agrees
  var shownTime = 0;
  var lastSeek = -1;   // last time value handed to the decoder
  var needsDraw = true; // canvas only needs repainting when the frame changes
  var rafId = null;
  var inView = false;
  var displayStep = -1;
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

  /* ---------------- Canvas ----------------
     The backing store is pinned to the frames' native 1920x1080 (1:1
     with the source frames). Scaling it by devicePixelRatio instead
     (up to 5120x2880 on a desktop) made every presented frame cost a
     ~14.7 MP paint — the paint cost behind the old desktop judder.
     CSS already stretches the canvas to fill the stage; drawCover
     picks the source region using the STAGE's aspect ratio, so that
     CSS stretch is uniform (no distortion) and the framing/cropping
     matches a full-resolution cover draw exactly. */
  var VIEW_W = 1920, VIEW_H = 1080;
  var stageAspect = 16 / 9;
  function sizeCanvas() {
    var r = stage.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) stageAspect = r.width / r.height;
    if (canvas.width !== VIEW_W || canvas.height !== VIEW_H) {
      canvas.width = VIEW_W;
      canvas.height = VIEW_H;
    }
    drawnFrame = -1; // aspect may have changed: force a repaint
    drawCurrent();
  }
  window.addEventListener("resize", sizeCanvas);

  function drawCover(img, iw, ih) {
    var cw = canvas.width, ch = canvas.height;
    if (!iw || !ih || !cw || !ch) return;
    // Cover-fit against a virtual viewport with the stage's aspect
    // (stageAspect wide, 1 tall): the centred visible source region
    // fills the whole native-res buffer.
    var s = Math.max(stageAspect / iw, 1 / ih);
    var sw = stageAspect / s, sh = 1 / s;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, cw, ch);
  }
  function frameIndexFor(t) {
    var fi = Math.round(t * FRAME_FPS);
    return Math.max(0, Math.min(FRAME_COUNT - 1, fi));
  }
  function drawFrame(fi) {
    // Paint the loaded frame nearest the eased position, preferring
    // the side the viewer is moving toward. Anchors span the whole
    // tour from the start, so a near frame exists at any position
    // long before the fill-in completes.
    var idx = -1;
    if (frameState[fi] === 1) idx = fi;
    else {
      for (var d = 1; d < FRAME_COUNT; d++) {
        var fwd = fi + d * scrollDir, back = fi - d * scrollDir;
        if (fwd >= 0 && fwd < FRAME_COUNT && frameState[fwd] === 1) { idx = fwd; break; }
        if (back >= 0 && back < FRAME_COUNT && frameState[back] === 1) { idx = back; break; }
        if (fi + d >= FRAME_COUNT && fi - d < 0) break;
      }
    }
    if (idx < 0 || idx === drawnFrame) return;
    drawnFrame = idx;
    drawCover(frames[idx], FRAME_W, FRAME_H);
  }
  function drawCurrent() {
    if (framesActive) { drawFrame(frameIndexFor(shownTime)); return; }
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
  video.addEventListener("seeked", function () {
    if (videoReady) { needsDraw = true; drawCurrent(); }
  });

  /* ---------------- Frame loading ----------------
     Anchor-first: the pool first fetches the anchor frames (one per
     second, spanning the whole tour), and the frame path goes live as
     soon as the anchors are essentially in. Fill-in then proceeds
     relative to the viewer: frames ahead of the current position in
     the current scroll direction are fetched first, so the loader
     races ahead of the scrub instead of trailing it. Every settled
     frame counts toward the loader, so the percentage stays honest.
     If frames essentially cannot load at all, fall back to the
     original video path wholesale. */
  function frameURL(i) { return "assets/frames/f" + ("0000" + i).slice(-4) + "." + FRAME_EXT + "?v=" + FRAME_VER; }
  function startVideoFallback() {
    if (framesGaveUp) return;
    framesGaveUp = true;
    framesActive = false;
    setLoader(0);
    fetchWithProgress();
  }
  function frameSettled(i, ok) {
    frameState[i] = ok ? 1 : 2;
    framesAttempted++;
    if (ok) framesOK++;
    if (i % ANCHOR_STEP === 0) { anchorsAttempted++; if (ok) anchorsOK++; }
    if (!framesGaveUp) {
      setLoader(framesAttempted / FRAME_COUNT);
      if (!framesActive && anchorsAttempted >= ANCHORS.length && anchorsOK >= ANCHORS.length * 0.8) framesActive = true;
      if (!framesActive && framesOK >= EARLY_FRAMES) framesActive = true;
      if (framesAttempted >= 60 && framesOK === 0) { startVideoFallback(); return; }
      if (framesAttempted >= FRAME_COUNT) {
        if (framesOK >= EARLY_FRAMES) { framesActive = true; hideLoader(); }
        else { startVideoFallback(); return; }
      }
    }
    if (framesActive) drawCurrent();
  }
  function loadFrames() {
    var anchorPtr = 0, POOL = 6;
    function nextIndex() {
      while (anchorPtr < ANCHORS.length) {
        var a = ANCHORS[anchorPtr++];
        if (!frameRequested[a]) { frameRequested[a] = 1; return a; }
      }
      // Fill-in: the pending frame nearest ahead of the viewer in the
      // current scroll direction wins; frames behind the viewer are
      // taken nearest-first only once nothing is ahead.
      var best = -1, bestScore = Infinity;
      for (var i = 0; i < FRAME_COUNT; i++) {
        if (frameRequested[i]) continue;
        var ahead = (i - currentFrameIdx) * scrollDir;
        var score = ahead >= 0 ? ahead : 100000 - ahead;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) frameRequested[best] = 1;
      return best;
    }
    function worker() {
      var i = nextIndex();
      if (i < 0) return;
      var img = new Image();
      img.onload = function () { frames[i] = img; frameSettled(i, true); worker(); };
      img.onerror = function () { frameSettled(i, false); worker(); };
      img.src = frameURL(i);
    }
    for (var k = 0; k < POOL; k++) worker();
  }

  /* Probe AVIF support (async, short timeout), then start the exact
     same anchor-first loader as before — WebP visitors see no change
     in behaviour, AVIF visitors just download ~half the bytes. */
  (function startWhenProbed() {
    var finished = false;
    function begin() {
      if (finished) return;
      finished = true;
      loadFrames();
      setTimeout(hideLoader, 20000); // absolute failsafe: never trap the visitor
    }
    try {
      var probe = new Image();
      probe.onload = function () { if (probe.naturalWidth > 0) FRAME_EXT = "avif"; begin(); };
      probe.onerror = function () { begin(); };
      setTimeout(begin, 1500);
      probe.src = AVIF_PROBE;
    } catch (e) { begin(); }
  })();

  /* ---------------- Scroll -> time ---------------- */
  function scrollProgress() {
    var rect = walk.getBoundingClientRect();
    var total = walk.offsetHeight - window.innerHeight;
    if (total <= 0) return 0;
    var p = -rect.top / total;
    return Math.max(0, Math.min(1, p));
  }
  /* Steps are driven per-frame from the SAME eased display progress
     that drives the imagery — no classes, no CSS transitions. The old
     design toggled an .active class from the raw scroll position and
     let a fixed 0.45 s CSS transition own the opacity: every class flip
     restarted the fade from its current value with a fresh full
     duration, so near a step boundary (wheel/trackpad jitter flips the
     class back and forth) the outgoing step's fade never completed and
     stayed readable as a ghost under the new step (owner screenshot:
     "ARRIVE" showing through "GATHER" at step 02/07), and the text ran
     on a different clock from the eased video besides. Now each step's
     opacity is a pure function of the eased position: fully opaque
     across the middle of its segment, crossfading with its neighbour
     (opacities sum to 1) only inside a defined window around the
     boundary, exactly 0 — and visibility:hidden — everywhere else. */
  var STEP_FADE = 0.30; // crossfade window, as a fraction of one segment
  function updateSteps() {
    var dp = duration > 0 ? shownTime / duration : 0;
    var sf = Math.max(0.5, Math.min(STEP_COUNT - 0.5, dp * STEP_COUNT));
    var best = 0, bestO = -1;
    for (var i = 0; i < steps.length; i++) {
      var d = sf - (i + 0.5);
      var o = (0.5 + STEP_FADE / 2 - Math.abs(d)) / STEP_FADE;
      o = Math.max(0, Math.min(1, o));
      var st = steps[i].style;
      st.opacity = o.toFixed(3);
      st.transform = "translateY(" + ((1 - o) * 14).toFixed(1) + "px)";
      st.visibility = o <= 0 ? "hidden" : "visible";
      if (o > bestO) { bestO = o; best = i; }
    }
    if (best !== displayStep) {
      displayStep = best;
      counter.textContent = ("0" + (best + 1)) + " / 0" + STEP_COUNT;
    }
  }
  var lastTickMs = 0;
  function tick(now) {
    if (!inView) { rafId = null; lastTickMs = 0; return; }
    var p = scrollProgress();
    progressFill.style.width = (p * 100).toFixed(2) + "%";
    if (duration > 0) {
      /* Frame-rate-independent ease. The old code applied 0.16 per rAF
         tick, so on 120 Hz+ monitors the approach ran ~2x faster than
         on a 60 Hz screen. Time-based instead: over dt ms the remaining
         gap scales by (1 - 0.16) ^ (dt / 16.667), which is exactly the
         old behaviour at 60 Hz at any refresh rate. dt is clamped so a
         tab-away or hitch can't teleport the playhead. */
      var dt = lastTickMs && now ? now - lastTickMs : 16.667;
      lastTickMs = now || 0;
      dt = Math.min(Math.max(dt, 0), 100);
      var ease = 1 - Math.pow(1 - 0.16, dt / 16.667);
      var targetTime = p * duration;
      var diff = targetTime - shownTime;
      if (Math.abs(diff) > 0.0005) {
        shownTime += diff * ease; // eased approach = buttery scrub, both directions
        if (Math.abs(targetTime - shownTime) <= 0.0005) shownTime = targetTime;
      }
      updateSteps();
      var fiNow = frameIndexFor(shownTime);
      if (fiNow !== currentFrameIdx) {
        scrollDir = fiNow > currentFrameIdx ? 1 : -1;
        currentFrameIdx = fiNow;
      }
      if (framesActive) {
        // Frame path: paint the loaded frame nearest the eased
        // position. No seeking, no decoder — drawImage only.
        drawFrame(fiNow);
      } else if (videoReady) {
      /* Fallback-only seek pacing. The encode is 24 fps (one frame =
         ~41.7 ms), so seeking in steps finer than a frame is wasted
         decoder work; and a seek issued while another is still in
         flight just stacks up — video.currentTime lags behind until
         the seek lands, so an unguarded loop seeks again and again,
         the browser coalesces the pile, and frames arrive in bursts.
         Rule: one seek at a time, and only once the eased position has
         moved at least one frame from the last seek — plus one final
         exact seek when the ease settles. */
      if (!video.seeking) {
        var FRAME = 1 / 24;
        var from = lastSeek >= 0 ? lastSeek : video.currentTime;
        var delta = shownTime - from;
        var settled = Math.abs(targetTime - shownTime) <= 0.0005;
        if (Math.abs(delta) >= FRAME || (settled && Math.abs(delta) > 0.002)) {
          try {
            video.currentTime = shownTime;
            lastSeek = shownTime;
            needsDraw = true;
          } catch (e) { /* seek mid-flight */ }
        }
      }
      }
    }
    if (needsDraw) { drawCurrent(); needsDraw = false; }
    rafId = requestAnimationFrame(tick);
  }
  var io = new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    if (inView && rafId === null) rafId = requestAnimationFrame(tick);
  }, { rootMargin: "60% 0px 60% 0px" });
  io.observe(stage);
})();
