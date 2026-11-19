# Stretch AWS preflight

The AWS deployment branch stopped at preflight. PowerShell could not resolve the `aws` command, and the standard Windows AWS CLI v2 installation path did not exist. The current environment contained no AWS configuration or credential variables, and the standard shared configuration, shared credential file, and SSO cache were absent.

The command `aws sts get-caller-identity` therefore yielded no verified identity. No AWS account or deployment region was verified. The kickoff default for a future verified preflight is `ca-central-1`.

Cost estimation and CDK authoring begin after successful identity verification. Synth, diff, deployment, smoke verification, destruction, residual-resource inspection, and actual-cost verification were skipped at this gate. This run incurred no AWS deployment charges and provisioned no AWS resources.

The [read-only ops console](../README.md#read-only-ops-console) is the independent local deliverable.
