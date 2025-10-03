# CPW Dynamic Library Affiliation - Implementation Plan

## Current Architecture Summary

### Build-time Configuration
- Libraries (and other settings) are configured via the YAML config file specified in the `CONFIG_FILE` environment variable
- Library registry support exists (`src/config/fetch-config.js:47-77`) but fetches at **build time**
- `APP_CONFIG` is baked into the Next.js build via `next.config.js` (lines 34-38)
- Static paths use `fallback: true` for ISR (Incremental Static Regeneration) with 1-hour revalidation

### Current Routing
- Multi-library routing: `/[library]/` dynamic routes
- Homepage shows all configured libraries (`MultiLibraryHome.tsx`)
- Single library instances use `OpenEbooksLanding` if configured

### Authentication Storage
- Uses `js-cookie` for credential storage (`src/auth/useCredentials.ts`)
- Cookies are scoped per library: `CPW_AUTH_COOKIE/{librarySlug}`
- No persistence option or public computer warnings currently

---

## Architecture Changes Required

### 1. Runtime Library Registry Fetching (Server-Side)

**Problem:** Libraries are currently fetched at build time and baked into the static bundle.

**Solution:** Implement server-side library registry fetching with intelligent caching and refresh strategy. Registry state is maintained on the server; only minimal client-facing data is exposed.

**Architecture Decision: Server-Side State**
- Registry data fetched and cached on **server** (Next.js API routes + server-side cache)
- Only client-necessary properties exposed to browser (id, slug, title, authDocUrl, logo)
- Full registry metadata remains server-side
- Reduces client bundle size and improves security
- Enables server-side slug computation and collision handling

**Key Changes:**
- Create Next.js API route: `/api/libraries` for client to query available libraries
- Server-side registry cache with min/max interval refresh logic
- Registry libraries **replace** corresponding build-time libraries (not merge)
- Fallback to most recent successful server state on fetch failure
- Build-time config only used as initial state (before first successful fetch)

**Refresh Strategy:**
- **Min Interval** (`refresh_min_interval`): Minimum seconds between fetch attempts
- **Max Interval** (`refresh_max_interval`): Maximum seconds after last successful fetch before auto-refresh
- **Triggered Refresh**: API requests trigger refresh if max interval elapsed and min interval respected
- **Failure Handling**: On fetch failure, retain most recent successful state (not build-time state)

**State Precedence:**
```
Server-side:
1. Most recent successful registry fetch (server runtime state)
2. Previous successful registry fetch (server-cached state)
3. Build-time config (initial state only, until first successful fetch)

Client-side:
1. Fetch from /api/libraries (returns filtered server state)
2. Client-side SWR cache for session
```

**Technical Approach:**
```typescript
// New file: src/pages/api/libraries.ts (Next.js API route)
interface ServerRegistryState {
  libraries: LibrariesConfig;        // Full library configs
  libraryMetadata: RegistryMetadata; // Full registry metadata (server-only)
  lastSuccessfulFetch: number | null;
  lastAttemptedFetch: number | null;
  source: 'build-time' | 'registry';
}

// Server-side cache per registry (in-memory, not exposed to client)
let serverRegistryCaches: Map<string, ServerRegistryState>; // registryUrl -> state

// API route handler
export default async function handler(req, res) {
  // Iterate through all configured registries
  // Check if refresh needed for each (respecting min/max intervals)
  // Fetch from registries if needed
  // Merge libraries with precedence rules:
  //   1. Static libraries (highest precedence)
  //   2. First registry libraries (if slug doesn't conflict with static)
  //   3. Subsequent registry libraries (if slug doesn't conflict with static or earlier registries)
  // Update server cache for each registry
  // Return only client-safe properties:
  return {
    libraries: libraries.map(lib => ({
      id: lib.id,
      slug: lib.slug,
      title: lib.title,
      authDocUrl: lib.authDocUrl,
      logoUrl: lib.logoUrl
    }))
  };
}
```

