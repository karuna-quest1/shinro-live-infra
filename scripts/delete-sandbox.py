#!/usr/bin/env python3
"""Delete a user's demo sandbox when they are done testing, and print what it used.

  AWS_PROFILE=cdk-dev AWS_REGION=us-east-1 python3 scripts/delete-sandbox.py <registered email>
  ... --dry-run   show the sandbox and its usage, delete nothing
  ... --yes       skip the confirmation prompt

What it deletes, through the API's own release path (agents/demo/sessions.py
DemoSessionLeaser.release, run inside the shinro-api container over SSM):
  - the user's session record and seat in Redis (the seat goes back to the pool of 20)
  - the session's terminal CLI tokens (revoked)
  - the EKS namespace demo-..., with the terminal and Temporal pods in it
  - the user's DEMO chats (agents/demo/purge.py, as at expiry): chat records,
    their Redis keys, checkpoints and S3 files (reports, generated code). These
    chats point at the deleted sandbox's Temporal UI and terminal, so they go too.
A namespace labelled with the user but with no session record (an orphan,
e.g. from an API restart during start-up) is deleted too.

Kept: the user, their login, and any non-demo chats. The user can start a new
sandbox later from "Meet the sample app".

Stats come from CloudWatch Container Insights and are read before deleting:
how long the namespace existed, and the peak and average CPU and memory of
all its pods together, plus each pod's peak.

Needs: ssm:SendCommand on the Shinro EC2, cloudwatch:GetMetricData, ssm:GetParameter.
"""
import argparse
import base64
import datetime as dt
import json
import re
import subprocess
import sys
import time

CLUSTER = "shinro-live"
INSTANCE_PARAM = "/shinro/live/shinro/instance-id"
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

# Runs inside the shinro-api container with the app's own settings and code.
REMOTE = r'''
import asyncio, json, os
from dataclasses import asdict

async def main():
    mode, email = os.environ["SBX_MODE"], os.environ["SBX_EMAIL"].strip()
    from memory.redis_repo import initialize_redis, get_redis_repo
    from agents.demo.sessions import DEMO_SESSION_LEASER as leaser
    from agents.demo.kube_sessions import MANAGED_SESSIONS, _label_value
    from kubernetes import client
    await initialize_redis()
    r = await get_redis_repo().get_redis_client()
    out = {"email": email}
    uid = None
    for e in dict.fromkeys([email, email.lower()]):
        v = await r.get(f"email_index:{e}")
        if v:
            uid = v.decode() if isinstance(v, bytes) else v
            break
    if not uid:
        out["error"] = "No Shinro user has this email (they must have signed in at least once)."
        print("SBXJSON" + json.dumps(out)); return
    out["user_id"] = uid
    session = await leaser.get(r, uid)
    out["session"] = asdict(session) if session else None
    cluster = leaser.controller.cluster
    core = client.CoreV1Api(cluster._api_client())
    selector = f"{MANAGED_SESSIONS},shinro.ai/user={_label_value(uid)}"
    out["namespaces"] = [
        {"name": n.metadata.name, "created": n.metadata.creation_timestamp.isoformat(), "phase": n.status.phase}
        for n in core.list_namespace(label_selector=selector).items
    ]
    # Demo chats, counted the way the app's purge picks them.
    from agents.demo.purge import _CONVERSATION_ID
    from schema.schema import ExecutionProfile
    repo = get_redis_repo()
    chats = [c for c in (await repo.get_user_conversations(uid) or [])
             if c.get("execution_profile") == ExecutionProfile.DEMO.value
             and _CONVERSATION_ID.fullmatch(str(c.get("conv_id") or ""))]
    out["demo_chats"] = len(chats)
    if mode == "delete":
        out["released"] = bool(session) and await leaser.release(r, uid)
        out["orphans_deleted"] = [
            n["name"] for n in out["namespaces"]
            if n["name"].startswith("demo-") and (not session or n["name"] != session.session_id)
            and cluster.delete_namespace(n["name"])
        ]
        # Same clean-up the app runs when a session expires (service.py _purge_demo_chats):
        # the chats, their Redis keys, checkpoints and S3 files. Only DEMO chats; others stay.
        from datetime import datetime, timezone
        from agents.demo.purge import purge_demo_conversations
        from memory import initialize_checkpoint_db
        from memory.s3_repo import get_s3_repo
        async with initialize_checkpoint_db() as saver:
            out["chats_deleted"] = await purge_demo_conversations(
                repo, uid, created_before=datetime.now(timezone.utc), s3=get_s3_repo(), checkpointer=saver)
    print("SBXJSON" + json.dumps(out, default=str))

asyncio.run(main())
'''


