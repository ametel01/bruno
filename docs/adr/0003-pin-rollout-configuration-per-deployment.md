# Pin rollout configuration per deployment

Each agent deployment records the rollout-configuration generation and exact infrastructure and
validation choices selected when it is accepted. Retries and recovery use those compatible recorded
choices instead of re-reading mutable defaults, preventing a rollback from changing snapshot,
runner size, dispatch, or readiness semantics midway through a deployment. Rollback changes defaults
for new deployments; an active deployment is superseded only by an explicit safety quarantine. This
adds durable configuration metadata but makes crash recovery and rollback deterministic.
