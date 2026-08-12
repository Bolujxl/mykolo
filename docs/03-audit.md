# Koloclay Auth: Hard Audit

This document is an adversarial audit of six specific attack surfaces in the
Koloclay auth codebase. It traces real code paths as an attacker would, and
reports what it finds — whether that confirms prior claims or contradicts
them. Verdicts are derived from the current code, not from the intended
behavior described in earlier documentation stages.

Where a finding depends on runtime behavior (concurrency, network latency
profiling) rather than code logic, the confidence level states this plainly.

---

## 1. Enumeration via response timing

**The attack:** An attacker submits emails to the login, signup, and
password-reset-request endpoints and measures response times. If responses take
measurably different amounts of time depending on whether the email is
registered, the attacker can build a list of valid accounts.

**What was actually traced:**

**Login route** (`src/app/api/auth/login/route.ts`):

The login route uses a precomputed dummy hash to normalize bcrypt timing
(lines 17-20):

```typescript
// Precomputed once so a lookup for a nonexistent email still pays the cost
// of a bcrypt compare — keeps response timing from leaking whether the
// email exists in the system.
const DUMMY_HASH = bcrypt.hashSync("kolovault-timing-normalization", 12);
```

And runs bcrypt regardless of whether the user was found (lines 53-56):

```typescript
const passwordMatches = await verifyPassword(
  password,
  user?.passwordHash ?? DUMMY_HASH
);
```

However, there is a timing leak later in the same branch (lines 58-61):

```typescript
if (!user || !passwordMatches) {
  if (user) await recordFailedLogin(user.id);
  return GENERIC_INVALID;
}
```

When `user` is null (email does not exist):
- Path: `findUnique` (DB read) → bcrypt against `DUMMY_HASH` → `return GENERIC_INVALID`

When `user` exists but password is wrong (email exists):
- Path: `findUnique` (DB read) → bcrypt against real hash → `recordFailedLogin` (DB read + DB write) → `return GENERIC_INVALID`

The difference is `recordFailedLogin`, which issues two additional database
queries: a `findUnique` on the User table and an `update` (`lockout.ts:23-44`).
Each DB round-trip adds observable latency. With SQLite (local, sub-ms), this
difference is small. With a remote Postgres database (production), each query
adds 1-10ms, making the 2-extra-query difference statistically detectable over
a few hundred samples.

**Signup route** (`src/app/api/auth/signup/route.ts:27-31`):

```typescript
const existing = await prisma.user.findUnique({ where: { email } });
if (!existing) {
  const passwordHash = await hashPassword(password);
  await prisma.user.create({ data: { email, passwordHash } });
}
```

When the email is new (not registered):
- Path: `findUnique` (DB) → `hashPassword` (bcrypt at 12 rounds, ~200-300ms) → `create` (DB write) → respond

When the email already exists:
- Path: `findUnique` (DB, returns quickly) → skip the block → respond

The timing difference is **enormous** — bcrypt hashing at 12 rounds takes
200-300 milliseconds. A database `findUnique` that returns a result takes
single-digit milliseconds. An attacker needs only *one* request per email to
reliably determine whether it's registered. No statistical analysis or
sampling required — the difference is visible to a human watching a network
tab.

**Reset-request route** (`src/app/api/auth/reset-password/request/route.ts:36-42`):

```typescript
const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
if (user) {
  const token = await createResetToken(user.id);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const resetUrl = `${appUrl}/reset-password/${token}`;
  await sendPasswordResetEmail(user.email, resetUrl);
}
```

When the email exists:
- Path: `findUnique` (DB) → `createResetToken` (DB `deleteMany` + `randomBytes(32)` + DB `create`) → `sendPasswordResetEmail` → respond

When the email doesn't exist:
- Path: `findUnique` (DB, returns null) → skip the block → respond

The "email exists" path includes a token creation (crypto random generation
plus two database mutations: `deleteMany` and `create`) and an email sending
call. Even without Resend configured (the function returns immediately at
`email.ts:16`), the DB operations alone create a substantial and reliably
detectable timing difference. With Resend configured, the difference includes
an outbound network call.

