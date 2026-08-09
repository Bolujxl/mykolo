# Koloclay Auth: Principles Map

This document maps real code from the Koloclay codebase to six named security
principles. Each section defines the principle in plain language, shows
concrete code references that demonstrate it (or fail to), and honestly notes
where the implementation is partial. The point is to be able to point at a
file, a function, and a specific line and say "this is here because of this
principle" — not to describe the principle in the abstract with generic
examples that could apply to any project.

---

## Least privilege

**Definition:** Every piece of code should have access to only the data and
operations it actually needs to do its job, and nothing more. If a function
only needs to know a user's ID to create an entry, it shouldn't also have
access to their password hash, email, or lockout state.

**Why it matters:** The wider the access, the more damage one compromised piece
of code can do. If every route handler receives the full user object including
the password hash, a bug in an innocent-looking entry-creation function could
accidentally leak password hashes in a response or log message. The principle
caps the blast radius of any single mistake.

**In this codebase:**

- `src/lib/auth/session.ts:5-12` — The session data interface only stores the
  bare minimum needed to identify a user and validate their session:

  ```typescript
  export interface SessionData {
    userId?: string;
    sessionId?: string;
  }
  ```

  The session cookie does not contain the user's email, password hash, role, or
  any other profile data. All it holds is a `userId` (a database ID, useless on
  its own without the corresponding `User` row) and a `sessionId` (a row
  pointer into the `Session` table). Even if the encrypted cookie were somehow
  decrypted, the attacker gets nothing but opaque identifiers — no credentials,
  no personal information. The actual user data stays server-side in the
  database, fetched on demand per request.

- `src/app/api/entries/route.ts:26-34` — The entry-creation route only uses the
  `userId` extracted by the auth guard, never pulling or touching any other
  user field:

  ```typescript
  const { amount, note, date } = parsed.data;
  const entry = await prisma.entry.create({
    data: {
      userId: auth.userId,
      amountCents: Math.round(amount * 100),
      note: note || null,
      date,
    },
  });
  ```

  The route receives `auth.userId` (just a string) from `requireAuthApi()`
  (`src/lib/auth/guards.ts:43-45`). It never queries the `User` table, never
  reads the user's email, goal, or password hash. It only needs to associate an
  entry with a user, and that's all it does.

- `src/app/api/entries/[id]/route.ts:20-22` — The entry-deletion route verifies
  ownership using the authenticated user's ID before deleting, without ever
  pulling the user record:

  ```typescript
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== auth.userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  ```

  The check `entry.userId !== auth.userId` confirms that the entry belongs to
  the authenticated user. The route doesn't query the `User` table at all —
  the only thing it needs to know is "does this entry belong to the person
  making the request," and it answers that with a single `findUnique` on the
  `Entry` table plus a string comparison.

**Gaps or partial adherence:**

- **Server Component full-user fetches.** The dashboard page
  (`src/app/dashboard/page.tsx:17`) calls
  `prisma.user.findUniqueOrThrow({ where: { id: userId } })` without a
  `select` clause, pulling every field on the `User` row — including
  `passwordHash`, `failedLoginCount`, `firstFailedLoginAt`, `lockedUntil`,
  `createdAt`, and `updatedAt` — even though it only uses `goalAmountCents`.
  The settings page (`src/app/settings/page.tsx:12`) does the same, using only
  `email` and `goalAmountCents`. These are server-side renders (the password
  hash never reaches the browser), but within the server process, unnecessary
  fields are in scope. Adding `select: { goalAmountCents: true, email: true }`
  would align these with the principle.

- **The login route's user query.** `src/app/api/auth/login/route.ts:51` does
  `prisma.user.findUnique({ where: { email } })` without a `select`. This
  particular case is less of a gap in practice — the login route genuinely
  needs `passwordHash`, `lockedUntil`, `failedLoginCount`,
  `firstFailedLoginAt`, and `id`, and the remaining fields (`email`,
  `goalAmountCents`, `createdAt`, `updatedAt`) are a handful of harmless extras.
  Still, explicitly selecting only the needed fields would be more precise.

- **`getClientIp` fallback.** When no proxy headers are present,
  `src/lib/auth/rate-limit.ts:74` returns the string `"unknown"`. All requests
  that can't be associated with an IP share a single rate-limit bucket. This is
  more generous than least privilege would prescribe — an attacker without
  proper headers could crowd out legitimate internal requests that also fall
  into the same bucket. In practice, virtually all production traffic arrives
  through a reverse proxy that sets `x-forwarded-for`, so this is a dev-scope
  concern rather than a deploy-time vulnerability.

