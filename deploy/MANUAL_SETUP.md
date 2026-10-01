# SmartJourney: manual production setup

Everything the CD pipelines **can't** do for you: account setup, clicking through consoles, and secrets. Do the sections in order. Expect about **2–3 hours** the first time.

**What runs where (one-month deployment):**

| Part | Where | Cost |
|---|---|---|
| Next.js frontend | Vercel Hobby | $0 |
| NestJS API, AI backend, Keycloak, Redis, Postgres (PostGIS + pgvector), Keycloak's Postgres, Caddy (HTTPS) | One AWS Lightsail 4 GB instance, Mumbai | ~$24 for the month |
| HTTPS hostnames | `sslip.io` (free, no domain to buy) + Let's Encrypt via Caddy | $0 |
| Docker images | GitHub Container Registry (GHCR) | $0 |

> This guide refers to files in this `deploy/` folder: `compose.prod.yml`, `compose.sh`, `Caddyfile`, `deploy.sh`, `backup.sh`, `.env.prod.example`, and the `keycloak.Dockerfile` / `migrate.Dockerfile` images. The CD pipelines in `.github/workflows/ci.yml` of `backend`, `ai-backend` and `frontend-web` build and deploy them automatically on every push to `main`.

---

## 0. Before you start: values you'll collect

Keep these in a password manager, **not** in git. You'll fill them in as you go.

| Name | Example / where it comes from |
|---|---|
| `STATIC_IP` | Lightsail static IP, e.g. `13.233.10.20` (section 2) |
| `IP_DASHED` | Same IP with dashes, e.g. `13-233-10-20` |
| API URL | `https://api.<IP_DASHED>.sslip.io` |
| Auth URL | `https://auth.<IP_DASHED>.sslip.io` |
| Vercel URL | `https://aismartjourney.vercel.app` (already created) |
| Deploy SSH key pair | `smartjourney_deploy` / `smartjourney_deploy.pub` (section 3.3) |
| Generated secrets | DB passwords, Keycloak admin password, client secrets, `NEXTAUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN` (section 4) |

---

## 1. Accounts and guardrails

### 1.1 AWS account
1. Sign in at <https://console.aws.amazon.com> with the root user **once** and enable **MFA** on it (account menu → Security credentials).
2. **IAM → Users → Create user** (e.g. `smartjourney-admin`), attach `AdministratorAccess`, enable console access and MFA. Use this user from now on, not root.
3. **Billing → Free tier / Credits:** note your **credit balance and expiry date**.
4. **Billing → Budgets → Create budget → Monthly cost budget:** set the amount to **$30**, with email alerts at **50%, 80% and 100%**. Do this before launching anything.
5. Set the console region (top right) to **Asia Pacific (Mumbai) `ap-south-1`** and use it for everything.

### 1.2 GitHub organisation (`SmartJourney-SmartTourismProject`)
1. **Org → Settings → Actions → General → Workflow permissions:** select **Read and write permissions**. The pipelines need it to push images to GHCR.
2. Org secrets are added in section 6, once you have the values.

### 1.3 Vercel: pick the project name now
The frontend URL is needed by the backend (CORS) and by Keycloak (allowed redirects), so decide it first.

