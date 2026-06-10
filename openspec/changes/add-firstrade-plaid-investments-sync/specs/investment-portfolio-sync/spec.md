## ADDED Requirements

### Requirement: Firstrade Plaid Investments live connector
The investment portfolio sync capability SHALL support Firstrade live sync through Plaid Investments only after Firstrade institution coverage, owner authorization, pricing, field coverage, and read-only terms are confirmed.

#### Scenario: Plaid coverage is not confirmed
- **WHEN** the system cannot confirm Firstrade Investments coverage for the owner's account through Plaid-approved coverage or Link flows
- **THEN** the Firstrade Plaid connector remains disabled and the system continues to use Firstrade CSV/export import as fallback

#### Scenario: Owner authorizes Plaid Link
- **WHEN** the owner completes Plaid Link authorization for Firstrade with Investments consent
- **THEN** the system stores Plaid connector tokens and item metadata only in private secrets or connector storage and does not store Firstrade passwords, OTPs, browser sessions, or mobile-app sessions

#### Scenario: Plaid holdings sync succeeds
- **WHEN** Plaid returns Firstrade investment accounts, holdings, securities, balances, and source timestamps
- **THEN** the system stores normalized holdings and cash balances with broker `firstrade`, source type `live-api`, source name `plaid-investments`, account alias, symbols, quantities, prices, market values, cost basis where available, currencies, and source freshness

#### Scenario: Plaid fields are incomplete
- **WHEN** Plaid omits cost basis, market value, current price, cash, security metadata, or transaction data for one or more rows
- **THEN** the system marks the affected snapshot or rows as partial and does not fabricate missing investment values

#### Scenario: Plaid transaction data is available without holdings
- **WHEN** Plaid returns transactions but cannot verify current holdings or balances
- **THEN** the system records activity rows only and does not mark Firstrade current positions or cash as verified

### Requirement: Plaid connector operational safety
The investment portfolio sync capability SHALL manage Plaid refresh, webhooks, rate limits, billing, and depermission with explicit owner-approved production gates.

#### Scenario: Production sync is requested
- **WHEN** Firstrade Plaid scheduled sync or refresh is enabled
- **THEN** the system requires owner approval for Plaid production access, pricing/billing exposure, token retention, webhook handling, and scheduled refresh cadence

#### Scenario: Plaid reports login or consent failure
- **WHEN** Plaid returns item login required, MFA, consent expired, permission, institution unavailable, or item error states
- **THEN** the system records a non-sensitive sync event, preserves the last known good snapshot with its own freshness, and avoids tight retry loops

#### Scenario: Plaid reports rate limiting
- **WHEN** Plaid returns endpoint or institution rate-limit responses
- **THEN** the system applies backoff, records a rate-limited sync event, and does not retry faster than the configured retry budget

#### Scenario: Owner revokes Plaid access
- **WHEN** the owner deauthorizes Firstrade Plaid access or requests connector deletion
- **THEN** the system disables scheduled sync, deletes or deauthorizes Plaid connector tokens according to Plaid-supported behavior, and preserves or purges normalized snapshots according to the owner-selected retention policy

#### Scenario: Write-capable behavior is requested
- **WHEN** any workflow requests Firstrade trade execution, order mutation, cash movement, or account mutation through Plaid or Firstrade
- **THEN** the system refuses the operation because the Plaid connector is read-only portfolio context only
