# Email setup — Google Workspace SMTP relay

## Why this rather than SendGrid

`aaranyascholarly.com` is already a Google Workspace domain, so Google's SPF
and DKIM records are already published in your DNS. Sending through Google
means:

- **No domain authentication step** and no new DNS records. SendGrid would
  have required three CNAMEs and a verification wait.
- **No new vendor** to manage, and no second place credentials can leak from.
- **10,000 recipients/day**, versus 100/day on SendGrid's free tier. A
  launching journal sends a few dozen; neither is a real constraint, but
  Google's ceiling is far higher.
- **Per-journal from-addresses work.** The relay may send as any address on
  the authenticated account's domain, so `alstm@`, `jec@` and the rest all
  send correctly and replies reach the right team.

What you give up: delivery analytics, bounce webhooks, and suppression lists.
At this stage you'd notice a bounce because a reviewer went quiet, not from a
dashboard — so that's an acceptable trade. If submission volume grows enough
that you need bounce handling, the SendGrid path is still in the code and
switching back is a config change, not a rewrite.

> Port note: Google Cloud blocks outbound port **25** everywhere with no
> exception, which is why a naive SMTP integration hangs on Cloud Run. Ports
> **587** and **465** are open, and the relay uses 587 — so this works.

## Step 1 — enable the relay (Google Admin console)

Go to <https://admin.google.com> as `admin@aaranyascholarly.com`.

**Apps → Google Workspace → Gmail → Routing → SMTP relay service → Configure**

| Setting | Value |
|---|---|
| Description | `Aaranya Scholarly journal platform` |
| Allowed senders | **Only addresses in my domains** |
| Authentication | tick **Only accept mail from the specified IP addresses** → *leave empty* — and tick **Require SMTP Authentication** |
| Encryption | tick **Require TLS encryption** |

**Require SMTP Authentication is the important one.** The relay can also
authorise by IP address, but Cloud Run's egress IPs are dynamic and
unpredictable, so IP-based authorisation cannot work here. Credentials are
the only viable option.

Save. Changes can take a few minutes to apply.

## Step 2 — create an App Password

App Passwords require 2-Step Verification on the account. If it isn't on
already, turn it on first — you'll want it regardless, given this account
owns the billing and the whole deployment.

1. <https://myaccount.google.com/apppasswords> (signed in as
   `admin@aaranyascholarly.com`)
2. Name it `Aaranya journal platform`
3. Google shows a 16-character password **once**. Copy it.
4. **Strip the spaces** — Google displays it in four groups of four, but it
   should be entered as 16 characters with no spaces.

## Step 3 — wire it in

Double-click **`0-RUN-EMAIL-SETUP.bat`**, paste the App Password, press
Enter, then Ctrl+Z and Enter.

It stores the password in Secret Manager (never on disk), grants the runtime
service account permission to read it, and attaches it to the Cloud Run
service along with the relay host, port, and sending account.

## Step 4 — prove it works

Register a new account on <https://aaranya-scholarly.web.app/register.html>
with an address you can check. You should receive **"Your Aaranya Scholarly
author account is ready"** within a minute.

Then submit a test manuscript. That fires two more: a receipt to the author
and a "new submission awaiting screening" notice to the editors.

## If mail doesn't arrive

Failures are recorded rather than hidden — the editor's review panel shows a
red warning against any reviewer whose invitation failed, so a silent send
failure is never mistaken for an unresponsive reviewer.

To see the underlying error:

```bash
gcloud run services logs read aaranya-website \
  --region=asia-south1 --project=aaranya-scholarly --limit=100
```

Look for lines beginning `[mailer] smtp failed`.

| Error | Cause |
|---|---|
| `Invalid login` / `535` | App Password wrong, or has spaces in it |
| `Must issue a STARTTLS command first` | `SMTP_PORT` not 587 |
| `Mail relay denied` / `550` | Step 1 not saved, or "Require SMTP Authentication" not ticked |
| `connect ETIMEDOUT` | Wrong host — must be `smtp-relay.gmail.com` |
| Sends succeed but nothing arrives | Check spam; confirm the from-address mailbox exists |

## Mailboxes

The app sends from `alstm@`, `ipsb@`, `ghesb@`, `jec@`, `jtim@`, `jsamp@`,
`acfdi@` and `editorial@aaranyascholarly.com`.

The relay will send *as* these addresses whether or not they exist as
mailboxes. But a reviewer replying to an invitation with a question will get
a bounce if the address doesn't receive mail. Create them in Workspace as
aliases or groups pointing at whoever handles editorial correspondence.

To send everything from one address instead, set `EDITORIAL_EMAIL` and remove
the per-journal entries from `JOURNAL_EMAILS` in `config.js`.
