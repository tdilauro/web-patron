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
export const DEFAULT_REGISTRY_REFRESH_MIN_INTERVAL = 60;    // seconds
export const DEFAULT_REGISTRY_REFRESH_MAX_INTERVAL = 300;   // seconds
export const CREDENTIAL_EXPIRATION_DAYS = 30;
export const HISTORICAL_SLUG_LIMIT = 5;             // max previous slugs to track
```

---

### 2. Library Search & Pinning UI

**New Components:**

**a) Library Search Component**
- Location: `src/components/LibrarySearch.tsx`
- Features:
  - Fuzzy search using `fuse.js` (already in dependencies)
  - Initial focus: Search by `catalogEntry.metadata.title` only
  - Display search results with library logos and titles
  - "Pin Library" button for each result
  - Future: Expand to include location and description metadata

**b) Pinned Libraries Manager**
- Location: `src/components/PinnedLibraries.tsx`
- Shows list of user's pinned libraries
- "Visit" and "Unpin" actions per library
- Indicates which libraries have active login credentials
- Unpin confirmation dialog when logged in

**c) Enhanced Home Page**
- Update `src/pages/index.tsx` logic
- Show pinned libraries first (from localStorage)
- UI label: "My Libraries" or simply "Libraries"
- Add "Find a Library" button → opens search modal
- Show warning on first pin about public computers

**UI Flow:**
```
User visits base URL (/)
├─ Has pinned libraries?
│  ├─ Yes → Show "My Libraries" + "Find Another Library"
│  └─ No  → Show "Find Your Library" search
│
User searches for library
├─ Results displayed with metadata
├─ Click "Pin Library" → Save to pinned libraries
└─ Optionally navigate to library catalog
```

---

### 3. Browser Storage Strategy

**Pinned Libraries vs Logged-in Libraries:**

CPW distinguishes between two independent concepts:

1. **Pinned Libraries**: Libraries the user has explicitly added to their personal list
   - User wants to keep them handy (browse catalog, check availability)
   - May or may not be logged in
   - Persisted in localStorage
   - UI label: "My Libraries" or "Libraries"
   - User actions: Pin, Unpin, Visit

2. **Logged-in Libraries**: Libraries where user has active authentication
   - Subset of pinned libraries OR standalone (session-only)
   - Credentials stored in cookies (scoped by library ID)
   - Only persisted if library is pinned + user opted into "Remember me"
   - User actions: Sign in, Sign out

**Key Behaviors:**
- **Pin without login**: User can pin a library just to browse catalog
- **Login without pin**: User can log in for a session, credentials not persisted
- **Pin + Login + "Remember me"**: Credentials persisted (30 days)
- **Unpin while logged in**: Ask user, then clear credentials
- **Logout while pinned**: Clear credentials, library stays pinned
- **"Remember me" checked**: Auto-pin library (persistent credentials require persistent library)

**ID vs Slug Architecture:**

**Important Distinction:**
- **ID**: Stable identifier from registry (`catalog.metadata.id`) or config key. Used for storage scoping (cookies, pinned libraries).
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

**a) Pinned Libraries** (new)
```typescript
// LocalStorage key: CPW_PINNED_LIBRARIES
interface PinnedLibrary {
  id: string;           // Stable identifier (for storage keys)
  slug: string;         // URL-friendly (computed, can change)
  title: string;
  authDocUrl: string;
  logoUrl?: string;     // Cached for offline display
  pinnedAt: number;     // timestamp
  source: 'static' | string; // 'static' or registry URL for tracking
}

type PinnedLibraries = PinnedLibrary[];

// Note: No limit on number of pinned libraries (browser-side storage only)
// Logo images cached by browser for pinned libraries
// Does NOT contain credentials (those are in cookies)
```

**b) Credentials** (only persisted for pinned libraries with "Remember me")
```typescript
// Cookie key (enhanced): CPW_AUTH_COOKIE/{libraryId}
// NOTE: Now scoped to library ID, not slug
interface AuthCredentials {
  token: string;
  methodType: string;
}