def aws(*args, parse=True):
    out = subprocess.check_output(["aws", *args, "--output", "json"], text=True)
    return json.loads(out) if parse else out


def remote(instance, mode, email):
    """Run REMOTE in the shinro-api container; returns its JSON result."""
    code = base64.b64encode(REMOTE.encode()).decode()
    cmd = (f"echo {code} | base64 -d | docker exec -i -e SBX_MODE={mode} -e SBX_EMAIL='{email}' "
           "shinro-api /app/.venv/bin/python - 2>/dev/null | grep '^SBXJSON' | tail -1 | cut -c8-")
    cid = aws("ssm", "send-command", "--instance-ids", instance, "--document-name", "AWS-RunShellScript",
              "--comment", f"demo sandbox {mode}", "--parameters", json.dumps({"commands": [cmd]}))["Command"]["CommandId"]
    for _ in range(60):
        time.sleep(2)
        try:
            inv = aws("ssm", "get-command-invocation", "--command-id", cid, "--instance-id", instance)
        except subprocess.CalledProcessError:
            continue
        if inv["Status"] not in ("Pending", "InProgress", "Delayed"):
            break
    out = (inv.get("StandardOutputContent") or "").strip()
    if not out:
        sys.exit(f"The API container gave no answer (SSM status {inv['Status']}): {inv.get('StandardErrorContent', '')[:500]}")
    return json.loads(out)


def usage(namespace, start, end):
    """Peak/avg of the namespace total, and each pod's peak, from Container Insights."""
    seconds = (end - start).total_seconds()
    period = 60 if seconds <= 3 * 86400 else 300
    def search(metric):
        return (f"SEARCH('{{ContainerInsights,ClusterName,Namespace,PodName}} MetricName=\"{metric}\" "
                f"ClusterName=\"{CLUSTER}\" Namespace=\"{namespace}\"', 'Average', {period})")
    queries = []
    for key, metric in (("cpu", "pod_cpu_usage_total"), ("mem", "pod_memory_working_set"),
                        ("cpureq", "pod_cpu_request"), ("memreq", "pod_memory_request")):
        queries += [{"Id": f"{key}pods", "Expression": search(metric), "ReturnData": key in ("cpu", "mem"),
                     "Label": "${PROP('Dim.PodName')}"},
                    {"Id": f"{key}sum", "Expression": f"SUM({key}pods)", "ReturnData": True}]
    res = aws("cloudwatch", "get-metric-data", "--start-time", start.isoformat(), "--end-time", end.isoformat(),
              "--metric-data-queries", json.dumps(queries))["MetricDataResults"]
    by_id = {}
    pods = {"cpu": {}, "mem": {}}
    for r in res:
        if r["Id"].endswith("sum"):
            by_id.setdefault(r["Id"], []).extend(r["Values"])
        else:
            label = r["Label"] or "?"
            pods[r["Id"][:-4]].setdefault(label, []).extend(r["Values"])
    stat = lambda v: (max(v), sum(v) / len(v)) if v else (None, None)
    return {
        "cpu": stat(by_id.get("cpusum", [])), "mem": stat(by_id.get("memsum", [])),
        "cpu_req": max(by_id.get("cpureqsum", []), default=None), "mem_req": max(by_id.get("memreqsum", []), default=None),
        "pods": {p: (max(pods["cpu"].get(p, [0]), default=0), max(pods["mem"].get(p, [0]), default=0))
                 for p in sorted(set(pods["cpu"]) | set(pods["mem"]))},
    }


