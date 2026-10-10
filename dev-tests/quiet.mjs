/**
 * The getting-started guide opens by itself for anybody who has not finished
 * it — every test account, in a fresh browser. Suites that are testing
 * something else start each browser with it put off for the session, exactly
 * as pressing "Later" would. guide.mjs is the suite that tests the guide.
 */
export function quietGuide(b) {
  const newContext = b.newContext.bind(b);
  b.newContext = async (opts) => {
    const ctx = await newContext(opts);
    await ctx.addInitScript(() => { try { sessionStorage.setItem('fair-guide-later', '1'); } catch (e) {} });
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