// Persistence logic:
// - If library is pinned AND "Remember me" checked: persistent cookie (30 days)
// - Otherwise: session cookie (cleared on browser close)
// - Unpinning a library clears its credentials
```

**Storage Locations:**
- **Pinned Libraries**: `localStorage` (always persistent for pinned libraries)
- **Credentials**: Cookies keyed by library ID
  - Session cookies by default (deleted on browser close)
  - Persistent cookies only if: library is pinned + "Remember me" checked
  - Unpinning clears cookies regardless of persistence type

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

// Session cookie (default, or if library not pinned)
Cookie.set(key, value); // No expires, cleared on browser close

// Persistent cookie (only if library pinned + "Remember me" checked)
Cookie.set(key, value, { expires: CREDENTIAL_EXPIRATION_DAYS }); // 30 days default

// On unpin: always clear
Cookie.remove(key); // Regardless of persistence type
```

**Login Form Updates:**
- `src/auth/BasicAuthHandler.tsx`
- `src/auth/BasicTokenAuthHandler.tsx`
- `src/auth/SamlAuthHandler.tsx`
- `src/auth/CleverAuthHandler.tsx`
- Add two checkboxes:
  - "Remember me on this device" (credential persistence)
  - "Pin this library to My Libraries" (library persistence)
- If "Remember me" checked but library not pinned: show inline warning
- If "Remember me" checked: auto-pin library (persistent credentials require persistent library)
- Show public computer warning (first time for each action)

---

## Deployment Strategy

This implementation will be delivered incrementally across multiple releases. Each release should be independently testable and deployable, providing value while minimizing risk.

### Migration Strategy Summary

**Key Insight:** Add **Release 0** to enable config migration independently from runtime fetching:

1. **Release 0** - Update config parser to support `registries` array (alongside existing formats)
2. **Between releases** - Update production config files from string to array format, rebuild
3. **Release 1** - Enable runtime registry fetching (uses new config format)

This approach allows:
- ✅ **Zero-risk Release 0** - Config parser changes only, no behavior changes
- ✅ **Gradual migration** - Update configs at your own pace between releases
- ✅ **Full compatibility** - Old configs keep working throughout
- ✅ **Clean separation** - Config structure changes separate from runtime logic changes
- ✅ **Easy rollback** - Each release can be independently rolled back

### Release Sequencing Principles

1. **Backend before Frontend** - Deploy server-side capabilities before UI that depends on them
2. **Feature Flags** - Use configuration or environment variables to enable features gradually
3. **Backward Compatibility** - Each release must work with existing deployments
4. **Data Migration** - Handle storage format changes gracefully
5. **Independent Testing** - Each release should be fully testable in isolation
6. **Config First** - Allow config format changes before the code that uses them (Release 0)

### Current Production State

**Important:** Production deployments currently use `libraries` in the config as:
- **Dictionary** (static): `libraries: { nypl: "https://...", queens: "https://..." }`
- **String** (registry): `libraries: "https://registry.example.com/libraries"`

The registry string format fetches at **build time** (see `src/config/fetch-config.js:112-114`).

The new architecture needs to:
1. Support both existing formats during migration
2. Introduce `registries` list without breaking current deployments
3. Gradually migrate registry-based deployments from build-time to runtime fetching

### Proposed Release Sequence

#### Release 0: Config Migration Support (Zero UI Impact)
**Goal:** Update config parsing to support new `registries` list while maintaining backward compatibility

**Scope:**
- Update `src/config/fetch-config.js` to support new config format:
  - `libraries` (object): Static libraries (existing)
  - `libraries` (string): Registry URL - still build-time (existing, deprecated path)
  - `registries` (array): Registry configs for runtime fetching (new)
- Add deprecation warning when `libraries` is a string
- Document migration path in config file

**Config Format Evolution:**
```javascript
// Current production (still supported):
libraries: "https://registry.example.com/libraries"  // Build-time fetch

// New format (backward compatible):
libraries:
  featured-lib: https://...  // Static (optional)
registries:
  - url: "https://registry.example.com/libraries"  // Runtime fetch
    refresh_min_interval: 60
    refresh_max_interval: 300
```

