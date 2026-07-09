// Note: the hosted preview's auto-redeploy poller (deploy/redeploy.sh, box-side
// only, not in this repo) is what picks up changes to this file within ~20s of
// a push to main.
// Mobile horizontal pager glue. The paging itself is native CSS scroll-snap on
// .shell (a full-screen x-mandatory snap row: Files / Chat / Backend); this
// script only (1) parks the view on Chat as the start page and (2) lights the
// position dots from the current scroll offset. No gesture handling — the
// browser drives the drag/reveal/commit and its momentum.
// Chat is the MIDDLE page: Files is to its left (swipe right reveals it),
// Backend to its right (swipe left). Horizontal was chosen specifically
// because it shares no axis with the on-screen keyboard (which resizes the
// viewport vertically) or the chat's own vertical history scroll — a vertical
// pager fought both of those constantly.
(() => {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  const mq = window.matchMedia("(max-width:900px)");
  const PAGES = 3, HOME = 1; // 0 Files · 1 Chat (home, middle) · 2 Backend

  const dots = document.createElement("div");
  dots.className = "mobileDots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PAGES; i++) dots.appendChild(document.createElement("span"));
  document.body.appendChild(dots);

  const pageW = () => shell.clientWidth || 1;
  const curPage = () => Math.max(0, Math.min(PAGES - 1, Math.round(shell.scrollLeft / pageW())));
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
    shell.scrollLeft = p * pageW();
    shell.style.scrollBehavior = prev;
    paint();
  };

  let raf = 0;
  shell.addEventListener("scroll", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; page = curPage(); paint(); });
  }, { passive: true });

  const park = () => { if (mq.matches) jumpTo(HOME); else paint(); };
  // Layout must be settled before scrollLeft means anything; retry a couple of
  // frames in case fonts/width land late.
  const initPark = () => { park(); requestAnimationFrame(park); };
  if (document.readyState === "complete") initPark();
  else window.addEventListener("load", initPark);

  window.addEventListener("resize", () => { if (mq.matches && !document.body.classList.contains("kbOpen")) jumpTo(page); });
  if (mq.addEventListener) mq.addEventListener("change", (e) => { if (e.matches) jumpTo(HOME); });

  // Keyboard-open safety net, kept even though horizontal paging shares no axis
  // with the keyboard: a focused input still triggers native scroll-into-view
  // maneuvers, and suspending snap for that duration costs nothing and avoids
  // any edge case. Delegated (focusin/focusout bubble) so it also covers the
  // Files panel's search input, not just the composer.
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
    kbCloseTimer = setTimeout(() => {
      document.body.classList.remove("kbOpen");
      shell.classList.remove("kbOpen");
      jumpTo(page);
    }, 320);
  });

  // Safety net: iOS Safari does not reliably fire a plain `window resize` when
  // the on-screen keyboard opens/closes — it fires `visualViewport.resize`
  // instead. Skip while a field is actively focused; the focusout handler
  // above already re-homes once focus clears.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      if (mq.matches && !document.body.classList.contains("kbOpen")) jumpTo(page);
    });
  }
})();
