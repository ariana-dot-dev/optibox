// Mobile vertical pager glue. The paging itself is native CSS scroll-snap on
// .shell (a full-screen y-mandatory snap column: Chat / Files / Backend); this
// script only (1) parks the view on Chat as the start page and (2) lights the
// position dots from the current scroll offset. No gesture handling — the
// browser drives the drag/reveal/commit and its momentum, so it never collides
// with the left-edge back-swipe the way the old horizontal transform did.
// Chat is the TOP page so both other views are reached by swiping up, the one
// direction the chat's own history scroll never eats (see the CSS comment).
(() => {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  const mq = window.matchMedia("(max-width:900px)");
  const PAGES = 3, HOME = 0; // 0 Chat (top, home) · 1 Files · 2 Backend

  const dots = document.createElement("div");
  dots.className = "mobileDots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PAGES; i++) dots.appendChild(document.createElement("span"));
  document.body.appendChild(dots);

  const pageH = () => shell.clientHeight || 1;
  const curPage = () => Math.max(0, Math.min(PAGES - 1, Math.round(shell.scrollTop / pageH())));
  let page = HOME;

  const paint = () => {
    const p = curPage();
    [...dots.children].forEach((d, i) => d.classList.toggle("on", i === p));
  };

  // Jump to a page without a visible animation (used for the initial park and
  // for keeping the same page across orientation/resize, where pixel offsets
  // change). scroll-snap keeps us pinned to the snap point afterwards.
  const jumpTo = (p) => {
    const prev = shell.style.scrollBehavior;
    shell.style.scrollBehavior = "auto";
    shell.scrollTop = p * pageH();
    shell.style.scrollBehavior = prev;
    paint();
  };

  let raf = 0;
  shell.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; page = curPage(); paint(); });
  }, { passive: true });

  const park = () => { if (mq.matches) jumpTo(HOME); else paint(); };
  // Layout must be settled before scrollTop means anything; retry a couple of
  // frames in case fonts/height land late.
  const initPark = () => { park(); requestAnimationFrame(park); };
  if (document.readyState === "complete") initPark();
  else window.addEventListener("load", initPark);

  window.addEventListener("resize", () => { if (mq.matches && !document.body.classList.contains("kbOpen")) jumpTo(page); });
  if (mq.addEventListener) mq.addEventListener("change", (e) => { if (e.matches) jumpTo(HOME); });

  // Keyboard-open handling. .shell is a mandatory-snap scroller; the browser's
  // native "scroll the focused input above the keyboard" maneuver targets the
  // nearest scrollable ancestor, which is THIS pager — so focusing any text
  // input forced a full-page snap-jump instead of the small nudge it needed,
  // sometimes landing on a different page and hiding the composer entirely.
  // Fix: suspend snapping for the duration of the focus (native scroll behaves
  // normally with no snap point to fight), then resync to the correct page once
  // focus leaves and the keyboard's closing animation has settled. Delegated
  // (focusin/focusout bubble, unlike focus/blur) so it also covers the Files
  // panel's search input, not just the composer.
  let kbCloseTimer = 0;
  document.addEventListener("focusin", (e) => {
    if (!mq.matches) return;
    if (!(e.target instanceof HTMLElement) || !/^(input|textarea)$/i.test(e.target.tagName)) return;
    clearTimeout(kbCloseTimer);
    document.body.classList.add("kbOpen");
    shell.classList.add("kbOpen");
  });
  document.addEventListener("focusout", (e) => {
    if (!mq.matches) return;
    if (!(e.target instanceof HTMLElement) || !/^(input|textarea)$/i.test(e.target.tagName)) return;
    clearTimeout(kbCloseTimer);
    // iOS shrinks the visual viewport back over ~250-300ms as the keyboard
    // hides; jumping immediately re-homes against the still-shrunk viewport
    // and can overshoot. Re-snap after the animation, not mid-flight.
    kbCloseTimer = setTimeout(() => {
      document.body.classList.remove("kbOpen");
      shell.classList.remove("kbOpen");
      jumpTo(page);
    }, 320);
  });

  // Safety net: iOS Safari does not reliably fire a plain `window resize` when
  // the on-screen keyboard opens/closes — it fires `visualViewport.resize`
  // instead. Skip while a field is actively focused (mid-keyboard-transition,
  // the browser's own scroll-into-view is what we want left alone); the
  // focusout handler above already re-homes once focus clears.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (mq.matches && !document.body.classList.contains("kbOpen")) jumpTo(page);
    });
  }
})();
