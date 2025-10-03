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
    refresh_min_interval: 60   # seconds (default: use constant)
    refresh_max_interval: 300   # seconds (default: use constant)
  # Future: support for multiple registries
  # - url: https://another-registry.example.com/libraries
  #   refresh_min_interval: 120
  #   refresh_max_interval: 600
```

**Constants:**
```typescript
// src/constants/registry.ts
export const REGISTRY_REFRESH_MIN_INTERVAL = 60;    // seconds
export const REGISTRY_REFRESH_MAX_INTERVAL = 300;   // seconds
export const CREDENTIAL_EXPIRATION_DAYS = 30;
export const HISTORICAL_SLUG_LIMIT = 5;             // max previous slugs to track
```

---

### 2. Library Search & Affiliation UI

**New Components:**

**a) Library Search Component**
- Location: `src/components/LibrarySearch.tsx`
- Features:
  - Fuzzy search using `fuse.js` (already in dependencies)
  - Initial focus: Search by `catalogEntry.metadata.title` only
  - Display search results with library logos and titles
  - "Add Library" button for each result
  - Future: Expand to include location and description metadata

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
  // Hook function for slug computation - implementation can change as needs evolve
  // catalogEntry is at registryFeed.catalogs[n] level (individual library)
  // NOT catalog-level metadata

  // Initial implementation (for backward compatibility):
  // Use catalogEntry.metadata.id directly
  return catalogEntry.metadata.id;

  // Future: Can update to slugify title, combine fields, etc.
  // This gives flexibility to adjust base URLs per library as needs change
}

// For static libraries: slug is the config key (dictionary key)
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
  logoUrl?: string;     // Cached for offline display
  addedAt: number;      // timestamp
  persist: boolean;     // user's choice to remember
  source: 'static' | string; // 'static' or registry URL for tracking
}

type Affiliations = LibraryAffiliation[];

// Note: No limit on number of affiliations (browser-side storage only)
// Logo images cached by browser for affiliated libraries
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
import { CREDENTIAL_EXPIRATION_DAYS } from 'constants/registry';

// Session (current behavior)
Cookie.set(key, value); // No expires

// Persistent (new)
Cookie.set(key, value, { expires: CREDENTIAL_EXPIRATION_DAYS }); // 30 days default
```

**Login Form Updates:**
- `src/auth/BasicAuthHandler.tsx`
- `src/auth/BasicTokenAuthHandler.tsx`
- Add "Remember my credentials" checkbox
- Show public computer warning (first time only)

---

## Implementation Phases

### Phase 1: Foundation (No UI changes)

1. Create constants file (`src/constants/registry.ts`)
   - Define refresh intervals, expiration days, historical slug limit
   - Ensures easy updates and reuse in tests
2. Create server-side slug generation utility (`src/utils/librarySlug.ts`)
   - Takes individual catalog entry (registryFeed.catalogs[n]) as input
   - Hook function that can evolve: initially uses `catalogEntry.metadata.id`
   - For static libraries: slug is the config key
   - Handles collisions: log error and keep first occurrence
3. Create Next.js API route `/api/libraries` with:
   - Server-side registry fetch logic for multiple registries
   - Min/max interval refresh logic per registry
   - In-memory server cache per registry (Map of registryUrl -> state)
   - Merge strategy: static > registry[0] > registry[1] (earlier wins on slug conflicts)
   - Static libraries cannot be overridden by registry libraries
   - Log collisions with library name and identifier
   - Track source (static or registry URL) for each library
   - Fallback to last successful state per registry (not build-time)
   - Returns only client-safe library properties
4. Create server-side library registry manager (`src/server/libraryRegistry.ts`)
   - Maintains server-side cache per registry
   - Handles fetching from multiple registries
   - Implements min/max interval logic per registry
   - Merges libraries with precedence: static > registry[0] > registry[1] > ...
   - Computes slugs server-side from individual catalog entries
   - Handles slug collisions: static wins, then earlier registry wins
   - Logs collisions and keeps first occurrence
   - No server cache persistence (re-fetch on restart)
5. Update `LibraryData` interface to include `id` field and `source` tracking
6. Create client-side hook `useLibraries` to fetch from `/api/libraries`
7. Create `LibraryAffiliationsContext` for affiliation management (client-side)
   - No limit on number of affiliations
   - Tracks source for each library
8. Add localStorage utilities for affiliations (client-side only)
9. Update `useCredentials` hook to support persistence option and use library ID
   - Clean break for cookie migration (no automatic migration)
10. Add public computer warning modal component
11. Create slug ↔ id mapping utilities (server-side primary, client receives computed values)
12. Implement slug redirect with user notification banner

**Estimated Complexity:** High (server-side architecture shift)

**Key Files:**
- `src/constants/registry.ts` (new) - Constants for intervals, expiration, limits
- `src/pages/api/libraries.ts` (new) - API route for library queries
- `src/server/libraryRegistry.ts` (new) - Server-side registry manager with caching
- `src/utils/librarySlug.ts` (new) - Server-side slug generation hook from catalog entries
- `src/hooks/useLibraries.ts` (new) - Client hook to fetch from API route
- `src/interfaces.ts` (modify) - Add `id` and `source` fields to `LibraryData`
- `src/context/LibraryAffiliationsContext.tsx` (new) - Client-side affiliation management
- `src/utils/libraryAffiliations.ts` (new) - Client-side affiliation storage
- `src/auth/useCredentials.ts` (modify) - Use library ID instead of slug
- `src/components/PublicComputerWarning.tsx` (new)
- `src/components/SlugChangeNotification.tsx` (new) - Banner for slug changes
- `src/dataflow/getLibraryData.ts` (modify) - Include ID in `buildLibraryData`