---

## Defense in depth

**Definition:** Stacking multiple independent security layers so that if one
fails or is bypassed, others are still standing. The idea isn't one
impenetrable wall — it's that an attacker has to clear several different
obstacles, each of which works differently and protects against different
threats.

**Why it matters:** Every mechanism has weak points — rate limiting doesn't
help against distributed attacks, lockout doesn't help if the attacker already
knows the password, hashing doesn't help against an active brute-force if the
service doesn't throttle requests. No single layer is sufficient alone; the
defense is in the combination.

**In this codebase:**

Koloclay stacks these independent layers against a credential-guessing
attacker. If an attacker evades any one of them, the next is still in their
way:

1. **Rate limiting by IP** — `src/lib/auth/rate-limit.ts:55-58`: 5 login
   attempts per IP per 15 minutes. Stops one source from sending thousands of
   guesses:

   ```typescript
   export const loginRateLimiter: RateLimiter = new InMemoryRateLimiter(
     5,
     15 * 60 * 1000
   );
   ```

   If the attacker rotates IPs (distributed attack), this layer is neutralized.

2. **Account lockout by user** — `src/lib/auth/lockout.ts:5-7`: 10 failed
   attempts within a rolling hour triggers a 1-hour lock. This catches what
   rate limiting misses — many IPs attacking one account:

   ```typescript
   export const LOCKOUT_THRESHOLD = 10;
   export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000;
   export const LOCKOUT_DURATION_MS = 60 * 60 * 1000;
   ```

   If the attacker already knows the password (not guessing), this layer is
   irrelevant — but that attacker now faces the next layer.

3. **Password strength requirements** — `src/lib/auth/password.ts:20-33`: 12
   characters minimum, requiring at least 3 of lowercase, uppercase, digit,
   and symbol categories. Makes the password itself resistant to brute-force
   even if all server-side throttling is bypassed:

   ```typescript
   export const passwordSchema = z
     .string()
     .min(12, "Password must be at least 12 characters long.")
     .max(256, "Password is too long.")
     .refine((value) => {
       const varietyChecks = [
         /[a-z]/.test(value),
         /[A-Z]/.test(value),
         /[0-9]/.test(value),
         /[^a-zA-Z0-9]/.test(value),
       ];
       const varietyCount = varietyChecks.filter(Boolean).length;
       return varietyCount >= 3;
     }, "Password must mix at least 3 of: lowercase, uppercase, numbers, symbols.");
   ```

4. **bcrypt hashing at 12 rounds** — `src/lib/auth/password.ts:5-9`: if the
   database is somehow read by an attacker, the stored password hashes are
   computationally expensive to crack. bcrypt is intentionally slow — each
   guess takes real wall-clock time, not microseconds:

   ```typescript
   const BCRYPT_ROUNDS = 12;

   export async function hashPassword(password: string): Promise<string> {
     return bcrypt.hash(password, BCRYPT_ROUNDS);
   }
   ```

5. **CSRF protection** — `src/lib/auth/csrf.ts`: a signed double-submit cookie
   prevents cross-site request forgery even if the attacker knows the victim is
   logged into Koloclay. The CSRF token in the cookie is signed with HMAC, so
   while the browser sends the cookie on cross-site requests, a malicious site
   can't read it (same-origin policy) to produce the matching header:

   ```typescript
   export async function verifyCsrf(request: Request): Promise<boolean> {
     const cookieValue = readCookie(request.headers.get("cookie") ?? "", CSRF_COOKIE);
     const headerToken = request.headers.get(CSRF_HEADER);
     if (!cookieValue || !headerToken) return false;

     const validToken = await verifyCsrfCookieValue(cookieValue);
     if (!validToken) return false;

     return timingSafeEqual(validToken, headerToken);
   }
   ```

   This is enforced on every mutating route — every `POST`, `PUT`, `PATCH`, and
   `DELETE` handler in the app begins with `if (!(await verifyCsrf(request)))`.

