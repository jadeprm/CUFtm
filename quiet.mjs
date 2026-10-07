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
    return ctx;
  };
  b.newPage = async (opts) => (await b.newContext(opts)).newPage();
  return b;
}