---

### Phase 2: Library Search & Discovery

1. Create `LibrarySearch` component with fuzzy search
   - Initial search by `metadata.title` only
   - Support for deep linking with query parameter (`/add-library?q=queens`)
2. Create `LibraryAffiliations` management component
3. Update home page (`src/pages/index.tsx`) to show affiliations
4. Add "Find a Library" flow
5. Implement logo caching for affiliated libraries (browser cache)

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
  source: 'static' | string; // 'static' or registry URL
}

// Client-side affiliation (localStorage) - matches updated interface from earlier
export interface LibraryAffiliation {
  id: string;           // Stable identifier
  slug: string;         // URL-friendly (computed server-side)
  title: string;
  authDocUrl: string;
  logoUrl?: string;     // Cached for offline display
  addedAt: number;
  persist: boolean;
  source: 'static' | string; // 'static' or registry URL for tracking
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

// Server-side registry state (per registry URL)
export interface ServerRegistryState {
  libraries: Record<string, ServerLibraryData>; // id -> library data
  lastSuccessfulFetch: number | null;
  lastAttemptedFetch: number | null;
}

// API response type
export interface LibrariesApiResponse {
  libraries: ClientLibraryInfo[];
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
import { HISTORICAL_SLUG_LIMIT } from 'constants/registry';

interface LibraryMapping {
  id: string;
  currentSlug: string;
  previousSlugs?: string[]; // Historical slugs for redirect (max 5)
}

// When server-side registry refreshes:
// 1. Compute new slug from fresh metadata (server-side)
// 2. If slug changed, add old slug to previousSlugs[] in server cache
// 3. Limit previousSlugs to HISTORICAL_SLUG_LIMIT (5)
// 4. API returns updated slug to client
// 5. Client updates affiliations with new slug
// 6. When client requests /[library]/, server checks both current and previous slugs
// 7. If old slug accessed: show notification banner, then redirect to new slug
```

### Backward Compatibility
- Existing build-time library configs continue to work (id = slug for these)
- Registry URL in config is optional
- Credential cookies keyed by ID remain compatible across slug changes
- Affiliations stored by ID remain compatible across slug changes
- Historical slugs (up to 5) provide backwards compatibility for bookmarks
- Cookie migration: Clean break (users must re-login, no automatic migration)
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
- Cookie migration from slug-based to ID-based keys (clean break, no migration)
- First-time user with no server cache (uses static libraries until registries fetch)
- Registry fetch times out (server respects min interval for retry on that registry)
- Multiple Next.js server instances (each has own cache, eventual consistency acceptable)
- Client requests library by old slug (server resolves via previousSlugs[])
- One registry succeeds, another fails (use successful registry data + last good state from failed)
- Different refresh intervals per registry (each tracks its own timing)

---

## Migration Path

### For Existing Users
- Cookie migration: Clean break (users must re-login with new ID-based cookies)
- Can opt into credential persistence on login
- Affiliation data is new (users start fresh)

### For Existing Deployments
- Config file remains compatible (existing `libraries` dictionary works)
- Can add `registries` list without breaking changes
- Static libraries continue to work as-is
- Gradual rollout possible (feature flag for registry support)

---

## Implementation Decisions

The following decisions have been made based on requirements and discussions:

### Decided:
1. **Registry Refresh Intervals**:
   - Min: 60 seconds, Max: 300 seconds (defined in constants)
   - Configurable per registry in config file

2. **Multi-Registry Precedence**:
   - Static > Registry[0] > Registry[1] > ... (earlier wins)
   - Log collisions with library name and identifier
   - Track source (static or registry URL) for each library

3. **Affiliation Limit**: No limit (browser-side storage only)

4. **Credential Expiration**: 30 days (defined in constant)

5. **Search Metadata**: Initial focus on `metadata.title` only

6. **Offline Support**: No registry caching, but cache library logos for affiliations

7. **Analytics**: Not tracking at this time

8. **URL Routing**: Yes, support deep linking with query parameter

9. **Slug Algorithm**: Initially use `catalogEntry.metadata.id` (via hook for future flexibility)

10. **Slug Collision Resolution**:
    - Cannot happen in static libraries (dictionary keys)
    - For registries: Log error and keep first occurrence

11. **Cookie Migration**: Clean break (no automatic migration)

12. **Historical Slug Limit**: 5 (defined in constant)

13. **Slug Redirect Behavior**: Show notification banner, then redirect

14. **Multi-Instance Deployment**: Keep separate in-memory caches

15. **Server Cache Persistence**: No persistence, re-fetch on restart

16. **Client-Safe Properties**: id, slug, title, authDocUrl, logoUrl

## Remaining Open Questions

None at this time. All major architectural decisions have been made.

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
