# CPW Dynamic Library Affiliation - Implementation Plan

## Current Architecture Summary

### Build-time Configuration
- Libraries are configured via `CONFIG_FILE` environment variable (YAML or registry URL)
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

### 1. Runtime Library Registry Fetching

**Problem:** Libraries are currently fetched at build time and baked into the static bundle.

**Solution:** Implement client-side library registry fetching with caching.

**Key Changes:**
- Create new React Context: `LibraryRegistryProvider`
- Use SWR for fetching registry feed with configurable refresh intervals
- Maintain backward compatibility with build-time config
- Support both static library definitions and registry URLs

**Technical Approach:**
```typescript
// New file: src/context/LibraryRegistryContext.tsx
// - useSWR to fetch registry feed from endpoint
// - Merge with build-time libraries (build-time takes precedence)
// - Auto-refresh every N minutes (configurable)
// - Cache in memory, no localStorage needed for registry itself
```

**Config Changes:**
```yaml
# community-config.yml
libraries:
  # Option 1: Static (current)
  library-slug: https://auth-doc-url

  # Option 2: Registry (enhanced - now fetched at runtime)
  registry_url: https://registry.thepalaceproject.org/libraries
  registry_refresh_interval: 300 # seconds, default 5 min
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

**Storage Architecture:**

**a) Library Affiliations** (new)
```typescript
// LocalStorage key: CPW_LIBRARY_AFFILIATIONS
interface LibraryAffiliation {
  slug: string;
  title: string;
  authDocUrl: string;
  addedAt: number; // timestamp
  persist: boolean; // user's choice to remember
}

type Affiliations = LibraryAffiliation[];
```

**b) Credentials** (enhanced)
```typescript
// Cookie key (existing): CPW_AUTH_COOKIE/{librarySlug}
interface AuthCredentials {
  token: string;
  methodType: string;
  persist?: boolean; // NEW: user's choice
  expiresAt?: number; // NEW: optional expiration
}
```

**Storage Locations:**
- **Affiliations**: `localStorage` (persistent across sessions if user opts in)
- **Credentials**: Cookies (existing mechanism, add persistence option)
  - Session cookies by default (deleted on browser close)
  - Persistent cookies if user opts in (30-day expiration)

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

1. Create `LibraryRegistryContext` for runtime registry fetching
2. Create `LibraryAffiliationsContext` for affiliation management
3. Add localStorage utilities for affiliations
4. Update `useCredentials` hook to support persistence option
5. Add public computer warning modal component

**Estimated Complexity:** Medium

**Key Files:**
- `src/context/LibraryRegistryContext.tsx` (new)
- `src/context/LibraryAffiliationsContext.tsx` (new)
- `src/utils/libraryAffiliations.ts` (new)
- `src/auth/useCredentials.ts` (modify)
- `src/components/PublicComputerWarning.tsx` (new)

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
- Use SWR's built-in caching (memory-based)
- Configurable `refreshInterval` for registry updates
- Fallback to build-time config if registry fetch fails
- Consider implementing `staleWhileRevalidate` pattern

### Routing Strategy
- Current: `/[library]/` requires library in build config
- New: `/[library]/` can resolve from runtime registry
- Maintain `fallback: true` in `getStaticPaths`
- ISR will generate pages on-demand for new libraries

### TypeScript Types
```typescript
// src/interfaces.ts additions
export interface LibraryAffiliation {
  slug: string;
  title: string;
  authDocUrl: string;
  addedAt: number;
  persist: boolean;
}

export interface LibraryRegistryConfig {
  url: string;
  refreshInterval?: number; // seconds
}

export interface EnhancedLibrariesConfig {
  static?: Record<string, string>; // slug -> authDocUrl
  registry?: LibraryRegistryConfig;
}
```

### Backward Compatibility
- Existing build-time library configs continue to work
- Registry URL in config is optional
- Credential cookies remain compatible (just add optional fields)
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

**Minimal (backward compatible):**
```yaml
libraries:
  nypl: https://example.com/nypl/auth
```

**Registry-based (new):**
```yaml
libraries:
  registry_url: https://registry.thepalaceproject.org/libraries
  registry_refresh_interval: 300
```

**Hybrid (static + registry):**
```yaml
libraries:
  static:
    featured-lib: https://example.com/featured/auth
  registry:
    url: https://registry.thepalaceproject.org/libraries
    refresh_interval: 300
```

---

## Testing Strategy

### Unit Tests
- Library registry context (mocked fetch)
- Library affiliation utilities (localStorage operations)
- Credential persistence logic
- Fuzzy search algorithm

### Integration Tests
- Full library search flow (Cypress)
- Affiliation persistence across page refreshes
- Credential persistence across browser sessions
- Public computer warning behavior

### Edge Cases
- Registry fetch failure (fallback to build config)
- localStorage quota exceeded
- Concurrent tab management (multiple CPW tabs)
- Library removed from registry (still in affiliations)

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

1. **Registry Refresh Interval:** What's the ideal default? (5 min, 15 min, 1 hour?)

2. **Affiliation Limit:** Should there be a max number of affiliated libraries per user?

3. **Credential Expiration:** Should persistent credentials have a shorter expiration than 30 days?

4. **Search Metadata:** Does the registry feed include enough metadata for good search (location, description)?

5. **Offline Support:** Should we implement offline caching of library registry?

6. **Analytics:** Should we track library search queries and affiliation additions?

7. **URL Routing:** Should we support direct links like `/add-library?q=queens` for deep linking?

---

## Summary

This implementation plan addresses all requirements:

✅ **Runtime library availability** - Libraries become available without rebuild via runtime registry fetching
✅ **Library search** - Fuzzy search component to find libraries by name
✅ **Library affiliation** - "Add this library" functionality with localStorage persistence
✅ **Multiple affiliations** - Users can be affiliated with multiple libraries
✅ **Affiliation persistence** - Optional browser storage with public computer warnings
✅ **Affiliation management** - Ability to remove persisted affiliations
✅ **Credential persistence** - Optional "Remember me" for login credentials
✅ **Smart home page** - Shows affiliated libraries with option to find more

The plan maintains backward compatibility, leverages existing patterns (SWR, cookies, ISR), and provides a clear migration path. The phased approach allows incremental development and testing.