```typescript
// New file: src/hooks/useLibraries.ts (Client-side hook)
// - useSWR to fetch from /api/libraries
// - Client-side caching (SWR default behavior)
// - No localStorage needed for registry (server maintains state)
```

**Config Changes:**
```yaml
# community-config.yml

# Static library definitions (slug -> auth-doc-url mappings)
libraries:
  library-slug: https://auth-doc-url
  another-library: https://example.com/auth

# Registry configurations (list of registries to fetch from at runtime)
registries:
  - url: https://registry.thepalaceproject.org/libraries
    refresh_min_interval: 60   # seconds, default 1 min (rate limit)
    refresh_max_interval: 300   # seconds, default 5 min (auto-refresh)
  # Future: support for multiple registries
  # - url: https://another-registry.example.com/libraries
  #   refresh_min_interval: 120
  #   refresh_max_interval: 600
```

---

### 2. Library Search & Affiliation UI

**New Components:**

**a) Library Search Component**
- Location: `src/components/LibrarySearch.tsx`
- Features:
  - Fuzzy search using `fuse.js` (already in dependencies)
  - Search by library name, ID, location metadata
  - Display search results with library logos and descriptions
  - "Add Library" button for each result

**b) Library Affiliation Manager**
- Location: `src/components/LibraryAffiliations.tsx`
- Shows list of user's affiliated libraries
- "Visit" and "Remove" actions per library
- Indicates which libraries have active credentials

**c) Enhanced Home Page**
- Update `src/pages/index.tsx` logic
- Show affiliated libraries first (from localStorage)
- Add "Find a Library" button → opens search modal
- Show warning on first affiliation save about public computers

**UI Flow:**
```
User visits base URL (/)
├─ Has affiliations?
│  ├─ Yes → Show "My Libraries" + "Find Another Library"
│  └─ No  → Show "Find Your Library" search
│
User searches for library
├─ Results displayed with metadata
├─ Click "Add Library" → Save to affiliations
└─ Optionally navigate to library catalog
```

---

### 3. Browser Storage Strategy

**ID vs Slug Architecture:**

**Important Distinction:**
- **ID**: Stable identifier from registry (`catalog.metadata.id`) or config key. Used for storage scoping (cookies, affiliations).
- **Slug**: URL-friendly string computed from library metadata. Used in URL paths (`/[slug]/`).
- **For static config libraries**: `id` equals the config key (which also serves as slug)
- **For registry libraries**: `id` comes from `catalog.metadata.id`, slug is computed from metadata

**Slug Generation:**
```typescript
// New file: src/utils/librarySlug.ts
function computeSlug(catalogEntry: RegistryCatalogEntry): string {
  // Compute URL-friendly slug from individual catalog entry data
  // catalogEntry is at registryFeed.catalogs[n] level (individual library)
  // NOT catalog-level metadata
  // Examples: catalogEntry.metadata.title → "queens-library"
  // This gives flexibility to adjust base URLs per library as needs change
  // Must be deterministic but can change if library metadata changes
}
```

**Storage Architecture:**

**a) Library Affiliations** (new)
```typescript
// LocalStorage key: CPW_LIBRARY_AFFILIATIONS
interface LibraryAffiliation {
  id: string;           // Stable identifier (for storage keys)
  slug: string;         // URL-friendly (computed, can change)
  title: string;
  authDocUrl: string;
  addedAt: number;      // timestamp
  persist: boolean;     // user's choice to remember
  registrySource?: string; // If from registry, store registry URL
}

type Affiliations = LibraryAffiliation[];
```

**b) Credentials** (enhanced)
```typescript
// Cookie key (enhanced): CPW_AUTH_COOKIE/{libraryId}
// NOTE: Now scoped to library ID, not slug
interface AuthCredentials {
  token: string;
  methodType: string;
  persist?: boolean;    // NEW: user's choice
  expiresAt?: number;   // NEW: optional expiration
}
```

**Storage Locations:**
- **Affiliations**: `localStorage` keyed by library ID (persistent across sessions if user opts in)
- **Credentials**: Cookies keyed by library ID (existing mechanism, add persistence option)
  - Session cookies by default (deleted on browser close)
  - Persistent cookies if user opts in (30-day expiration)

