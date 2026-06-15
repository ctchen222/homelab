## ADDED Requirements

### Requirement: Guided Telegram bookkeeping drafts
The FinOps workspace SHALL guide allowlisted Telegram users through bookkeeping drafts before writing transactions to ezBookkeeping.

#### Scenario: Quick sentence creates a draft
- **WHEN** an allowlisted Telegram user sends a quick bookkeeping sentence such as `lunch 120` or `coffee 80`
- **THEN** the assistant creates an expense bookkeeping draft with the recognized amount, default currency, default local transaction date, and note text
- **AND** the assistant asks for any missing category, account, or confirmation details instead of storing the message only as pending review

#### Scenario: Explicit type overrides quick sentence expense default
- **WHEN** an allowlisted Telegram user sends a quick bookkeeping sentence with explicit income or transfer wording such as `income salary 50000`, `收入 salary 50000`, `transfer 1000`, or `轉帳 1000`
- **THEN** the assistant creates a draft for the explicit transaction type instead of defaulting to expense
- **AND** the assistant still asks for missing category, account, transfer account, or confirmation details before writing anything to ezBookkeeping

#### Scenario: Quick sentence includes a daily bookkeeping date
- **WHEN** an allowlisted Telegram user sends a quick bookkeeping sentence containing `今天`, `昨天`, `前天`, `YYYY-MM-DD`, or `MM/DD`
- **THEN** the assistant stores the parsed transaction date on the draft
- **AND** invalid or future dates are rejected without changing the existing draft or writing a transaction

#### Scenario: Draft waits for explicit confirmation
- **WHEN** a guided bookkeeping draft has enough type, transaction date, amount, currency, category, and account information to create a transaction
- **THEN** the assistant displays a confirmation summary before writing to ezBookkeeping
- **AND** the confirmation summary includes transaction date, type, amount, currency, category, account, and note
- **AND** the transaction is not written until the user presses an explicit confirm action

#### Scenario: User edits a draft before confirmation
- **WHEN** an allowlisted Telegram user chooses to edit type, transaction date, amount, category, account, or note from the confirmation step
- **THEN** the assistant updates the existing draft and returns to the appropriate guided step without creating a transaction

#### Scenario: Active draft text replies update the current step
- **WHEN** an allowlisted Telegram user has an active guided bookkeeping draft and sends an ordinary text reply
- **THEN** the assistant interprets the text according to the current draft step before running the generic message parser
- **AND** amount entry, custom date entry, note entry, known category names, known account names, and new category names update the active draft without creating a second draft

#### Scenario: Active draft blocks a new quick sentence
- **WHEN** an allowlisted Telegram user has an active guided bookkeeping draft and sends a new quick sentence such as `dinner 200`
- **THEN** the assistant does not create a second guided draft
- **AND** the assistant asks the user to resume or cancel the existing draft

#### Scenario: User cancels a draft
- **WHEN** an allowlisted Telegram user cancels an active guided bookkeeping draft
- **THEN** the assistant marks the draft as cancelled and does not write a transaction to ezBookkeeping

#### Scenario: Draft expires
- **WHEN** a guided bookkeeping draft is older than the configured expiry time
- **THEN** the assistant rejects further callback or message actions for that draft
- **AND** the assistant does not write a transaction to ezBookkeeping

#### Scenario: Existing text commands continue to work
- **WHEN** an allowlisted Telegram user sends a fully supported text command such as `expense <amount> [currency] <category> <account>` or `overview today`
- **THEN** the assistant continues to handle the existing command behavior without requiring the guided button flow

#### Scenario: Slash commands bypass active draft text handling
- **WHEN** an allowlisted Telegram user has an active guided bookkeeping draft and sends a supported slash command such as `/help`, `/cancel`, or `/status`
- **THEN** the assistant handles the slash command according to its existing command semantics instead of treating it as ordinary draft text

### Requirement: Telegram inline keyboard option discovery
The FinOps workspace SHALL display ezBookkeeping categories and accounts as Telegram inline keyboard options during guided bookkeeping.

#### Scenario: Category options are shown
- **WHEN** a guided expense or income draft needs a category
- **THEN** the assistant reads available ezBookkeeping categories for the relevant transaction type
- **AND** the assistant sends Telegram inline keyboard buttons for selectable categories

