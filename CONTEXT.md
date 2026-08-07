# Agent Deployment

This context defines the language used to describe provisioning and making an agent usable for its
owner.

## Language

**Agent Deployment**:
The durable attempt created by an owner's request to make an agent usable. It begins when that
request commits and ends in either readiness or terminal failure.
_Avoid_: Agent creation, creation run

**Cold Deployment**:
An Agent Deployment that creates a new runner only after the owner's request commits. Capacity that
already existed before the request is outside the cold-deployment cohort.
_Avoid_: Cold start, cold run

**Owner**:
The principal with exclusive authority over an agent and any runner assigned to it.
_Avoid_: Tenant, account, runner user

**Same-Owner Reuse**:
Placement of an agent on compatible spare capacity belonging to the same Owner. It is never part of
the Cold Deployment cohort.
_Avoid_: Same-user reuse, shared runner, warm capacity

**Ready Deployment**:
An Agent Deployment whose real Hermes gateway is healthy, whose intended Telegram configuration is
verified, and whose readiness is durably recorded.
_Avoid_: Runner ready, gateway ready, boot ready

**Cold-Deployment SLO**:
At least 95 percent of eligible Cold Deployments must become Ready Deployments within 60 seconds of
the request transaction committing. A terminal failure or timeout misses the objective.
_Avoid_: Successful-run p95, API response time

**Eligible Cold Deployment**:
A real production Owner request that commits and requires a newly created runner. Explicitly tagged
operator trials and deployments cancelled by the Owner before the SLO boundary are excluded;
service and provider failures are not.
_Avoid_: Benchmark trial, successful deployment

**SLO Miss**:
An Eligible Cold Deployment that has not become a Ready Deployment within 60 seconds. An SLO Miss
does not itself stop the deployment from continuing toward readiness or ordinary terminal failure.
_Avoid_: Deployment failure, timeout

**Provider Trial Cohort**:
An authorized, immutable sequence of numbered synthetic deployment attempts used to decide whether
a guarded production rollout may begin. Attempts are never replaced or discarded after the cohort
starts.
_Avoid_: Benchmark sample, successful trials

**Rollout Configuration**:
The versioned set of infrastructure and validation choices assigned to an Agent Deployment. A later
default or rollback does not reinterpret that deployment's recorded choices.
_Avoid_: Current environment, feature flags

**Runner Capacity**:
The number of agents a runner may safely host under an approved resource profile. Missing or stale
capacity evidence reduces capacity rather than permitting optimistic placement.
_Avoid_: Slot count, configured maximum

**Snapshot Attestation**:
Immutable evidence binding a runner snapshot to the exact runner, Hermes, platform, and boot-contract
identities that were validated together. It does not expire merely because time passes.
_Avoid_: Snapshot metadata, image name

**Approved Snapshot**:
A Snapshot Attestation currently authorized for new Cold Deployments. Approval may be superseded or
revoked without changing the attestation itself.
_Avoid_: Latest snapshot, valid snapshot

**Verified Release**:
Immutable evidence that an Approved Snapshot and the exact control-plane-to-runner contract were
successfully exercised together using the full boot fixture.
_Avoid_: Successful build, deployed revision

**Admitted Runner**:
A runner accepted for agent placement after presenting the required snapshot, release, identity,
registration, heartbeat, and readiness evidence.
_Avoid_: Booted runner, healthy machine

**Observed Check**:
Evidence measured directly from the runner currently seeking admission.
_Avoid_: Attested check, release evidence

**Attested Check**:
Historical evidence imported from the exact Approved Snapshot or Verified Release and not rerun on
the runner currently seeking admission.
_Avoid_: Observed check, current health