6. **Session registry with server-side revocation** —
   `src/lib/auth/sessions.ts:18-29`: the session cookie alone is not enough to
   authenticate. Every request re-validates that the session's database row
   still exists and hasn't expired. This means "log out everywhere" genuinely
   terminates all sessions server-side — deleting the rows makes all
   corresponding cookies inert:

   ```typescript
   export async function isSessionRecordValid(
     sessionId: string,
     userId: string
   ): Promise<boolean> {
     const record = await prisma.session.findUnique({ where: { id: sessionId } });
     if (!record || record.userId !== userId) return false;
     if (record.expiresAt < new Date()) {
       await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
       return false;
     }
     return true;
   }
   ```

7. **Session cookie flags** — `src/lib/auth/session.ts:26-32`: the session
   cookie is set with `httpOnly: true` (JavaScript can't read it, so XSS can't
   steal it), `sameSite: "lax"` (browsers won't send it on cross-site POSTs,
   mitigating CSRF at the cookie level), and `secure: true` in production
   (browsers only send it over HTTPS):

   ```typescript
   cookieOptions: {
     httpOnly: true,
     secure: process.env.NODE_ENV === "production",
     sameSite: "lax" as const,
     maxAge: SESSION_TTL_SECONDS,
     path: "/",
   },
   ```

**Why these are genuinely independent:** If rate limiting is evaded (rotating
IPs), lockout still catches repeated failures on one account. If lockout is
bypassed (attacker already knows the password), CSRF and session validation
prevent unauthorized actions. If CSRF is circumvented (a browser bug in
same-origin enforcement), the session registry still allows remote revocation.
If the database is stolen, bcrypt rounds make the hashes costly to crack. Each
layer addresses a different vector; no single breakthrough defeats the whole
system.

**Gaps or partial adherence:**

- **In-memory rate limiter in multi-instance deployments.** The rate limiter's
  counters live in process memory (`src/lib/auth/rate-limit.ts:21`). In a
  serverless deployment where each function instance has its own isolated
  memory, the rate-limiting layer evaporates — an attacker's requests spread
  across instances get independent counters. This is the most significant gap
  in the depth stack: the outermost layer (rate limiting) weakens to near-zero
  in a multi-instance production environment. Until this is backed by a shared
  store (Redis), the effective defense depth drops from seven layers to six in
  production.

- **No second factor.** There is no multi-factor authentication layer. If an
  attacker has both the email and the password, nothing further stops them.
  This is a scope decision for the current build, not an oversight, but it
  means the depth chain has no step past "something you know."

---

## Fail securely

**Definition:** When something goes wrong — an exception, a missing value, an
unexpected state, a timeout — the system should default to the *safe* outcome
(deny access, reject the request, invalidate the token) rather than
accidentally falling through to the *permissive* outcome. A system that
"fails open" when an error occurs is a system that grants access whenever
something breaks.

**Why it matters:** Errors and edge cases are inevitable — network timeouts,
corrupted cookies, null values from a database migration, race conditions.
If the code treats a missing check result the same as a passing check, every
unhandled exception becomes a bypass. Fail-secure design ensures that bugs and
unexpected conditions create denials, not unauthorized access.

**In this codebase:**

- `src/app/api/auth/login/route.ts:53-56` — When no user is found for a given
  email, the password verification still runs against a precomputed dummy hash
  instead of short-circuiting. This means the computational cost (and response
  timing) is identical whether the email exists or not. If the code instead did
  `if (!user) return GENERIC_INVALID` without running bcrypt, an attacker could
  measure the response time to determine whether an email was registered:

  ```typescript
  const passwordMatches = await verifyPassword(
    password,
    user?.passwordHash ?? DUMMY_HASH
  );
  ```

  The safe fallback (`user?.passwordHash ?? DUMMY_HASH`) ensures that the
  "user not found" path is not observably faster than the "user found, password
  wrong" path.

- `src/lib/auth/reset-token.ts:33-47` — `consumeResetToken` returns `null`
  (failure) for *any* invalid state — missing record, already-used token,
  expired token. The function never throws, never returns undefined, never
  distinguishes between these failure modes. A caller that forgets to check
  the return value gets `null` for userId, which downstream code can't
  accidentally treat as a valid user:

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

  Three distinct rejection conditions all produce the same result (`null`). No
  error type leaks which check failed.

