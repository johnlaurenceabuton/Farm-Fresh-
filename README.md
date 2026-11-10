# Farm Fresh

Farm Fresh is a browser-based storefront backed by Supabase.

## Project files

- `index.html` — storefront markup and page entry point.
- `styles.css` — storefront styling.
- `app.js` — browser behavior, authentication, and Supabase client integration.
- `supabase/schema.sql` — database tables, policies, and order/inventory functions.
- `supabase/README.md` — Supabase project and owner account setup.

Keep `index.html`, `styles.css`, and `app.js` together when deploying; the page loads the stylesheet and application script by relative path. The Supabase JavaScript client is loaded from jsDelivr.
