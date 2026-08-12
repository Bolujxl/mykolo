# KoloVault Auth: The ELI7 Read-Through

This document is the comprehension pass — written after the build, for the
person who directed that build, so that the mechanisms inside it are actually
understood rather than just known to work. It walks through the real code that
exists in this project right now, file by file and line by line, pausing to
define every term that isn't everyday English the first time it appears. If a
section reads like it was written by someone who just finished reading the
source and is explaining what they found, that's because it was.

---

## Quick glossary

These terms appear throughout the sections below. Each gets a one-sentence
plain-English definition here so it doesn't need to be redefined inline.

- **IP address** — a number that identifies a device on the internet, like a
  return address on an envelope; when your browser talks to a server, the
  server sees your IP address as where to send the reply.
- **Hash / hashing** — running data through a mathematical function that
  produces a fixed-size, scrambled-looking string (the "hash") from which the
  original input cannot be recovered; the same input always produces the same
  hash, but changing even one character produces an entirely different hash.
- **Salt** — random extra data mixed into a password before hashing it, so that
  two users with the same password don't end up with the same hash (which would
  make them trivially bulk-crackable if the database leaked).
- **Token** — a long random string that acts as a one-time key or ticket;
  possessing the token proves you're allowed to do something (like reset a
  password), because no one could realistically guess it.
- **Cookie** — a small piece of data the server asks the browser to store and
  send back on every subsequent request; the browser attaches it automatically,
  which is how the server remembers who you are across page loads.
- **HTTP-only cookie** — a cookie that the browser sends on requests but that
  JavaScript running on the page cannot read; this prevents malicious scripts
  from stealing the cookie's contents even if they manage to run on the page.
- **Middleware** — code that runs on every incoming request before it reaches
  the actual route handler; like a security checkpoint at the entrance of a
  building that screens everyone before they reach their destination.
- **Session** — a way for the server to remember who a user is across multiple
  page loads; the browser holds a session cookie, and the server uses that to
  look up which user it's talking to.
- **TTL (time-to-live) / expiry window** — the amount of time something is
  valid before it stops working; after the TTL passes, the thing (token,
  session, rate-limit window) is treated as expired.
- **CSRF (cross-site request forgery)** — an attack where a malicious site
  tricks a victim's browser into making an unwanted request to a site where
  the victim is already logged in; the browser sends the session cookie
  automatically, so without CSRF protection, the target site would treat the
  forged request as legitimate.
- **Brute force** — trying every possible combination (of passwords, tokens,
  etc.) until one works; the defense is making the search space too large to
  feasibly explore.
- **Rolling window** — a time window that moves continuously with each event,
  so every individual event has its own expiration rather than all events
  sharing one fixed bucket that resets on a schedule.
- **Fixed window** — a time window anchored to a specific starting point; all
  events within that window share the same expiration time, and when the
  window ends, the whole thing resets.
- **HMAC (hash-based message authentication code)** — a way to produce a
  signature for some data using a secret key, so that anyone who doesn't know
  the secret can't forge a valid signature, but anyone who does can verify
  that the data hasn't been tampered with.
- **bcrypt** — a hashing function specifically designed for passwords; it's
  intentionally slow (configurable via "rounds"), which makes brute-forcing
  hashes prohibitively expensive even if an attacker has the hash and a fast
  computer.
- **Serverless / serverless function** — code that runs in a temporary
  container spun up for a single request and then destroyed; multiple copies
  can run in parallel across different machines, and they don't share memory
  with each other.

---

## The auth flow, briefly

KoloVault is a financial savings tracker. You sign up, log in, and manage
entries on a dashboard. The auth system that gates all of this lives in
`src/lib/auth/` and `src/app/api/auth/`, and it follows a standard pattern
that should feel familiar if you've used any modern web app.

**Signup.** A visitor at `/signup` fills in an email and password (minimum 12
characters, at least three of: lowercase, uppercase, digit, symbol). The form
POSTs to `POST /api/auth/signup`. That route checks CSRF, validates the input
against `signupSchema` (`src/lib/auth/schemas.ts:11-14`), and then — critically
— does *not* reveal whether the email already exists. If it's a new email, the
password is hashed with bcrypt (12 rounds, `src/lib/auth/password.ts:5-9`) and
a `User` row is created. If the email already exists, the route still returns
the identical success message. Either way, the user is not logged in
automatically; they must go to `/login` next. This makes account enumeration
via signup impossible — an attacker can't tell whether an email is registered
by attempting to sign up with it.

**Login.** The user at `/login` submits email and password to
`POST /api/auth/login`. The route (`src/app/api/auth/login/route.ts`) does,
in order: CSRF check, rate-limit check (the first focus area of this
document), input validation, user lookup, password verification against the
stored bcrypt hash. If the password matches, it checks whether the account is
locked (the second focus area). If everything passes, it clears any existing
lockout state, creates a session record in the `Session` table, and stores the
user ID and session ID in an iron-session encrypted cookie. The browser is then
redirected to `/dashboard`.

**Session.** Every subsequent request reads the encrypted session cookie via
`getSession()` (`src/lib/auth/session.ts:35-38`). The cookie contains a
`sessionId` that points to a row in the `Session` database table. On each
authenticated request, `isSessionRecordValid()` (`src/lib/auth/sessions.ts:18-29`)
re-checks that the row still exists and hasn't expired. If the row is gone (the
user logged out, or "log out everywhere" was used), the session is treated as
invalid even though the cookie itself hasn't expired. This is what makes remote
session revocation possible — the cookie alone isn't enough; the database row
must back it.

**Dashboard.** Pages like `/dashboard` call `requireAuth()`
(`src/lib/auth/guards.ts:28-32`), which runs the session validation described
above and redirects to `/login` if the user isn't authenticated. The dashboard
then queries the user's entries and renders them.

**Logout.** The logout route (`POST /api/auth/logout`) deletes the session row
from the database and destroys the cookie. "Log out everywhere"
(`POST /api/auth/logout-everywhere`) deletes *all* session rows for the
current user and destroys the local cookie, signing them out of every device
they were logged into.

That's the surface. The rest of this document goes deep on the three mechanisms
that make this more than a basic username-password gate.

---