1. Sign in at <https://vercel.com> with GitHub.
2. **Add New → Project → Import** `frontend-web` from the org. (If the org isn't listed: **Adjust GitHub App Permissions** → give Vercel access to that repo.)
3. Set the **Project Name**. Yours is already created: production URL **`https://aismartjourney.vercel.app`**.
4. Framework preset **Next.js** (auto-detected). Root directory: leave as the repo root.
5. **Don't deploy yet.** If it auto-deploys, that's fine: it will fail or show a broken login until section 7, and nothing is harmed.

---

## 2. Lightsail instance

1. Open <https://lightsail.aws.amazon.com>, **Create instance**:
   - **Region:** Mumbai (`ap-south-1`), any zone.
   - **Platform:** Linux/Unix. **Blueprint:** OS Only → **Ubuntu 24.04 LTS**.
   - **SSH key:** use the default key, or upload your own public key.
   - **Plan:** the **4 GB RAM / 2 vCPU** plan (~$24/month).
   - **Name:** `smartjourney-prod`. Click **Create**.
2. **Networking tab → Create static IP**, attach it to `smartjourney-prod`. Write down `STATIC_IP` and `IP_DASHED`.
3. **Networking tab → IPv4 Firewall**, so that **exactly** these rules exist:
   | Application | Protocol | Port | Source |
   |---|---|---|---|
   | SSH | TCP | 22 | **Your IP only** (tick "Restrict to IP address") |
   | HTTP | TCP | 80 | Any (Let's Encrypt needs this) |
   | HTTPS | TCP | 443 | Any |

   Delete anything else. **Never** open 5432, 6379, 3001, 8000 or 8080.

   Because SSH is restricted to your IP, GitHub Actions also needs SSH access. Either allow port 22 from anywhere **and** rely on key-only login (the Ubuntu default), or keep it restricted and add GitHub's IP ranges. For a one-month project, **allow 22 from anywhere with key-only auth**. That's simpler, and password login is disabled by default on Lightsail.
4. **Snapshots:** nothing yet. You'll take one after section 8.

---

## 3. Server preparation (one time, over SSH)

Connect with the browser SSH button in Lightsail, or `ssh -i <lightsail-key>.pem ubuntu@<STATIC_IP>`.

### 3.1 Updates, Docker, automatic security patches
```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo apt -y install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # choose "Yes"
docker --version && docker compose version
```

### 3.2 Swap (insurance against running out of memory during a demo)
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # should show 2.0Gi swap
```

### 3.3 A `deploy` user for GitHub Actions
On **your own computer**, create a key pair used only for CD:
```bash
ssh-keygen -t ed25519 -C "smartjourney-cd" -f smartjourney_deploy -N ""
```
Back on the **server**:
```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo mkdir -p /home/deploy/.ssh /opt/smartjourney/backups
sudo nano /home/deploy/.ssh/authorized_keys      # paste the contents of smartjourney_deploy.pub
sudo chown -R deploy:deploy /home/deploy/.ssh /opt/smartjourney
sudo chmod 700 /home/deploy/.ssh && sudo chmod 600 /home/deploy/.ssh/authorized_keys
```
Test from your computer: `ssh -i smartjourney_deploy deploy@<STATIC_IP> docker ps`. It should print an empty table.

---

## 4. Secrets: the server's `/opt/smartjourney/.env`

1. Generate fresh secrets. **Don't reuse any dev value**: `admin`/`admin`, the local `SETTINGS_ENCRYPTION_KEY` and so on must all change. Run this on the server or your computer, once per secret:
   ```bash
   openssl rand -base64 32 | tr -d '/+=' | cut -c1-32   # passwords / client secrets / tokens
   openssl rand -base64 32                              # SETTINGS_ENCRYPTION_KEY (keep the trailing =)
   ```
2. As `deploy` on the server, create `/opt/smartjourney/.env` from `deploy/.env.prod.example` (copy its contents into `nano /opt/smartjourney/.env`) and fill it in. `DATABASE_URL`, `KEYCLOAK_ISSUER` and the other derived URLs are built by `compose.prod.yml`, so you don't set them:

| Group | Variables | Value |
|---|---|---|
| Hostnames | `IP_DASHED` | e.g. `13-233-10-20` |
| | `FRONTEND_URL` | `https://aismartjourney.vercel.app` |
| App database | `POSTGRES_USER`, `POSTGRES_DB` | `smartjourney`, `smartjourney` |
| | `POSTGRES_PASSWORD` | generated |
| Keycloak database | `KEYCLOAK_DB_USER`, `KEYCLOAK_DB_NAME` | `keycloak`, `keycloak` |
| | `KEYCLOAK_DB_PASSWORD` | generated |
| Keycloak | `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD` | e.g. `sjadmin` + generated, for the Keycloak admin console |
| | `KEYCLOAK_WEB_CLIENT_SECRET` | generated (Vercel needs the **same** value, section 7) |
| | `KEYCLOAK_AUDIENCE`, `KEYCLOAK_ADMIN_CLIENT_ID` | same values as your local `backend/.env` (defaults `smartjourney-api` / `smartjourney-backend`) |
| Caddy | `ACME_EMAIL` | your email (Let's Encrypt expiry notices) |
| | `KEYCLOAK_ADMIN_CLIENT_SECRET` | **generated now.** Keycloak creates the `smartjourney-backend` client with this secret on first start, and NestJS uses the same value |
| Google sign-in | `GOOGLE_SIGNIN_CLIENT_ID`, `GOOGLE_SIGNIN_CLIENT_SECRET` | same as local (section 5 updates the redirect URI) |
| Email (password reset) | `KC_SMTP_HOST=smtp.gmail.com`, `KC_SMTP_PORT=587`, `KC_SMTP_AUTH=true`, `KC_SMTP_STARTTLS=true`, `KC_SMTP_SSL=false`, `KC_SMTP_USER`, `KC_SMTP_FROM`, `KC_SMTP_FROM_DISPLAY_NAME=SmartJourney` | a Gmail address |
| | `KC_SMTP_PASSWORD` | a **Gmail app password** (Google Account → Security → 2-Step Verification → App passwords), not the account password |
| Shared secrets | `SETTINGS_ENCRYPTION_KEY` | generated (base64, 32 bytes) |
| | `INTERNAL_API_TOKEN` | generated |
| AI providers | `GEMINI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `OPENWEATHER_API_KEY`, `ORS_API_KEY`, `BOOKING_RAPIDAPI_KEY`, `BOOKING_RAPIDAPI_HOST`, `TICKETMASTER_API_KEY`, `LLM_PROVIDER_CHAIN`, `USD_LKR_RATE` | same as your local `ai-backend/.env` |

3. Lock it down: `chmod 600 /opt/smartjourney/.env`.

> `SETTINGS_ENCRYPTION_KEY` encrypts any API key saved in **Admin → AI models**. If you change it later, saved keys become unreadable and fall back to `.env`.

---

## 5. Google Cloud console (Google sign-in)

Keycloak handles "Sign in with Google", so Google must allow the production callback.

1. <https://console.cloud.google.com> → the project that owns `GOOGLE_SIGNIN_CLIENT_ID` → **APIs & Services → Credentials** → the OAuth 2.0 client.
2. **Authorized redirect URIs → Add URI:**
   `https://auth.<IP_DASHED>.sslip.io/realms/smartjourney/broker/google/endpoint`
3. Keep the localhost one for development. **Save** (it can take a few minutes to apply).
4. If the OAuth consent screen is in **Testing** mode, only listed test users can sign in with Google. Add the demo accounts under **Audience → Test users**, or publish the app.

Google Calendar sync isn't deployed (the AI backend isn't public), so its client needs no change.

---

## 6. GitHub secrets (enable CD)

**Org → Settings → Secrets and variables → Actions → New organization secret.** Give each one access to the `backend`, `ai-backend` and `frontend-web` repos:

| Secret | Value |
|---|---|
| `SERVER_HOST` | `STATIC_IP` |
| `SERVER_USER` | `deploy` |
| `SERVER_SSH_KEY` | the **private** key file `smartjourney_deploy`, whole contents including the BEGIN/END lines |
| `VERCEL_TOKEN` | Vercel → avatar → **Account Settings → Tokens → Create** (scope: your team or account; expiry: 30–60 days) |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | run `npx vercel link` in `frontend-web`, pick the project, then copy `orgId` (starts with `team_`) and the project `id` (starts with `prj_`) from `.vercel/repo.json` (older Vercel CLI versions wrote `.vercel/project.json` instead). **Don't commit `.vercel/`** (it's gitignored). |

---

## 7. Vercel project settings

**Project → Settings:**

1. **Git → Production Branch:** `new-main` (the `frontend-web` default branch). Pushes to `new-main` deploy through the GitHub Actions pipeline after lint and tests pass. `vercel.json` turns off Vercel's own automatic production deploys from that branch, while PR preview deployments still happen. (`backend` and `ai-backend` deploy from their default branch, `main`.)
2. **Functions → Function Region:** **Mumbai, India (`bom1`)**. Login token calls go from Vercel to Keycloak in Mumbai, and the default US region adds a round trip to every login.
3. **Environment Variables:** add these for **Production**:
   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://api.<IP_DASHED>.sslip.io` |
   | `NEXTAUTH_URL` | `https://aismartjourney.vercel.app` |
   | `NEXTAUTH_SECRET` | generated (section 4 command) |
   | `KEYCLOAK_ISSUER` | `https://auth.<IP_DASHED>.sslip.io/realms/smartjourney` |
   | `NEXT_PUBLIC_KEYCLOAK_ISSUER` | same as above |
   | `KEYCLOAK_CLIENT_ID` | `smartjourney-web` |
   | `NEXT_PUBLIC_KEYCLOAK_CLIENT_ID` | `smartjourney-web` |
   | `KEYCLOAK_CLIENT_SECRET` | **the same value** as `KEYCLOAK_WEB_CLIENT_SECRET` on the server |

   `NEXT_PUBLIC_*` values are baked in at build time. After changing one, redeploy (push to `new-main` or re-run the workflow from the Actions tab).

---

## 8. First deploy and data load

### 8.1 Deploy order
Each pipeline skips its deploy job, with a notice, until its secrets exist. Once they do, deploy in this order, waiting for each run to go green:
1. **backend** repo → **Actions → CI → Run workflow** on `main`, with **"Rebuild and redeploy the db and keycloak images too" ticked**. The box has no images yet, so this one manual run builds all five. It copies `deploy/` to `/opt/smartjourney`, starts `db`, `keycloak_db` and `redis`, runs the migrations, starts Keycloak (about 1–2 minutes: it imports the realm) and the backend, then Caddy. Caddy gets the HTTPS certificates on its first request, which can take up to a minute. Later pushes to `main` deploy by themselves, and only rebuild db or keycloak when their files change.
2. **ai-backend** repo: push to `main` (or **Run workflow**). It builds its image and `deploy.sh` starts it.
3. **frontend-web** repo: push to `new-main` (or **Run workflow**). It builds and deploys to Vercel.

Every deploy health-checks the new container and **rolls back to the previous image automatically** if it doesn't become healthy.

Check from your computer: `curl https://api.<IP_DASHED>.sslip.io/health` should return `{"status":"ok"}`, and `https://auth.<IP_DASHED>.sslip.io` should show Keycloak.

**If the packages are private:** the first backend deploy fails at `docker compose pull`. Either make the images public (**Org → Packages →** each of `backend`, `ai-backend`, `keycloak`, `db`, `migrate` **→ Package settings → Change visibility → Public**; they contain no secrets), or, on the server as `deploy`, run `docker login ghcr.io -u <github-user>` with a classic PAT that has only `read:packages`. Then re-run the job.

### 8.2 Copy your local data into production
The first deploy creates an **empty** database. Replace it with your local one (25 districts, 6,572 listings, events, knowledge base: about 39 MB).

On **your computer** (local stack running):
```bash
docker exec smartjourney_postgres pg_dump -U <local POSTGRES_USER> -d smartjourney -Fc -f /tmp/sj.dump
docker cp smartjourney_postgres:/tmp/sj.dump ./sj.dump
scp -i smartjourney_deploy sj.dump deploy@<STATIC_IP>:/opt/smartjourney/backups/
```
On the **server** as `deploy`, in `/opt/smartjourney`:
```bash
./compose.sh stop backend ai-backend
./compose.sh exec -T db dropdb -U smartjourney --force smartjourney
./compose.sh exec -T db createdb -U smartjourney smartjourney
./compose.sh exec -T db pg_restore -U smartjourney -d smartjourney --no-owner --no-privileges < backups/sj.dump
./compose.sh start backend ai-backend
```
(`compose.sh` is a wrapper for `docker compose` that always loads `.env` and the image-tag file. Use it for every compose command on the server.)
The dump includes the `schema_migration` table, so later deploys apply only newer migrations. **Don't re-run the data connectors** in production; they'd spend API quota re-fetching data you already have.

### 8.3 Keycloak after the first start
Production Keycloak starts from `realm-export.json`, so **local user accounts are not copied**. Everyone signs up again.

1. Open `https://auth.<IP_DASHED>.sslip.io/admin` and sign in with `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`.
2. **Realm `smartjourney` → Clients → `smartjourney-web` → Settings:** check that Valid redirect URIs and Web origins include your Vercel URL. They come from `FRONTEND_URL`; add them by hand if missing.
3. Grant the backend's service account its admin roles (a realm import doesn't restore them). From **your computer**, in the `backend` repo:
   ```bash
   KC_URL=https://auth.<IP_DASHED>.sslip.io KC_ADMIN_USER=<bootstrap user> KC_ADMIN_PASSWORD=<bootstrap password> \
     sh keycloak/grant-service-account-roles.sh
   ```
   It should print three `HTTP 204` lines and the roles granted. The client secret it prints must equal `KEYCLOAK_ADMIN_CLIENT_SECRET` in the server `.env`; Keycloak took it from there on first import, so nothing needs copying. (Admin pages can take about 5 minutes to pick up the new roles, because the backend caches its token.)
