/**
 * The getting-started guide opens by itself for anybody who has not finished
 * it — every test account, in a fresh browser. Suites that are testing
 * something else start each browser with it put off for the session, exactly
 * as pressing "Later" would. guide.mjs is the suite that tests the guide.
 */
export function quietGuide(b, { popups = false } = {}) {
  const newContext = b.newContext.bind(b);
  b.newContext = async (opts) => {
    const ctx = await newContext(opts);
    await ctx.addInitScript(() => { try { sessionStorage.setItem('fair-guide-later', '1'); } catch (e) {} });

    /**
     * And the committee's pop-up, which is the guide's problem all over again
     * but worse: it is a box over the page that belongs to no suite in
     * particular, so one left live by a crashed run breaks every other suite
     * with "intercepts pointer events" — a failure that looks nothing like
     * its cause.
     *
     * Answered at the network edge rather than with a flag in app.js: this is
     * a fact about the test browser, not a behaviour the app should carry.
     * `quietGuide(b, { popups: true })` lets it through, for the one suite
     * whose job is to test it.
     */
    if (!popups) {
      await ctx.route('**/api/push?do=popup', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ popup: null }),
      }));
    }
    /**
     * The app now opens on หน้าแรก. Every suite here was written against the
     * work page being where a sign-in lands, so a bare address still goes
     * there; redesign.mjs opens the home page on purpose, by
     * setting the fair-test-home cookie.
     */
    await ctx.addInitScript(() => {
      try {
        if (location.pathname === '/' && (!location.hash || location.hash === '#') && !/fair-test-home=1/.test(document.cookie)) {
          history.replaceState(null, '', location.pathname + location.search + '#/work');
        }
      } catch (e) {}
    });
    return ctx;
  };
  b.newPage = async (opts) => (await b.newContext(opts)).newPage();
  return b;
}

/**
 * The "coming up" list shows four rows and folds the rest behind ดูทั้งหมด.
 * A suite looking for one particular meeting opens it first.
 */
export async function expandUpcoming(pg) {
  const more = pg.locator('.upcoming .up-more');
  if (await more.count() && /ดูทั้งหมด|See all/.test(await more.innerText())) {
    await more.click();
    await pg.waitForTimeout(300);
  }
}
