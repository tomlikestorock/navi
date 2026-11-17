# Rolling back a blue/green deploy

Blue/green releases run the new version beside the old one and switch traffic
at the load balancer. If the new color fails its health checks, flip traffic
back to the previous environment instead of debugging in production.

During an incident the priority is restoring service. Roll back first, then
diagnose the failed release from logs and metrics. Do not attempt to fix
forward while customers are affected.

Promote traffic only after health checks pass for the new environment. Keep the
previous environment running until the release has survived a full traffic
cycle.
