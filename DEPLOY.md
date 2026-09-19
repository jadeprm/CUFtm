# Deploying this, step by step

Written for someone who has never deployed anything. No command line, no `git`. Budget about 30 minutes.

## First, two things worth knowing

**Drag-and-drop hosting won't work for this.** Vercel and Netlify's drag-and-drop is for websites — files a browser downloads and displays. This app has no web page at all; its interface is Slack itself. What it needs is a host that *runs* the code when Slack calls it. Vercel does that, free, but the code has to arrive via GitHub rather than a drag-and-drop box. The closest thing to dragging files is Step 2, where you drag the folder into GitHub's web uploader.

**Vercel's free plan is for non-commercial use.** Their docs say the Hobby plan "restricts users to non-commercial, personal use only." A student club or a personal project is fine. If this is for a company, their terms want you on the paid Pro plan ($20/month). Worth deciding now rather than after you have built a dependency on it.

There is a chicken-and-egg problem in what follows: Slack needs your Vercel web address, and Vercel needs your Slack passwords. So the order below is deploy first, connect second. Following it out of order is the most common way this goes wrong.

---

## Step 1 — Get the folder ready

Unzip the download. You should see a folder called `slack-task-manager` containing `api`, `src`, `app.js`, `package.json`, `manifest.json` and some documentation.

**Do not** add or upload a `node_modules` folder if one appears — Vercel builds that itself, and uploading it will fail.

---

## Step 2 — Put the code on GitHub

GitHub is free file storage that Vercel reads from.

1. Go to <https://github.com> and make a free account (skip if you have one).
2. Click the **+** in the top right → **New repository**.
3. Name it `slack-task-manager`. Choose **Private**. Click **Create repository**.
4. On the next page, click the link **uploading an existing file**.
5. Open your unzipped folder, select everything *inside* it, and drag it onto the upload box. Wait for all the file names to appear — the `api` and `src` folders should be listed too.
6. Click **Commit changes**.

If hidden files like `.gitignore` don't come along, that's fine — nothing breaks.

---

## Step 3 — Deploy to Vercel

1. Go to <https://vercel.com> → **Sign up** → **Continue with GitHub**. No credit card.
2. On your dashboard click **Add New…** → **Project**.
3. Find `slack-task-manager` in the list and click **Import**.
4. Change nothing. Click **Deploy**.
5. Wait a minute or two, then copy your new address from the top of the page. It looks like `https://slack-task-manager-abc123.vercel.app`.

Two things that look like failures but aren't. Opening that address in a browser shows a 404 error — correct, there is no web page, only an endpoint Slack talks to. And the deployment may be marked with a warning about missing environment variables — you add those in Step 5.

Write your address down. You need it twice in the next step.

---

## Step 4 — Create the Slack app

1. Open `manifest.json` from your folder in any text editor (TextEdit, Notepad, VS Code).
2. Find every `YOUR-PROJECT.vercel.app` — there are **two** — and replace each with your real Vercel address from Step 3. Keep the `/api/slack/events` part exactly as it is. So it becomes, for example, `https://slack-task-manager-abc123.vercel.app/api/slack/events`.
3. Select all the text in the file and copy it.
4. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
5. Pick your workspace. Choose the **JSON** tab, delete what's there, paste yours, click **Next** → **Create**.
6. Click **Install to Workspace** → **Allow**.

Now collect the two passwords Vercel needs:

- Still in your Slack app, go to **OAuth & Permissions** and copy the **Bot User OAuth Token** — it starts with `xoxb-`.
- Go to **Basic Information** → **App Credentials** and copy the **Signing Secret** (click Show first).

Treat both like passwords. Don't paste them into a chat or a public document.

---

## Step 5 — Give Vercel the two passwords

1. In Vercel, open your project → **Settings** → **Environment Variables**.
2. Add the first: Key `SLACK_BOT_TOKEN`, Value the `xoxb-…` token. **Save**.
3. Add the second: Key `SLACK_SIGNING_SECRET`, Value the signing secret. **Save**.
4. Go to the **Deployments** tab. On the top deployment, click the **⋯** menu → **Redeploy** → **Redeploy**.

That last redeploy is not optional. Environment variables only reach deployments created after they were saved, so skipping it leaves the app broken in a way that looks like a Slack problem.

---

## Step 6 — Try it

In Slack, go to any channel and invite the bot: type `/invite @Task Manager`.

Then:

- Type `/todo` and press enter. The form should appear.
- Fill it in and click **Create**. A task card appears in the channel.
- Click **In Progress**, then **Done**. The card should change each time.
- Hover any message → **More actions** (⋯) → **Create task from message**. The form should open already filled in.

---

## When something doesn't work

| What you see | What it means |
| --- | --- |
| `/todo` says "failed with the error dispatch_failed" | The Request URL is wrong, or you skipped the redeploy in Step 5. Check the URL in Slack ends in `/api/slack/events`. |
| "We had some trouble connecting" | Same causes. Re-check the two `YOUR-PROJECT` replacements in Step 4. |
| The form opens but Create does nothing | Usually a missing or mistyped `SLACK_BOT_TOKEN`. Re-copy it and redeploy. |
| "Task Manager is not in this channel" | Run `/invite @Task Manager` in that channel. |
| Buttons do nothing | Interactivity's Request URL is missing. Slack app → **Interactivity & Shortcuts** → check the URL is filled in and on. |

To see the actual error: Vercel → your project → **Logs**. Click the most recent entry from when you tried the command. The free plan keeps one hour of logs, so look soon after testing.

---

## Changing the code later

Edit the file on GitHub (click it, then the pencil icon) and commit. Vercel redeploys within a minute. Every deploy is kept, so you can roll back from the Deployments tab if an edit breaks something.

---

## Running it on your own computer instead

Only useful if you want to test changes before they go live, and it needs Node.js installed.

1. Slack app → **Socket Mode** → turn it on. Then **Basic Information** → **App-Level Tokens** → generate a token with the `connections:write` scope.
2. Copy `.env.example` to a file named `.env` and fill in all three values.
3. In a terminal, in the project folder: `npm install`, then `npm run dev`.

Socket Mode and the Vercel deployment can't both be live at once — Slack sends each event to one place. Turn Socket Mode back off when you're done.
