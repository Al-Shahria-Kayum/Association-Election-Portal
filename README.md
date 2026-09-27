# CSA DIU Election Portal

A responsive, interaction-ready front-end implementation of the Chuadanga Student Association, DIU election portal.

## Run locally

Run `node scripts/local-server.js`, then open `http://localhost:4173` in a modern browser. You can also serve this folder with any static web server.

## Supabase DIU email verification

The portal uses passwordless Supabase Auth: a user enters a DIU address, receives a magic link (or OTP if you change the Supabase email template), and is admitted only after the verified session returns. No Google OAuth is needed.

1. Create a Supabase project and run both migrations, in order, in its SQL Editor: [identity and profile setup](supabase/migrations/202609270001_verified_members.sql), then [election platform and integrity rules](supabase/migrations/202609270002_election_platform.sql).
2. In **Authentication → URL Configuration**, set the Site URL and add your deployed callback URL. For local development add `http://localhost:4173`. Supabase only redirects to allowed URLs.
3. In **Authentication → Providers → Email**, keep email sign-in enabled. Use the default magic-link template, or replace `{{ .ConfirmationURL }}` with `{{ .Token }}` to deliver a six-digit OTP.
4. Set `SUPABASE_URL` to the project root (for example, `https://your-project-ref.supabase.co`) and `SUPABASE_PUBLISHABLE_KEY` from [.env.example](.env.example). You may place them in a local `.env` file or the environment used to start `server.js`. Do not use the `/rest/v1` endpoint as `SUPABASE_URL`: Auth uses the project root. The server makes only these public values available to the browser. Do not use or expose a `SUPABASE_SERVICE_ROLE_KEY`.

For PowerShell, set the values for the current terminal before starting the server:

```powershell
$env:SUPABASE_URL = 'https://your-project-ref.supabase.co'
$env:SUPABASE_PUBLISHABLE_KEY = 'your-publishable-key'
node scripts/local-server.js
```

## Vercel deployment

This project is deployed as a static site with one Vercel Function: `api/config.js`. The included `vercel.json` maps the browser request to `/config.js`; it deliberately does not run the local development listener in production.

In **Vercel → Project Settings → Environment Variables**, create these values for Production (and Preview if needed):

- `SUPABASE_URL` — your Supabase project root, for example `https://your-project-ref.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY` — your Supabase publishable/anon key

Do **not** add a service-role key to Vercel or the browser. In Supabase Auth URL Configuration, add the deployed Vercel URL to the allowed Redirect URLs list.

## Included flows

- Student dashboard, position browsing, candidate profiles, vote confirmation, private vote status, and published results.
- Admin election management, state transitions, application approvals, people management, and audit log views.
- Responsive desktop/tablet/mobile interface with loading-free state changes, modal confirmations, notifications, search, and created-position flow.

## Production implementation note

Supabase handles the email-verification session and the included database migration makes the verified email/domain the gate for a `student` profile. Before a public production launch, still add a CAPTCHA/rate-limit strategy, private image storage/upload validation, a retention policy, and production monitoring.

The second migration now provides the election tables and server-enforced actions: positions, applications, private one-vote-per-position ballots, idempotency keys, candidate caps, state transitions, aggregate results, RLS, member suspension, and audit records. The UI reloads this data from Supabase after every verified login, so approved/rejected applications and account status persist across refreshes.

## Admin access

Every verified account receives the `student` role. There is deliberately no self-service admin selection. After a trusted user has completed email verification, promote them from the Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin'
where email = 'trusted.person@diu.edu.bd';
```

On their next magic-link sign-in, the **Administration** section appears in the sidebar. Student accounts see only Overview, Election positions, My applications, and Results.

### Removing a person

The People screen’s **Remove access** action suspends the person and records an audit event. It does not erase their identity, ballot, application, or audit history—deleting those records would compromise election integrity. A suspended account cannot activate the portal again; **Restore access** reverses the suspension.