**Verdict:** FAIL

**Confidence:** Confirmed by static code analysis. The branching paths are
unambiguous — different code executes depending on whether the email is
registered. Timing confirmation was reasoned from known bcrypt cost (~200-300ms
at 12 rounds) and database latency characteristics; actual millisecond
measurements were not taken, but the differences are in different orders of
magnitude (hundreds of milliseconds vs. single digits), which requires no
precise measurement to confirm.

**Severity:** High — the signup and reset-request endpoints trivially leak
account existence to anyone who can measure response times.

**Fix:**
1. **Signup:** Always run `hashPassword` and `create`, even when the user
   already exists. Hash a dummy password (same 12 rounds) and discard the
   result rather than creating a duplicate. The DB `create` call would fail on
   the unique constraint, which should be caught silently:
   ```typescript
   const passwordHash = await hashPassword(password);
   try {
     await prisma.user.create({ data: { email, passwordHash } });
   } catch (e) {
     // unique constraint — account already exists, same response either way
   }
   ```
2. **Reset request:** Always run `createResetToken` (which includes
   `deleteMany`, `randomBytes`, and `create`) against a dummy user or a
   random ID, and always call `sendPasswordResetEmail` with a no-op or dummy
   address. Alternatively, restructure so the same number of DB operations
   executes in both paths.
3. **Login:** Move `recordFailedLogin` to run after the response is sent
   (e.g., via `waitUntil` or a fire-and-forget pattern) so its timing doesn't
   leak, or always run a dummy DB operation on the "user doesn't exist" path.

---

## 2. CSRF gaps on the password reset endpoints

**The attack:** A malicious site tricks a victim's browser into making a
POST request to `/api/auth/reset-password/confirm` (the password-reset
endpoint), attempting to reset the victim's password if the victim has a
valid reset token in their URL. Without CSRF protection on this route, the
browser's stored CSRF cookie would be silently sent but the route wouldn't
check for a matching header, letting the forged request through.

**What was actually traced:**

**Reset-confirm route** (`src/app/api/auth/reset-password/confirm/route.ts:10-13`):

```typescript
export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }
```

`verifyCsrf` is the very first thing the route handler does — before parsing
the body, before validating input, before consuming the token. The check is
the same `verifyCsrf` function used by every other mutating route. It reads the
CSRF cookie from the request headers, reads the `x-csrf-token` header, and
compares them using a timing-safe comparison (`csrf.ts:86-95`).

**Reset-request route** (`src/app/api/auth/reset-password/request/route.ts:16-19`):

```typescript
export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }
```

The reset-request endpoint also checks CSRF before doing anything else.

