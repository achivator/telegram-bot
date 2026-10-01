# Deploying the bot to Coolify

`main` is production. A merged pull request reaches users like this:

1. GitHub Actions (`.github/workflows/ci.yml`) runs `npm test`.
2. Only if the tests pass, the `deploy` job asks Coolify to deploy the new
   commit and waits for the result. The job fails if Coolify's build or
   rollout fails, so a red `deploy` job on `main` means production still runs
   the previous version.

Pull requests run step 1 only. This replaces the old Dokku deployment,
which pushed every commit on `main` without running the tests.

## One-time setup in Coolify

1. **Resource**: New Resource → Application → this GitHub repository, branch
   `main`, build pack **Nixpacks**. Nixpacks takes the Node version from
   `engines.node` in `package.json` (22.x, the same field CI reads) and
   starts `npm start` (`node standalone.mjs`). Ports Exposes: `3000`.
2. **Domain**: give the bot its own HTTPS domain, e.g.
   `https://bot.achivator.cc`. Telegram delivers updates to it.
3. **Turn Auto Deploy off** (Configuration → Advanced → Auto Deploy).
   Otherwise Coolify deploys every push before CI has run.
4. **Environment variables** (see `.env.example`):
   - `NODE_ENV=production` switches the bot from long polling to a webhook.
   - `WEBHOOK_URL`: the domain from step 2 (`bot.achivator.cc`; a leading
     `https://` is accepted too). On start the bot calls `setWebhook` with
     it.
   - `PORT=3000`. It must match Ports Exposes.
   - `WEBHOOK_SECRET` (optional): the webhook's secret token. Telegram sends
     it in the `X-Telegram-Bot-Api-Secret-Token` header of every update, and
     the bot answers 403 to any request without it, so a forged update cannot
     reach it even if the webhook URL leaks (a forged "upgraded to a
     supergroup" message could otherwise attach one chat to another chat's
     TON pool). 1-256 characters of `A-Z a-z 0-9 _ -`; the bot refuses to
     start with anything else. Unset, it is derived from `ACHIVATOR_TOKEN`
     (a SHA-256), so it needs no setup and survives redeploys. Set it to
     rotate it independently of the token; the next start registers it with
     `setWebhook`.
   - `ACHIVATOR_TOKEN`, `MONGODB_URI`: the same database as the mini app
     (`achivator_bot`).
   - `MONGODB_URI`, `ACHIVATOR_TOKEN` and `WEBHOOK_URL` are **required in
     production**: `standalone.mjs` exits on start without them, and Coolify
     then shows a crash loop.
   - `ACHIVATOR_GRAFANA_USER_ID`, `ACHIVATOR_GRAFANA_TOKEN`: optional Grafana
     metrics. Without them the bot logs one warning on start ("Metrics
     disabled") and runs.
   - Optional tuning: `CREATOR_MULTIPLIER`, `MIN_REACTOR_MESSAGES`,
     `PAIR_DAILY_CAP`, `RECEIVER_DAILY_CAP`, `REWARD_MAX_POINTS`.
   - `JETTONS_PER_POINT`: the same value as in the mini app (default 0.01).
     The bot records it in the price history when `/jetton` switches a chat
     to another jetton and resets its point price.
   - Subscriptions in Telegram Stars: `SUBSCRIPTIONS_ENABLED`, `TRIAL_DAYS`,
     `GRACE_DAYS`, with the same values as in the mini app. The mini app's
     `TELEGRAM_BOT_TOKEN` must be this bot's token: Telegram sends the payment
     of an invoice to the bot that created it.

## One-time setup in GitHub

In the repository settings, Environments → `production`:

| Kind     | Name               | Value                                                                   |
| -------- | ------------------ | ----------------------------------------------------------------------- |
| Variable | `COOLIFY_URL`      | Base URL of the Coolify instance, e.g. `https://coolify.example.com`     |
| Variable | `COOLIFY_APP_UUID` | The bot application's UUID in Coolify                                    |
| Secret   | `COOLIFY_TOKEN`    | Coolify → Keys & Tokens → API tokens, with the `deploy` permission       |

Until all three are set, the `deploy` job only prints a warning and passes.
The old `DOKKU_PRIVATE_KEY` secret is no longer used.

## Moving from Dokku

A bot has exactly one webhook, and every start of the bot points it at
itself. So:

1. If MongoDB moves too, copy the data first (`mongodump` from the old
   database, `mongorestore` into the new one), and stop the old bot during
   the copy so no updates are written to the old database meanwhile.
2. Deploy on Coolify. On start it takes the webhook over.
3. **Stop the Dokku app right away** (`dokku ps:stop achivator-bot`).
   Otherwise, the next time it restarts it takes the webhook back, and the
   two deployments steal updates from each other.
4. Check with `https://api.telegram.org/bot<token>/getWebhookInfo` that
   `url` is the Coolify domain and `last_error_message` is empty. A
   `last_error_message` of "Wrong response from the webhook: 403 Forbidden"
   means two deployments with different `WEBHOOK_SECRET`s are fighting over
   the webhook: the one that started last registered its secret.
