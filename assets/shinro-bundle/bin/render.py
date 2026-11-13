#!/usr/bin/env python3
"""Render everything the Shinro EC2 runs from what CDK published.

Reads by name, at boot and on every release (bin/roll.sh):
  SSM             /shinro/live/streams, /shinro/live/shinro/config, identity,
                  camunda and eks values, /shinro/live/release/* (optional)
  Secrets Manager cookie secrets, the Camunda assessment secret, the CloudFront
                  origin secret, and the app's own settings (shinro-live/shinro/*-env)
  Cognito         each app client's secret (DescribeUserPoolClient)

Writes run/ (mode 600, root only): images.env, api.env, tool-exec.env,
oauth2-<stream>.env, compose.streams.yaml and nginx/*.conf.
Nothing secret is ever in the bundle, an image or the repo (PLAN 3.5).

Standard library only, plus the AWS CLI that ships with Amazon Linux 2023.
"""
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUN = ROOT / "run"
NGINX = RUN / "nginx"


def aws(*args, default=None):
    """Run the AWS CLI and parse its JSON. Missing optional values return `default`."""
    proc = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if proc.returncode != 0:
        if default is not None:
            return default
        sys.exit(f"render.py: aws {' '.join(args[:2])} failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


def param(name, default=None):
    out = aws("ssm", "get-parameter", "--name", name, default={} if default is not None else None)
    return out.get("Parameter", {}).get("Value", default)


def params_by_path(path):
    out = aws("ssm", "get-parameters-by-path", "--path", path, "--recursive", default={})
    return {p["Name"][len(path) + 1:]: p["Value"] for p in out.get("Parameters", [])}


def secret(name, default=None):
    out = aws("secretsmanager", "get-secret-value", "--secret-id", name,
              default={} if default is not None else None)
    return out.get("SecretString", default)


def json_secret(name):
    """Optional JSON object of extra settings; {} if missing or empty."""
    raw = secret(name, default="")
    try:
        value = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        sys.exit(f"render.py: {name} must hold a JSON object of NAME: value pairs")
    return {str(k): str(v) for k, v in value.items()}


def client_secret(pool_id, client_id):
    out = aws("cognito-idp", "describe-user-pool-client", "--user-pool-id", pool_id, "--client-id", client_id)
    return out["UserPoolClient"]["ClientSecret"]


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.chmod(tmp, mode)
    tmp.replace(path)


def env_file(values):
    for k, v in values.items():
        if "\n" in v:
            sys.exit(f"render.py: {k} contains a newline")
    return "".join(f"{k}={v}\n" for k, v in values.items())


# ---------------------------------------------------------------- inputs

cfg = json.loads(param("/shinro/live/shinro/config"))
streams = json.loads(param("/shinro/live/streams"))
region, registry = cfg["region"], cfg["registry"]
identity = params_by_path("/shinro/live/identity")
pool_id = identity["pool-id"]
camunda_ip = param("/shinro/live/camunda-private-ip")


def imds(path):
    token_req = urllib.request.Request("http://169.254.169.254/latest/api/token", method="PUT",
                                       headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"})
    token = urllib.request.urlopen(token_req, timeout=5).read().decode()
    req = urllib.request.Request(f"http://169.254.169.254/latest/meta-data/{path}",
                                 headers={"X-aws-ec2-metadata-token": token})
    return urllib.request.urlopen(req, timeout=5).read().decode()


my_ip = os.environ.get("RENDER_LOCAL_IP") or imds("local-ipv4")  # override for local tests only

release = {**cfg["releaseDefaults"], **params_by_path("/shinro/live/release")}
image = lambda name: f"{registry}/{release[f'{name}-image']}" if "/" not in release[f"{name}-image"] else release[f"{name}-image"]

# ---------------------------------------------------------------- images

write(RUN / "images.env", env_file({
    "AWS_REGION": region,
    "API_IMAGE": image("api"),
    "TOOL_EXEC_IMAGE": image("tool-exec"),
    **{f"{k.upper()}_IMAGE": v for k, v in cfg["supportImages"].items()},
}))

# ---------------------------------------------------------------- the API
primary = streams[0]  # FRONTEND_URL is a single value today (gotcha 5.24)
route_secret = secret("shinro-live/shinro/temporal-ui-route-secret")
api_env = {
    "REDIS_HOST": "redis",
    "REDIS_PORT": "6379",
    # Its own default is redis://redis-stack:6379/0 and ignores REDIS_HOST.
    "SEMANTIC_CACHE_REDIS_URL": "redis://redis:6379/0",
    "AWS_REGION": region,
    # Master password for everything the API encrypts into Redis (Camunda
    # configs, LLM credentials). Without it the API disables encryption and
    # every save returns 503. Never regenerate it: existing records are
    # encrypted with this value and nothing else can read them.
    "AUTH_SECRET": secret("shinro-live/shinro/auth-secret"),
    # Where reports and inventory files go. Without it the Camunda inventory
    # tool fails before it runs: "S3 bucket not configured."
    "DOC_BUCKET_NAME": cfg["docsBucket"],
    "FRONTEND_URL": f"https://{primary['subdomain']}",
    "COOKIE_SECURE": "true",
    "OAUTH_PROVIDER": "cognito",
    "OAUTH_REDIRECT_URI": f"https://{primary['subdomain']}/v2/oauth/callback",
    "COGNITO_REGION": region,
    "COGNITO_USER_POOL_ID": pool_id,
    "COGNITO_CLIENT_ID": identity["api-client-id"],
    "COGNITO_CLIENT_SECRET": client_secret(pool_id, identity["api-client-id"]),
    "COGNITO_DOMAIN": identity["login-url"],
    # Camunda, back channel only: private IP, Keycloak token (CAMUNDA-DEPLOYMENT section 6).
    "DEMO_CAMUNDA_DEPLOYMENT_MODE": "self_managed",
    "DEMO_CAMUNDA_AUTH_METHOD": "oidc",
    "DEMO_CAMUNDA_ZEEBE_ADDRESS": f"grpc://{camunda_ip}:26500",
    "DEMO_CAMUNDA_REST_URL": f"http://{camunda_ip}:8080",
    "DEMO_CAMUNDA_OPERATE_URL": f"http://{camunda_ip}:8080",
    "DEMO_CAMUNDA_AUTH_URL": f"http://{camunda_ip}:18080/auth/realms/camunda-platform/protocol/openid-connect/token",
    "DEMO_CAMUNDA_CLIENT_ID": "shinro-assessment",
    "DEMO_CAMUNDA_CLIENT_SECRET": secret("shinro-live/camunda/shinro-assessment-client-secret"),
    "DEMO_CAMUNDA_AUDIENCE": "orchestration-api",
    # Sessions on EKS, one namespace per user. The API signs in to the cluster by
    # name with the instance role (agents/demo/eks_auth.py); no kubeconfig.
    "DEMO_SESSION_CONTROLLER": "kubernetes",
    "DEMO_EKS_CLUSTER": cfg["eksClusterName"],
    "DEMO_EKS_REGION": region,
    # Session pods tolerate the sandbox taint and select these nodes.
    "DEMO_SANDBOX_NODE_POOL": cfg["sandboxNodePool"],
    # Terminals call the API through its public address, never a private path.
    "DEMO_SESSION_API_URL": f"https://{primary['subdomain']}/v2",
    "DEMO_TERMINAL_IMAGE": image("terminal"),
    "DEMO_TEMPORAL_IMAGE": image("temporal"),
    "DEMO_IMAGE_PULL_POLICY": "IfNotPresent",
    "DEMO_SHINRO_API_IP": my_ip,
    # Each session's own Temporal, by its service name inside the session namespace.
    # Without it the demo catalog has no target (PLAN 3.5).
    "DEMO_TEMPORAL_ADDRESS": "temporal:7233",
    "DEMO_TEMPORAL_UI_URL": f"https://{cfg['temporalUiHost']}",
    "DEMO_SESSION_TTL_HOURS": str(cfg["sessionTtlHours"]),
    "DEMO_SESSION_MAX_ACTIVE": str(cfg["sessionMaxActive"]),
    # The Camunda console link in the chat, shown with the shared read-only login
    # below. Both halves must be the ones camunda-bundle's identity container
    # seeded into Keycloak -- print anything else and the prospect gets
    # "Invalid username or password" on Operate (CAMUNDA-DEPLOYMENT 5.5).
    "DEMO_CAMUNDA_CONSOLE_URL": f"https://{cfg['camundaHost']}/operate",
    "DEMO_CAMUNDA_CONSOLE_USERNAME": cfg["camundaDemoUsername"],
    "DEMO_CAMUNDA_CONSOLE_PASSWORD": secret("shinro-live/camunda/demo-user-password"),
    # nginx sends it on the internal Temporal UI lookup; the API refuses the call without it.
    "DEMO_TEMPORAL_UI_ROUTE_SECRET": route_secret,
    # ActiveSessions, SessionStartFailures, LlmSpendUsd: the alarms wait for these (step 8).
    "DEMO_METRICS_NAMESPACE": cfg["metricsNamespace"],
    # No /docs, /redoc or /openapi.json in production (nginx blocks them too).
    "API_DOCS_ENABLED": "false",
}
# The app team's own settings (LLM keys and the rest) win over the defaults above.
api_env.update(json_secret("shinro-live/shinro/api-env"))
write(RUN / "api.env", env_file(api_env))

write(RUN / "tool-exec.env", env_file({
    "REDIS_HOST": "redis", "REDIS_PORT": "6379", "AWS_REGION": region,
    # The inventory tool uploads the report here. It also arrives as a stream
    # param from the API; this is the fallback its own code reads.
    "DOC_BUCKET_NAME": cfg["docsBucket"],
    **json_secret("shinro-live/shinro/tool-exec-env"),
}))

# ---------------------------------------------------------------- oauth2-proxy, one per stream
# Guards the consoles only; the app signs users in itself.
compose_streams = {"services": {}}
for s in streams:
    name = s["name"]
    ident = lambda key: identity[f"streams/{name}/{key}"]
    client_id = ident("client-id")
    write(RUN / f"oauth2-{name}.env", env_file({
        "OAUTH2_PROXY_PROVIDER": "oidc",
        "OAUTH2_PROXY_OIDC_ISSUER_URL": identity["issuer-url"],
        "OAUTH2_PROXY_CLIENT_ID": client_id,
        "OAUTH2_PROXY_CLIENT_SECRET": client_secret(pool_id, client_id),
        "OAUTH2_PROXY_COOKIE_SECRET": secret(ident("cookie-secret-arn")),
        "OAUTH2_PROXY_COOKIE_NAME": f"_shinro_{name}",
        "OAUTH2_PROXY_COOKIE_DOMAINS": f".{cfg['domain']}",
        "OAUTH2_PROXY_WHITELIST_DOMAINS": f".{cfg['domain']}",
        "OAUTH2_PROXY_COOKIE_SECURE": "true",
        "OAUTH2_PROXY_COOKIE_EXPIRE": f"{cfg['sessionHours']}h",
        "OAUTH2_PROXY_COOKIE_REFRESH": "1h",
        # The session lives in Redis; the cookie carries only a ticket.
        # With the cookie store a Cognito session (id + access + refresh tokens)
        # is over 4kb, so oauth2-proxy splits it across several Set-Cookie
        # headers and re-emits them on the auth_request subrequest. nginx then
        # refuses the oversized header block ("upstream sent too big header"),
        # scores a valid 202 as 502, and answers 500 -- two requests in three
        # on camunda-demo, intermittently on temporal-demo (2026-11-12).
        # Its own database: db 0 belongs to the app.
        "OAUTH2_PROXY_SESSION_STORE_TYPE": "redis",
        "OAUTH2_PROXY_REDIS_CONNECTION_URL": "redis://redis:6379/2",
        "OAUTH2_PROXY_SCOPE": "openid email profile",
        "OAUTH2_PROXY_CODE_CHALLENGE_METHOD": "S256",
        "OAUTH2_PROXY_OIDC_GROUPS_CLAIM": "cognito:groups",
        "OAUTH2_PROXY_ALLOWED_GROUPS": ident("group"),
        "OAUTH2_PROXY_EMAIL_DOMAINS": "*",
        "OAUTH2_PROXY_REVERSE_PROXY": "true",
        "OAUTH2_PROXY_SET_XAUTHREQUEST": "true",
        "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON": "true",
        "OAUTH2_PROXY_UPSTREAMS": "static://202",
        "OAUTH2_PROXY_HTTP_ADDRESS": "0.0.0.0:4180",
    }))
    compose_streams["services"][f"oauth2-proxy-{name}"] = {
        "image": cfg["supportImages"]["oauth2Proxy"],
        "container_name": f"oauth2-proxy-{name}",
        "env_file": [f"./run/oauth2-{name}.env"],
        "restart": "unless-stopped",
        # It keeps its sessions there, so it must not start first.
        "depends_on": {"redis": {"condition": "service_healthy"}},
        "networks": ["shinro"],
        "logging": {"driver": "awslogs", "options": {
            "awslogs-region": region, "awslogs-create-group": "false",
            "awslogs-group": f"/shinro-live/shinro/oauth2-proxy-{name}"}},
    }
write(RUN / "compose.streams.yaml", json.dumps(compose_streams, indent=2), mode=0o644)

# ---------------------------------------------------------------- nginx
origin_secret = secret("shinro-live/edge/origin-secret")
ui = cfg["uiBucketHost"]
cert = f"/etc/letsencrypt/live/{cfg['domain']}"

PROXY_HEADERS = """
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header X-Forwarded-Port  443;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        $connection_upgrade;
    # Never trust identity headers from a client (gotcha 5.7).
    proxy_set_header X-Auth-Request-Email "";
    proxy_set_header X-Auth-Request-User  "";
    proxy_set_header X-Auth-Request-Groups "";"""

S3_HEADERS = f"""
    proxy_http_version 1.1;
    proxy_set_header Host {ui};
    proxy_set_header Authorization "";
    proxy_set_header Cookie "";
    proxy_hide_header Set-Cookie;
    proxy_hide_header x-amz-id-2;
    proxy_hide_header x-amz-request-id;
    proxy_hide_header x-amz-server-side-encryption;
    proxy_ssl_server_name on;
    proxy_intercept_errors on;"""

stream_map = "\n".join(f"  {s['subdomain']} {s['name']};" for s in streams)
app_conf = f"""# Generated by bin/render.py. App paths, from CloudFront only (PLAN 1.11).
map $host $stream {{
  default "";
{stream_map}
}}
map $http_x_shinro_origin $origin_ok {{
  default 0;
  "{origin_secret}" 1;
}}

server {{
  listen 80 default_server;
  server_name _;

  # CloudFront adds this header; anything else reaching :80 is refused.
  if ($origin_ok = 0) {{ return 403; }}
  if ($stream = "") {{ return 404; }}

  # API docs are never public (backend, 2026-11-10).
  location ~ ^/(docs|redoc|openapi\\.json)(/|$) {{ return 404; }}
  location ~ ^/v2/(docs|redoc|openapi\\.json)(/|$) {{ return 404; }}
  # Internal lookup for the Temporal UI console; never from outside.
  location ^~ /v2/demo/temporal-ui/ {{ return 404; }}

  location /v2/ {{
    set $api http://shinro-api:8000;
    proxy_pass $api;{PROXY_HEADERS}
    proxy_read_timeout 300s;
  }}

  # The terminal websocket: a quiet terminal must not be dropped (gotcha 5.27).
  location /v2/demo/terminal {{
    set $api http://shinro-api:8000;
    proxy_pass $api;{PROXY_HEADERS}
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }}

  # The built UI, per stream, from the private bucket (only this VPC may read it).
  # The UI is a single-page app: it serves every page, "/" included.
  location /assets/ {{
    proxy_pass https://{ui}/$stream$uri;{S3_HEADERS}
    add_header Cache-Control "public, max-age=31536000, immutable" always;
  }}
  # Other real files at the UI's root (favicon.ico, robots.txt, images...).
  location ~ "^/[^/]+\\.[A-Za-z0-9]+$" {{
    proxy_pass https://{ui}/$stream$uri;{S3_HEADERS}
    add_header Cache-Control "public, max-age=3600" always;
  }}
  # Every other path is a page of the app: index.html, never cached, so a new
  # release shows at once. The app's router decides what each page shows.
  location / {{
    proxy_pass https://{ui}/$stream/index.html;{S3_HEADERS}
    add_header Cache-Control "no-cache" always;
  }}
}}
"""
write(NGINX / "10-app.conf", app_conf, mode=0o640)


# nginx's default is a single 4k buffer for an upstream's response headers,
# which is less than a Set-Cookie block carrying OIDC tokens. Too small and
# nginx discards the response: on an auth_request subrequest that reads as 502,
# which auth_request has no handler for, so the user gets 500. Sessions live in
# Redis now, but the headroom stays -- a 500 is the worst way to learn this.
AUTH_BUFFERS = """
    proxy_buffer_size 16k;
    proxy_buffers 4 16k;
    proxy_busy_buffers_size 32k;"""


def oauth2_blocks(proxy):
    return f"""
  # Variables, so nginx starts even before the proxy container is up.
  location /oauth2/ {{
    set $oauth2 http://{proxy}:4180;
    proxy_pass $oauth2;
    proxy_set_header Host                    $host;
    proxy_set_header X-Real-IP               $remote_addr;
    proxy_set_header X-Forwarded-Proto       https;
    proxy_set_header X-Forwarded-Host        $host;
    proxy_set_header X-Auth-Request-Redirect $request_uri;{AUTH_BUFFERS}
  }}
  location = /oauth2/auth {{
    internal;
    set $oauth2 http://{proxy}:4180;
    proxy_pass $oauth2;
    proxy_pass_request_body off;
    proxy_set_header Content-Length    "";
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Uri   $request_uri;{AUTH_BUFFERS}
  }}
  location @signin {{ return 302 https://$host/oauth2/start?rd=$request_uri; }}"""


def tls(host):
    return f"""
  listen 443 ssl;
  http2 on;
  server_name {host};
  ssl_certificate     {cert}/fullchain.pem;
  ssl_certificate_key {cert}/privkey.pem;"""


def console_servers(host, body):
    """One console's server blocks: :80 for CloudFront (origin-checked) and :443 until the cutover.

    Behind CloudFront, a request without the origin secret is someone reaching the
    server directly: send it to the public https address instead of serving it.
    """
    return f"""
server {{
  listen 80;
  server_name {host};
  if ($origin_ok = 0) {{ return 301 https://$host$request_uri; }}
  # This connection is plain http from CloudFront; the browser's is https.
  # Relative Location headers, so nginx's own redirects never say http://.
  absolute_redirect off;
{body}
}}
server {{{tls(host)}
{body}
}}"""


# e.g. 10\.60\.[0-9]{1,3}\.[0-9]{1,3}: Temporal UI traffic only to this VPC's addresses (a /16).
vpc_ip_regex = cfg["vpcPrefix"].replace(".", r"\.") + r"\.[0-9]{1,3}\.[0-9]{1,3}"

consoles = []
# Camunda login attempts per client IP (the Camunda console has no Cognito gate).
CONSOLE_ZONES = "limit_req_zone $binary_remote_addr zone=camunda_login:1m rate=10r/m;\n"
for s in streams:
    proxy = f"oauth2-proxy-{s['name']}"
    for host in s.get("consoles", []):
        if host == cfg["camundaHost"]:
            # No Cognito gate (oauth2-proxy) here, by decision 2026-11-13: Camunda's
            # own Keycloak login (the shared, read-only demo account) is the only
            # login. CAMUNDA-DEPLOYMENT section 3: /auth to Keycloak, the rest to Camunda.
            # Keycloak only serves its login for the camunda-platform realm; its admin
            # console, the master realm and the account console (where the shared
            # demo user could change everyone's password) are refused.
            consoles.append(console_servers(host, f"""
  location = / {{ return 302 /operate; }}
  location ^~ /auth/admin/ {{ return 404; }}
  location ^~ /auth/realms/master/ {{ return 404; }}
  location ^~ /auth/realms/camunda-platform/account {{ return 404; }}
  # Password and code posts: slow down guessing.
  location ^~ /auth/realms/camunda-platform/login-actions/ {{
    limit_req zone=camunda_login burst=10 nodelay;
    limit_req_status 429;
    set $kc {camunda_ip}:18080;
    proxy_pass http://$kc$request_uri;{PROXY_HEADERS}
  }}
  location ^~ /auth/realms/camunda-platform/ {{
    set $kc {camunda_ip}:18080;
    proxy_pass http://$kc$request_uri;{PROXY_HEADERS}
  }}
  location ^~ /auth/resources/ {{
    set $kc {camunda_ip}:18080;
    proxy_pass http://$kc$request_uri;{PROXY_HEADERS}
  }}
  location ^~ /auth/ {{ return 404; }}
  location / {{
    set $cam {camunda_ip}:8080;
    proxy_pass http://$cam$request_uri;{PROXY_HEADERS}
    proxy_read_timeout 3600s;
  }}"""))
        elif host == cfg["temporalUiHost"]:
            # Each user's own Temporal UI (decision 4.6). The API answers which one:
            # GET /v2/demo/temporal-ui/route (service/routers/demo_session.py) with
            # X-Auth-Request-Email, X-Original-URI and X-Shinro-Route-Secret
            # -> 200 + "X-Accel-Redirect: /_temporal/<node-ip>/<nodeport><uri>",
            #    or 404 with the "start a migration" page.
            consoles.append(console_servers(host, f"""{oauth2_blocks(proxy)}

  location / {{
    auth_request /oauth2/auth;
    error_page 401 = @signin;
    auth_request_set $email $upstream_http_x_auth_request_email;
    set $api http://shinro-api:8000;
    proxy_pass $api/v2/demo/temporal-ui/route;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $host;
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Auth-Request-Email $email;
    proxy_set_header X-Shinro-Route-Secret "{route_secret}";
  }}
  # Only sandbox NodePorts inside this VPC, whatever the API answers.
  # Quoted: nginx needs quotes around a regex containing braces.
  location ~ "^/_temporal/(?<tip>{vpc_ip_regex})/(?<tport>3[0-2][0-9]{{3}})(?<turi>/.*)$" {{
    internal;
    proxy_pass http://$tip:$tport$turi$is_args$args;{PROXY_HEADERS}
    proxy_read_timeout 3600s;
  }}"""))
        else:
            print(f"render.py: no nginx block for console {host}; skipped", file=sys.stderr)


write(NGINX / "20-consoles.conf", "# Generated by bin/render.py. The demo consoles: Temporal UI behind oauth2-proxy,\n"
      "# Camunda behind its own Keycloak login only.\n" + CONSOLE_ZONES
      + "".join(consoles) + "\n", mode=0o640)

print(f"render.py: {len(streams)} stream(s), {len(consoles)} console(s), api {api_env['FRONTEND_URL']}, "
      f"release {release.get('commit', 'unknown')[:12]}")
