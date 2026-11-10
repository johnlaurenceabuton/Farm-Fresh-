# Farm Fresh Supabase setup

1. In the Supabase project SQL Editor, run [`schema.sql`](./schema.sql) once. It creates the shop tables, policies, starter products/dates, order RPCs, and Realtime publication entries.
2. Run [`seller_marketplace.sql`](./seller_marketplace.sql) after `schema.sql`. It adds private farmer-certificate storage, owner-reviewed seller applications, seller-scoped products and orders, and atomic checkout splitting for orders from multiple farms. Re-run it after future seller schema changes.
3. Host the site over HTTPS (or localhost during development) and open `index.html`. The Supabase project URL and publishable key are configured in the page. A publishable key is intended for browser use; never put a `service_role` or secret key in this app.
4. Register the owner with the email address that should control the store. You can use **Create an account** on the site, or send an invitation from **Authentication → Users → Add user → Send invitation** in the Supabase dashboard. If you use an invitation, open its email link to sign in, then use **Set / Change Password** in the signed-in navigation to choose a password.
5. In the Supabase SQL Editor, promote that exact account:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = lower('OWNER_EMAIL_HERE');
   ```

   Replace `OWNER_EMAIL_HERE` with the owner's email. Confirm one row was updated, then sign out and back in to open the Admin Control Panel.
6. Buyers create customer accounts. A farmer can select the seller account type or apply later, then submit their farm details and farmer certificate. The certificate is stored in a private bucket and is visible only to the applicant and owner administrators. The owner must review and approve the application; seller approval never grants owner-admin privileges.
7. Approved sellers can manage only their own products, prices, stock, and orders. Customers can shop from multiple farms; checkout creates one independent order per farm so each seller can update only their own delivery status. Owner administrators retain platform-wide controls, including payment settings and application review.

The legacy browser-only accounts, inventory, and orders are not imported. Customer passwords are managed by Supabase Auth and are never saved in browser storage by this app.

## Current email confirmation setting

Email confirmation is disabled in this Supabase project so new accounts can sign up without sending a verification email. Users can register with an email address they have not verified; enable confirmation again after configuring reliable custom SMTP.

## Signup email delivery

Supabase's built-in email service is for testing, only sends to authorized team addresses, and is currently limited to two messages per hour. For customer signups, configure a custom SMTP provider in the project's [Authentication SMTP settings](https://supabase.com/dashboard/project/arbgxvobvvhvxdlpyllp/auth/smtp). Supabase's [SMTP setup guide](https://supabase.com/docs/guides/auth/auth-smtp) lists supported providers and setup details. Do not put SMTP credentials in this repository or the browser app.