def duration(seconds):
    h, m = divmod(int(seconds) // 60, 60)
    return f"{h // 24}d {h % 24}h {m}m" if h >= 24 else f"{h}h {m}m"


def cores(m):
    return "-" if m is None else f"{m / 1000:.2f} vCPU ({m:.0f}m)"


def gib(b):
    return "-" if b is None else (f"{b / 2**30:.2f} GiB" if b >= 2**30 else f"{b / 2**20:.0f} MiB")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("email", help="the user's registered (Cognito) email")
    p.add_argument("--dry-run", action="store_true", help="show the sandbox and its usage; delete nothing")
    p.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    a = p.parse_args()
    email = a.email.strip()
    if not EMAIL_RE.match(email):
        sys.exit(f"Not an email address: {email!r}")

    instance = aws("ssm", "get-parameter", "--name", INSTANCE_PARAM)["Parameter"]["Value"]
    info = remote(instance, "info", email)
    if "error" in info:
        sys.exit(info["error"])
    session, namespaces = info["session"], info["namespaces"]
    if not session and not namespaces:
        sys.exit(f"{email} has no sandbox running. Nothing to delete.")

    now = dt.datetime.now(dt.timezone.utc)
    ns = next((n for n in namespaces if session and n["name"] == session["session_id"]), namespaces[0] if namespaces else None)
    name = ns["name"] if ns else session["session_id"]
    created = dt.datetime.fromisoformat(ns["created"] if ns else session["assigned_at"])
    print(f"User:       {email}  ({info['user_id']})")
    print(f"Sandbox:    {name}" + ("" if session else "  (orphan: no session record; seat already free)"))
    print(f"Created:    {created:%Y-%m-%d %H:%M} UTC")
    if session:
        print(f"Expires:    {session['expires_at'][:16].replace('T', ' ')} UTC  (seat {session['seat']})")
    for extra in namespaces:
        if extra["name"] != name:
            print(f"Also:       {extra['name']} (orphan, deleted too)")
    print(f"Demo chats: {info.get('demo_chats', 0)}" + ("" if a.dry_run else " (deleted with the sandbox)"))

    stats = usage(name, max(created, now - dt.timedelta(days=14)), now)

    if a.dry_run:
        print("\n--dry-run: nothing deleted.")
    else:
        if not a.yes and input(f"\nDelete {name} and {info.get('demo_chats', 0)} demo chat(s) of {email}? [y/N] ").strip().lower() not in ("y", "yes"):
            sys.exit("Cancelled. Nothing deleted.")
        result = remote(instance, "delete", email)
        gone = [n for n in [session["session_id"] if result.get("released") else None, *result.get("orphans_deleted", [])] if n]
        if not gone:
            sys.exit("Nothing was deleted (the sandbox may have just expired). Run with --dry-run to check.")
        for _ in range(30):  # wait until Kubernetes has removed the pods
            left = [n["name"] for n in remote(instance, "info", email).get("namespaces", [])]
            if not left:
                break
            time.sleep(5)
        ended = dt.datetime.now(dt.timezone.utc)
        state = "deleted" if not left else f"deleting (still Terminating: {', '.join(left)})"
        print(f"\n✅ Sandbox {', '.join(gone)} for {email} {state}. Seat released. "
              f"{result.get('chats_deleted', 0)} demo chat(s) deleted.")
        now = ended

    print(f"\nActive for: {duration((now - created).total_seconds())}")
    print(f"CPU:        peak {cores(stats['cpu'][0])}, average {cores(stats['cpu'][1])}"
          f"   (reserved {cores(stats['cpu_req'])})")
    print(f"Memory:     peak {gib(stats['mem'][0])}, average {gib(stats['mem'][1])}"
          f"   (reserved {gib(stats['mem_req'])})")
    for pod, (c, m) in stats["pods"].items():
        print(f"  {pod:40} peak {c:.0f}m CPU, {gib(m)}")
    if stats["cpu"][0] is None:
        print("  (no Container Insights data: the sandbox may be younger than a few minutes)")


if __name__ == "__main__":
    main()