**Testing:**
- Test all three config formats work correctly
- Verify deprecation warning appears for string format
- Validate no behavior change in any deployment

**Deployment Notes:**
- **Zero functional changes** - just enables future config migration
- String `libraries` continues to work (build-time fetch as before)
- New `registries` array has no effect yet (will be used in Release 1)
- Can update production config files to new format at any time

**Migration Path for Deployments:**
1. Deploy Release 0 (supports both old and new config formats)
2. Update config files: convert string `libraries` to `registries` array
3. Rebuild (still build-time fetch, but using new config structure)
4. After Release 1 deployed: runtime fetching automatically enabled

**Feature Flag:** None needed (pure config parsing change)

---

#### Release 1: Server-Side Registry Foundation
**Goal:** Enable runtime library fetching without any UI changes

**Scope:**
- Constants file (`src/constants/registry.ts`)
- Server-side registry manager (`src/server/libraryRegistry.ts`)
- API route `/api/libraries`
- Server-side slug generation utilities
- Use `registries` array from config for runtime fetching
- CLI test utility (`npm run test:registry`)

**Testing:**
- Unit tests for registry manager and API route
- CLI utility validation with real registry endpoints
- Verify static libraries still work unchanged
- Verify build-time registry fetch still works (deprecated path)

**Deployment Notes:**
- Configs with `registries` array now fetch at **runtime** (not build time)
- Configs with string `libraries` still fetch at **build time** (deprecated)
- Configs with object `libraries` (static) unchanged
- No client-side changes means no user impact
- Deployments can migrate configs from string to array format

**Feature Flag:** `ENABLE_RUNTIME_REGISTRY` (default: false, enable when registry array present)

**Migration Checkpoint:**
- Deployments using string `libraries`: Update config to `registries` array, then redeploy
- This shifts from build-time to runtime fetching (after Release 1 deployed)

---

#### Release 2: Library ID Infrastructure
**Goal:** Support stable library IDs alongside slugs

**Scope:**
- Add `id` and `source` fields to `LibraryData` interface
- Update `buildLibraryData` to include ID
- Update `useCredentials` to support both slug and ID (dual-mode)
- Add slug ↔ ID mapping utilities
- Update all storage operations to check for both formats

**Testing:**
- Verify existing slug-based cookies still work
- Verify ID-based cookies work for new libraries
- Test slug changes don't break credentials

**Deployment Notes:**
- Fully backward compatible with existing cookies
- Both slug-based and ID-based cookies work
- No user action required
- Can gradually migrate to ID-only in future release

**Data Migration:** None (dual-mode support during transition)

---

#### Release 3: Pinned Libraries Storage (No UI)
**Goal:** Enable pinned library persistence without UI

**Scope:**
- `PinnedLibrariesContext` implementation
- localStorage utilities for pinned libraries
- Hook to sync pinned libraries with available libraries
- Public computer warning modal component (not yet shown)
- Unpin confirmation dialog component (not yet shown)

**Testing:**
- Unit tests for localStorage operations
- Test localStorage QuotaExceeded handling
- Verify context provides correct data

**Deployment Notes:**
- Components exist but aren't rendered yet
- No UI changes visible to users
- Enables next release to show pinned libraries

**Feature Flag:** None needed (no visible changes)

---

#### Release 4: Enhanced Home Page
**Goal:** Show pinned libraries and search UI

**Scope:**
- `LibrarySearch` component with fuzzy search
- `PinnedLibraries` management component
- Update home page to show "My Libraries" section
- "Find a Library" button and modal
- Deep linking support (`/add-library?q=queens`)
- Public computer warning (shown on first pin)

**Testing:**
- Integration tests for search flow
- Test pinning/unpinning libraries
- Test public computer warning behavior
- Test deep linking to search

**Deployment Notes:**
- Users see new search and pinning UI
- Existing users see "Find Your Library" (no pinned libraries yet)
- Users can start building their library list
- All libraries still accessible (backward compatible)

