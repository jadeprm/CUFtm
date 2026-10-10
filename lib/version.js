/**
 * What is actually deployed.
 *
 * There is one copy of this string in the server's code and one in the
 * page's, and the profile page compares them. That sounds redundant until a
 * deployment goes half-right: the day api/ was updated and lib/ was not cost
 * an evening of hunting a bug that was really a missing file, and a letter
 * from อำนวยการ 2 with no อำนวยการใหญ่ step looks exactly like a bug until you
 * notice the site is still running last week's page.
 *
 * Bumped by hand with each package, because it describes the package.
 */
export const APP_VERSION = '2026-10-11b';
