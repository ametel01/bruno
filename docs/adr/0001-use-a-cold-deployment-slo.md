# Use a cold-deployment SLO without pre-created capacity

Agent deployment must be measured from the durable acceptance of a user's request until the real
Hermes gateway, intended Telegram configuration, and readiness record are all usable. At least 95
percent of eligible cold deployments must reach that state within 60 seconds, with failures and
timeouts counted as misses. Runners may not be created before the request merely to satisfy this
SLO; although pre-created capacity would make the target easier and less provider-dependent, it
would measure a different product and cost model. Thirty authorized trials may unlock guarded
rollout, but the SLO is proven only by the latest 100 eligible production cold deployments. Missing
the 60-second boundary records an SLO miss without terminating work that can still become ready.
Historical deployments without the accepted boundary are diagnostic evidence, not members of the
new SLO cohort. Synthetic trials cannot substitute for missing production observations. Acceptance
is decided by ready-within-60-seconds counts—at least 29 of 30 authorized provider trials and 95 of
the latest 100 eligible production deployments—not by a percentile calculated only from successful
runs. Valid requests that fail before commit affect a separate API-acceptance availability measure.
The latest-100 status is evaluated continuously and can regress after it has first been proven.
