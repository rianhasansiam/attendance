# Interface languages

The interface supports English (`en`, default) and Simplified Chinese (`zh-CN`). Existing URLs and API field values are unchanged. No database migration is required for localization.

## Selection and persistence

The accessible language selector appears on login, the shared desktop/mobile header, and public profiles. `POST /api/locale` validates the allowlist and stores `attendance-locale` for one year with `Path=/`, `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS. Invalid or absent preferences resolve to English; browser language does not override this default.

After the cookie is saved, Next.js refreshes the current Server Component tree. Components have no locale-based root key, so routes, query parameters, filters, pagination, input nodes, unsaved values, sessions, and Redux state remain in place. A failed update keeps the current interface and displays a translated retry message.

`src/i18n/request.ts` resolves each request independently. The root renders the matching HTML `lang` and initial provider messages together, behind a Suspense boundary. Loading fallbacks use a client translation leaf so they do not read request cookies outside Suspense. Browser titles and descriptions are rendered with the selected locale using [React 19 metadata hoisting](https://react.dev/reference/react-dom/components/title), so they are present in server HTML and update with the provider. This also handles authorization redirects without Next.js 16.3’s cookie-dependent `generateMetadata` validation edge case. Framework validation remains enabled. Cached data remains language-neutral; translated output is request-scoped. The root sends shared messages, and feature providers send only the current workspace's selected-language namespaces. No browser translation service is used.

This follows the [next-intl App Router integration](https://next-intl.dev/docs/getting-started/app-router) and [request configuration](https://next-intl.dev/docs/usage/configuration). Version 4.14.7 supports the installed Next.js 16 and React 19 peer ranges.

## Implementation map

| Files                                                                 | Purpose                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `messages/en/*.json`, `messages/zh-CN/*.json`                         | Matching feature dictionaries with ICU sentences and plurals.                                                                |
| `src/i18n/*`, `next.config.ts`                                        | Typed keys, request locale, English fallback, providers, localized metadata, safe errors, and decimal-safe money formatting. |
| `src/app/api/locale/route.ts`, `src/components/language-switcher.tsx` | Validated persistent preference and language switching without route changes or form resets.                                 |
| `src/app/*`, `src/components/*`, `src/store/use-query-view.ts`        | Localized layouts, authentication, workspaces, forms, feedback, query errors, accessibility labels, dates, and numbers.      |
| `src/modules/reports/*`, expense report modules and API routes        | Locale-aware human-readable PDF exports while preserving JSON/data contracts.                                                |
| `src/assets/fonts/NotoSansCJKsc-Regular.otf`, accompanying license    | Server-only Chinese PDF glyphs, alongside existing Latin/Bengali fonts.                                                      |
| `tests/*`, `tests/e2e/localization.spec.ts`                           | Dictionary, fallback, formatting, error, export, state-preservation, and browser regression coverage.                        |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`               | Compatible `next-intl`, ICU validation parser, and explicit optional build-script settings.                                  |

## Editing translations

Translations live in matching JSON files under `messages/en/` and `messages/zh-CN/`, grouped into `common`, `navigation`, `auth`, `employee`, `admin`, `expenses`, and `reports`.

1. Add a descriptive stable key to the relevant English namespace and its Chinese counterpart.
2. Use `useTranslations("namespace")` in client/shared components or `await getTranslations("namespace")` in async Server Components. Keep complete sentences together and interpolate dynamic values.
3. Use ICU plurals/selects when grammar or status varies. Keep interpolation names identical in both dictionaries.
4. Keep stored names, notes, custom categories, addresses, API identifiers, enum values, and audit JSON unchanged. Translate only display labels.
5. Run `pnpm exec vitest run tests/localization.test.ts` and `pnpm typecheck`. Typed keys are declared in `src/i18n/types.d.ts`.

When adding an entirely new namespace, register it in `src/i18n/messages.ts`, the type declaration, and the relevant `FeatureMessages` provider. Keep feature dictionaries out of the shared login payload.

The loader explicitly merges missing Chinese entries with English and logs the missing paths during development. Tests compare all keys and parsed ICU arguments, reject empty messages, and validate ICU syntax. A missing message never renders a raw key; the runtime error handler provides a safe English fallback if both dictionaries lack a key.

API errors use an allowlist of public messages and stable error codes in `src/i18n/errors.ts`. Unknown internal errors display a generic localized message. Add new public error translations to `common.errors` or `common.validation`; do not surface arbitrary server exception text.

## Formatting and exports

Dates and times use the selected locale while keeping the original date-only value or configured office/ledger timezone. Currency codes remain unchanged (including BDT), and decimal-safe ledger formatting preserves large amounts without floating-point conversion. Attendance, overtime, leave, and financial calculations are untouched.

Human-readable PDF headings, statuses, summaries, and dates use the locale cookie. JSON responses, filenames, enum identifiers, and stored content retain their contracts. PDF output embeds local Hind Siliguri fonts for Latin/Bengali and Noto Sans CJK SC for Chinese; these font files are server assets and are not downloaded by the web interface. The web interface uses installed system CJK fonts.

Browser date pickers, native HTML validation bubbles, password-manager UI, biometric/passkey prompts, geolocation permission dialogs, Google consent screens, and OS installation prompts follow browser/provider/OS settings. The application cannot force their language. Existing installed PWA names may require reinstallation for a refreshed localized manifest.

## Verification

Automated coverage includes dictionary/ICU completeness, explicit fallback, locale allowlisting and cookie attributes, safe error mapping, preserved financial amounts/timezones/overtime, live form and feedback translation, PDF text/glyph bounds, and browser language persistence/state/authorization on desktop and mobile.

Browser and database integration tests require a disposable PostgreSQL database whose name includes `test`. They must not use the application's production database. See the main README for database setup and the test commands.

### Validation record — 2026-09-28

The following checks were actually run. Database tests used two separate databases in a disposable local PostgreSQL cluster on port `55479`; the production database and `.env` were not changed. Existing migrations were applied only to these test databases. No deployment or new schema migration was performed. The temporary database and browser test servers were stopped after validation.

| Exact command                                                                                    | Final result                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                 | Passed; no `--force` or `--legacy-peer-deps` used.                                    |
| `pnpm lint`                                                                                      | Passed, no lint errors or warnings.                                                   |
| `pnpm typecheck`                                                                                 | Passed, route generation and TypeScript checks.                                       |
| `pnpm format:check`                                                                              | Passed.                                                                               |
| `pnpm db:validate`                                                                               | Passed.                                                                               |
| `pnpm build`                                                                                     | Passed, production compilation and route generation.                                  |
| `TEST_DATABASE_URL='postgresql://i18n_test@127.0.0.1:55479/attendance_i18n_unit_test' pnpm test` | Passed: 93 suites, 1,246 tests, no skipped tests.                                     |
| `TEST_DATABASE_URL='postgresql://i18n_test@127.0.0.1:55479/attendance_i18n_test' pnpm test:e2e`  | Passed: 101 browser tests, including all 16 localization scenarios; no skipped tests. |
| `pnpm exec prettier --check docs/localization.md messages/**/*.json`                             | Passed.                                                                               |
| `git diff --check`                                                                               | Passed.                                                                               |

PDF verification included automated text/glyph and page-bound checks plus visual inspection of English/Chinese reports with Bengali user content and a long Chinese entry spanning three pages. Browser screenshots covered representative desktop/mobile login, reports, navigation, and employee screens in both languages.

Non-failing diagnostics included Node experimental Web Crypto warnings and PostgreSQL client deprecation warnings. Next.js development validation also logged `NEXT_REDIRECT` diagnostics for intentionally denied admin navigation; the browser authorization and runtime-error checks passed, and production builds completed. Framework validation has not been disabled.