**Feature Flag:** `ENABLE_LIBRARY_PINNING` (default: true after Release 3)

---

#### Release 5: Credential Persistence Enhancement
**Goal:** Add "Remember me" and pin integration to login forms

**Scope:**
- Update all auth handlers (Basic, Token, SAML, Clever)
- Add two checkboxes to login forms
- Implement persistent vs session cookie logic
- Auto-pin when "Remember me" checked
- Show public computer warning for credentials
- Integrate unpin confirmation dialog

**Testing:**
- Test all auth methods with persistence options
- Test pin + remember me combinations
- Test unpin while logged in
- Test logout while pinned

**Deployment Notes:**
- Existing users see new checkbox options on login
- Session cookies remain default (backward compatible)
- Persistent cookies only when explicitly opted in
- Clean break from old cookie format (users re-login)

**Feature Flag:** `ENABLE_CREDENTIAL_PERSISTENCE` (default: true after Release 4)

**Data Migration:**
- Old cookies (slug-based) continue to work until user re-logins
- New cookies (ID-based with persistence flag) created on new login
- Migration happens naturally over time

---

#### Release 6: Slug Change Handling
**Goal:** Support library metadata changes gracefully

**Scope:**
- Historical slug tracking (max 5 previous slugs)
- Slug change notification banner
- Auto-update pinned libraries when slug changes
- Redirect from old slug to new slug

**Testing:**
- Test slug changes in registry
- Test bookmark with old slug
- Test notification banner display
- Test pinned library updates

**Deployment Notes:**
- Handles registry libraries changing metadata
- User bookmarks remain functional (with redirect)
- Pinned libraries auto-update to new slug
- Notification informs users of URL changes

**Feature Flag:** None needed (handles edge cases gracefully)

---

#### Release 7: Polish & Observability
**Goal:** Production hardening and monitoring

**Scope:**
- Comprehensive test coverage (unit + integration)
- Error tracking for registry fetch failures
- Metrics for search usage, pin rates
- Performance monitoring for `/api/libraries`
- Storybook stories for new components
- Documentation updates
- Accessibility audit

**Testing:**
- Load testing for API route
- Browser compatibility testing
- Accessibility testing with screen readers
- Edge case validation

**Deployment Notes:**
- No new features, only improvements
- Monitoring helps identify issues early
- Documentation helps team maintain code

---

### Config Migration Flow

```
Current Production Configs:
┌─────────────────────────────────────────────────────────────┐
│ Static:                   │ Registry:                       │
│ libraries:                │ libraries:                      │
│   nypl: https://...       │   "https://registry.../libs"    │
│   queens: https://...     │                                 │
│ [Build-time static]       │ [Build-time fetch]              │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    Deploy Release 0
                    (Config parser update)
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Both formats still work - no behavior change                │
│ + New registries array supported (no effect yet)            │
└─────────────────────────────────────────────────────────────┘
                              ↓
                   Update Config Files
                 (Registry deployments migrate)
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Static:                   │ Migrated:                       │
│ libraries:                │ registries:                     │
│   nypl: https://...       │   - url: https://registry...    │
│   queens: https://...     │     refresh_min_interval: 60    │
│ [Build-time static]       │ [Still build-time - no R1 yet]  │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    Deploy Release 1
                (Runtime registry fetching)
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ Static:                   │ Runtime:                        │
│ libraries:                │ registries:                     │
│   nypl: https://...       │   - url: https://registry...    │
│   queens: https://...     │     refresh_min_interval: 60    │
│ [Build-time static]       │ [RUNTIME fetch - no rebuild!]   │
└─────────────────────────────────────────────────────────────┘
```

### Rollback Strategy

Each release should be independently rollback-able:

1. **Release 0:** Simple rollback (only config parser affected, no behavior change)
2. **Release 1-3:** Simple rollback (no user-visible changes, configs stay migrated)
3. **Release 4:** Rollback removes search UI (no data loss)
4. **Release 5:** Rollback disables persistence options (session cookies remain)
5. **Release 6:** Rollback loses slug redirect (bookmarks may break)
6. **Release 7:** Rollback loses monitoring (no functional impact)