4. Sign up in the app with your own account. Then, in the Keycloak admin console, **Users →** your user **→ Role mapping → Assign role →** realm role **`admin`**. Sign out and in again to see the Admin menu.
5. **Realm settings → Email → Test connection** to confirm Gmail SMTP works.

### 8.4 App settings
1. **Admin → AI models → API keys:** keys in the server `.env` already work. Re-enter any key you want managed from the panel; the production encryption key is new, so local DB-saved keys don't carry over.
2. **Models order:** `gemini-3.5-flash-lite` → `gemini-3.6-flash` → `claude-haiku-4-5` → `openai/gpt-oss-120b`. **Save order**, then **Test models**.
3. If Explore shows no places, listings aren't verified. On the server:
   `./compose.sh exec ai-backend python -m app.data.verify_all_for_demo`

### 8.5 Backups
On the server as `deploy`:
```bash
crontab -e
# add (daily 02:00 Sri Lanka time = 20:30 UTC):
30 20 * * * /opt/smartjourney/backup.sh >> /opt/smartjourney/backups/backup.log 2>&1
```
Next day: check that `ls /opt/smartjourney/backups` shows a dated `.dump`. Once, test-restore it into a scratch database. A backup you've never restored isn't a backup.

Then, in **Lightsail → Snapshots → Create snapshot**, take your known-good rollback point.

