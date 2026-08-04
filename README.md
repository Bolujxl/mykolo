# Koloclay

A digital kolo — the everyday savings-pot practice, rebuilt as a small web
app. The feature surface (entries, total saved, a goal progress bar) is
deliberately small; the auth surface is where the effort went: rate
limiting, account lockout, token-based password reset, remote session
revocation, CSRF protection, and error messages that never confirm whether
an email is registered.

## Stack

Next.js 15 (App Router, TypeScript), Tailwind CSS v4, Prisma + SQLite,
bcryptjs, iron-session, Zod, Resend.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in real secrets — see below
npx prisma migrate dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

See `.env.example`. Generate real secrets rather than using the placeholders:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- `SESSION_SECRET` — encrypts the iron-session cookie. 32+ random chars.
- `CSRF_SECRET` — signs the CSRF double-submit cookie. Falls back to
  `SESSION_SECRET` if unset, but a distinct value is better key hygiene.
- `RESEND_API_KEY` — optional. Password reset emails always log to the
  console as well, so this can be left blank for local dev/grading.
- `DATABASE_URL` — SQLite file for local dev (`file:./dev.db`).

## Known gaps (deliberate, documented in the project brief)

- **Rate limiting is in-memory** (`src/lib/auth/rate-limit.ts`). It's behind
  a `RateLimiter` interface so swapping in Upstash's Redis-backed limiter is
  a one-file change, but as shipped the counters live in process memory and
  won't be consistent across multiple server instances or serverless
  function invocations. Fine for local dev and a single-process deployment;
  close this gap before any multi-instance production deploy.
- **SQLite, not Postgres.** `prisma/schema.prisma` uses SQLite for local
  dev/grading. Switching to Postgres at deploy time is a one-line change to
  the `datasource` block plus a `DATABASE_URL` pointing at Postgres — the
  rest of the schema is unaffected.
- **No "active sessions" UI.** The `Session` table tracks one row per login
  so "log out everywhere" can revoke them all, but there's no settings page
  listing individual sessions with device/location info. The schema doesn't
  block adding that later; it's just out of scope for this pass.

## Auth surface

All of this lives under `src/lib/auth/`:

- `session.ts` — iron-session config (HTTP-only, secure in production,
  `SameSite=Lax`, 7-day expiry).
- `sessions.ts` — the `Session` registry table. Every authenticated request
  re-checks that its session row still exists; "log out everywhere" deletes
  every row for the user, not just the local cookie.
- `password.ts` — bcrypt hashing + the 12-character/variety password schema.
- `schemas.ts` — Zod schemas for every auth and entry input, enforced
  server-side.
- `guards.ts` — `requireAuth`/`requireGuest` (Server Components, redirect-
  based) and `requireAuthApi` (Route Handlers, 401-based).
- `rate-limit.ts` — 5 login attempts per IP per 15 minutes.
- `lockout.ts` — locks an account for an hour after 10 failed attempts
  within a rolling hour; resetting your password is the unlock path.
- `reset-token.ts` — single-use, hashed password reset tokens (30 min TTL).
- `csrf.ts` — signed double-submit cookie CSRF protection, verified on every
  mutating route (`middleware.ts` guarantees the cookie exists before any
  page renders).

Login and signup never reveal whether a given email is registered: signup
returns the same message either way without creating a duplicate account,
and login always returns a generic "Invalid email or password." unless the
password is actually correct — only then does a locked account get a
specific, actionable message, so the lockout state itself can't be used to
enumerate which emails have accounts.