#### Scenario: Account options are shown
- **WHEN** a guided draft needs a payment account or income account
- **THEN** the assistant reads available ezBookkeeping accounts
- **AND** the assistant sends Telegram inline keyboard buttons for selectable accounts

#### Scenario: Options require pagination
- **WHEN** the available category or account options exceed the configured button page size
- **THEN** the assistant provides pagination buttons instead of omitting reachable options

#### Scenario: Callback data is compact
- **WHEN** the assistant renders a category, account, pagination, edit, confirm, or cancel button
- **THEN** the Telegram callback data contains only a short draft identifier, action identifier, and compact option identifier
- **AND** the assistant resolves full category, account, transaction, and user state from server-side storage or ezBookkeeping APIs
- **AND** the callback data stays within Telegram's callback data size limit

#### Scenario: ezBookkeeping options cannot be read
- **WHEN** ezBookkeeping category or account discovery fails because the API is unavailable or the token is invalid
- **THEN** the assistant tells the user the setup is unavailable
- **AND** the assistant preserves the draft without pretending the option selection succeeded

### Requirement: Telegram button implementation contract
The FinOps workspace SHALL implement guided bookkeeping buttons as explicit Telegram inline keyboard state transitions.

#### Scenario: Draft step controls available buttons
- **WHEN** a guided draft is waiting for type, date, category, account, new-category parent, new-category confirmation, or final confirmation
- **THEN** the assistant renders only the inline keyboard buttons that are valid for that current draft step
- **AND** actions from other draft steps are rejected without mutating the draft

#### Scenario: Type selection buttons are rendered
- **WHEN** a guided draft needs transaction type selection or the user edits transaction type
- **THEN** the assistant renders inline buttons for expense, income, transfer, and cancel
- **AND** pressing a type button updates the existing draft instead of creating a second draft

#### Scenario: Date selection buttons are rendered
- **WHEN** a guided draft needs transaction date selection or the user edits transaction date
- **THEN** the assistant renders inline buttons for today, yesterday, the day before yesterday, custom date, back, and cancel
- **AND** pressing a date shortcut stores the matching local transaction date on the existing draft

#### Scenario: Category buttons are rendered from ezBookkeeping IDs
- **WHEN** a guided draft needs category selection
- **THEN** each selectable category button uses the ezBookkeeping category display name as button text
- **AND** each category callback contains only the draft identifier, category action, and ezBookkeeping category identifier
- **AND** pressing a category button stores the selected category on the existing draft

#### Scenario: Account buttons are rendered from ezBookkeeping IDs
- **WHEN** a guided draft needs account selection
- **THEN** each selectable account button uses the ezBookkeeping account display name as button text
- **AND** each account callback contains only the draft identifier, account action, and ezBookkeeping account identifier
- **AND** pressing an account button stores the selected account on the existing draft

#### Scenario: Pagination buttons update the same prompt
- **WHEN** a user presses a category or account pagination button
- **THEN** the assistant updates the existing Telegram prompt or keyboard to show the requested option page
- **AND** the assistant does not change the selected category, selected account, amount, date, note, or transaction type

#### Scenario: Confirmation buttons are rendered only for complete drafts
- **WHEN** a guided draft has all required fields for its transaction type
- **THEN** the assistant renders confirm, edit, and cancel inline buttons with the confirmation summary
- **AND** pressing confirm writes at most one ezBookkeeping transaction for the draft

#### Scenario: Button tap updates the Telegram prompt
- **WHEN** a valid guided-flow button is pressed
- **THEN** the assistant acknowledges the callback query
- **AND** the assistant edits the existing Telegram message text or reply markup when Telegram allows it
- **AND** the assistant sends a new prompt only when the existing Telegram message cannot be edited

#### Scenario: Invalid or stale button tap is acknowledged
- **WHEN** a user taps a malformed, stale, expired, unauthorized, or step-invalid guided-flow button
- **THEN** the assistant acknowledges the callback query
- **AND** the assistant does not write a transaction, create a category, or mutate unrelated draft state

### Requirement: Guarded Telegram category creation
The FinOps workspace SHALL allow Telegram category creation only through an explicit guided confirmation flow.

#### Scenario: User starts category creation from a draft
- **WHEN** an allowlisted Telegram user chooses to create a new category while selecting a category for a guided draft
- **THEN** the assistant asks for the new category name and parent category before creating anything in ezBookkeeping