- `src/lib/auth/sessions.ts:18-29` — `isSessionRecordValid` treats an expired
  session as invalid, but it also *deletes* the expired row instead of leaving
  it in the database. This means an expired session can't be accidentally
  re-validated later by a code change that relaxes the expiry check — the row
  is gone:

  ```typescript
  if (record.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return false;
  }
  ```

  The `.catch(() => {})` on the delete is itself a fail-safe: if the database
  is unavailable during the deletion, the function still returns `false`
  (denying access) rather than crashing or hanging.

- `src/lib/auth/guards.ts:11-22` — When a session is found to be invalid (the
  session registry row is gone or expired), the guard attempts to destroy the
  stale cookie. If that destruction fails (because the code is running in a
  Server Component context where cookie mutation isn't allowed), it catches the
  error and continues — returning `null` (not authenticated) rather than
  throwing an unhandled exception:

  ```typescript
  if (!valid) {
    try {
      session.destroy();
    } catch {
      // ignore — not in a context that allows cookie mutation
    }
    return null;
  }
  ```

  The system always lands on "not authenticated" regardless of whether the
  cookie cleanup succeeded.

- `src/lib/auth/lockout.ts:9-11` — `isAccountLocked` returns `false` (not
  locked) when `lockedUntil` is `null` (the account was never locked) *and*
  when `lockedUntil` is in the past (the lock expired). There is no separate
  "lock expired" cleanup step that could fail and leave an account
  permanently locked. The check naturally ages out:

  ```typescript
  export function isAccountLocked(user: Pick<User, "lockedUntil">): boolean {
    return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
  }
  ```

**Gaps or partial adherence:**

- **Rate limiter error handling is implicit.** The `InMemoryRateLimiter.check()`
  method (`src/lib/auth/rate-limit.ts:28-44`) has no try/catch and no explicit
  error path. If the Map operations somehow threw (extremely unlikely for a
  synchronous in-memory Map, but not formally impossible), the exception would
  propagate uncaught to the route handler. The route handler at line 33 of the
  login route calls `await loginRateLimiter.check(ip)` without a try/catch. If
  this threw, the login route would return a 500 error rather than silently
  allowing the request — so the *outcome* is still a denial (fail-secure), but
  the error is unhandled rather than explicitly caught and logged. In a
  production system, a failed rate-limit check should produce a specific
  logged warning so operators know the protection layer is down.

- **`getClientIp` fallback to `"unknown"`.** `src/lib/auth/rate-limit.ts:74`
  returns the literal string `"unknown"` when no proxy headers are present.
  This silently collapses all un-IP-able traffic into one bucket. The system
  doesn't log or warn that IP extraction failed — it just proceeds as if
  everything is normal. A fail-secure approach to IP extraction might log a
  warning and consider whether to apply a strict default policy
  (e.g., blocking requests without identifiable IPs, or at minimum logging
  the condition so operators notice if their proxy configuration breaks).

---

## Generic errors

**Definition:** When an operation fails, the error message sent to the caller
should not reveal *why* it failed in a way that helps an attacker map the
system. "Invalid email or password" is generic; "That email is not registered"
or "The password is incorrect" or "That account is locked" leaks information
that an attacker can use to enumerate valid accounts, confirm guessed
passwords, or map the system's internal state.

**Why it matters:** Attackers probe systems by observing responses. If the
server volunteers different error messages for "email not found" versus
"password wrong," an attacker can first build a list of valid emails (by
submitting addresses until they stop getting "email not found"), then attack
only those with password guesses. Generic errors make every failed attempt look
identical from the outside, giving the attacker no signal to refine their
approach.

**In this codebase:**

- `src/app/api/auth/login/route.ts:22-25` — The constant returned for all
  credential failures (wrong email, wrong password, or both):

  ```typescript
  const GENERIC_INVALID = NextResponse.json(
    { error: "invalid_credentials", message: "Invalid email or password." },
    { status: 401 }
  );
  ```

  This is returned at line 60 for *every* case where the credentials don't
  match — nonexistent email, existing email with wrong password, both. No
  distinction. The error code `invalid_credentials` is identical in all cases;
  the message `"Invalid email or password."` is identical; the HTTP status 401
  is identical.

- `src/app/api/auth/login/route.ts:20` — A precomputed bcrypt hash is used as a
  timing normalization constant. When the email doesn't exist, the server still
  runs a full bcrypt comparison against this dummy value, making the response
  time indistinguishable from the case where the email exists but the password
  is wrong:

  ```typescript
  const DUMMY_HASH = bcrypt.hashSync("koloclay-timing-normalization", 12);
  ```

  Without this, an attacker could measure response times: a fast rejection
  (email lookup returned nothing → skip bcrypt → respond) versus a slow
  rejection (email found → run bcrypt → respond) would reveal which emails
  exist. The dummy hash forces both paths to take the same time.

- `src/app/api/auth/signup/route.ts:33-35` — Signup returns the identical
  response whether the email was new (account created) or already registered
  (silently skipped). An attacker can't use the signup endpoint to check
  whether an email is already in use:

  ```typescript
  return NextResponse.json({
    message: "If that email can be used to create an account, it now has one. Log in to continue.",
  });
  ```

  Even the message's phrasing ("If that email can be used...") is deliberately
  conditional — it doesn't confirm that an account was created, only that if
  it *could* have been, it was.

- `src/app/api/auth/reset-password/request/route.ts:9-11` — The password-reset
  request endpoint uses a shared constant for all outcomes:

  ```typescript
  const GENERIC_MESSAGE = {
    message: "If that email has an account, a password reset link has been sent.",
  };
  ```

  This is returned at line 44 regardless of whether `user` was found (line 36)
  and regardless of whether an email was actually sent (line 41). The
  conditional block at lines 37-42 — token creation, URL construction, email
  sending — all happen as server-side side effects invisible to the caller. No
  response timing difference leaks whether the block ran.

- `src/app/api/auth/login/route.ts:66-76` — The lockout message is only
  returned *after* the password has been confirmed correct. An attacker who
  submits a random password gets `GENERIC_INVALID` even against a locked
  account. Only someone who already knows the password learns that the account
  is locked:

  ```typescript
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
  ```

  The comment at lines 63-65 explicitly documents this as a deliberate oracle
  prevention: "otherwise an attacker guessing emails could use the lockout
  message itself as an oracle for which addresses have accounts."

- `src/app/api/entries/[id]/route.ts:20-22` — The entry-deletion route returns
  `"not_found"` (404) for both "the entry doesn't exist" and "the entry exists
  but belongs to a different user." An attacker can't use the delete endpoint
  to probe whether specific entry IDs exist in the system:

  ```typescript
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== auth.userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  ```

  The check collapses two distinct conditions (nonexistent entry, wrong
  ownership) into one response. Even returning a 403 for the ownership case
  would leak that the entry ID *exists* — it just belongs to someone else. The
  404 path avoids that leak.

**Gaps or partial adherence:**

- **Rate-limiting response explicitly announces the mechanism.**
  `src/app/api/auth/login/route.ts:36` returns
  `"Too many login attempts. Try again later."` with a 429 status. While this
  doesn't leak anything about the account or the credentials, it does confirm
  to the attacker that rate limiting is active and that they've hit its
  threshold. This is a pragmatic trade-off (a 429 is semantically correct HTTP,
  and the retry instruction is useful to a legitimate user), but it does give
  the attacker a signal about the defense mechanism's configuration. An even
  more generic approach would return the same 401/400 as a normal failure after
  the threshold. However, blocking a legitimate user with no indication of
  *why* is poor UX, and a 429 is the standard HTTP status for this scenario.

- **Lockout message includes remaining time.** At line 70 of the login route,
  the lockout message tells the user exactly how many minutes remain. This is
  useful UX for a legitimate locked-out user, but it also reveals the lockout
  duration to anyone who knows the password — an attacker who has guessed the
  password and hits a lockout now knows exactly when to return. The trade-off
  is documented by the project's overall posture favoring user-friendly unlock
  paths. This is deliberate, not an oversight, but it's an information leak the
  codebase consciously accepts.

---

## Secure defaults

**Definition:** The safe behavior should be what happens automatically, without
requiring extra configuration, a conscious opt-in, or that someone remember to
flip a switch. If a developer adds a new route and forgets to think about
security at all, the default should still protect them.

**Why it matters:** Security that depends on remembering to enable it is
security that gets forgotten. Every new route handler, every new server action,
every new page is a potential gap — unless the framework or architecture
defaults to secure and requires explicit effort to be unsafe.

**In this codebase:**

- `src/lib/auth/session.ts:26-32` — The session cookie is created with four
  secure flags by default. No route or developer opting in — every session
  cookie gets these automatically:

  ```typescript
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  },
  ```

  - `httpOnly: true` — the cookie is invisible to JavaScript. An XSS injection
    can't read it.
  - `secure: process.env.NODE_ENV === "production"` — in production, the
    cookie is only sent over HTTPS. In development (localhost over HTTP), the
    flag is relaxed so the app works, but only where an attacker can't
    realistically intercept localhost traffic.
  - `sameSite: "lax"` — the browser won't attach this cookie to cross-site
    POST requests, providing a built-in CSRF defense at the browser level.
  - `path: "/"` — the cookie is available for all routes, so the session
    persists across pages.

  All of these are set unconditionally in the shared `sessionOptions` object.
  No per-route configuration is needed.

- `src/middleware.ts:13-31` — The CSRF cookie is auto-generated on every
  request where one doesn't already exist or where the existing one's signature
  is invalid. This runs in middleware (before any route handler), so every page
  and every API route benefits from CSRF protection without any explicit
  per-route setup:

  ```typescript
  export async function middleware(request: NextRequest) {
    const response = NextResponse.next();

    const existing = request.cookies.get(CSRF_COOKIE)?.value;
    const validToken = existing ? await verifyCsrfCookieValue(existing) : null;

    if (!validToken) {
      const value = await generateCsrfCookieValue();
      response.cookies.set(CSRF_COOKIE, value, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
    }

    return response;
  }
  ```

  The `config.matcher` at lines 33-34 covers all routes except static assets
  and the favicon. A new route added to the app automatically gets a CSRF
  cookie — the developer doesn't need to register it anywhere.
  The cookie is `httpOnly: false` deliberately so client-side JavaScript can
  read the token to echo it back as a header on fetch requests (the
  double-submit pattern). What makes this safe despite being JS-readable is the
  HMAC signature: a cross-site attacker can't read the cookie value to compute
  the matching header.

- `src/lib/auth/password.ts:20-33` — The password validation schema is applied
  unconditionally. Minimum 12 characters, at least 3 of 4 character categories.
  A developer creating a new form that accepts passwords can't accidentally
  skip these rules unless they explicitly bypass the shared `passwordSchema`:

  ```typescript
  export const passwordSchema = z
    .string()
    .min(12, "Password must be at least 12 characters long.")
    .max(256, "Password is too long.")
    .refine((value) => {
      const varietyChecks = [
        /[a-z]/.test(value),
        /[A-Z]/.test(value),
        /[0-9]/.test(value),
        /[^a-zA-Z0-9]/.test(value),
      ];
      const varietyCount = varietyChecks.filter(Boolean).length;
      return varietyCount >= 3;
    }, "Password must mix at least 3 of: lowercase, uppercase, numbers, symbols.");
  ```

  The `signupSchema` (`schemas.ts:11-14`) and `confirmResetSchema`
  (`schemas.ts:25-28`) both reference this shared `passwordSchema` rather than
  redefining password rules. A new schema that needs password validation would
  import and reuse it, staying consistent by default.

- `src/lib/auth/guards.ts:6-25` — The `getValidatedSession()` function not only
  checks the cookie but also validates the session registry row. Sessions can't
  just *exist* — they must have a live database row, which means "log out
  everywhere" genuinely revokes them. This dual validation is automatic for
  every call to `requireAuth()`, `requireGuest()`, and `requireAuthApi()`:

  ```typescript
  async function getValidatedSession() {
    const session = await getSession();
    if (!session.userId || !session.sessionId) return null;

    const valid = await isSessionRecordValid(session.sessionId, session.userId);
    if (!valid) {
      try {
        session.destroy();
      } catch {
        // ignore — not in a context that allows cookie mutation
      }
      return null;
    }

    return { session, userId: session.userId };
  }
  ```

**Gaps or partial adherence:**

- **CSRF token read by client JS.** `src/middleware.ts:22` sets
  `httpOnly: false` on the CSRF cookie so that `src/lib/csrf-client.ts:7-14`
  can read it from `document.cookie`. This is necessary for the double-submit
  cookie pattern, but it does create a surface that wouldn't exist if the token
  were injected server-side into every page. A successful XSS injection could
  read this cookie and produce valid CSRF headers for the duration of the
  victim's page visit — though the `httpOnly` session cookie would still be
  protected, so the attacker couldn't steal the session itself. The CSRF
  cookie's 7-day `maxAge` also means a stolen CSRF token could be used until
  the browser naturally discards it (or the user clears cookies). This is
  inherent to the double-submit pattern, not a Koloclay-specific design choice,
  but it means the default isn't as strictly secure as a fully httpOnly token
  would be.

- **`prisma` as a global singleton.** `src/lib/db.ts:7-9` caches the Prisma
  client on `globalThis` to survive Next.js hot reloading in development. This
  is a standard Next.js Pattern, not a vulnerability, but it means the Prisma
  client (with full database access) is a module-level singleton accessible to
  any import anywhere in the codebase. There's no permission boundary between
  auth code and business code at the database-access level — any function that
  imports `prisma` can query any table. A more restrictive default would use
  the Prisma client extensions or row-level patterns to scope access, but that
  level of database-access control is unusual in small-to-medium Next.js apps
  and is not a reasonable expectation for this project's scope.

- **No `Strict-Transport-Security` header.** The codebase doesn't set an HSTS
  header in middleware or the Next.js config. HSTS tells browsers "always use
  HTTPS for this domain, even if the user types `http://`." In a production
  deployment behind Vercel, Vercel's edge network typically handles HSTS at the
  infrastructure level, so this is often redundant — but the codebase itself
  doesn't explicitly configure it, so deploying to a platform that doesn't set
  it automatically would leave a gap.

---

## Separation of concerns between auth logic and business logic

**Definition:** Authentication and authorization code (who you are, what you're
allowed to do) should live in dedicated, isolated modules with clear
interfaces. Business-logic code (creating entries, updating goals, rendering
dashboards) should consume those interfaces rather than reimplementing or
bypassing auth checks. The two concerns should be developed, tested, and
reasoned about independently.

**Why it matters:** When auth checks are scattered inline across business
routes — an `if (!session) return 401` copy-pasted into every handler — any
change to the auth model requires touching every file. Worse, a developer
adding a new route might forget to copy the check, leaving that route
unguarded. An isolated auth module with a small set of boundary functions
(`requireAuth`, `requireAuthApi`, `requireGuest`) means adding a new route is
as simple as calling one of those functions at the top, and the auth logic
itself can be strengthened in one place without touching business code.

**In this codebase:**

- **Dedicated auth module.** All auth logic lives under `src/lib/auth/`, a
  directory with nine files, each responsible for one concern:
  ```
  src/lib/auth/
  ├── csrf.ts        — CSRF token generation and verification
  ├── guards.ts      — route guards (requireAuth, requireGuest, requireAuthApi)
  ├── lockout.ts     — account lockout tracking
  ├── password.ts    — password hashing, verification, and strength schema
  ├── rate-limit.ts  — rate limiting
  ├── reset-token.ts — password reset token lifecycle
  ├── schemas.ts     — Zod validation schemas
  ├── session.ts     — session cookie configuration and access
  ├── sessions.ts    — session registry (database layer)
  ```

  No business-logic file in `src/app/api/entries/`, `src/app/api/goal/`,
  `src/app/dashboard/`, or `src/app/settings/` directly imports
  `iron-session`, `bcrypt`, or `node:crypto`. Those concerns are fully
  encapsulated behind the `lib/auth/` boundary.

- **Three boundary functions.** Business-logic code interacts with auth through
  exactly three functions, all exported from `src/lib/auth/guards.ts`:

  ```typescript
  // For Server Components / pages: redirects to /login when not authenticated.
  export async function requireAuth() {
    const result = await getValidatedSession();
    if (!result) redirect("/login");
    return result;
  }

  // For Server Components / pages: redirects to /dashboard when already
  // authenticated (login/signup pages shouldn't be reachable while logged in).
  export async function requireGuest() {
    const result = await getValidatedSession();
    if (result) redirect("/dashboard");
  }

  // For Route Handlers: returns null instead of redirecting so the caller can
  // respond with a JSON 401.
  export async function requireAuthApi() {
    return getValidatedSession();
  }
  ```

  These three functions are the complete auth surface that business code sees.
  A new developer adding a protected page or route only needs to know which of
  these three to call — they never need to understand how sessions work, how
  session registry validation works, or how lockout state is tracked.

- **Consistent calling pattern across all business routes.** Every business
  route and page follows the same two-line pattern:

  **Server Components (pages):**
  ```typescript
  // src/app/dashboard/page.tsx:14
  const { userId } = await requireAuth();
  ```
  ```typescript
  // src/app/settings/page.tsx:11
  const { userId } = await requireAuth();
  ```

  **Route Handlers (API):**
  ```typescript
  // src/app/api/entries/route.ts:12-15
  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  ```
  ```typescript
  // src/app/api/goal/route.ts:12-15
  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  ```
  ```typescript
  // src/app/api/entries/[id]/route.ts:14-17
  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  ```

  Every business route authenticates and authorizes through the same
  `requireAuthApi()` function called at the top. The rest of the route's logic
  concerns only its business domain (entries, goals) and uses `auth.userId` as
  the authenticated user identifier — never trusting a client-supplied ID.

- **Auth pages use `requireGuest`.** The login, signup, and reset-password
  pages all call `requireGuest()` to redirect already-authenticated users to
  the dashboard:

  ```typescript
  // src/app/(auth)/login/page.tsx:9
  await requireGuest();
  ```
  ```typescript
  // src/app/(auth)/signup/page.tsx:9
  await requireGuest();
  ```
  ```typescript
  // src/app/(auth)/reset-password/page.tsx:9
  await requireGuest();
  ```
  ```typescript
  // src/app/(auth)/reset-password/[token]/page.tsx:13
  await requireGuest();
  ```

  A user who is already logged in and navigates to `/login` is immediately
  bounced to `/dashboard` — the auth pages don't need to check for this
  condition themselves; the guard handles it consistently.

- **The CSRF check is also centralized.** Every mutating route handler calls
  `verifyCsrf(request)` from `lib/auth/csrf.ts`, not a copy-pasted inline
  check. This means if the CSRF strategy changes (e.g., from double-submit
  cookie to a new token pattern), only `csrf.ts` and `csrf-client.ts` need to
  change — none of the route handlers do.

- **Shared validation schemas.** The Zod schemas in `src/lib/auth/schemas.ts`
  are the single source of truth for input validation. The signup, login,
  reset-request, and reset-confirm routes all import their schemas from this
  file rather than defining validation inline. The password schema is defined
  once (`src/lib/auth/password.ts:20-33`) and reused by both `signupSchema` and
  `confirmResetSchema`. A change to password strength requirements requires
  editing exactly one file.

**Gaps or partial adherence:**

- **`entrySchema` and `goalSchema` live in `lib/auth/schemas.ts`.** These two
  schemas (`src/lib/auth/schemas.ts:30-47`) validate business data (financial
  entry amounts, savings goals), not auth data. They're defined in the same
  file as `signupSchema`, `loginSchema`, and `confirmResetSchema`, which means
  the auth module's boundary bleeds into the business domain. A developer
  looking for the entry validation rules has to open `lib/auth/schemas.ts` —
  an auth directory — rather than a business-logic location. Moving
  `entrySchema` and `goalSchema` to their own file (e.g.,
  `lib/validation/schemas.ts` or co-locating them with their route handlers)
  would make the separation cleaner. This is a minor organizational bleed, not
  a security issue — both schemas correctly import from `zod`, and validation
  failures are handled by each route's own error logic.

- **No `app/(auth)/actions.ts` file.** This project does not use Next.js Server
  Actions for auth operations. Instead, it uses traditional API routes
  (`src/app/api/auth/*`) called from client components via `fetch`. This is a
  valid architectural choice, not a gap, but it's worth noting because some
  Next.js projects centralize their auth logic in a single `actions.ts` file
  under the auth route group. In this codebase, the auth logic is in the API
  route files themselves and the `lib/auth/` module — spread across more files
  but with the same net effect of centralization behind a clean interface.

- **Prisma import is direct, not behind an auth-aware wrapper.** Business
  routes import `prisma` from `@/lib/db` directly and have unrestricted
  database access. The codebase trusts that business routes will use
  `auth.userId` correctly in their queries (and they do), but there's no
  technical enforcement preventing a business route from querying the `User`
  table or the `Session` table. A more rigorous separation would wrap database
  access in per-domain repositories (e.g., `lib/repos/entries.ts` exporting
  `createEntry(userId, data)` and `deleteEntry(userId, entryId)`) so that
  business route handlers never import `prisma` directly. This is a
  codebase-scale concern, not specific to auth, and is typical of small-to-medium
  Next.js projects where the overhead of repository layers outweighs the
  benefit given the team size and codebase surface area.
