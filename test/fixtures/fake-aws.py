#!/usr/bin/env python3
"""Stands in for the AWS CLI when testing bin/render.py. Values come from FAKE_AWS_STATE (JSON)."""
import json
import os
import sys

state = json.load(open(os.environ["FAKE_AWS_STATE"]))
a = sys.argv[1:]
arg = lambda k: a[a.index(k) + 1]

if a[:2] == ["ssm", "get-parameter"]:
    name = arg("--name")
    if name not in state["params"]:
        sys.exit(254)
    print(json.dumps({"Parameter": {"Value": state["params"][name]}}))
elif a[:2] == ["ssm", "get-parameters-by-path"]:
    path = arg("--path")
    items = state["paths"].get(path, {})
    print(json.dumps({"Parameters": [{"Name": f"{path}/{k}", "Value": v} for k, v in items.items()]}))
elif a[:2] == ["secretsmanager", "get-secret-value"]:
    sid = arg("--secret-id")
    if sid not in state["secrets"]:
        sys.exit(254)
    print(json.dumps({"SecretString": state["secrets"][sid]}))
elif a[:2] == ["cognito-idp", "describe-user-pool-client"]:
    print(json.dumps({"UserPoolClient": {"ClientSecret": "secret-for-" + arg("--client-id")}}))
else:
    sys.exit(254)