---

## 9. Final checks

- [ ] From outside, only 80/443 answer: `nc -zv <STATIC_IP> 5432 6379 3001 8000 8080` must **all fail**.
- [ ] Full demo path on the real URLs:
  - [ ] Sign up and sign in, plus Google sign-in and a password reset email.
  - [ ] Plan a trip in chat (the card says `llm`, not `fallback`), save it, then open Saved itineraries.
  - [ ] Explore, then add a budget expense.
  - [ ] Admin → AI models → Test.
- [ ] Each repo's Actions tab shows its last run green through deploy (`main` for backend and ai-backend, `new-main` for frontend-web).
- [ ] AWS Billing shows the Budget and no unexpected services.

## 10. Evaluation day

- **Freeze:** no pushes to `main` (backend, ai-backend) or `new-main` (frontend-web) for 24 h before.
- **The day before:** take a Lightsail snapshot, and do a full dress rehearsal of the demo path on the real URLs.
- **15 minutes before:** open the site, sign in and plan one trip to warm up Keycloak and the AI backend.
- Check **Admin → AI models → Test** before the demo. If Gemini is out of quota, Claude Haiku takes over automatically.

## 11. Decommission (after the month)

Put a calendar reminder for the day after evaluation.

1. Download the final backup: `scp -i smartjourney_deploy deploy@<STATIC_IP>:/opt/smartjourney/backups/<latest>.dump .`
2. **Lightsail:** delete the instance, then **release the static IP** (an unattached static IP is billed), then delete snapshots.
3. **GitHub:** delete or disable the `SERVER_*` secrets, and remove the deploy jobs or disable the workflows so pushes don't fail.
4. **Vercel:** keep the project as a portfolio piece (free) or delete it. Revoke the `VERCEL_TOKEN`.
5. **Google Cloud:** remove the production redirect URI.
6. **Anthropic / other paid keys:** revoke the production keys, or lower the spend limit to $0.
7. **AWS Billing:** check the next bill shows **$0** for Lightsail. Delete the Budget last.