**Why ID for storage, Slug for URLs:**
- IDs are stable (registry-provided or config key)
- Slugs can change if library metadata changes (name updates, etc.)
- Storage must survive metadata changes → use ID
- URLs should be human-readable → use slug
- Need bidirectional mapping: slug → id and id → slug

**Public Computer Warning:**
- Show modal on first save attempt
- Checkbox: "Don't show this again for this browser"
- Store preference in `localStorage: CPW_HIDE_PUBLIC_WARNING`

---

### 4. Credential Persistence Enhancement

**Modify:** `src/auth/useCredentials.ts`

**Changes:**
- Add `persist` parameter to cookie options
- Session cookie (default): no `expires` parameter
- Persistent cookie (opt-in): 30-day expiration
- Update login forms to include "Remember me" checkbox

**Cookie Configuration:**
```typescript
// Session (current behavior)
Cookie.set(key, value); // No expires

// Persistent (new)
Cookie.set(key, value, { expires: 30 }); // 30 days
```

**Login Form Updates:**
- `src/auth/BasicAuthHandler.tsx`
- `src/auth/BasicTokenAuthHandler.tsx`
- Add "Remember my credentials" checkbox
- Show public computer warning (first time only)

---

## Implementation Phases

### Phase 1: Foundation (No UI changes)

1. Create server-side slug generation utility (`src/utils/librarySlug.ts`)
   - Takes individual catalog entry (registryFeed.catalogs[n]) as input
   - Generates slug from library-specific metadata (not catalog-level metadata)
   - Provides hook to adjust base URLs for libraries as needs change
2. Create Next.js API route `/api/libraries` with:
   - Server-side registry fetch logic for multiple registries
   - Min/max interval refresh logic per registry
   - In-memory server cache per registry (Map of registryUrl -> state)
   - Merge strategy: static > registry[0] > registry[1] (earlier wins on slug conflicts)
   - Static libraries cannot be overridden by registry libraries
   - Fallback to last successful state per registry (not build-time)
   - Returns only client-safe library properties
3. Create server-side library registry manager (`src/server/libraryRegistry.ts`)
   - Maintains server-side cache per registry
   - Handles fetching from multiple registries
   - Implements min/max interval logic per registry
   - Merges libraries with precedence: static > registry[0] > registry[1] > ...
   - Computes slugs server-side from individual catalog entries
   - Handles slug collisions: static wins, then earlier registry wins
4. Update `LibraryData` interface to include `id` field
5. Create client-side hook `useLibraries` to fetch from `/api/libraries`
6. Create `LibraryAffiliationsContext` for affiliation management (client-side)
7. Add localStorage utilities for affiliations (client-side only)
8. Update `useCredentials` hook to support persistence option and use library ID
9. Add public computer warning modal component
10. Create slug ↔ id mapping utilities (server-side primary, client receives computed values)

**Estimated Complexity:** High (server-side architecture shift)

**Key Files:**
- `src/pages/api/libraries.ts` (new) - API route for library queries
- `src/server/libraryRegistry.ts` (new) - Server-side registry manager with caching
- `src/utils/librarySlug.ts` (new) - Server-side slug generation from catalog metadata
- `src/hooks/useLibraries.ts` (new) - Client hook to fetch from API route
- `src/interfaces.ts` (modify) - Add `id` field to `LibraryData`, create client-safe types
- `src/context/LibraryAffiliationsContext.tsx` (new) - Client-side affiliation management
- `src/utils/libraryAffiliations.ts` (new) - Client-side affiliation storage
- `src/auth/useCredentials.ts` (modify) - Use library ID instead of slug
- `src/components/PublicComputerWarning.tsx` (new)
- `src/dataflow/getLibraryData.ts` (modify) - Include ID in `buildLibraryData`

---

### Phase 2: Library Search & Discovery

1. Create `LibrarySearch` component with fuzzy search
2. Create `LibraryAffiliations` management component
3. Update home page (`src/pages/index.tsx`) to show affiliations
4. Add "Find a Library" flow

