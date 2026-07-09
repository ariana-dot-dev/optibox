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

  window.addEventListener("resize", () => { if (mq.matches) jumpTo(page); });
  if (mq.addEventListener) mq.addEventListener("change", (e) => { if (e.matches) jumpTo(HOME); });
})();