## Deep dive: Rate limiting — how it decides when to block a request

### The problem

Without rate limiting, nothing stops an attacker (or a misbehaving script) from
sending thousands of login attempts per second against the server. Even if none
of those attempts succeed, they cost resources — CPU time for bcrypt
comparisons, database queries, network bandwidth. Worse, if an attacker can try
unlimited password guesses, they can brute-force weak passwords. Rate limiting
caps how many attempts any given source can make in a given time period, making
automated attacks infeasibly slow.

### The files

- `src/lib/auth/rate-limit.ts` — the limiter itself
- `src/app/api/auth/login/route.ts:32-39` — the login route applies it
- `src/app/api/auth/reset-password/request/route.ts:21-29` — the password-reset
  request route applies its own instance

### What key does it track?

The limiter tracks requests by **IP address**. An IP address is a number that
identifies a device on the internet — it's the return address the server sees
on every request. The function `getClientIp()` at line 67 extracts it:

```typescript
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
```

`x-forwarded-for` is a header set by reverse proxies (like Vercel's edge
network or a load balancer) that records the original client's IP when the
request passes through intermediaries. The code takes the **leftmost** entry
(the original client) because proxies append their own IPs to the right. If
that header isn't present, it falls back to `x-real-ip`, another proxy header.
If neither is present (unlikely in production, possible in local dev), it
returns the string `"unknown"`.

Why track by IP rather than, say, email address? Because an attacker trying
to brute-force passwords hasn't necessarily submitted a valid email yet (or may
be guessing emails too). IP is the one piece of identifying information the
server has *before* any user lookup happens. It's not perfect — a single
attacker can rotate IPs, and multiple legitimate users can share an IP (like
everyone in a coffee shop) — but it's the best available pre-authentication
signal. The separate lockout mechanism (next section) covers what IP-based rate
limiting misses.

### The actual limiter: `InMemoryRateLimiter`

The file defines an interface first (`RateLimiter`, lines 9-11) with a single
`check(key)` method. This is important for future-proofing: the interface means
the current in-memory implementation can be swapped for a Redis-backed one
later without touching any of the route handlers that call it.

The concrete implementation is `InMemoryRateLimiter` (lines 20-52):

```typescript
class InMemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}
```

The `hits` Map is the data structure that holds all the counters. A **Map** is
like a dictionary — you give it a key (here, an IP address as a string) and it
returns a value (here, an object with a `count` and a `windowStart` timestamp).
The Map lives in the Node.js process's memory, meaning it's fast (no database
query) but also ephemeral (more on that at the end).

Two instances are created at the bottom of the file:

```typescript
export const loginRateLimiter: RateLimiter = new InMemoryRateLimiter(
  5,
  15 * 60 * 1000
);

export const resetRequestRateLimiter: RateLimiter = new InMemoryRateLimiter(
  5,
  15 * 60 * 1000
);
```

Both use the same parameters: **5 attempts per 15 minutes** (15 × 60 × 1000
milliseconds = 900,000 ms). There are two separate instances — one for the
login route and one for the password-reset request route — so hitting the login
rate limit doesn't block you from requesting a password reset, and vice versa.
This is intentional: a legitimate user who's locked out of login should still
be able to trigger a password reset without immediately tripping a shared rate
limit.

### The `check()` method, step by step

Here's the full method (`lines 28-44`):

```typescript
async check(key: string): Promise<RateLimitResult> {
  const now = Date.now();
  this.sweep(now);

  const entry = this.hits.get(key);
  if (!entry || now - entry.windowStart >= this.windowMs) {
    this.hits.set(key, { count: 1, windowStart: now });
    return { success: true, remaining: this.limit - 1, resetAt: now + this.windowMs };
  }

  entry.count += 1;
  const resetAt = entry.windowStart + this.windowMs;
  if (entry.count > this.limit) {
    return { success: false, remaining: 0, resetAt };
  }
  return { success: true, remaining: this.limit - entry.count, resetAt };
}
```

Here's what happens, step by step:

1. **Get the current time** (`now = Date.now()`). `Date.now()` returns the
   number of milliseconds since January 1, 1970 (Unix epoch). All timestamps
   in this codebase use this millisecond format.

2. **Sweep** (`this.sweep(now)`). This is a garbage-collection step that only
   actually does anything once the Map has 5,000 or more entries (line 47):
   ```typescript
   private sweep(now: number) {
     if (this.hits.size < 5000) return;
     for (const [key, entry] of this.hits) {
       if (now - entry.windowStart >= this.windowMs) this.hits.delete(key);
     }
   }
   ```
   When triggered, it walks through every entry and deletes any whose window
   has expired. This prevents the Map from growing indefinitely and consuming
   all available memory in a long-running process. The 5,000-entry threshold
   means sweeping is skipped entirely for low-traffic scenarios (like local dev).

3. **Look up the entry** for this key (`this.hits.get(key)`). If no entry
   exists for this IP at all, or if the existing entry's window has expired:
   - Create a fresh entry: `{ count: 1, windowStart: now }`.
   - Return `{ success: true, remaining: this.limit - 1, resetAt: now + this.windowMs }`.
   - `remaining` tells the caller how many attempts are left before the
     limit kicks in (not that the caller currently uses this value, but the
     interface provides it).
   - `resetAt` is the timestamp when this window will expire (15 minutes from
     the *first* attempt in the window, not from this attempt).

4. **If the entry exists and the window hasn't expired yet**, increment the
   count by 1. Then evaluate:
   - If `entry.count > this.limit` (meaning the 6th or later attempt,
     since the limit is 5): return `{ success: false, remaining: 0, resetAt }`.
     The route handler will see `success: false` and respond with a 429 status.
   - Otherwise (attempts 2 through 5): return `{ success: true, remaining: this.limit - entry.count, resetAt }`.

### Fixed window vs. sliding window

This codebase implements a **fixed window**. The window is anchored to the
timestamp of the *first* attempt (`windowStart`). Every subsequent attempt
within 15 minutes of that anchor increments the same counter. When 15 minutes
have elapsed since `windowStart`, the window resets and a new anchor is set
at the current time.

