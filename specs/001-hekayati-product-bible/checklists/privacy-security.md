# Privacy & Security Checklist: Hekayati

**Purpose**: Verify child-image privacy, credential isolation, and local-only guarantees.
**Created**: 2026-07-14 | **Feature**: [spec.md](../spec.md) §3.21, Constitution III/XIV

## Credentials

- [ ] CHK201 Gemini key stored only in macOS Keychain; masked display; test/replace/delete flows work (FR-105)
- [ ] CHK202 Key absent from: DB dump, logs after noisy run, export archives, error messages, UI source (FR-106, SC-005 — automated scans)
- [ ] CHK203 Codex auth never read, copied, exported, or logged by Hekayati (FR-100/126)
- [ ] CHK204 Log-redaction unit tests cover key patterns + image bytes (FR-131)
- [ ] CHK205 RR-08 argv-exposure verified/mitigated at Phase 1 (research R8)

## Child-Image Privacy

- [ ] CHK206 Consent recorded (date+note) before any provider call with photos; block message exact (FR-004)
- [ ] CHK207 Provider payloads contain only per-call minimum (audited payload snapshot test) (FR-134)
- [ ] CHK208 GPS/EXIF stripped from working copies; originals never sent to providers (FR-021)
- [ ] CHK209 Permanent deletion removes DB records AND disk media; verified by post-delete FS scan (FR-005)
- [ ] CHK210 Cross-family selection blocked structurally (FR-003)
- [ ] CHK211 Template-from-story strips photos/names/mentions (FR-051 privacy fixture)
- [ ] CHK212 No telemetry/analytics/external calls besides selected provider endpoints (FR-132 — network capture test)

## Local-Only Operation

- [ ] CHK213 Startup refuses non-loopback bind; test proves it (FR-110, EC-H06)
- [ ] CHK214 Data dirs 0700, files 0600 (FR-130)
- [ ] CHK215 No-backup warning on first run + export screen; export labeled "not a backup" (FR-133, EC-H07/08)
- [ ] CHK222 Listener configuration rejects wildcard, LAN, hostname, IPv6, and alternate-loopback values before socket open; the accepted literal `127.0.0.1` listener is independently verified after listen (FR-147, SC-014)
- [ ] CHK223 Exact canonical authority guard rejects missing/malformed `Host`, `localhost`, alternate `127/8`, DNS-rebinding hostnames, and spoofed forwarded-host variants before routing (FR-147, EC-H09)
- [ ] CHK224 Cross-origin CORS and PNA preflights fail with no `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials`, or `Access-Control-Allow-Private-Network` opt-in (FR-148, EC-H10/11)
- [ ] CHK225 Every unsafe method requires an exact `Origin` (exact `Referer` fallback only when absent) plus the current CSRF header; missing, `null`, mismatched, and stale fixtures make zero mutations (FR-148, EC-H12)
- [ ] CHK226 CSRF bootstrap is `Cache-Control: no-store`; restart rotates the runtime-only token, an old tab fails closed, a canonical reload succeeds, and token scans of DB/log/export are empty (FR-148, EC-H13)

## Intake & Archive Safety

- [ ] CHK216 File type validated by content; size limits enforced (FR-022)
- [ ] CHK217 ZIP import rejects traversal/symlink/executable/corrupt/future-version fixtures pre-write (FR-128, EC-G01–G10)
- [ ] CHK218 Import atomic: interrupted-commit fixture leaves zero visible partial state (EC-G08)
- [ ] CHK219 Export secret-scan gate fails archives containing seeded secrets (FR-126, EC-G11)

## Process

- [ ] CHK220 Security review performed on: keychain wrapper, upload handling, export/import, provider adapters (Constitution workflow)
- [ ] CHK221 RR-13 legal review scheduled before commercial launch (consent wording, privacy policy, provider ToS for child images)