Both endpoints are unauthenticated (the user hasn't logged in), but the CSRF
cookie is set by middleware (`src/middleware.ts:19-28`) on *every* page visit,
including the unauthenticated `/reset-password` pages. The middleware's
`config.matcher` (`src/middleware.ts:33-34`) excludes only static assets — all
page URLs get a CSRF cookie. So any visitor to any page has a valid CSRF cookie
by the time they interact with a route.

**Verdict:** PASS

**Confidence:** Confirmed by static code analysis. Both routes call
`verifyCsrf(request)` as their first operation. No code path exists that
bypasses this check.

**Severity:** N/A

---

## 3. Token entropy and expiry

**The attack:** An attacker intercepts or guesses reset tokens. If tokens are
generated from a weak source of randomness (e.g., `Math.random()`) or have too
few bits of entropy, the attacker could brute-force them within the expiry
window. If the expiry check has off-by-one or timezone bugs, expired tokens
might still be accepted. If a token can be used more than once, an attacker who
obtains a valid token (through shoulder-surfing, log leakage, or email
interception) could reuse it repeatedly.

**What was actually traced:**

**Entropy source** (`src/lib/auth/reset-token.ts:19`):

```typescript
const token = randomBytes(32).toString("hex");
```

`randomBytes` is imported from `node:crypto` (line 2), which is Node.js's
binding to the operating system's cryptographically secure random number
generator. This is not `Math.random()` — it draws from system entropy sources
(`/dev/urandom` on Linux, `CryptGenRandom` on Windows).

32 bytes = 256 bits = 2^256 possible values. A 64-character hexadecimal string.
Brute-forcing 2^256 values is computationally infeasible — even a hypothetical
computer that could try one trillion tokens per second would take far longer
than the age of the universe.

**Expiry at creation time** (`src/lib/auth/reset-token.ts:5,24`):

```typescript
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
```

Expiry is set to exactly 30 minutes from the moment `Date.now()` is called at
token creation. Both `Date.now()` and `new Date()` use UTC-based Unix
millisecond timestamps — no timezone conversion, no ambiguous local time. The
30-minute window cannot shift due to daylight saving or timezone configuration
because all arithmetic is in raw UTC milliseconds.

**Expiry at verification time** (`src/lib/auth/reset-token.ts:39`):

```typescript
if (!record || record.usedAt || record.expiresAt < new Date()) return null;
```

The check uses `<` (strict less-than), not `<=`. A token whose `expiresAt` is
exactly equal to `new Date()` is treated as expired. This is slightly stricter
than necessary but is the safe side — it errs on the side of rejecting.

No off-by-one risk: the comparison `expiresAt < new Date()` correctly rejects
tokens whose expiry moment has passed. A token created at Unix timestamp T with
expiresAt = T + 1,800,000ms will be rejected when `new Date()` >= T +
1,800,001ms. The sub-millisecond precision of the comparison makes this
accurate.

**Replay protection** (`src/lib/auth/reset-token.ts:33-47`):

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

The function checks `record.usedAt` (line 39) — if it's not null, the token was
already used. After passing all checks, it sets `usedAt` to the current
timestamp (lines 41-44). This is a read-then-write pattern, not an atomic
operation.

**Race condition on replay:** Between the `findUnique` (line 35-37, which reads
`usedAt`) and the `update` (line 41-43, which sets `usedAt`), there is a gap
where two concurrent requests for the same token could both:

1. Request A: `findUnique` → `usedAt` is null → passes the check (line 39)
2. Request B: `findUnique` → `usedAt` is null → passes the check (line 39)
   (before Request A's update commits)
3. Request A: `update` → sets `usedAt` = T1
4. Request B: `update` → sets `usedAt` = T2 (overwrites)
5. Both requests proceed to `hashPassword` + `user.update` in the confirm
   route (lines 33-34 of `confirm/route.ts`)

In a single-process Node.js server handling requests sequentially through the
event loop, the `await` on `findUnique` and `update` creates yield points where
the event loop can interleave. Two simultaneous requests hitting the same token
could both pass validation before either's update commits.

**Practical impact of replay race:** Both requests would successfully reset the
password — the second reset simply overwrites the first. The attacker can't use
this to gain persistent access (the password they set in request B gets
overwritten by request A, or vice versa). However, it means the token is not
strictly single-use under concurrent load. An attacker with a valid token and
the ability to race requests could potentially reset the password
simultaneously with the legitimate user, creating a confusing state.

**Verdict:** PASS on entropy and expiry correctness. PARTIAL on replay
protection under concurrency.

**Confidence:** Entropy and expiry — confirmed by static code analysis.
`randomBytes(32)` from `node:crypto` is cryptographically secure; expiry
arithmetic is straightforward UTC millisecond math with no timezone or
off-by-one issues. Replay race — reasoned from code structure; not confirmed
with concurrent runtime testing.

**Severity (replay race):** Low — the practical impact is that two concurrent
requests both succeed, but neither gains persistent unauthorized access. The
worst case is a confusing state where two parties both think they've set the
password.

**Fix (replay race):** Use a database-level atomic operation. With Prisma, this
means either:
- Use `updateMany` with a `where` clause that includes `usedAt: null`, then
  check the count of updated rows — if 0, the token was already consumed by a
  concurrent request.
- Use a raw SQL query with `UPDATE ... WHERE usedAt IS NULL RETURNING userId`,
  which is atomic.

The fix for the confirm route would be:
```typescript
// Replace consumeResetToken with an atomic version
const result = await prisma.passwordResetToken.updateMany({
  where: { tokenHash, usedAt: null, expiresAt: { gte: new Date() } },
  data: { usedAt: new Date() },
});
if (result.count === 0) return NextResponse.json(
  { error: "invalid_token", message: "This reset link is invalid or has expired." },
  { status: 400 }
);
```

---

## 4. Rate limiter race condition

**The attack:** An attacker sends multiple nearly-simultaneous requests from
the same IP, hoping some slip past the rate limiter because the counter hasn't
been updated by the time the next request is checked.

**What was actually traced:**

The rate limiter's `check()` method (`src/lib/auth/rate-limit.ts:28-44`):

```typescript
async check(key: string): Promise<RateLimitResult> {
  const now = Date.now();
  this.sweep(now);

  const entry = this.hits.get(key);       // Step 1: read
  if (!entry || now - entry.windowStart >= this.windowMs) {
    this.hits.set(key, { count: 1, windowStart: now });
    return { success: true, remaining: this.limit - 1, resetAt: now + this.windowMs };
  }

  entry.count += 1;                       // Step 2: increment
  const resetAt = entry.windowStart + this.windowMs;
  if (entry.count > this.limit) {         // Step 3: check
    return { success: false, remaining: 0, resetAt };
  }
  return { success: true, remaining: this.limit - entry.count, resetAt };
}
```

The method is declared `async` but contains **zero `await` expressions**. This
means the entire body executes synchronously within a single event loop tick.
The `async` keyword at line 28 makes it return a Promise, but that Promise is
resolved before the function returns because there's nothing to wait for.

In the route handler, the method is called with `await`
(e.g., `login/route.ts:33`):

```typescript
const rateLimit = await loginRateLimiter.check(ip);
```

However, because `check()` has no internal await, the `await` in the route
handler resolves immediately — it doesn't yield to the event loop. Execution
proceeds synchronously from the `check()` call into the result inspection.

In a single-process Node.js server (which is the default for `next dev` and the
standard Next.js deployment model):
- The event loop processes one request's handler at a time.
- A handler only yields to other handlers when it hits an actual `await` on an
  unresolved Promise (e.g., `await prisma.user.findUnique(...)`, `await
  fetch(...)`, `await new Promise(...)`).
- Since `check()` has no await points, Request A's call to `check()` completes
  entirely — read, increment, check, return — before Request B's handler gets
  any CPU time.
- Therefore, Request B always sees the counter as updated by Request A. No race
  condition manifests in single-process execution.

**Multi-process caveat:** In a cluster or serverless deployment where multiple
Node.js processes handle requests concurrently, the in-memory Map is not shared
across processes. This is the documented multi-instance gap (the comment at
lines 13-19 of `rate-limit.ts`), not a race condition. Each process has its own
independent counter.

**Verdict:** PASS — for single-process execution (the current deployment
model). The synchronous body with zero await points means `check()` is
effectively atomic within the event loop.

**Confidence:** Reasoned from code structure and Node.js event loop semantics.
This was NOT confirmed with actual concurrent request testing (which would
require tools like `autocannon` or `wrk` sending bursts of requests and
checking whether any exceed the limit). The reasoning is sound for
single-process Node.js, but runtime testing would provide higher confidence
for the multi-process case.

**Severity:** N/A (PASS)

---

## 5. What happens when the email service fails

**The attack:** An attacker submits a password-reset request for a known email
address. If the email service fails, does the server's behavior change in a way
that reveals internal state — a different response message, a different status
code, a stack trace, or the raw reset token in an error?

**What was actually traced:**

**Email sending function** (`src/lib/email.ts`):

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

Three distinct failure/configuration modes and their behavior:

**Mode 1 — Resend not configured (`resend` is null):**
- Line 14: `console.log(...)` — prints the raw reset URL (including the
  plaintext token) to the server console.
- Line 16: `if (!resend) return;` — function returns immediately. No error.
- Back in the reset request route (`request/route.ts:41`): `await
  sendPasswordResetEmail(...)` resolves immediately.
- Line 44: `return NextResponse.json(GENERIC_MESSAGE)` — identical to the
  success case.
- **The token was already created and stored** at line 38 of the request
  route (`const token = await createResetToken(user.id)`). The token exists
  in the `PasswordResetToken` table (hashed) and will expire in 30 minutes.
  The user never received it. The attacker receives the generic message and
  cannot tell the email wasn't sent.

**Mode 2 — Resend configured, send succeeds:**
- Same `console.log` at line 14 (the URL is still logged).
- Resend sends the email.
- The function returns normally. Response is `GENERIC_MESSAGE`.

**Mode 3 — Resend configured, send fails (network error, API error, etc.):**
- Same `console.log` at line 14 — still prints the raw reset URL.
- `resend.emails.send(...)` throws.
- `catch` at line 29 catches the error.
- `console.error(...)` at line 30 logs the error object to the server console.
- Function returns void (not throwing). No error propagates to the caller.
- Back in the request route: `sendPasswordResetEmail(...)` resolves normally.
- Response is `GENERIC_MESSAGE` — identical to all other outcomes.
- The token is still in the database. The user never received the email.

The user-facing response is identical across all three modes. The status code
is always 200, the message is always the generic `GENERIC_MESSAGE`. The
attacker cannot distinguish whether the email was sent or failed.

**Critical finding — raw token in server logs:**

Line 14:
```typescript
console.log(`[kolovault] Password reset link for ${email}: ${resetUrl}`);
```

The `resetUrl` contains the unhashed, plaintext reset token. This line fires
**unconditionally** — it is not gated by a development-mode check, an
environment variable, or any conditional. In production, this means:
- Every password reset request that hits a real email address logs the full
  reset URL (including the raw 64-character hex token) to the deployment
  platform's log system (Vercel logs, CloudWatch, Datadog, etc.).
- Anyone with access to those logs — platform operators, team members with log
  access, anyone who gains access to a log aggregation service — can see and
  use any reset token that hasn't expired yet.
- The comment next to the log call says "costs nothing to keep" — this is
  incorrect for production. The cost is a persistent plaintext record of every
  reset token generated, stored outside the database's hashing protection,
  accessible to anyone with log read access.

The token is hashed in the database (SHA-256, `reset-token.ts:7-8`), which
means a database compromise doesn't expose usable tokens. But the console log
bypasses this protection entirely — the raw token is written to a different
system (logs) without hashing.

**Additional concern — token creation order:**

In the reset request route (`request/route.ts:37-42`):

```typescript
if (user) {
  const token = await createResetToken(user.id);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const resetUrl = `${appUrl}/reset-password/${token}`;
  await sendPasswordResetEmail(user.email, resetUrl);
}
```

The token is created (line 38) *before* the email is sent (line 41). If the
email fails, the token still exists in the database. The user never receives
it, but the token is valid for 30 minutes. If the attacker can somehow obtain
the token (e.g., from server logs — see above), they can use it to reset the
password without the user ever having seen the email.

Reversing the order — sending the email first, then creating the token — is not
trivially correct either (the token must exist before it can be embedded in the
email URL). The better approach is to create the token, send the email, and
if the send fails, delete the token. Currently, the token persists in the
database regardless of email delivery status.

**Verdict:** FAIL — the unconditional `console.log` on line 14 of `email.ts`
prints the raw (unhashed) reset token to server logs, bypassing the database's
hashing protection. This is the most concrete security finding in this audit.

**Confidence:** Confirmed by static code analysis. The `console.log` has no
conditional guard and is not behind a development-only check. The token is
emitted in plaintext.

**Severity:** Critical — raw reset tokens are persisted in server logs. If
those logs are compromised, every password reset token generated is a live
account-takeover credential. The severity is elevated because this is not a
theoretical timing side channel requiring statistical analysis — it's a direct,
readable output of the raw secret.

**Fix:**
1. **Remove the `console.log` line entirely, or gate it behind a development
   check:**
   ```typescript
   if (process.env.NODE_ENV !== "production") {
     console.log(`[kolovault] Password reset link for ${email}: ${resetUrl}`);
   }
   ```
   For local development, the developer can find the link in the terminal. In
   production, the log is suppressed.

2. **Delete the token if email delivery fails:**
   ```typescript
   const token = await createResetToken(user.id);
   const resetUrl = `${appUrl}/reset-password/${token}`;
   try {
     await sendPasswordResetEmail(user.email, resetUrl);
   } catch {
     // Email failed — clean up the token so it can't be used
     await prisma.passwordResetToken.deleteMany({ where: { userId, usedAt: null } });
   }
   ```

3. **Consider not creating the token until email delivery is confirmed**
   (harder to implement correctly since the token must be in the email URL).

---

## 6. Any place an error message leaks information

**The attack:** An attacker systematically probes every endpoint with malformed
and edge-case inputs, looking for error responses that differ in a useful way
— different messages for different internal states (email exists vs. doesn't,
account locked vs. wrong password), raw internal field names, stack traces,
validation rule details that reveal the schema.

**What was actually traced:**

**Login route** (`src/app/api/auth/login/route.ts`):

The login route uses hardcoded messages throughout:
- Line 29: CSRF fail → `"Invalid request."` 403
- Line 36: Rate limited → `"Too many login attempts."` 429 — reveals rate
  limiting is active and the threshold has been hit. Pragmatic UX trade-off
  (standard HTTP 429) but distinguishable from credential failure.
- Line 45: Invalid input → `"Invalid email or password."` 400 — **hardcoded
  generic** — does NOT expose Zod validation details, unlike the signup route.
  This is the correct approach.
- Line 23: Invalid credentials → `"Invalid email or password."` 401 — generic.
  Same message used for "email not found" and "password wrong."
- Lines 69-72: Account locked → `"Too many failed attempts. Your account is
  locked for X more minute(s)..."` 403 — reveals lockout state and remaining
  duration. Gates this behind correct password verification (line 66), so an
  attacker must already know the password to see this message.

**Signup route** (`src/app/api/auth/signup/route.ts:19-22`):

```typescript
if (!parsed.success) {
  return NextResponse.json(
    { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    { status: 400 }
  );
}
```

This **exposes raw Zod validation messages** to the client. The messages will
include:
- `"Enter a valid email address."` — from `emailSchema` (`schemas.ts:8`)
- `"Password must be at least 12 characters long."` — from
  `passwordSchema.min(12, ...)` (`password.ts:22`)
- `"Password must mix at least 3 of: lowercase, uppercase, numbers,
  symbols."` — from `passwordSchema.refine(...)` (`password.ts:33`)
- `"Password is too long."` — from `passwordSchema.max(256, ...)`
  (`password.ts:23`)

Revealing the password policy is low severity (it's public information in most
systems, and attackers can discover it by trial and error), but it is
inconsistent with the generic-error principle that the codebase otherwise
follows. The login route demonstrates the correct pattern (hardcoded generic
message at line 45), but the signup route does not.

**Reset-confirm route** (`src/app/api/auth/reset-password/confirm/route.ts:18-21`):

```typescript
if (!parsed.success) {
  return NextResponse.json(
    { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    { status: 400 }
  );
}
```

Same pattern — exposes raw Zod messages. A bad password gets the detailed
policy violation message; a missing token gets `"String must contain at least
1 character(s)."` These are not secret, but they're more detail than the
generic-error principle calls for.

**Entry and goal routes:**
- `entries/route.ts:21`: `parsed.error.issues[0]?.message ?? "Invalid input."`
- `goal/route.ts:21`: same pattern.

These expose Zod messages for business data (`"Amount must be greater than
zero."`, `"Amount is too large."`, etc.). This is appropriate UX — telling a
user their entry amount is negative or too large is useful information, not
a security leak. The user is already authenticated when these routes are hit.

**HTTP status code differences as information leaks:**

An attacker can distinguish several internal states purely by HTTP status code
without reading the body at all:

| Status | Endpoint | Meaning |
|--------|----------|---------|
| 403 | Login | CSRF check failed |
| 403 | Login | Account locked (requires correct password first, so non-leaking) |
| 429 | Login | Rate limited (reveals threshold hit) |
| 400 | Login | Invalid input format |
| 401 | Login | Invalid credentials (email not found OR password wrong — no distinction) |
| 200 | Login | Success |

The login route's status codes differentiate between: CSRF failure, rate
limiting, invalid input format, and invalid credentials. An attacker can
determine whether their input format is wrong (400) or their credentials are
wrong (401), and whether they've hit the rate limit (429). The credential
failure (401) does not distinguish "email not found" from "password
wrong" — that is the critical boundary, and it holds.

**console.log / console.error audit:**

Two `console` calls exist in auth-related code:
1. `email.ts:14`: `console.log(...)` — prints raw reset token. Covered in
   Audit #5. CRITICAL.
2. `email.ts:30`: `console.error(...)` — prints Resend error to server logs.
   If Resend's error response includes the email address or other PII, that
   data appears in logs. Low severity (server-side only, but avoidable).

No other `console.log` or `console.error` calls exist in the auth directory or
the auth route handlers.

**Zod schema structure exposure:**

The `emailSchema` (`schemas.ts:4-9`) applies `.trim()` and `.toLowerCase()`
before validation. A client-side validation error from Zod might reveal these
transformations, but only the validation message is sent (`issues[0].message`),
not the full schema definition. No internal field names or database column
names appear in error responses.

**Verdict:** PARTIAL

**Confidence:** Confirmed by static code analysis. Every error path in every
auth route was traced. The console.log token exposure is a separate finding
covered in Audit #5.

**Severity:** Medium — the primary issue is the inconsistent use of Zod error
messages in signup and reset-confirm routes (low individual severity) combined
with the distinguishable HTTP status codes that reveal rate-limit and CSRF
states (low individual severity). Together, they give an attacker more signal
than the generic-error principle intends.

**Fix:**
1. **Signup route line 19-22:** Replace Zod message exposure with a hardcoded
   generic message, matching the login route's pattern:
   ```typescript
   if (!parsed.success) {
     return NextResponse.json(
       { error: "invalid_input", message: "Invalid email or password." },
       { status: 400 }
     );
   }
   ```
   The client-side password strength meter (`PasswordStrengthMeter.tsx`)
   already provides real-time UX feedback on password requirements; the server
   doesn't need to echo them.

2. **Reset-confirm route lines 18-21:** Same fix — use a hardcoded message
   rather than `parsed.error.issues[0]?.message`.

3. **Consider masking the rate-limit 429 response** by returning a 401 or 400
   with a generic message instead of the distinct 429 status and
   "Too many login attempts" message. This is a UX trade-off — a legitimate
   user benefits from knowing they're rate-limited rather than thinking their
   password is wrong. The current approach is defensible but worth noting as
   a deliberate choice to leak rather than an oversight.

---

## Summary

| # | Area | Verdict | Severity |
|---|------|---------|----------|
| 1 | Enumeration via timing | FAIL | High |
| 2 | CSRF on reset endpoints | PASS | — |
| 3 | Token entropy & expiry | PARTIAL | Low |
| 4 | Rate limiter race condition | PASS | — |
| 5 | Email service failure handling | FAIL | Critical |
| 6 | Error message leaks (general) | PARTIAL | Medium |