#### Scenario: Unknown text is not auto-created
- **WHEN** a quick sentence or text reply contains a category name that does not map to an existing ezBookkeeping category
- **THEN** the assistant does not automatically create the category
- **AND** the assistant offers the guided category creation path or asks the user to choose an existing category

#### Scenario: Category creation is confirmed
- **WHEN** an allowlisted Telegram user confirms a new category name, transaction type, and parent category in the guided flow
- **THEN** the assistant creates the category through the ezBookkeeping API
- **AND** the assistant can immediately use the created category in the active draft

#### Scenario: Category creation fails
- **WHEN** ezBookkeeping rejects or fails the guided category creation request
- **THEN** the assistant preserves the active draft and reports the failure
- **AND** the assistant does not mark the transaction draft as confirmed

#### Scenario: Account creation is requested
- **WHEN** an allowlisted Telegram user tries to create a new account or payment method from the guided bookkeeping flow
- **THEN** the assistant declines or defers the account creation request
- **AND** the assistant asks the user to choose an existing ezBookkeeping account

### Requirement: Telegram callback idempotency and security
The FinOps workspace SHALL process Telegram callback queries with the same safety guarantees as message updates.

#### Scenario: Webhook receives a callback query
- **WHEN** Telegram sends a `callback_query` update to `POST /telegram/webhook`
- **THEN** the assistant extracts the callback user, chat, message, callback identifier, and callback data
- **AND** the assistant routes the callback to the guided bookkeeping state machine

#### Scenario: Callback user is unauthorized
- **WHEN** a Telegram callback query comes from a user not in the allowlist
- **THEN** the assistant rejects the callback and does not reveal finance data or mutate draft state

#### Scenario: Callback is acknowledged
- **WHEN** the assistant receives any supported or rejected Telegram callback query
- **THEN** it sends an `answerCallbackQuery` response or equivalent acknowledgement so the Telegram client does not leave the button spinner active

#### Scenario: Confirm callback is retried
- **WHEN** Telegram retries a confirm callback or the user taps confirm more than once
- **THEN** the assistant writes at most one ezBookkeeping transaction for the draft
- **AND** later callbacks report that the draft was already handled

#### Scenario: Old callback is tapped
- **WHEN** a user taps a button for a draft that is already confirmed, cancelled, expired, or failed
- **THEN** the assistant rejects the action without writing a transaction or reopening the draft

#### Scenario: Production webhook is configured
- **WHEN** guided Telegram bookkeeping is enabled in production webhook mode
- **THEN** the Telegram webhook registration includes `callback_query` in `allowed_updates`
- **AND** production verification checks `getWebhookInfo` before treating the guided flow as ready

### Requirement: Guided bookkeeping verification
The FinOps workspace SHALL verify each guided bookkeeping behavior through tests and production-safe evidence before treating the flow as ready.

#### Scenario: Unit tests cover a full expense flow
- **WHEN** the guided bookkeeping tests run
- **THEN** they verify quick sentence intake, expense defaulting, daily date parsing, category button rendering, account button rendering, confirmation rendering, ezBookkeeping write, and duplicate-confirm prevention for an expense draft

#### Scenario: Unit tests cover guarded category creation
- **WHEN** the guided category creation tests run
- **THEN** they verify no category is created before explicit confirmation
- **AND** they verify the created category can be used in the active draft after ezBookkeeping accepts it

#### Scenario: Unit tests cover failure states
- **WHEN** ezBookkeeping returns an error, the token is invalid, a callback is unauthorized, or a draft is expired
- **THEN** tests verify that the assistant does not mark the draft confirmed and does not create a duplicate or silent transaction

#### Scenario: Unit tests cover active draft text routing
- **WHEN** the guided bookkeeping tests run
- **THEN** they verify ordinary text replies update the active draft step before the generic parser runs
- **AND** they verify a new quick sentence during an active draft does not create a second draft

#### Scenario: Production smoke test preserves clean data
- **WHEN** the guided bookkeeping flow is smoke-tested against the VPS deployment
- **THEN** the operator records the transaction count before the test, creates one clearly marked non-production transaction, verifies it appears in ezBookkeeping, deletes or reverts that transaction, and records that the transaction count returned to the pre-test value