**Special Case - Release 0 → Release 1 Rollback:**
- If Release 1 rolled back, migrated configs (using `registries` array) fall back to build-time fetch
- No data loss, just timing change (runtime → build-time)
- Can keep migrated config format even with Release 1 rolled back

### Cross-Release Compatibility

- **Release 0:** Enables config migration without requiring Release 1 (build-time still works)
- **Release 0 + 1:** Config parser supports both old and new formats, Release 1 uses new format for runtime
- **Release 1 + 2:** Registry fetching works with both slug and ID
- **Release 2 + 3:** IDs work for both cookies and pinned libraries
- **Release 3 + 4:** Storage ready before UI shows it
- **Release 4 + 5:** Pinning works before credential persistence
- **Release 5 + 6:** Credentials persist correctly even with slug changes

### Environment-Specific Rollout

**Development:**
- All releases enabled immediately
- Test with real registry endpoints
- Validate CLI utility regularly

**Staging:**
- Enable `ENABLE_REGISTRY_FETCHING` first (Release 1)
- Soak for 1 week, validate no regressions
- Enable subsequent releases with 1-week soak each

**Production:**
- Follow staging by 1-2 weeks
- Enable registries for subset of users first (A/B test)
- Monitor error rates and performance
- Gradual rollout of each release

### Testing Between Releases

- **Regression Suite:** Run after each release
- **Integration Tests:** Validate cross-release compatibility
- **Manual QA Checklist:** Test user flows end-to-end
- **CLI Utility:** Validate registry config before deployment

---

## Implementation Phases

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
4a. Create command-line test utility (`src/scripts/testRegistryManager.ts`)
   - Loads static `libraries` and `registries` from config file
   - Instantiates server-side library registry manager
   - Emits errors/warnings to stderr
   - Emits merged library list as JSON to stdout
   - Usage: `npm run test:registry` or `ts-node src/scripts/testRegistryManager.ts`
   - Helps validate registry manager logic in development
5. Update `LibraryData` interface to include `id` field and `source` tracking
6. Create client-side hook `useLibraries` to fetch from `/api/libraries`
7. Create `PinnedLibrariesContext` for pinned library management (client-side)
   - No limit on number of pinned libraries
   - Tracks source for each library
   - Tracks login status per library
8. Add localStorage utilities for pinned libraries (client-side only)
9. Update `useCredentials` hook to use library ID and check if library is pinned
   - Persistent cookies only for pinned libraries with "Remember me"
   - Clean break for cookie migration (no automatic migration)
10. Add public computer warning modal component (two variants: pin warning, credential warning)
11. Create slug ↔ id mapping utilities (server-side primary, client receives computed values)
12. Implement slug redirect with user notification banner
13. Add unpin confirmation dialog component

**Estimated Complexity:** High (server-side architecture shift)

**Key Files:**
- `src/constants/registry.ts` (new) - Constants for intervals, expiration, limits
- `src/pages/api/libraries.ts` (new) - API route for library queries
- `src/server/libraryRegistry.ts` (new) - Server-side registry manager with caching
- `src/scripts/testRegistryManager.ts` (new) - CLI test utility for registry manager
- `src/utils/librarySlug.ts` (new) - Server-side slug generation hook from catalog entries
- `src/hooks/useLibraries.ts` (new) - Client hook to fetch from API route
- `src/interfaces.ts` (modify) - Add `id` and `source` fields to `LibraryData`
- `src/context/PinnedLibrariesContext.tsx` (new) - Client-side pinned library management
- `src/utils/pinnedLibraries.ts` (new) - Client-side pinned library storage
- `src/auth/useCredentials.ts` (modify) - Use library ID instead of slug
- `src/components/PublicComputerWarning.tsx` (new) - Two variants for pin/credential warnings
- `src/components/UnpinConfirmationDialog.tsx` (new) - Confirm unpin when logged in
- `src/components/SlugChangeNotification.tsx` (new) - Banner for slug changes
- `src/dataflow/getLibraryData.ts` (modify) - Include ID in `buildLibraryData`
- `package.json` (modify) - Add `test:registry` script