In a **sliding window**, each individual attempt would have its own independent
expiry — attempt 1 expires 15 minutes after it happened, attempt 2 expires 15
minutes after *it* happened, and so on. At any given moment, the server would
count how many attempts occurred in the last 15 minutes, regardless of when the
"first" one was.

**Practical difference:** With the fixed window, if a user makes their 5
allowed attempts in the last 30 seconds of a window, they can make 5 more
immediately when the window resets — effectively 10 attempts in a tight burst
straddling the boundary. With a sliding window, at most 5 attempts can exist
within *any* 15-minute span, period. The fixed window is slightly more
permissive at boundaries, but it's also far simpler to implement and reason
about. For this project's scope, the difference is a reasonable trade-off
documented rather than a bug.

### How the login route uses the result

Back in `src/app/api/auth/login/route.ts:32-39`:

```typescript
const ip = getClientIp(request);
const rateLimit = await loginRateLimiter.check(ip);
if (!rateLimit.success) {
  return NextResponse.json(
    { error: "rate_limited", message: "Too many login attempts. Try again later." },
    { status: 429 }
  );
}
```

If the limiter returns `success: false`, the route immediately responds with
HTTP status **429** (Too Many Requests) and the message `"Too many login
attempts. Try again later."`. The rest of the route — input parsing, user
lookup, password verification, lockout check, session creation — never runs.
The attacker gets nothing except a 429. No indication of whether the email
exists, whether the password was close, nothing. Just a wall.

### Traced example: 7 attempts from the same IP

Assume the same IP address `203.0.113.42` hits the login endpoint. The clock
starts at `T = 0` minutes.

| Attempt | Time  | `entry.count` before | `entry.count` after | `windowStart` | `success` | `remaining` | `resetAt` | What happens |
|---------|-------|---------------------|---------------------|---------------|-----------|-------------|-----------|--------------|
| 1       | T=0   | (no entry)          | 1                   | T=0           | true      | 4           | T+15      | First attempt in a new window. Anchor set. |
| 2       | T=2   | 1                   | 2                   | T=0           | true      | 3           | T+15      | Count increments. Still within the window. |
| 3       | T=4   | 2                   | 3                   | T=0           | true      | 2           | T+15      | Same. |
| 4       | T=6   | 3                   | 4                   | T=0           | true      | 1           | T+15      | One attempt remaining. |
| 5       | T=8   | 4                   | 5                   | T=0           | true      | 0           | T+15      | Last allowed attempt. `remaining` is now 0. |
| 6       | T=9   | 5                   | 6                   | T=0           | **false** | 0           | T+15      | **Blocked.** 429 response. `6 > 5` triggers rejection. |
| 7       | T=12  | 6                   | 7                   | T=0           | **false** | 0           | T+15      | **Blocked.** Still the same window; count keeps climbing. |
| —       | T=16  | 7                   | → entry replaced    | T=16          | true      | 4           | T+31      | Window expired (`16 ≥ 15` from T=0). Fresh entry with count=1. |

At T+16, a new window begins anchored at T=16. The next 5 attempts would be
allowed again.

### Why in-memory has a real limitation

The in-memory Map is fast and requires no additional infrastructure, but it has
a fundamental limitation: the Map lives in one Node.js process's memory. In a
production deployment running on a serverless platform (like Vercel), each
incoming request may be handled by a *different* serverless function instance
— a separate container with its own isolated memory. Two requests that land on
two different instances see two different Maps. An attacker whose requests get
distributed across four instances could send 20 attempts (5 per instance)
without any single instance's counter hitting the threshold.

This is a **known, documented gap** in the current build. The file itself flags
it in the comment at lines 13-18:

```
// Known gap: these counters live in process memory. They don't persist or
// stay consistent across multiple server instances/serverless function
// invocations. Fine for local dev and a single-process deployment — flagged
// here as the thing to close before any multi-instance production deploy.
```

The fix is swapping the `RateLimiter` implementation to one backed by a shared
data store like Redis (Upstash Redis is commonly paired with serverless
Next.js). Because the `RateLimiter` interface is already defined, that swap
requires changing exactly one file (`rate-limit.ts`) — every route handler
uses the interface, so they wouldn't need to change.

### Why this approach, not an alternative

A naive rate limiter might use a single global counter (`let attempts = 0`) and
block after 5 total attempts across *all* users. That would let one malicious
IP lock out everyone else. This implementation tracks per-IP, so each source
gets its own allowance.

A naive fixed-rate approach might reset on a clock boundary (every 15 minutes
on the hour: 12:00, 12:15, 12:30, etc.) rather than using a per-key window.
That would let an attacker send 5 attempts at 12:14:59 and 5 more at 12:15:00
— 10 attempts in 2 seconds. This implementation anchors each window to the
first attempt's actual timestamp, so you can't game clock boundaries.

---

## Deep dive: Account lockout — how state is stored and checked

### The problem

Rate limiting blocks requests by network address. But what if an attacker
controls many IP addresses (a botnet, or simply rotating through proxy
servers)? Each IP gets its own 5-attempt allowance, so the rate limiter alone
would let through unlimited password guesses against a specific account by
spreading the attempts across many IPs.

Account lockout solves the other half of the problem: it tracks how many times
a specific **account** has seen a failed login attempt, regardless of where
those attempts came from. If someone fails to log into `alice@example.com` 10
times within an hour, the account itself gets locked — even if each attempt
came from a different IP address.

Together, rate limiting and lockout form two layers:
- **Rate limiting** (by IP) stops one source from hammering the server.
- **Lockout** (by account) stops many sources from hammering one account.

### The files

- `src/lib/auth/lockout.ts` — the lockout logic
- `prisma/schema.prisma:18-22` — the `User` model fields that store lockout state
- `src/app/api/auth/login/route.ts:58-76` — the login route applies it
- `src/app/api/auth/reset-password/confirm/route.ts:39` — the password-reset
  confirm route clears it

### The storage mechanism

The `User` model in `prisma/schema.prisma` has three fields dedicated to
lockout tracking (lines 18-22):

```prisma
// Account lockout state (lib/auth/lockout.ts). Failed attempts are
// counted within a rolling 1-hour window; 10 failures locks the account.
failedLoginCount   Int       @default(0)
firstFailedLoginAt DateTime?
lockedUntil        DateTime?
```

