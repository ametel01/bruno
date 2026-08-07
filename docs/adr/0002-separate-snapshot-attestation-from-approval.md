# Separate immutable snapshot attestation from revocable approval

A snapshot attestation permanently binds a DigitalOcean snapshot to the exact validated runner,
default-agent, Hermes, platform, and boot-contract identities; time alone does not invalidate that
evidence. Production approval is instead represented by the exact manifest digest selected through
protected configuration, so operators can supersede or revoke a snapshot without rewriting its
history. Promotion replaces the selected digest, revocation removes it, and rollback restores a
retained previously approved compatible digest. Source revision remains provenance rather than an
unrelated control-plane compatibility constraint. Lightweight boot validation requires both the
snapshot attestation and a verified release attestation joined by immutable artifact and contract
identities; the release workflow does not receive DigitalOcean credentials or boot the provider
snapshot again. Signed bundles are retained in digest-addressed long-lived storage, with production
pinning the exact bundle digest and preserving at least the active and previous approved bundles.
Bundles are published as OCI artifacts in GHCR and identify their Ed25519 signing key. Production
trusts an operator-managed key set so a replacement key can overlap with rollback evidence before
the old key is explicitly removed.
