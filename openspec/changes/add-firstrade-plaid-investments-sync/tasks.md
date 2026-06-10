## 1. Plaid Feasibility Gates

- [ ] 1.1 Confirm Plaid Investments coverage for Firstrade through Plaid-approved coverage or Link flows.
- [ ] 1.2 Document Plaid production access, billing/pricing exposure, Investments Refresh costs, and owner approval requirements.
- [ ] 1.3 Define owner depermission, token deletion, and data retention behavior before any real Firstrade Plaid Item is created.
- [ ] 1.4 Add validation checklist entries for Firstrade Plaid coverage, owner consent, field coverage, and pricing approval.

## 2. Connector State and Authorization

- [ ] 2.1 Add private Plaid connector state schema for item IDs, access-token references, account IDs, webhook cursor/state, error state, and refresh timestamps.
- [ ] 2.2 Add secret/config wiring for Plaid client credentials and token references without committing plaintext secrets.
- [ ] 2.3 Add owner-only Plaid Link token creation and public-token exchange endpoints behind the private FinOps boundary.
- [ ] 2.4 Add redaction rules for Plaid access tokens, item IDs, account IDs, request IDs, and raw Plaid payloads.

## 3. Firstrade Plaid Sync

- [ ] 3.1 Add a Plaid Investments broker adapter descriptor with `candidate-approval-required` until gates are satisfied.
- [ ] 3.2 Implement holdings and balances fetch from Plaid Investments and normalize accounts, holdings, securities, prices, cost basis, market values, cash, currency, and source timestamps into `SnapshotEnvelope`.
- [ ] 3.3 Implement investment transactions import as activity rows without treating transactions alone as verified current holdings.
- [ ] 3.4 Mark snapshots partial when Plaid omits cost basis, market value, price, security metadata, cash, or transactions.
- [ ] 3.5 Preserve Firstrade CSV/export import as fallback and prevent duplicate normalized snapshots across Plaid and CSV sources.

## 4. Refresh, Webhooks, and Failure Handling

- [ ] 4.1 Add Plaid refresh flow with conservative retry budgets and source freshness updates.
- [ ] 4.2 Add webhook handling for item updates and investments refresh completion where supported.
- [ ] 4.3 Classify item login required, MFA, permission, consent expired, institution unavailable, and rate-limit states into non-sensitive sync events.
- [ ] 4.4 Preserve last known good snapshots when Plaid refresh fails and avoid tight retry loops.

## 5. Deployment and Operations

- [ ] 5.1 Add Docker/Helm wiring for disabled-by-default Firstrade Plaid sync jobs and private Plaid secrets.
- [ ] 5.2 Add operations runbook steps for Plaid Link authorization, real-data preview, scheduled enablement, depermission, billing review, rollback, and token purge.
- [ ] 5.3 Add tests for sandbox fixtures, missing coverage, missing credentials, nullable Plaid fields, owner depermission, rate limits, item login required, and write-capable operation refusal.
- [ ] 5.4 Verify unit tests, OpenSpec validation, Helm lint, and Helm template rendering with Plaid jobs disabled by default.