**Estimated Complexity:** Medium-High

**Key Files:**
- `src/components/LibrarySearch.tsx` (new)
- `src/components/LibraryAffiliations.tsx` (new)
- `src/pages/index.tsx` (modify)
- `src/components/MultiLibraryHome.tsx` (modify)

---

### Phase 3: Credential Persistence

1. Update all login forms to include "Remember me" checkbox
2. Integrate public computer warning into login flow
3. Update cookie logic to support session vs persistent
4. Add "Forget me" functionality to clear credentials

**Estimated Complexity:** Low-Medium

**Key Files:**
- `src/auth/BasicAuthHandler.tsx` (modify)
- `src/auth/BasicTokenAuthHandler.tsx` (modify)
- `src/auth/SamlAuthHandler.tsx` (modify - for consistency)
- `src/auth/CleverAuthHandler.tsx` (modify - for consistency)

---

### Phase 4: Polish & Testing

1. Add comprehensive tests for new contexts
2. Add integration tests for library search flow
3. Add tests for affiliation persistence
4. Update documentation
5. Add Storybook stories for new components

**Estimated Complexity:** Medium

**Testing Focus:**
- Library registry fetching and caching
- Affiliation CRUD operations
- Credential persistence across sessions
- Public computer warning behavior
- Multi-library routing with dynamic affiliations

---

## Technical Considerations

