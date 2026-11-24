# 👖 Jeans Days

A simple, phone-friendly app for staff to pay for jeans days and for admins to see who has paid.

- **Teachers/staff:** create an account, tap the days they want on a calendar, flip on "swag" for discounted days, and pay by card (Apple Pay / Google Pay work too).
- **Admins:** see *who's in jeans* for any day, record cash/check payments, reset passwords, view totals, download a spreadsheet, and set the school year, prices, and no-school days.

Default prices: **$2/day**, or **$1/day** when also wearing Meadowlark swag (changeable in Admin → Settings).

Runs on **Cloudflare Workers + D1** (free tier is plenty) with **Stripe Checkout** for payments.

---

## Setup (about 20 minutes)

You need: a Cloudflare account, a Stripe account, and Node.js installed.

### 1. Deploy
The D1 database (`jeans-tracker`) is already created and set up in the Kellee@prairiegiraffe.com Cloudflare account, and its ID is in `wrangler.toml`. To deploy:
```bash
npm install
npx wrangler login      # pick the Kellee@prairiegiraffe.com account
npm run deploy
```
Optional: put the admin's email in `wrangler.toml` → `ADMIN_EMAILS` (comma-separate several). Time zone is set to Mountain (Gillette, WY).
You'll get a URL like `https://jeans-tracker.<you>.workers.dev`. You can add a custom domain in the Cloudflare dashboard.

The app now runs in **demo mode** (no cards charged) so you can try it.

> The very first account created becomes an admin automatically, so sign up yourself first.

### 2. Connect Stripe
1. In Stripe → Developers → API keys, copy the **Secret key** (start with the `sk_test_` key to test).
2. `npx wrangler secret put STRIPE_SECRET_KEY` and paste it.
3. In Stripe → Developers → Webhooks → **Add endpoint**:
   - URL: `https://YOUR-APP-URL/api/stripe/webhook`
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
4. Copy the endpoint's **Signing secret** (`whsec_...`) and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.

Test with card `4242 4242 4242 4242`, any future date, any CVC. When it works, repeat steps 1–4 with your **live** keys.

### 3. Before launch
In **Admin → Settings**: set the first/last day of school and add holidays and breaks ("Block the whole week" helps with breaks).

---

## Notes
- **Stripe fees** are about 2.9% + 30¢ per checkout, so a single $1 day loses ~33¢. Encourage staff to buy several days at once (the "Every Friday this month" button helps). PayPal's fees are similar.
- **Refunds** are done in the Stripe dashboard. The app doesn't remove a refunded day automatically.
- **Forgot password:** an admin opens People → the person → *Reset password* and gives them the temporary password.
- Swag pricing works on the honor system.

## Local development
```bash
echo 'ADMIN_EMAILS="you@example.com"' > .dev.vars
npm run db:init:local
npm run dev     # http://localhost:8787
```