---

### Phase 2: Library Search & Discovery

1. Create `LibrarySearch` component with fuzzy search
   - Initial search by `metadata.title` only
   - Support for deep linking with query parameter (`/add-library?q=queens`)
   - "Pin Library" button for each result
2. Create `PinnedLibraries` management component
   - Shows list with login status indicators
   - "Unpin" action with confirmation if logged in
3. Update home page (`src/pages/index.tsx`) to show pinned libraries
   - UI label: "My Libraries" or "Libraries"
4. Add "Find a Library" flow
5. Implement logo caching for pinned libraries (browser cache)

**Estimated Complexity:** Medium-High

**Key Files:**
- `src/components/LibrarySearch.tsx` (new)
- `src/components/PinnedLibraries.tsx` (new)
- `src/pages/index.tsx` (modify)
- `src/components/MultiLibraryHome.tsx` (modify)

---

### Phase 3: Credential Persistence & Login Enhancement

1. Update all login forms to include two checkboxes:
   - "Remember me on this device"
   - "Pin this library to My Libraries"
2. Implement logic: "Remember me" auto-pins library
3. Show inline warning if "Remember me" checked but library not pinned
4. Integrate public computer warning into login/pin flows
5. Update cookie logic to support session vs persistent based on pin status
6. Add "Sign out" functionality that preserves pinned status

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

