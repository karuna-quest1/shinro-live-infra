# Operator scripts

Scripts the team runs by hand against the live Shinro environment (AWS account `425106880357`, `us-east-1`).

| Script | What it does |
|---|---|
| [`delete-sandbox.py`](#delete-sandboxpy) | Deletes a user's demo sandbox and demo chats when they finish testing, and prints how much the sandbox used |

---

## `delete-sandbox.py`

EKS capacity is limited: each sandbox reserves about 0.6 vCPU and 1.25 GiB, and two sandbox nodes fit about 5 sandboxes. Sandboxes expire on their own after 48 hours. When you finish testing, delete yours with this script so the next person can start one.

### Usage

```bash
AWS_PROFILE=<your profile> AWS_REGION=us-east-1 python3 scripts/delete-sandbox.py <registered email>
```

| Option | Effect |
|---|---|
| *(none)* | Shows the sandbox, asks `Delete …? [y/N]`, deletes it, prints the stats |
| `--dry-run` | Shows the sandbox and its usage. Deletes nothing |
| `--yes` | Skips the confirmation prompt |

Use the email the user signs in to Shinro with (their Cognito email).

### Example

```
$ python3 scripts/delete-sandbox.py shrihari@quest1.io
User:       shrihari@quest1.io  (35cd9bc6-…)
Sandbox:    demo-85c615b593fb
Created:    2026-11-13 07:17 UTC
Expires:    2026-11-15 13:32 UTC  (seat 3)
Demo chats: 8 (deleted with the sandbox)

Delete demo-85c615b593fb and 8 demo chat(s) of shrihari@quest1.io? [y/N] y

✅ Sandbox demo-85c615b593fb for shrihari@quest1.io deleted. Seat released. 8 demo chat(s) deleted.

Active for: 8h 14m
CPU:        peak 0.64 vCPU (640m), average 0.02 vCPU (16m)   (reserved 0.60 vCPU (600m))
Memory:     peak 444 MiB, average 227 MiB   (reserved 1.25 GiB)
  temporal                                 peak 8m CPU, 101 MiB
  terminal                                 peak 635m CPU, 372 MiB
```

| Line | Meaning |
|---|---|
| Active for | Time since the sandbox's namespace was created |
| CPU / Memory peak | Highest combined use of all the sandbox's pods |
| CPU / Memory average | Average over the sandbox's whole life |
| reserved | What Kubernetes held for the sandbox (pod requests). This is what fills the nodes, whatever the actual use |
| Per-pod lines | Each pod's own peak: `terminal` (builds and runs code) and `temporal` (the Temporal dev server and UI) |

Stats come from CloudWatch Container Insights and are read before deleting. A sandbox only a few minutes old may have no data yet.

### What it deletes

The script uses the app's own clean-up code, the same code that runs when a sandbox expires after 48 hours:

- **The seat and session record** in Redis. The seat goes back to the pool of 20.
- **The terminal's CLI tokens.** They are revoked.
- **The EKS namespace** `demo-…`, with its terminal and Temporal pods.
- **The user's demo chats**: chat records, their Redis keys and checkpoints, and their S3 files (reports and generated code). These chats link to the deleted sandbox's Temporal UI and terminal, so they are deleted too.
- **Orphan namespaces**: a `demo-…` namespace labelled with the same user but with no session record (for example, left by an API restart while the sandbox was starting).

**Kept:** the user, their login, and any non-demo chats. They can start a new sandbox at any time: **New Migration → Continue** on "Meet the sample app".

> ⚠️ **This cannot be undone.** Download any reports or generated code you want to keep before running it. Don't run it while the user is in the middle of a migration.

### Requirements

- **Python 3.9+.** Standard library only, nothing to install.
- **AWS CLI v2**, signed in to account `425106880357`.
- **IAM permissions:**
  - `ssm:SendCommand` and `ssm:GetCommandInvocation` on the Shinro EC2 (`/shinro/live/shinro/instance-id`)
  - `ssm:GetParameter` on `/shinro/live/shinro/instance-id`
  - `cloudwatch:GetMetricData`

  `ssm:SendCommand` on the Shinro EC2 allows running any command as root on that host. Give it only to people trusted with the host.

### How it works

1. It reads the Shinro EC2's instance id from SSM.
2. Over SSM Run Command, it runs a short Python program inside the `shinro-api` container, using the app's own settings and code. The EKS API is private, so this is the only way in.
3. **Look-up:** the program finds the user by email (`email_index:<email>` in Redis), then their session and every namespace labelled `shinro.ai/user=<user id>`. It also counts their demo chats.
4. From your machine, the script reads the sandbox's CPU and memory from CloudWatch Container Insights.
5. **Delete** (after you confirm):
   - `DemoSessionLeaser.release()` (`agents/demo/sessions.py`) frees the seat, revokes the tokens and deletes the namespace.
   - Orphan namespaces are deleted directly.
   - `purge_demo_conversations()` (`agents/demo/purge.py`) deletes the demo chats.
6. It waits until Kubernetes has removed the namespace (up to about 2.5 minutes), then prints the confirmation and the stats.

### Errors

| Message | Meaning |
|---|---|
| `Not an email address` | Check the argument |
| `No Shinro user has this email` | The person never signed in to Shinro, or the email is spelt differently |
| `… has no sandbox running. Nothing to delete.` | Already deleted or expired |
| `The API container gave no answer` | `shinro-api` is down or restarting, or the backend code the script uses has changed. Nothing was deleted. Report it to the infra owner |
| `still Terminating` | Kubernetes is still removing the pods. They will go on their own. Check with `--dry-run` a minute later |

To see every sandbox in the cluster, with its owner and expiry, use `~/sharon/eks-sandboxes.sh` (ask the infra owner), or check the `ActiveSessions` graph on the `shinro-live` CloudWatch dashboard.

