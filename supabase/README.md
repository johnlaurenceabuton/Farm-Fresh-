# Farm Fresh Supabase setup

1. In the Supabase project SQL Editor, run [`schema.sql`](./schema.sql) once. It creates the shop tables, policies, starter products/dates, order RPCs, and Realtime publication entries.
2. Run [`seller_marketplace.sql`](./seller_marketplace.sql) after `schema.sql`. It adds private farmer-certificate storage, seller-scoped products and orders, and atomic checkout splitting for orders from multiple farms. Re-run the updated migration on existing projects to apply the seller-only delivery workflow and receipt-only owner access.
3. Run [`seller_directory.sql`](./seller_directory.sql) after `seller_marketplace.sql`. It adds a public RPC that returns approved sellers' registered farm names for the customer farm search and refreshes the API schema cache. Default `Farm Fresh` values and seller profile names are not treated as farm names; products without a confirmed seller are grouped separately.
4. Run [`delivery_notifications.sql`](./delivery_notifications.sql) after `seller_marketplace.sql`. It adds private, per-account in-app delivery notifications and Realtime updates.
5. Run [`customer_order_cancellation.sql`](./customer_order_cancellation.sql) after `delivery_notifications.sql`. It adds secure customer cancellation, restores product stock, and notifies the customer, seller, and admins.
6. Run [`seller_preapproval.sql`](./seller_preapproval.sql) after the seller marketplace migration. It creates a private pre-registration application table; only the Edge Function can access it.
7. Run [`seller_preapplication_rate_limit.sql`](./seller_preapplication_rate_limit.sql). It adds a private, database-backed submission limit for the public application form; no CAPTCHA service or browser key is required.
8. Link the Supabase CLI to this project, set the app URL, and deploy the seller application and delivery receipt email functions:

   ```sh
   supabase link --project-ref arbgxvobvvhvxdlpyllp
   supabase secrets set SITE_URL="https://johnlaurenceabuton.github.io/Farm-Fresh-/index.html"
   supabase functions deploy seller-applications
   supabase functions deploy delivery-notifications
   ```

   The seller application function uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. In its settings, turn **Verify JWT with legacy secret** off: the function validates its caller itself, and the public application endpoint uses server-side validation plus a five-submission-per-IP-per-hour limit. It stores only an HMAC of the request IP and removes old rate-limit rows. In **Authentication → URL Configuration**, allow the exact `index.html` URL as a redirect URL for invitation links. Set `SITE_URL` to that same deployed app URL. Configure the `RESEND_API_KEY` and `FROM_EMAIL` Edge Function secrets for owner email alerts when seller applications arrive and for order receipt and cancellation emails. Supabase provides its URL and service-role key automatically.
9. Host the site over HTTPS and open `index.html`. The Supabase project URL and publishable key are configured in the page. A publishable key is intended for browser use; never put a `service_role` or secret key in this app.
10. Register the owner with the email address that should control the store. You can use **Create an account** on the site, or send an invitation from **Authentication → Users → Add user → Send invitation** in the Supabase dashboard. If you use an invitation, open its email link and set a password.
11. In the Supabase SQL Editor, promote that exact account:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = lower('OWNER_EMAIL_HERE');
   ```

   Replace `OWNER_EMAIL_HERE` with the owner's email. Confirm one row was updated, then sign out and back in to open the Admin Control Panel.
12. Buyers can create customer accounts. Farmers must submit a pre-registration application with their farm details and certificate (up to 5 MB) before creating an account. The owner reviews applications in the Admin Control Panel. Approval creates a seller account and emails an invitation; the farmer sets their own password from that invitation. Rejection does not create an account.
13. Approved sellers can manage only their own products, prices, stock, and orders. Sellers control delivery status through Pending → Preparing → Ready → Delivered, and can mark a Preparing order Delivered directly when appropriate. Delivery creates in-app notifications and sends receipt emails to the customer, seller, and admins; sellers can retry receipt emails from the order card. Customer cancellations create in-app notifications and send cancellation emails to the customer, seller, and admins; customers can retry cancellation emails from their order card. Customers can cancel Pending, Preparing, or Ready orders by selecting a reason; the order is cancelled and its stock restored. Paid cancellations are flagged for owner refund review; no automatic refund is issued. Customers can shop from multiple farms; checkout creates one independent order per farm.

The legacy browser-only accounts, inventory, and orders are not imported. Customer passwords are managed by Supabase Auth and are never saved in browser storage by this app.

## Current email confirmation setting

Email confirmation is disabled in this Supabase project so new accounts can sign up without sending a verification email. Users can register with an email address they have not verified; enable confirmation again after configuring reliable custom SMTP.

## Signup email delivery

Supabase's built-in email service is for testing, only sends to authorized team addresses, and is currently limited to two messages per hour. For customer signups, configure a custom SMTP provider in the project's [Authentication SMTP settings](https://supabase.com/dashboard/project/arbgxvobvvhvxdlpyllp/auth/smtp). Supabase's [SMTP setup guide](https://supabase.com/docs/guides/auth/auth-smtp) lists supported providers and setup details. Do not put SMTP credentials in this repository or the browser app.