### Next.js ISR Compatibility
- Current pages use `getStaticProps` with `revalidate: 3600`
- ISR will continue to work for individual library pages
- Runtime registry fetching complements ISR (doesn't replace it)
- Library pages can still be pre-rendered at build time for known libraries

### Registry Feed Caching
- **Server-side cache**: In-memory Map per registry on Next.js server (module-level variable)
  - Key: registry URL
  - Value: ServerRegistryState for that registry
- **Client-side cache**: SWR's built-in caching for active browser session
- No localStorage for registry data (server is source of truth)
- Min/max interval configuration per registry for server-side refresh timing
- **Merge strategy**:
  1. Start with static libraries from config (highest precedence)
  2. Apply libraries from first registry
  3. Apply libraries from subsequent registries in order
  4. **Conflict resolution by slug**:
     - Static library always wins over registry library (same slug)
     - Earlier registry wins over later registry (same slug)
  5. Static libraries cannot be overridden by registries
- **Fallback strategy**: On registry fetch failure, server uses most recent successful state for that registry (not build-time)
- Build-time static libraries serve as base layer always
- Server cache persists across API requests (until server restart)
- After server restart, uses static libraries + re-fetches all registries
- Client SWR configuration:
  - `revalidateOnFocus`: false (server handles refresh logic)
  - `revalidateOnReconnect`: false (server handles refresh logic)
  - `dedupingInterval`: 60000 (1 minute - avoid duplicate requests)

### Routing Strategy
- Current: `/[library]/` requires library in build config (library = slug)
- New: `/[library]/` can resolve from runtime registry (library = slug)
- URL routing uses **slug** (human-readable, can change)
- Internal routing logic must resolve slug → ID for storage operations
- Maintain `fallback: true` in `getStaticPaths`
- ISR will generate pages on-demand for new libraries
- When registry metadata changes and slug is recomputed:
  - Update slug → ID mapping
  - Old URLs (old slug) may break, new URLs (new slug) will work
  - Consider implementing slug redirect mechanism for backwards compatibility

### TypeScript Types
```typescript
// src/interfaces.ts additions

// Client-safe library info (exposed via API)
export interface ClientLibraryInfo {
  id: string;
  slug: string;
  title: string;
  authDocUrl: string;
  logoUrl?: string;
}

// Server-side full library data (includes registry metadata)
export interface ServerLibraryData extends ClientLibraryInfo {
  registryMetadata?: Record<string, any>; // Full registry catalog data
  source: 'build-time' | 'registry';
}

// Client-side affiliation (localStorage)
export interface LibraryAffiliation {
  id: string;           // Stable identifier
  slug: string;         // URL-friendly (computed server-side)
  title: string;
  authDocUrl: string;
  addedAt: number;
  persist: boolean;
  registrySource?: string;
}

// Existing LibraryData with ID added
export interface LibraryData {
  id: string;           // NEW: Stable identifier
  slug: string;         // Existing field
  catalogUrl: string;
  shelfUrl: string | null;
  catalogName: string;
  // ... other existing fields
}

// Server-side registry state
export interface ServerRegistryState {
  libraries: Record<string, ServerLibraryData>; // id -> library data
  lastSuccessfulFetch: number | null;
  lastAttemptedFetch: number | null;
  source: 'build-time' | 'registry';
}

// API response type
export interface LibrariesApiResponse {
  libraries: ClientLibraryInfo[];
  source: 'build-time' | 'registry';
  lastUpdated: number | null;
}

// Registry configuration (list item)
export interface RegistryConfig {
  url: string;
  refresh_min_interval?: number; // seconds, default 60
  refresh_max_interval?: number; // seconds, default 300
}

// App config updates
export interface AppConfig {
  // ... existing fields
  libraries: Record<string, string>; // slug -> authDocUrl (static only)
  registries?: RegistryConfig[];     // list of registries (new)
}
```

### Slug Change Handling
When a library's metadata changes in the registry, the computed slug may change:

**Challenge:**
- User has affiliation stored (with old slug)
- Registry metadata changes → new slug computed
- User's old URLs (bookmarks) use old slug
- Credentials and affiliations keyed by ID still work

**Solution:**
1. **Affiliation Update:** When registry data refreshes, recompute all slugs for affiliated libraries
2. **Mapping Cache:** Maintain in-memory cache of both current and historical slugs → ID
3. **URL Resolution:** When resolving `/[library]/`, check both:
   - Current slug → ID mapping
   - Historical slug → ID mapping (with optional redirect to new slug)
4. **User Notification:** If slug changed for affiliated library, show banner: "Library URL updated"

**Implementation:**
```typescript
// src/server/libraryRegistry.ts (server-side)
interface LibraryMapping {
  id: string;
  currentSlug: string;
  previousSlugs?: string[]; // Historical slugs for redirect
}

// When server-side registry refreshes:
// 1. Compute new slug from fresh metadata (server-side)
// 2. If slug changed, add old slug to previousSlugs[] in server cache
// 3. API returns updated slug to client
// 4. Client updates affiliations with new slug
// 5. Keep previousSlugs[] on server for backwards compat (max 5?)
// 6. When client requests /[library]/, server checks both current and previous slugs
```

### Backward Compatibility
- Existing build-time library configs continue to work (id = slug for these)
- Registry URL in config is optional
- Credential cookies keyed by ID remain compatible across slug changes
- Affiliations stored by ID remain compatible across slug changes
- Historical slugs provide backwards compatibility for bookmarks
- No breaking changes to existing API

---

## Security Considerations

1. **Public Computer Warning:**
   - Clear, prominent warning before saving any data
   - Don't auto-dismiss warning
   - Require explicit user action

2. **Credential Storage:**
   - Session cookies by default (cleared on browser close)
   - Persistent cookies only with explicit opt-in
   - Consider adding "Clear all data" button in settings

3. **Registry Fetching:**
   - Validate registry feed structure
   - Handle malicious/malformed responses gracefully
   - Set reasonable fetch timeouts
   - Consider CORS implications

4. **localStorage Limits:**
   - Gracefully handle QuotaExceededError
   - Implement cleanup for old affiliations
   - Consider max affiliation count (e.g., 20 libraries)

---

## User Experience Enhancements

1. **First-Time User Flow:**
   ```
   Visit CPW → See "Find Your Library"
   → Search by name → Add library
   → See public computer warning
   → Choose to persist or not
   → Navigate to library catalog
   ```

2. **Returning User Flow:**
   ```
   Visit CPW → See "My Libraries" list
   → Click library → Enter catalog
   → (Auto-login if credentials persisted)
   ```

3. **Multi-Library User Flow:**
   ```
   Visit CPW → See all affiliated libraries
   → Switch between them easily
   → Add new library without losing others
   → Manage affiliations (remove unwanted)
   ```

---

## Configuration Examples

**Minimal (backward compatible - static only):**
```yaml
libraries:
  nypl: https://example.com/nypl/auth
  queens: https://example.com/queens/auth
```

**Registry-based (new - registries only):**
```yaml
registries:
  - url: https://registry.thepalaceproject.org/libraries
    refresh_min_interval: 60   # Min 1 minute between fetches
    refresh_max_interval: 300  # Auto-refresh every 5 minutes
```

**Hybrid (static + registries):**
```yaml
# Static library definitions (always available)
libraries:
  featured-lib: https://example.com/featured/auth
  local-lib: https://example.com/local/auth

# Registry configurations (static libraries take precedence over registry libraries on slug conflicts)
registries:
  - url: https://registry.thepalaceproject.org/libraries
    refresh_min_interval: 60
    refresh_max_interval: 300
  # Optional: multiple registries supported
  # - url: https://regional-registry.example.com/libraries
  #   refresh_min_interval: 120
  #   refresh_max_interval: 600
```

---

## Testing Strategy

### Unit Tests
- Server-side library registry manager (mocked fetch)
  - Min/max interval enforcement per registry
  - Merge strategy (static > registry[0] > registry[1], earlier wins)
  - Static libraries have absolute precedence over registry libraries
  - Fallback to last successful state per registry on failure
  - Server-side cache persistence across requests (Map of registry URLs)
  - Handling multiple registries with different intervals
  - Slug collision resolution (static > earlier registry)
- API route `/api/libraries` (integration test)
  - Returns only client-safe properties
  - Triggers refresh when appropriate per registry
  - Respects min/max intervals per registry
  - Correctly merges static + multiple registry sources
- Client hook `useLibraries` (mocked API)
- Library affiliation utilities (localStorage operations)
- Credential persistence logic
- Fuzzy search algorithm
- Server-side slug generation and collision handling across all sources
- Slug ↔ ID mapping utilities (server-side)

### Integration Tests
- Full library search flow (Cypress)
- Affiliation persistence across page refreshes
- Credential persistence across browser sessions
- Public computer warning behavior

### Edge Cases
- Registry fetch failure (server fallback to last successful state for that registry)
- Server restart (loses in-memory cache, uses static libraries + re-fetches all registries)
- Network issues during registry fetch (server retains last good state per registry)
- Concurrent API requests during registry refresh (server handles with locking/deduplication)
- Library removed from registry (still in user's affiliations - how to handle?)
- Library added to registry with same slug as static library (static wins, registry ignored)
- Same library slug in multiple registries (earlier registry wins)
- Slug collision across static and registry libraries (server-side resolution)
- Slug changes while user is browsing (next page load gets new slug from API)
- Cookie migration from slug-based to ID-based keys (one-time migration on server)
- First-time user with no server cache (uses static libraries until registries fetch)
- Registry fetch times out (server respects min interval for retry on that registry)
- Multiple Next.js server instances (each has own cache - consider Redis for shared state)
- Client requests library by old slug (server resolves via previousSlugs[])
- One registry succeeds, another fails (use successful registry data + last good state from failed)
- Different refresh intervals per registry (each tracks its own timing)

---

## Migration Path

### For Existing Users
- No action required
- Existing cookies continue to work
- Can opt into persistence on next login
- No data loss

### For Existing Deployments
- Config file remains compatible
- Can add registry URL without breaking changes
- Gradual rollout possible (feature flag)

---

## Open Questions for Discussion

1. **Registry Refresh Intervals:** What are the ideal defaults?
   - `refresh_min_interval`: 60 seconds (1 min) - prevents excessive requests
   - `refresh_max_interval`: 300 seconds (5 min) - auto-refresh interval
   - These are now configurable per registry in the `registries` list

2. **Multi-Registry Precedence:** When multiple sources provide a library with the same slug:
   - **Implemented strategy**: Static > Registry[0] > Registry[1] > ...
   - Static libraries always win over registry libraries
   - Earlier registry wins over later registry
   - Should we warn/log when conflicts occur (slug collision)?
   - Should we track which source a library came from in metadata?

3. **Affiliation Limit:** Should there be a max number of affiliated libraries per user?

4. **Credential Expiration:** Should persistent credentials have a shorter expiration than 30 days?

5. **Search Metadata:** Does the registry feed include enough metadata for good search (location, description)?

6. **Offline Support:** Should we implement offline caching of library registry?

7. **Analytics:** Should we track library search queries and affiliation additions?

8. **URL Routing:** Should we support direct links like `/add-library?q=queens` for deep linking?

9. **Slug Algorithm:** What metadata should be used for slug generation from catalog entry?
   - Note: Slug is computed from individual catalog entry (registryFeed.catalogs[n]), not catalog-level metadata
   - Option A: Use `catalogEntry.metadata.id` directly as slug (simplest, but less human-readable)
   - Option B: Slugify `catalogEntry.metadata.title` (human-readable, but more collision risk)
   - Option C: Hybrid (slugify title, append ID fragment if collision)
   - Benefit: Provides flexibility to adjust library base URLs as needs change

10. **Slug Collision Resolution:** How to handle when two libraries compute to the same slug?
    - Note: Precedence prevents some collisions (static > earlier registry)
    - For remaining collisions within same source:
      - Append numeric suffix? (`queens-library-2`)
      - Append ID fragment? (`queens-library-abc123`)
      - Fail and use ID as fallback?
    - Must handle collisions across static libraries AND all registries
    - Collision detection happens during merge phase on server

11. **Cookie Migration:** How to handle existing cookies with slug-based keys?
    - Server-side automatic detection and migration on first API request?
    - Run both old and new keys in parallel temporarily?
    - Clean break (users re-login)?

12. **Historical Slug Limit:** How many previous slugs to maintain per library on server? (Suggested: 5)

13. **Slug Redirect Behavior:** When old slug accessed, should server:
    - Silently resolve to correct library (no redirect)
    - 301 redirect to new slug URL
    - Show user notification banner?

14. **Multi-Instance Deployment:** For scaled deployments with multiple Next.js instances:
    - Keep separate in-memory caches (simpler, eventual consistency)?
    - Use shared cache (Redis/Memcached) for consistency?
    - What are the performance/complexity tradeoffs?

15. **Server Cache Persistence:** Should server cache survive restarts?
    - Persist to disk/database between restarts?
    - Or acceptable to re-fetch from registries after restart?

16. **Client-Safe Properties:** What minimal library properties should be exposed to client?
    - Current: id, slug, title, authDocUrl, logoUrl
    - Should we include: description, location, colors, etc.?
    - Balance between client needs and server-side filtering

---

## Summary

This implementation plan addresses all requirements:

✅ **Runtime library availability** - Libraries become available without rebuild via server-side runtime registry fetching
✅ **Server-side state management** - Registry data cached on server; only client-safe properties exposed to browser
✅ **Library search** - Fuzzy search component to find libraries by name
✅ **Library affiliation** - "Add this library" functionality with localStorage persistence (client-side)
✅ **Multiple affiliations** - Users can be affiliated with multiple libraries
✅ **Affiliation persistence** - Optional browser storage with public computer warnings
✅ **Affiliation management** - Ability to remove persisted affiliations
✅ **Credential persistence** - Optional "Remember me" for login credentials
✅ **Smart home page** - Shows affiliated libraries with option to find more
✅ **ID/Slug separation** - Stable IDs for storage, computed slugs for URLs (server-side computation)
✅ **Intelligent caching** - Server-side min/max interval refresh strategy with fallback to last successful state

The plan maintains backward compatibility, leverages existing patterns (SWR for client, ISR for pages), and provides a clear migration path. The server-side architecture ensures security, reduces client bundle size, and enables centralized slug computation and collision handling. The phased approach allows incremental development and testing.
