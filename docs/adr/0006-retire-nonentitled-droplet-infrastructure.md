# Retire non-entitled Droplet infrastructure

A stopped or powered-off DigitalOcean Droplet remains billable, so Bruno.Ai destroys the exact
Droplet and firewall when free beta access or Product Entitlement ends rather than preserving the
runtime indefinitely. Before the hard destruction deadline, Bruno.Ai attempts a verified encrypted
Recovery Archive outside the Droplet; archive failure is recorded as critical but does not extend
billable infrastructure beyond the agreed deadline. Retirement remains incomplete until work is
stopped, runtime credentials are disabled, and authoritative provider checks prove that no billable
runtime resource remains. A retained archive may restore the same logical Operator onto new
infrastructure for 30 days, after which the archive and recovery-only credentials are automatically
deleted. This trades seamless preservation of infrastructure identity for a clear cost boundary and
bounded, verifiable recovery.
