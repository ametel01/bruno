# Separate identity, commerce, and product entitlement

Clerk proves Founder identity and session state, while Lemon Squeezy acts as Merchant of Record for
checkout, payments, refunds, and subscription state. Bruno.Ai remains authoritative for Release
Stage admission, the internal Owner mapping, Product Entitlement, business authority, and product
data. A one-time opaque Checkout Correlation binds checkout to an internal Owner; checkout email,
Clerk identity, redirects, and browser success never grant entitlement. Paid operation begins only
after a signature-verified Lemon Squeezy event is recorded idempotently and reconciled with current
provider state. This separation adds an explicit reconciliation boundary but prevents either an
identity session or an unverified commerce notification from becoming product authority.