- **`failedLoginCount`** — how many consecutive failed login attempts have
  occurred on this account within the current rolling window. Starts at 0. An
  `Int` (integer), not nullable.
- **`firstFailedLoginAt`** — the timestamp of the *first* failure in the
  current rolling window. Null if there haven't been any failures yet. This is
  what defines the "within an hour" check — if the latest failure occurs more
  than an hour after this timestamp, the window resets.
- **`lockedUntil`** — if the account is currently locked, this is the timestamp
  when the lock expires. Null if the account is not locked. The lock persists
  for one hour after the moment the threshold is reached.

### The constants

From `src/lib/auth/lockout.ts:5-7`:

```typescript
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000; // failures counted per rolling hour
export const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // account stays locked for an hour
```

- **10 failed attempts** within a **1-hour rolling window** triggers the lock.
- Once locked, the account stays locked for **1 hour**.
- The window and the lock duration happen to be the same value here (both
  1 hour), but they're separate constants because they serve different
  purposes — the window is for *counting* failures, the duration is for
  *holding* the lock after it triggers.

### The check: `isAccountLocked()`

```typescript
export function isAccountLocked(user: Pick<User, "lockedUntil">): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}
```

This is a simple time check: the account is locked if (a) `lockedUntil` is not
null and (b) the current time is still before `lockedUntil`. If `lockedUntil`
is in the past, the account is no longer locked even though the field still has
a value — the check naturally allows the lock to expire without requiring a
cleanup job to null out the field.

### `recordFailedLogin()` — called on every failed login

This function runs when a login attempt provides the correct password for an
existing account but fails for another reason (typically: the *password itself
failed*, or the account is locked). Here's the full logic (lines 22-45):

```typescript
export async function recordFailedLogin(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const now = new Date();
  const windowExpired =
    !user.firstFailedLoginAt ||
    now.getTime() - user.firstFailedLoginAt.getTime() > LOCKOUT_WINDOW_MS;

  const nextCount = windowExpired ? 1 : user.failedLoginCount + 1;
  const nextFirstFailedLoginAt = windowExpired ? now : user.firstFailedLoginAt;
  const shouldLock = nextCount >= LOCKOUT_THRESHOLD;

  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: nextCount,
      firstFailedLoginAt: nextFirstFailedLoginAt,
      lockedUntil: shouldLock
        ? new Date(now.getTime() + LOCKOUT_DURATION_MS)
        : user.lockedUntil,
    },
  });
}
```

Step by step:

1. **Fetch the user.** If the user doesn't exist (shouldn't happen in practice,
   since this is only called after a user lookup succeeded), bail out.

2. **Check if the rolling window has expired.** The window has expired if
   `firstFailedLoginAt` is null (no failures at all yet) or if the current
   time is more than `LOCKOUT_WINDOW_MS` (1 hour) after `firstFailedLoginAt`.
   This is what makes it a *rolling* window — the counter resets when an hour
   has passed since the first failure, even if the 10-attempt threshold was
   never reached.

3. **Determine the next count.** If the window expired, start fresh at 1.
   Otherwise, increment the current count by 1.

4. **Determine the next `firstFailedLoginAt`.** If the window expired, set it
   to `now` (this failure becomes the new anchor). Otherwise, keep the existing
   anchor — the window stays anchored to the original first failure.

5. **Decide whether to lock.** `shouldLock` is true if `nextCount >= 10`.

6. **Update the database row.** If `shouldLock` is true, set `lockedUntil` to
   one hour from now. If not, leave `lockedUntil` as-is (which may be null if
   the account was never locked, or a past/future timestamp if it already was).

### `clearFailedLogins()` — the reset

```typescript
export async function clearFailedLogins(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, firstFailedLoginAt: null, lockedUntil: null },
  });
}
```

All three fields are reset: counter to 0, anchor timestamp to null, lockout
timestamp to null. This is called in two places:
- **On successful login** (`login/route.ts:78`): if the password is correct
  and the account isn't locked, the counter resets — a successful login proves
  the real user is present, so accumulated failures no longer matter.
- **On password reset** (`reset-password/confirm/route.ts:39`): resetting the
  password is the explicit unlock path.

### How the login route weaves it together

The login route at `src/app/api/auth/login/route.ts` uses lockout in a specific
order that's carefully designed to avoid information leaks. Here's the relevant
sequence:

```typescript
const user = await prisma.user.findUnique({ where: { email } });

const passwordMatches = await verifyPassword(
  password,
  user?.passwordHash ?? DUMMY_HASH
);

if (!user || !passwordMatches) {
  if (user) await recordFailedLogin(user.id);
  return GENERIC_INVALID;
}

// Only reveal lockout state once the password is known to be correct —
// otherwise an attacker guessing emails could use the lockout message
// itself as an oracle for which addresses have accounts.
if (isAccountLocked(user)) {
  return NextResponse.json(
    {
      error: "account_locked",
      message: `Too many failed attempts. Your account is locked for ${lockoutMinutesRemaining(
        user
      )} more minute(s), or you can reset your password to unlock it immediately.`,
    },
    { status: 403 }
  );
}

await clearFailedLogins(user.id);
```

Key design decisions visible here:

1. **`recordFailedLogin` is only called if `user` exists** (line 59: `if (user) await recordFailedLogin(user.id)`). If someone tries to log into a
   nonexistent email, no lockout counter is incremented — only the rate limiter
   counts the attempt. This prevents an attacker from locking accounts they
   don't know exist, and prevents lockout state from revealing which emails are
   registered (a nonexistent email's lockout counter would always stay at 0,
   which would be a signal if the attacker could somehow observe it).

2. **The lockout message is only sent after a correct password** (line 66:
   `isAccountLocked(user)` is checked *after* `passwordMatches` has been
   confirmed). This means an attacker can't submit random passwords and use
   whether they get an "account locked" versus "invalid credentials" response
   to determine whether the email exists. They must already know the correct
   password before the server will confirm the account is locked. Since a
   locked-out user presumably knows their own password, this reveals nothing to
   an attacker.

3. **`clearFailedLogins` runs after a successful login** (line 78), resetting
   the counter so that intermittent legitimate failures don't accumulate toward
   a lockout.

### The unlock path

