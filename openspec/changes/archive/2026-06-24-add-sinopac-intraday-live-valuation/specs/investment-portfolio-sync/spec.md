## ADDED Requirements

### Requirement: SinoPac intraday live valuation
The investment portfolio sync capability SHALL value SinoPac holdings displayed in Wealthfolio from the broker-provided intraday last price refreshed during Taiwan trading hours, and SHALL NOT override that broker valuation with an end-of-day official-market price source for SinoPac.

#### Scenario: SinoPac valuation is refreshed during trading hours
- **WHEN** a SinoPac broker snapshot is captured during Taiwan trading hours (09:00–13:30 TPE) on a configured intraday cadence of every 15–30 minutes
- **THEN** the system updates the Wealthfolio valuation quote for each SinoPac holding from the snapshot's current `last_price`
- **AND** Wealthfolio's displayed unrealized P/L for SinoPac reflects that current-session price rather than a prior trading day's close

#### Scenario: End-of-day official price does not override broker valuation
- **WHEN** valuation quotes exist for a SinoPac holding
- **THEN** no end-of-day official-market price (for example TWSE/TPEx end-of-day OpenAPI close) is written or selected as the SinoPac valuation price
- **AND** the broker-provided last price is the authoritative valuation source for SinoPac holdings

#### Scenario: Quote is not mislabeled with a later date than its data
- **WHEN** a valuation quote is written for a SinoPac holding
- **THEN** the quote's effective date corresponds to the as-of date of the price data it carries, not the unrelated execution date of the sync job

#### Scenario: Closing price is captured at end of session
- **WHEN** the trading session ends at market close (13:30 TPE)
- **THEN** a SinoPac broker snapshot runs at or after market close on each trading day
- **AND** the broker `last_price` captured by that post-close run becomes the persisted closing valuation for the day

#### Scenario: Valuation outside trading hours
- **WHEN** the market is closed or the day is a non-trading day
- **THEN** the last intraday or post-close broker valuation persists as the displayed SinoPac price
- **AND** the system does not substitute a stale end-of-day official-market price in its place

#### Scenario: SinoPac broker snapshot is unavailable or stale
- **WHEN** the intraday SinoPac broker snapshot fails or its data is older than the configured freshness threshold
- **THEN** the system marks the affected SinoPac valuation as stale or unavailable rather than presenting it as current

#### Scenario: Non-SinoPac holdings are unaffected
- **WHEN** the SinoPac intraday valuation runs
- **THEN** Firstrade US holdings continue to be valued from their own normalized snapshot
- **AND** their valuation source and cadence are not changed by this requirement