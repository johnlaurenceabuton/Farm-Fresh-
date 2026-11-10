# Farm Fresh Supabase setup

1. In the Supabase project SQL Editor, run [`schema.sql`](./schema.sql) once. It creates the shop tables, policies, starter products/dates, order RPCs, and Realtime publication entries.
2. Host the site over HTTPS (or localhost during development) and open `index.html`. The Supabase project URL and publishable key are configured in the page. A publishable key is intended for browser use; never put a `service_role` or secret key in this app.
3. Register the owner with the email address that should control the store. You can use **Create an account** on the site, or send an invitation from **Authentication → Users → Add user → Send invitation** in the Supabase dashboard. If you use an invitation, open its email link to sign in, then use **Set / Change Password** in the signed-in navigation to choose a password.
4. In the Supabase SQL Editor, promote that exact account:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = lower('OWNER_EMAIL_HERE');
   ```

   Replace `OWNER_EMAIL_HERE` with the owner's email. Confirm one row was updated, then sign out and back in to open the Admin Control Panel.
5. Customers create their own accounts and use the normal storefront. Customer data and orders are protected by row-level security; only the owner can manage products, inventory, reservation dates, payment QR codes, and all order statuses.

The legacy browser-only accounts, inventory, and orders are not imported. Customer passwords are managed by Supabase Auth and are never saved in browser storage by this app.