There are two ways an account becomes unlocked:

1. **Automatic expiry.** After `LOCKOUT_DURATION_MS` (1 hour) from the moment
   the lock was applied, `isAccountLocked()` will return false because
   `lockedUntil.getTime()` will be in the past. The user can log in normally
   (with their correct password). The lockout counter and
   `firstFailedLoginAt` still have their old values in the database, but the
   next failed login will find that the rolling window has expired (because
   `firstFailedLoginAt` is now more than an hour old), so the counter resets
   to 1 with a fresh window.

2. **Password reset.** The lockout message itself tells the user:
   `"...or you can reset your password to unlock it immediately."`. When the
   user completes a password reset (via `POST /api/auth/reset-password/confirm`),
   line 39 calls `clearFailedLogins(userId)`, which nulls out `lockedUntil`
   immediately. The user can then log in with their new password right away,
   without waiting the full hour.

### Traced example: 11 consecutive failed login attempts

User `alice@example.com` (let's call her ID `user_abc123`). Timestamps in
minutes from `T = 0`.

| Attempt | Time | `failedLoginCount` before | `firstFailedLoginAt` | Action |
|---------|------|--------------------------|----------------------|--------|
| 1       | T=0  | 0                        | null                 | Wrong password. Window is fresh (no `firstFailedLoginAt`), so `windowExpired = true`. Count → 1. `firstFailedLoginAt` → T=0. |
| 2       | T=2  | 1                        | T=0                  | Wrong password. Window not expired. Count → 2. |
| 3       | T=4  | 2                        | T=0                  | Wrong password. Count → 3. |
| 4       | T=5  | 3                        | T=0                  | Count → 4. |
| 5       | T=6  | 4                        | T=0                  | Count → 5. |
| 6       | T=7  | 5                        | T=0                  | Count → 6. |
| 7       | T=8  | 6                        | T=0                  | Count → 7. |
| 8       | T=8  | 7                        | T=0                  | Count → 8. |
| 9       | T=9  | 8                        | T=0                  | Count → 9. |
| 10      | T=9  | 9                        | T=0                  | Count → 10. `nextCount (10) >= LOCKOUT_THRESHOLD (10)`, so `shouldLock = true`. `lockedUntil` → T+60 (1 hour from now). **Account is now locked.** |
| 11      | T=10 | 10                       | T=0                  | Wrong password again, but the lockout message isn't shown here — the login route sends `GENERIC_INVALID` ("Invalid email or password.") because the password didn't match. The counter increments to 11 in the database, but the user doesn't see the lockout status. |

Now Alice tries to log in with her **correct** password at T=12:

1. `findUnique` finds her user.
2. `verifyPassword` returns `true` (she used the right password).
3. The `if (!user || !passwordMatches)` check is false — we don't enter that branch.
4. `isAccountLocked(user)` checks: `lockedUntil` is T+60, and T=12 is before T+60. **True** — account is still locked.
5. The route returns a 403 with:
   ```
   "Too many failed attempts. Your account is locked for 48 more minute(s),
   or you can reset your password to unlock it immediately."
   ```
   The `48` comes from `lockoutMinutesRemaining()` which computes
   `Math.ceil((T+60 - T+12) in minutes) = Math.ceil(48) = 48`.

**The unlock:** Alice requests a password reset, receives the link, submits a
new password. The confirm route calls `clearFailedLogins(user_abc123)`, which
sets `failedLoginCount → 0`, `firstFailedLoginAt → null`,
`lockedUntil → null`. Alice logs in with her new password. The login route sees
`isAccountLocked(user)` is false (no `lockedUntil`), calls
`clearFailedLogins` again (harmless, already clean), creates her session, and
she's in.

### Why this doesn't reveal information

The combination of two design decisions — (1) `recordFailedLogin` only for
existing users, and (2) lockout status only revealed after correct password —
means an attacker learns nothing from the login response that they didn't
already know. If they submit a random email, they get "Invalid email or
password" regardless of whether the email exists. If they submit a correct
email with a wrong password, they still get "Invalid email or password." Only
when they submit a correct email *and* the correct password does the server
volunteer lockout information — and at that point, they've already proven they
know the email and the password, so confirming "yes, this account exists and
it's locked" reveals nothing new.

### Why this approach, not an alternative

A naive lockout might reveal the lockout state *before* checking the password
("This account is locked. Try again in 48 minutes."). That would create an
oracle — an attacker could submit emails and passwords and use the lockout
message as confirmation that the email is real. This codebase defers the
lockout check until after password verification, closing that oracle.

Another naive approach might lock the account based on a site-wide counter
rather than a per-account counter — one global lockout threshold for all failed
logins anywhere. That would let one attacker brute-forcing one account trigger
a lock for *everyone*. This codebase tracks failures per-user.

A naive lockout might never expire ("account is locked until an admin unlocks
it"). This codebase uses automatic expiry (1 hour) plus a self-service unlock
path (password reset), so a locked-out user isn't dependent on an admin being
available — they can always just wait an hour or reset their password.

---

## Deep dive: Password reset — the full token lifecycle

### The problem

People forget passwords. The application needs a way for a legitimate user to
set a new password without being logged in. But that flow can't be a backdoor
— an attacker who knows (or guesses) a user's email shouldn't be able to take
over the account through the reset mechanism.

The defense is a **token** — a long random string that acts as a one-time key.
The token is sent to the email address on file, so only someone with access to
that inbox can follow the link and reset the password. The rest of this section
walks through exactly how that token is created, stored, validated, and
destroyed in this codebase.

### The files

- `src/lib/auth/reset-token.ts` — token creation and consumption
- `src/lib/email.ts` — email delivery (Resend + console fallback)
- `src/app/api/auth/reset-password/request/route.ts` — the "forgot password" endpoint
- `src/app/api/auth/reset-password/confirm/route.ts` — the "submit new password" endpoint
- `prisma/schema.prisma:47-57` — the `PasswordResetToken` model

### Step 1: The request

A user at `/reset-password` fills in their email and submits. The
`ResetRequestForm` component (`src/components/auth/ResetRequestForm.tsx`)
POSTs to `/api/auth/reset-password/request` with `{ email }`.

The route (`src/app/api/auth/reset-password/request/route.ts`) does:

```typescript
const GENERIC_MESSAGE = {
  message: "If that email has an account, a password reset link has been sent.",
};
```

This constant is the response for *every* outcome — email exists or not, rate
limited or not. The route applies rate limiting first (its own instance,
`resetRequestRateLimiter`, so requesting a reset doesn't consume the login
rate-limit allowance), then validates the input, then looks up the user:

```typescript
const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
if (user) {
  const token = await createResetToken(user.id);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const resetUrl = `${appUrl}/reset-password/${token}`;
  await sendPasswordResetEmail(user.email, resetUrl);
}

return NextResponse.json(GENERIC_MESSAGE);
```

If the email **doesn't** exist: `user` is null, the `if` block is skipped, and
`GENERIC_MESSAGE` is returned immediately. No email is sent. No token is
created. No error. The attacker sees `"If that email has an account, a password
reset link has been sent."` — identical to the response they'd get for a real
email. This prevents account enumeration: an attacker can't submit a batch of
emails to the reset endpoint and determine which ones are registered by
comparing responses.

If the email **does** exist: the block runs, the token is created, the email is
sent, and the same `GENERIC_MESSAGE` is returned. The email-sending is a
**side effect** — it happens server-side, invisible to the caller. The caller
can't observe whether `sendPasswordResetEmail` actually ran.

### Step 2: Token generation

`createResetToken()` in `src/lib/auth/reset-token.ts:14-29`:

```typescript
export async function createResetToken(userId: string): Promise<string> {
  await prisma.passwordResetToken.deleteMany({
    where: { userId, usedAt: null },
  });

  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  return token;
}
```

Step by step:

1. **Delete old unused tokens.** `deleteMany` removes any existing
   `PasswordResetToken` rows for this user that haven't been used yet
   (`usedAt: null`). This means only one valid reset token can exist per user
   at a time — requesting a new one invalidates any previous un-used links.
   This prevents an attacker from accumulating many active tokens and using the
   oldest one after the user has already reset their password.

2. **Generate the token.** `randomBytes(32).toString("hex")`:
   - `randomBytes(32)` produces 32 random bytes (256 bits) from the operating
     system's cryptographically secure random number generator (`node:crypto`).
     This isn't `Math.random()` — it pulls entropy from system-level sources
     that are designed to be unpredictable.
   - `.toString("hex")` converts those 32 bytes into a 64-character string of
     hexadecimal digits (0-9, a-f). For example:
     `a1b2c3d4e5f6...`.
   - The search space is 2^256 — a number so large (roughly 10^77) that no
     computer, now or in the foreseeable future, could iterate through even a
     meaningful fraction of it. This is what "unguessable" means: it's not that
     guessing is hard, it's that the number of possible values is
     astronomically beyond what can be tried.

3. **Store the hashed token.** The *plaintext* token is never written to the
   database. Instead, `hashToken(token)` runs it through SHA-256
   (`createHash("sha256").update(token).digest("hex")`) and stores only the
   hash. The hashing function here (lines 7-8):
   ```typescript
   function hashToken(token: string): string {
     return createHash("sha256").update(token).digest("hex");
   }
   ```
   This is a fast, one-way hash (not a slow password hash like bcrypt — tokens
   don't need bcrypt's slowness because they're already 256 bits of random,
   which is unguessable regardless of hash speed). The same plaintext always
   produces the same hash.

4. **Return the plaintext token.** The function returns the raw, unhashed
   token. This plaintext value only exists in server memory long enough to be
   passed to the email-sending function. After that, the only record of the
   token is the hash in the database, which cannot be reversed to recover the
   original.

### Step 3: Token storage

The `PasswordResetToken` model in `prisma/schema.prisma:47-57`:

```prisma
model PasswordResetToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

The critical field is `tokenHash` — it's marked `@unique`, meaning no two rows
can have the same hash (which is a natural consequence of the tokens being
random and the hash being deterministic). The plaintext token appears nowhere
in this model. The fields `expiresAt` and `usedAt` control the token's
lifecycle (explained in Step 4 and Step 6).

**Why hash before storage?** If an attacker somehow gained read access to the
database (e.g., a SQL injection vulnerability, a leaked backup, a compromised
admin credential), they would see `tokenHash` values — SHA-256 hashes. To use a
hash as a reset token, they'd need to find a plaintext that produces that exact
hash. That's computationally infeasible for a 256-bit random input. If the raw
token were stored instead, the attacker could read it directly from the
database and reset anyone's password without ever touching their inbox. Hashing
the token before storage is the same principle as hashing passwords — don't
store the secret in a readable form.

### Step 4: Expiry

From `src/lib/auth/reset-token.ts:5`:

```typescript
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
```

When a token is created, its `expiresAt` is set to `Date.now() + RESET_TOKEN_TTL_MS`
— 30 minutes from the moment of creation.

When a token is consumed (`consumeResetToken`, lines 33-47), the expiry is
checked:

```typescript
if (!record || record.usedAt || record.expiresAt < new Date()) return null;
```

If `record.expiresAt` is before the current time, the function returns null —
the token is treated as invalid, same as if it didn't exist.

**Why 30 minutes?** A reset link sitting in an email inbox from three months
ago shouldn't still work. The email could have been forwarded, the inbox could
have been compromised since then, or the user could have changed their mind.
The 30-minute window is long enough for a legitimate user to receive the email
and click the link (even accounting for email delivery delays), but short
enough that a lingering, un-attended reset link isn't a permanent account
takeover vector. Some applications use 15 minutes or 1 hour; 30 minutes is a
middle ground.

### Step 5: Delivery

`sendPasswordResetEmail()` in `src/lib/email.ts:8-31`:

```typescript
export async function sendPasswordResetEmail(
  email: string,
  resetUrl: string
): Promise<void> {
  console.log(`[kolovault] Password reset link for ${email}: ${resetUrl}`);

  if (!resend) return;

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM ?? "KoloVault <onboarding@resend.dev>",
      to: email,
      subject: "Reset your KoloVault password",
      html: `
        <p>Someone requested a password reset for this KoloVault account.</p>
        <p><a href="${resetUrl}">Reset your password</a></p>
        <p>This link expires in 30 minutes. If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  } catch (error) {
    console.error("[kolovault] Failed to send password reset email via Resend:", error);
  }
}
```

Two things happen here:

1. **Console log always fires.** The reset URL is always printed to the server
   console, regardless of whether Resend is configured. In local development
   (where no email API key is set), the developer finds the link in the
   terminal output. This is a dev safety net — you can test the full reset flow
   without an email service.

2. **Resend sends the email** (if `RESEND_API_KEY` is configured). Resend is an
   email API service. The email body contains an HTML link whose `href` is the
   reset URL with the raw token embedded in the path:
   ```
   https://mykolo.vercel.app/reset-password/a1b2c3d4e5f6...
   ```
   The link contains the **raw, unhashed** token. This is necessary because the
   server only stores the hash — when the user clicks the link, the server
   receives the raw token, hashes it, and compares the hash against the stored
   `tokenHash`. If the link contained the hash instead, it would be useless
   (the server would hash the hash, producing a different value that matches
   nothing). This is the same principle as password authentication: the user
   provides the raw password, the server hashes it, and compares against the
   stored hash.

### Step 6: Verification

When the user clicks the link, their browser navigates to
`/reset-password/{token}`. The page component
(`src/app/(auth)/reset-password/[token]/page.tsx`) extracts the token from the
URL and renders `ResetConfirmForm` with it. The user types a new password and
submits. The form POSTs to `/api/auth/reset-password/confirm` with
`{ token, password }`.

The confirm route calls `consumeResetToken(token)` at line 25:

```typescript
const userId = await consumeResetToken(token);
if (!userId) {
  return NextResponse.json(
    { error: "invalid_token", message: "This reset link is invalid or has expired." },
    { status: 400 }
  );
}
```

`consumeResetToken()` in `src/lib/auth/reset-token.ts:33-47`:

```typescript
export async function consumeResetToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) return null;

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.userId;
}
```

Step by step:

1. **Hash the incoming token.** The plaintext from the URL is hashed with the
   same SHA-256 function used during creation. This produces the value that
   would have been stored if this token is legitimate.

2. **Look up by hash.** `findUnique({ where: { tokenHash } })` searches the
   `PasswordResetToken` table for a row whose `tokenHash` matches. The
   `@unique` constraint on `tokenHash` means there can be at most one match.

3. **Three rejection checks.** All three conditions return null (rejection) —
   no subtle differences in response that could distinguish *why* the token
   failed:
   - `!record` — no row with this hash exists. The token is fabricated or
     already consumed by a row deletion.
   - `record.usedAt` — the row exists but `usedAt` is not null, meaning this
     token was already used once. Tokens are single-use; replay is prevented.
   - `record.expiresAt < new Date()` — the token has expired (older than
     30 minutes).

4. **Burn the token.** If all checks pass, the row's `usedAt` is set to
   `new Date()`. This is the "consume" step — the token is marked as used so
   it can't be redeemed again. The row isn't deleted (it stays for audit
   trail), but any future attempt to use this same token will hit the
   `record.usedAt` check and return null.

5. **Return the userId.** The caller now knows which user this reset was
   authorized for, without ever having to trust a user-supplied identifier —
   the token itself proves authorization.

### Step 7: Completion

Back in the confirm route, once `consumeResetToken` returns a valid `userId`:

```typescript
const passwordHash = await hashPassword(password);
await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

// Resetting your password is the account's unlock path, and — since
// whoever holds a working reset link controls the mailbox — a natural
// point to kill any sessions an attacker may have been riding on.
await clearFailedLogins(userId);
await revokeAllSessionRecords(userId);

return NextResponse.json({ message: "Password updated. You can now log in." });
```

1. **Hash the new password** with bcrypt at 12 rounds (`hashPassword` from
   `src/lib/auth/password.ts:7-9`). The raw password is never stored.

2. **Update the user row.** The `passwordHash` field is replaced with the new
   hash. The old password is now invalid — even if an attacker had the old
   hash, it no longer matches anything.

3. **Clear the lockout** by calling `clearFailedLogins(userId)`. This is the
   explicit unlock path — even if the account was locked, a successful
   password reset removes the lock so the user can log in immediately.

4. **Revoke all sessions** by calling `revokeAllSessionRecords(userId)` — this
   deletes every `Session` row for the user (`prisma.session.deleteMany`).
   This is a security-conscious extra step: if someone else had hijacked a
   session (e.g., the user logged in on a shared computer and forgot to log
   out), resetting the password kills that session remotely. The hijacker's
   next request will fail the `isSessionRecordValid` check because the
   database row no longer exists.

5. **Return success.** The response is `"Password updated. You can now log in."`.
   The user is not logged in automatically — they must go to `/login` and
   authenticate with their new password. This means the reset flow doesn't
   create a session that bypasses the normal login path.

### Step 8: Session invalidation on password reset

This codebase **does** invalidate sessions on password reset (step 7 above).
`revokeAllSessionRecords(userId)` at line 40 of the confirm route deletes every
`Session` row belonging to the user. This means:

- If the legitimate user is logged in on their phone, laptop, and desktop, all
  three sessions are killed. They'll need to log in again with the new password
  on each device.
- If a malicious actor had somehow obtained a valid session cookie (e.g., by
  physically accessing an unlocked device), that cookie becomes useless — the
  corresponding `Session` row is gone, so `isSessionRecordValid` will return
  false on the next request, and the guard code in `guards.ts:17` will attempt
  to destroy the stale cookie.

This is the correct behavior for a password reset: if the password is being
reset because the account may have been compromised, any existing sessions
should be treated as potentially illegitimate and terminated.

### Traced example: a full reset from "forgot password" to new login

Alice (`alice@example.com`, user ID `user_abc123`) has forgotten her password.

**T=0: Request.** Alice visits `/reset-password`, types her email, and submits.
The browser POSTs `{ email: "alice@example.com" }` to
`/api/auth/reset-password/request`.

- CSRF check passes.
- Rate limiter check passes (she hasn't requested a reset before).
- Input validation passes.
- `prisma.user.findUnique({ where: { email: "alice@example.com" } })` returns
  Alice's user row.
- `createResetToken("user_abc123")` runs:
  - Old unused tokens for `user_abc123` are deleted (none exist).
  - `randomBytes(32).toString("hex")` produces, say,
    `"a3f7c2d1e4b5a6f8091c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5"`.
  - A `PasswordResetToken` row is created:
    ```
    id:        "tok_xyz789"
    userId:    "user_abc123"
    tokenHash: "9f86d081..."  (SHA-256 of the token above)
    expiresAt: T+30 (30 minutes from now)
    usedAt:    null
    createdAt: T
    ```
  - The function returns the plaintext token.
- `resetUrl` becomes `"http://localhost:3000/reset-password/a3f7c2d1e4...a4b5"`.
- `sendPasswordResetEmail("alice@example.com", resetUrl)` logs the URL to
  console and (if Resend is configured) sends an email.
- Route returns `{ message: "If that email has an account, a password reset link has been sent." }`.
- Alice sees the confirmation message.

**Database state now:**
```
PasswordResetToken table:
| id         | userId       | tokenHash    | expiresAt | usedAt | createdAt |
|------------|--------------|--------------|-----------|--------|-----------|
| tok_xyz789 | user_abc123  | 9f86d081...  | T+30      | null   | T         |
```

**T+5: Click the link.** Alice opens her email (or finds the link in the
console), clicks it, and lands at `/reset-password/a3f7c2d1e4...a4b5`. The page
extracts the token from the URL and renders a form with a new-password field.
She types `"MyNewSecureP@ss1!"` (which passes the 12-character, 3-type
variety check) and submits.

The browser POSTs to `/api/auth/reset-password/confirm` with:
```json
{ "token": "a3f7c2d1e4...a4b5", "password": "MyNewSecureP@ss1!" }
```

**In the confirm route:**

1. CSRF check passes.
2. Body parsed. `confirmResetSchema` validates both fields.
3. `consumeResetToken("a3f7c2d1e4...a4b5")` runs:
   - `hashToken("a3f7c2d1e4...a4b5")` produces `"9f86d081..."`.
   - `findUnique({ where: { tokenHash: "9f86d081..." } })` finds
     `tok_xyz789`.
   - `record.usedAt` is null (not used yet) → passes.
   - `record.expiresAt` (T+30) > T+5 → not expired → passes.
   - `update({ id: "tok_xyz789", data: { usedAt: T+5 } })` — token is now
     burned.
   - Returns `"user_abc123"`.
4. `hashPassword("MyNewSecureP@ss1!")` produces a new bcrypt hash (e.g.,
   `"$2a$12$..."`).
5. `prisma.user.update({ id: "user_abc123", data: { passwordHash: "$2a$12$..." } })`
   — Alice's password is now updated.
6. `clearFailedLogins("user_abc123")` — lockout fields reset (harmless, she
   wasn't locked).
7. `revokeAllSessionRecords("user_abc123")` — any existing Session rows for
   Alice are deleted (none exist in this example, but if she had been logged
   in on another device, those sessions would be killed).
8. Returns `{ message: "Password updated. You can now log in." }`.

**Database state now:**
```
PasswordResetToken table:
| id         | userId       | tokenHash    | expiresAt | usedAt | createdAt |
|------------|--------------|--------------|-----------|--------|-----------|
| tok_xyz789 | user_abc123  | 9f86d081...  | T+30      | T+5    | T         |

User table (Alice):
| passwordHash     | failedLoginCount | lockedUntil |
|------------------|------------------|-------------|
| $2a$12$...       | 0                | null        |
```

**T+6: Log in.** Alice goes to `/login`, enters `alice@example.com` and
`MyNewSecureP@ss1!`. The login route:
- Finds her user.
- `verifyPassword("MyNewSecureP@ss1!", "$2a$12$...")` — bcrypt compares and
  returns `true`.
- `isAccountLocked` is false.
- `clearFailedLogins` runs (harmless, counters already at 0).
- A `Session` row is created: `{ userId: "user_abc123", expiresAt: T+6 + 7 days }`.
- The session cookie is set with `userId` and the new `sessionId`.
- Alice is redirected to `/dashboard`. She's in.

**If someone tries to reuse the token at T+7:**
- `consumeResetToken("a3f7c2d1e4...a4b5")` runs.
- `hashToken(...)` produces `"9f86d081..."`.
- `findUnique` finds `tok_xyz789`.
- `record.usedAt` is `T+5` (not null) → returns `null`.
- The route returns `"This reset link is invalid or has expired."`.

**If someone tries the token at T+35 (past the 30-minute expiry):**
- `consumeResetToken(...)` finds `tok_xyz789`.
- `record.usedAt` is `T+5` → this alone would reject, but even if it were
  somehow still null, `record.expiresAt (T+30) < T+35` → returns null.

### Why this approach, not an alternative

A naive reset flow might store the raw token in the database. If the database
leaked, every reset token becomes a credential that can take over any account.
This codebase hashes tokens before storage, so a database dump yields SHA-256
hashes that can't be reversed to usable tokens.

A naive reset flow might not expire tokens. A reset link from 2019 sitting in
an abandoned inbox becomes a permanent skeleton key. This codebase expires
tokens after 30 minutes.

A naive reset flow might allow token reuse (the same link works multiple times
until it expires). If a reset link is intercepted (e.g., the user forwarded the
email to someone thinking it was harmless), the interceptor could keep using it
even after the user sets a new password. This codebase marks tokens as `usedAt`
on first redemption and rejects any subsequent attempt.

A naive reset flow might not invalidate sessions on password reset. If someone
hijacked a session and the user resets their password to try to kick them out,
the hijacker would stay logged in indefinitely — the password change only
affects future logins, not existing sessions. This codebase calls
`revokeAllSessionRecords` on password reset, so every existing session is
terminated immediately.

A naive reset flow might reveal account existence by returning different
responses for "email not found" versus "email found, link sent." This codebase
returns the identical `GENERIC_MESSAGE` for all outcomes, and the email sending
(if any) happens server-side where the caller can't observe it.

A naive reset flow might not rate-limit the request endpoint, letting an
attacker spam password-reset emails to annoy a user or use the email-sending
path as a free email relay. This codebase applies a dedicated rate limiter
(`resetRequestRateLimiter`) at 5 requests per 15 minutes per IP on the request
route.
