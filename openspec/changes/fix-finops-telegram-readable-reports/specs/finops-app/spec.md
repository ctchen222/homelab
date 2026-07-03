## ADDED Requirements

### Requirement: Safe Telegram HTML rendering
The FinOps assistant SHALL render Telegram report and command responses with safe Telegram HTML formatting when formatting improves readability.

#### Scenario: Formatted Telegram message is sent
- **WHEN** the assistant sends a formatted Telegram report or command response
- **THEN** the Bot API payload includes `parse_mode: HTML`
- **AND** dynamic text from users, ezBookkeeping, watchlist config, errors, LLM output, categories, accounts, aliases, and notes is escaped before rendering

#### Scenario: Telegram rejects malformed HTML entities
- **WHEN** Telegram rejects a formatted message because it cannot parse entities
- **THEN** the assistant retries once with plain text content
- **AND** the retry does not include `parse_mode: HTML`

#### Scenario: Telegram returns a non-HTML delivery error
- **WHEN** Telegram returns a delivery error that is not an HTML entity-parse failure
- **THEN** the assistant does not strip formatting and retry as plain text
- **AND** the delivery failure remains visible through logs and the caller result

#### Scenario: Webhook shortcut response is used
- **WHEN** the assistant returns a Bot API-compatible sendMessage response through the Telegram webhook HTTP response
- **THEN** the response preserves `parse_mode` and inline keyboard markup when present

### Requirement: Concise readable daily report
The FinOps assistant SHALL generate a concise zh-TW daily report for Telegram while preserving visibility into core report sections and partial failures.

#### Scenario: Daily report succeeds
- **WHEN** the daily report schedule runs and ezBookkeeping plus watchlist data are available
- **THEN** the report includes a zh-TW heading, yesterday spending total and count, current-month spending, income, net cashflow, savings rate when calculable, large-expense warnings when present, pending review count, and watchlist summary

#### Scenario: Watchlist config is unavailable or malformed
- **WHEN** the daily report cannot read or parse the configured watchlist
- **THEN** the report status is `partial`
- **AND** the Telegram text clearly marks the watchlist section as unavailable or malformed instead of silently omitting it

#### Scenario: ezBookkeeping data is unavailable
- **WHEN** the daily report cannot fetch ezBookkeeping transactions
- **THEN** the report status is `partial`
- **AND** the Telegram text clearly marks bookkeeping data as unavailable while still including pending review count and watchlist status when possible

#### Scenario: Report artifact is written
- **WHEN** the daily report or end-of-day spending report is generated
- **THEN** the assistant writes a plain-text artifact to the configured report directory
- **AND** the stored report history records the report type, status, summary, and artifact path

### Requirement: Visible LLM commentary failures
The FinOps assistant SHALL treat optional LLM report commentary as non-mutating commentary and make enabled-but-unavailable LLM behavior visible.

#### Scenario: LLM commentary succeeds
- **WHEN** LLM summarization is enabled and returns non-empty commentary
- **THEN** the assistant appends the escaped LLM commentary to the daily report
- **AND** the LLM output does not mutate ezBookkeeping, Wealthfolio, watchlist config, or portfolio records

#### Scenario: LLM commentary is enabled but not configured
- **WHEN** LLM summarization is enabled but the endpoint or token is missing
- **THEN** the report status is `partial`
- **AND** the Telegram text clearly marks LLM commentary as unavailable

#### Scenario: LLM commentary endpoint fails
- **WHEN** the LLM summary endpoint returns an error, throws, or returns empty content
- **THEN** the report status is `partial`
- **AND** the Telegram text clearly marks LLM commentary as unavailable instead of silently treating the report as complete

#### Scenario: LLM receives report context
- **WHEN** the assistant asks the LLM to summarize the report
- **THEN** the request includes risk framing and a plain report context string
- **AND** the request does not grant the LLM any bookkeeping, broker, or portfolio mutation capability