// Client-side pinned library (localStorage)
export interface PinnedLibrary {
  id: string;           // Stable identifier
  slug: string;         // URL-friendly (computed server-side)
  title: string;
  authDocUrl: string;
  logoUrl?: string;     // Cached for offline display
  pinnedAt: number;     // timestamp
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
- Pinned libraries stored by ID remain compatible across slug changes
- Historical slugs (up to 5) provide backwards compatibility for bookmarks
- Cookie migration: Clean break (users must re-login, no automatic migration)
- No breaking changes to existing API

---

## Security Considerations

1. **Public Computer Warning:**
   - Two separate warnings: one for pinning libraries, one for credential persistence
   - Clear, prominent warning before saving any data
   - Don't auto-dismiss warning
   - Require explicit user action

2. **Credential Storage:**
   - Session cookies by default (cleared on browser close)
   - Persistent cookies only if library is pinned + "Remember me" checked
   - Unpinning a library clears its credentials
   - Consider adding "Clear all data" button in settings

3. **Registry Fetching:**
   - Validate registry feed structure
   - Handle malicious/malformed responses gracefully
   - Set reasonable fetch timeouts
   - Consider CORS implications

4. **localStorage Limits:**
   - Gracefully handle QuotaExceededError
   - Implement cleanup for old pinned libraries if needed
   - No hard limit on pinned libraries (but monitor localStorage usage)

---

## User Experience Enhancements

### User Flow Scenarios

**1. Pin Then Login:**
```
User searches and pins library
  → Pin confirmation + public computer warning
  → Library added to "My Libraries"
  → User navigates to library catalog
  → User clicks "Sign In"
  → Login form shows:
     ☑ "Remember me on this device"
     (Pin checkbox hidden - already pinned)
  → If "Remember me" checked: Persistent cookie (30 days)
  → If unchecked: Session cookie
```

**2. Login Without Pin (Direct URL):**
```
User navigates to library URL directly
  → Not pinned, not logged in
  → User clicks "Sign In"
  → Login form shows:
     ☐ "Remember me on this device"
     ☐ "Pin this library to My Libraries"
  → User checks "Remember me" → auto-checks "Pin" (persistent credentials require pinned library)
  → User can check "Pin" alone → library pinned, session cookie only
  → Submit: Library pinned (if checked) + credentials stored
```

**3. Unpin While Logged In:**
```
User clicks "Unpin" on logged-in library
  → Confirmation dialog:
     "You are currently signed in to [Library].
      Unpinning will sign you out."
     [Cancel] [Unpin and Sign Out]
  → If confirmed:
     - Remove from pinned libraries
     - Clear credentials cookie
```

**4. Logout While Pinned:**
```
User clicks "Sign Out" on pinned library
  → Clear credentials cookie
  → Library remains in "My Libraries"
  → Can sign back in later
```

**5. Returning User:**
```
Visit CPW → See "My Libraries" list
  → Shows pinned libraries with login status
  → Click pinned library:
     - If logged in: Enter catalog (authenticated)
     - If not logged in: See "Sign In" option
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

## Development Tools

### Registry Manager Test Utility

A command-line tool for testing and validating the server-side library registry manager in development environments.

**Location:** `src/scripts/testRegistryManager.ts`

**Purpose:**
- Validate registry manager logic without running full Next.js server
- Test configuration changes quickly
- Debug registry fetching and merging logic
- Verify slug generation and collision handling

**Functionality:**
1. Load configuration from `CONFIG_FILE` environment variable (same as production)
2. Parse static `libraries` and `registries` from YAML config
3. Instantiate the server-side library registry manager
4. Fetch from all configured registries
5. Apply merge logic (static > registry[0] > registry[1] > ...)
6. Generate slugs for all libraries
7. Detect and log any collisions
8. Output results

**Output Specification:**
- **stdout**: JSON array of merged libraries with all fields
  ```json
  [
    {
      "id": "nypl",
      "slug": "nypl",
      "title": "New York Public Library",
      "authDocUrl": "https://...",
      "logoUrl": "https://...",
      "source": "static"
    },
    {
      "id": "queens-library",
      "slug": "queens-library",
      "title": "Queens Library",
      "authDocUrl": "https://...",
      "logoUrl": "https://...",
      "source": "https://registry.thepalaceproject.org/libraries"
    }
  ]
  ```
- **stderr**: Error and warning messages
  - Registry fetch errors
  - Slug collisions (with library name and identifier)
  - Configuration errors
  - Precedence warnings (when registry library overridden by static)

**Usage:**
```bash
# Via npm script
CONFIG_FILE=community-config.yml npm run test:registry

# Direct with ts-node
CONFIG_FILE=community-config.yml ts-node src/scripts/testRegistryManager.ts

# Pipe output for analysis
CONFIG_FILE=config.yml npm run test:registry | jq '.[] | select(.source != "static")'
```

**Implementation Notes:**
- Should use same code paths as production API route
- No caching (always fresh fetch for testing)
- Exit codes:
  - 0: Success (even if warnings)
  - 1: Configuration error
  - 2: Registry fetch failure (all registries failed)
- Can be used in CI for config validation

**package.json addition:**
```json
{
  "scripts": {
    "test:registry": "ts-node src/scripts/testRegistryManager.ts"
  }
}
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

3. **Pinned Library Limit**: No limit (browser-side storage only)

4. **Credential Expiration**: 30 days (defined in constant)

5. **Search Metadata**: Initial focus on `metadata.title` only

6. **Offline Support**: No registry caching, but cache library logos for pinned libraries

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
✅ **Library pinning** - "Pin this library" functionality with localStorage persistence (client-side)
✅ **Multiple pinned libraries** - Users can pin multiple libraries (no limit)
✅ **Pin/Login independence** - Users can pin without logging in, or login without pinning (session-only)
✅ **Credential persistence** - Only for pinned libraries with "Remember me" checked
✅ **Unpin protection** - Confirmation dialog when unpinning logged-in libraries
✅ **Smart home page** - Shows "My Libraries" (pinned libraries) with login status
✅ **ID/Slug separation** - Stable IDs for storage, computed slugs for URLs (server-side computation)
✅ **Intelligent caching** - Server-side min/max interval refresh strategy with fallback to last successful state

The plan maintains backward compatibility, leverages existing patterns (SWR for client, ISR for pages), and provides a clear migration path. The server-side architecture ensures security, reduces client bundle size, and enables centralized slug computation and collision handling. The phased approach allows incremental development and testing.
