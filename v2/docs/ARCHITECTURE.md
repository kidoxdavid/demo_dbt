# Architecture (v2, Phase 1: foundation)
- **Modular monolith**, TypeScript, npm workspaces. Parameterised SQL through `pg` (no ORM), zod for input, vitest on a real Postgres.
- **Windows (areas):** shop, studio, admin, support, finance, marketing. Each has its own cookie (`es_<area>`) and its own session row, so signing out of one leaves the others. The API path decides the window (`/api/admin/*` is admin); only `/api/auth/*` reads the `x-area` header. A session only carries roles that belong to its window, so a shop session never carries staff or seller power.
- **Roles:** staff roles are platform-wide; seller roles are scoped to one seller (`user_roles.seller_id`, the foreign key arrives with the sellers table in the catalogue phase). Authorisation is per resource: `can(user, permission)` and `canForSeller(user, permission, sellerId)`.
- **Sessions, not JWTs.** Opaque token in an HttpOnly SameSite=Lax cookie; only its SHA-256 is stored. scrypt password hashes. Origin check on every mutation. Rate limit on sign-in and sign-up. Five failed sign-ins lock the account for 15 minutes; unknown, disabled and wrong-password sign-ins answer identically.
- **Audit log** is append-only (database trigger). Settings, flags, roles, categories and attributes all write before/after values and a reason.
- **Settings and flags:** settings have a zod schema and a default (`src/settings.ts`); a missing row means the default. A missing flag means ON (AI descriptions are the exception: off until enabled).
- **Categories** are a tree with typed attribute definitions (text, number with unit, select, multiselect, colour, boolean) that drive both seller forms and buyer filters; children inherit their parents' attributes. Launch categories load once and are never overwritten by a later migration run.
- **Money** will be integer CAD cents everywhere (no money tables yet).

## Phase 2 additions
- **Catalogue model:** sellers -> shops (one each) -> products -> variants. A product has a primary category plus any others it fits (`product_categories`); listing a category includes its sub-categories. Options (up to three, 100 combinations) generate a variant table that keeps price and stock for combinations that already existed.
- **Stock integrity:** `CHECK (stock_reserved <= stock_on_hand)`; a trigger makes one-of-a-kind products single-variant with at most one in stock (enforced in the database, not only the API). Made-to-order variants do not track stock.
- **One card query** (`lib/cards.ts`) feeds every listing; search adds ranking on top of the same fragments.
- **Media:** magic-byte sniffing, sharp for images (WebP 320/640/1280, EXIF and GPS removed, orientation applied, blur-up placeholder), ffmpeg for video (H.264 MP4 at most 1280 wide, poster frame, 60 s cap), database copy plus disk copy, Range support, long-lived caching.
- **Studio windows:** `/api/studio/*` is the seller area; seller permissions come from the seller role on that seller only.
