// Mobile swipe pager: Backend (0) | Chat (1) | Files (2), Chat is home.
// A horizontal drag moves the 3-pane strip 1:1 with the finger (rubber-banded
// past the ends); releasing beyond 25% of the screen width — or a quick flick —
// commits to the neighbouring view, anything less snaps back. The gesture
// yields to vertical scrolling (axis lock) and to horizontally scrollable
// content like code blocks (native scroll wins there).
(() => {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  const mq = window.matchMedia("(max-width:900px)");
  const PAGES = 3, HOME = 1;
  let page = HOME;

  const dots = document.createElement("div");
  dots.className = "mobileDots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PAGES; i++) dots.appendChild(document.createElement("span"));
  document.body.appendChild(dots);

  const paint = () => {
    shell.style.setProperty("--page", String(page));
    [...dots.children].forEach((d, i) => d.classList.toggle("on", i === page));
  };
  paint();

  const hScrollable = (el) => {
    for (; el && el !== shell && el.nodeType === 1; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const o = getComputedStyle(el).overflowX;
        if (o === "auto" || o === "scroll") return true;
      }
    }
    return false;
  };

  let startX = 0, startY = 0, startT = 0, dx = 0, axis = null, tracking = false;

  shell.addEventListener("touchstart", (e) => {
    tracking = mq.matches && e.touches.length === 1 && !hScrollable(e.target);
    if (!tracking) return;
    axis = null; dx = 0;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; startT = Date.now();
    shell.classList.remove("pageSnap");
  }, { passive: true });

  shell.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    const mx = e.touches[0].clientX - startX, my = e.touches[0].clientY - startY;
    if (!axis) {
      if (Math.abs(mx) < 9 && Math.abs(my) < 9) return; // direction not decided yet
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (axis === "y") { tracking = false; return; } // vertical scroll wins
    }
    dx = mx;
    if ((page === 0 && dx > 0) || (page === PAGES - 1 && dx < 0)) dx /= 3; // rubber-band
    shell.style.setProperty("--dragx", dx + "px");
    if (e.cancelable) e.preventDefault(); // horizontal is ours; touch-action:pan-y keeps vertical native
  }, { passive: false });

  const settle = () => {
    if (!tracking) return;
    tracking = false;
    const w = window.innerWidth || 1;
    const flick = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(Date.now() - startT, 1) > 0.5;
    if (axis === "x" && (Math.abs(dx) > w * 0.25 || flick)) {
      page = Math.min(PAGES - 1, Math.max(0, page + (dx < 0 ? 1 : -1)));
    }
    shell.classList.add("pageSnap");
    shell.style.setProperty("--dragx", "0px");
    paint();
    dx = 0;
  };
  shell.addEventListener("touchend", settle);
  shell.addEventListener("touchcancel", settle);
})();
