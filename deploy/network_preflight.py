"""Read-only network gate. Run on the Linux Docker host, before stopping services.

Standalone Python 3.10+, no third-party dependencies. Also vendored by Airalogy
BD; keep copies byte-identical. Never prints Compose environment or credentials.
"""

import argparse
import ipaddress
import json
import os
import platform
import re
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


class CheckError(Exception):
    pass


def command(args):
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CheckError(
            f"Cannot run {args[0]}; install it on the deployment host."
        ) from None
    if result.returncode:
        # Command stderr may contain a resolved secret or the entire Compose config.
        raise CheckError(
            f"{args[0]} inspection failed (exit {result.returncode}); no deployment was started."
        )
    return result.stdout


def json_command(args):
    try:
        return json.loads(command(args))
    except ValueError:
        raise CheckError(f"Invalid inspection output from {args[0]}.") from None


def network(value, label, strict=False):
    try:
        return ipaddress.ip_network(value, strict=strict)
    except (ValueError, TypeError):
        raise CheckError(f"Invalid CIDR in {label}.") from None


def settings(compose):
    # Same --env-file/--project-directory as the deployment, including overrides.
    values = {}
    for line in command([*compose, "config", "--environment"]).splitlines():
        key, separator, value = line.partition("=")
        if separator and key.startswith("NETWORK_PREFLIGHT_"):
            values[key] = value
    cloud = values.get("NETWORK_PREFLIGHT_CLOUD", "none")
    if cloud not in ("none", "aliyun"):
        raise CheckError("NETWORK_PREFLIGHT_CLOUD must be none or aliyun.")
    protected = values.get("NETWORK_PREFLIGHT_PROTECTED_CIDRS", "").strip()
    if cloud == "none" and not protected:
        raise CheckError(
            "Set NETWORK_PREFLIGHT_PROTECTED_CIDRS to all VPC/VPN/LAN CIDRs, or explicitly 'none' for a host with no additional networks; on ECS set NETWORK_PREFLIGHT_CLOUD=aliyun."
        )
    cidrs = (
        []
        if protected in ("", "none")
        else [
            network(item, "protected networks", True)
            for item in re.split(r"[,\s]+", protected)
        ]
    )
    endpoints = re.split(
        r"[,\s]+", values.get("NETWORK_PREFLIGHT_ENDPOINTS", "").strip()
    )
    return cloud, cidrs, [item for item in endpoints if item]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise CheckError("Metadata redirect refused.")


def aliyun_vpc():
    # Fixed link-local provider endpoint, no proxies or RAM credentials. Token is
    # short-lived and only used to read network metadata (IMDS security mode).
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    base = "http://100.100.100.200/latest/"
    try:
        request = urllib.request.Request(
            base + "api/token",
            method="PUT",
            headers={"X-aliyun-ecs-metadata-token-ttl-seconds": "60"},
        )
        with opener.open(request, timeout=3) as response:
            token = response.read(4096).decode().strip()
        if not token:
            raise ValueError("empty metadata token")
        request = urllib.request.Request(
            base + "meta-data/vpc-cidr-block",
            headers={"X-aliyun-ecs-metadata-token": token},
        )
        with opener.open(request, timeout=3) as response:
            value = response.read(4096).decode().strip()
        return network(value, "Aliyun VPC", True)
    except (OSError, ValueError, CheckError):
        raise CheckError(
            "Cannot verify Aliyun VPC metadata; deployment blocked. Check IMDS access or supply verified CIDRs in manual mode; do not guess a subnet."
        ) from None


def pools(item):
    return [
        network(pool["Subnet"], "existing Docker network", True)
        for pool in (item.get("IPAM", {}).get("Config") or [])
        if pool.get("Subnet")
    ]


def bridge_device(item):
    return (item.get("Options") or {}).get("com.docker.network.bridge.name") or (
        "docker0" if item["Name"] == "bridge" else "br-" + item["Id"][:12]
    )


def plans(config, existing=None):
    live = existing is not None
    existing = existing or []
    by_name = {item["Name"]: item for item in existing}
    result = []
    for key, spec in config.get("networks", {}).items():
        name = spec.get("name", f"{config['name']}_{key}")
        actual = by_name.get(name)
        external = bool(spec.get("external"))
        if spec.get("driver", "bridge") != "bridge" or spec.get("enable_ipv6"):
            raise CheckError(
                f"Network {key}: this gate supports IPv4 bridge networks only."
            )
        declared = [
            network(item.get("subnet"), f"network {key}", True)
            for item in spec.get("ipam", {}).get("config", [])
        ]
        if external:
            if live and not actual:
                raise CheckError(f"External network {key} does not exist.")
            declared = pools(actual) if actual else declared
        if not declared and (not external or live):
            raise CheckError(
                f"Network {key}: explicit IPAM subnet required; Docker automatic allocation is not accepted."
            )
        for index, cidr in enumerate(declared):
            private = [
                ipaddress.ip_network(value)
                for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
            ]
            if (
                cidr.version != 4
                or not any(cidr.subnet_of(block) for block in private)
                or cidr.prefixlen > 29
            ):
                raise CheckError(
                    f"Network {key}: choose an RFC1918 IPv4 subnet with at least 8 addresses."
                )
            if any(cidr.overlaps(block) for block in declared[:index]):
                raise CheckError(f"Network {key}: overlapping IPAM pools.")
        if actual:
            labels = actual.get("Labels") or {}
            if actual["Driver"] != "bridge" or actual.get("EnableIPv6"):
                raise CheckError(
                    f"Existing network {key} is not an IPv4 bridge network."
                )
            if not external and (
                labels.get("com.docker.compose.project") != config["name"]
                or labels.get("com.docker.compose.network") != key
            ):
                raise CheckError(
                    f"Network {key} belongs to another deployment; choose another name."
                )
            if set(declared) != set(pools(actual)):
                raise CheckError(
                    f"Network {key}: configured subnet differs from the live network; plan an explicit maintenance migration before deployment."
                )
            actual_pools = {pool["Subnet"]: pool for pool in actual["IPAM"]["Config"]}
            for pool in spec.get("ipam", {}).get("config", []):
                live_pool = actual_pools[pool["subnet"]]
                for setting, inspected in (
                    ("gateway", "Gateway"),
                    ("ip_range", "IPRange"),
                ):
                    if pool.get(setting) and pool[setting] != live_pool.get(inspected):
                        raise CheckError(
                            f"Network {key}: live IPAM {setting} differs; plan a maintenance migration."
                        )
        result.append({"key": key, "cidrs": declared, "actual": actual})
    if not result:
        raise CheckError(
            "No bridge network found; host/container networking needs a separate deployment review."
        )
    return result


def check(plan, protected, existing=(), routes=(), addresses=(), endpoints=()):
    errors = []
    for index, entry in enumerate(plan):
        actual = entry["actual"]
        own_device = bridge_device(actual) if actual else None
        for cidr in entry["cidrs"]:
            prefix = f"Network {entry['key']} ({cidr})"
            for block in protected:
                if cidr.version == block.version and cidr.overlaps(block):
                    errors.append(f"{prefix} overlaps protected/cloud network {block}.")
            for other in plan[:index]:
                if any(cidr.overlaps(block) for block in other["cidrs"]):
                    errors.append(
                        f"{prefix} overlaps another planned network {other['key']}."
                    )
            for other in existing:
                if actual and actual["Id"] == other["Id"]:
                    continue
                if any(
                    cidr.version == block.version and cidr.overlaps(block)
                    for block in pools(other)
                ):
                    errors.append(
                        f"{prefix} overlaps another Docker network {other['Name']}."
                    )
            for route in routes:
                dst = route.get("dst", "default")
                if dst in ("default", "0.0.0.0/0"):
                    continue
                block = network(dst, "host route")
                # Only this exact reused bridge's connected/local routes are
                # exempt. Never exempt all 172/8 routes or every Docker bridge.
                own = (
                    own_device
                    and route.get("dev") == own_device
                    and not route.get("gateway")
                    and block.subnet_of(cidr)
                    and route.get("type", "unicast")
                    in ("unicast", "local", "broadcast")
                )
                if not own and block.version == cidr.version and cidr.overlaps(block):
                    errors.append(
                        f"{prefix} overlaps host route {block} on {route.get('dev', 'policy table')}."
                    )
            for interface in addresses:
                for address in interface.get("addr_info", []):
                    if address.get("family") != "inet":
                        continue
                    block = network(
                        f"{address['local']}/{address['prefixlen']}", "host interface"
                    )
                    if interface["ifname"] == own_device and block == cidr:
                        continue
                    if cidr.overlaps(block):
                        errors.append(
                            f"{prefix} overlaps interface {interface['ifname']} ({block})."
                        )
            for ip in endpoints:
                if ip.version == cidr.version and ip in cidr:
                    errors.append(
                        f"{prefix} would capture a configured external service address ({ip})."
                    )
    if errors:
        raise CheckError(
            "\n".join(dict.fromkeys(errors))
            + "\nChoose a nonoverlapping subnet and recheck. This tool never changes routes, networks, containers or volumes."
        )


def resolve_endpoints(config, explicit):
    internal = set(config.get("services", {}))
    values = list(explicit)
    for service in config.get("services", {}).values():
        for attachment in (service.get("networks") or {}).values():
            internal.update((attachment or {}).get("aliases") or [])
        env = service.get("environment") or {}
        for key in ("DATABASE_URL", "REDIS_URL", "MINIO_ENDPOINT", "BD_OSS_ENDPOINT"):
            if env.get(key):
                values.append(env[key])
    result = set()
    for value in set(values):
        try:
            host = urlsplit(value if "://" in value else "//" + value).hostname
            if not host:
                raise ValueError("missing host")
            if value not in explicit and host in internal:
                continue
            for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM):
                result.add(ipaddress.ip_address(item[4][0]))
        except (ValueError, OSError):
            raise CheckError(
                "Cannot resolve a configured external service. Check DNS and NETWORK_PREFLIGHT_ENDPOINTS; credentials and endpoint values are intentionally omitted."
            ) from None
    return result


def live_inventory():
    if (
        platform.system() != "Linux"
        or Path("/.dockerenv").exists()
        or Path("/run/.containerenv").exists()
    ):
        raise CheckError(
            "Run the live network check directly on the Linux Docker host; --config-only is not deployment approval."
        )
    endpoint = os.environ.get("DOCKER_HOST")
    if os.environ.get("DOCKER_CONTEXT") or not endpoint:
        context = json_command(["docker", "context", "inspect"])[0]
        endpoint = context["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise CheckError(
            "Remote Docker context refused; run this gate on the target host."
        )
    info = json_command(["docker", "info", "--format", "{{json .}}"])
    if (
        info.get("OSType") != "linux"
        or "desktop" in info.get("OperatingSystem", "").lower()
        or any("rootless" in value for value in info.get("SecurityOptions", []))
    ):
        raise CheckError(
            "Use the target host's regular Linux Docker Engine; this route check cannot validate rootless/Desktop networks."
        )
    ids = command(["docker", "network", "ls", "--quiet"]).split()
    existing = json_command(["docker", "network", "inspect", *ids]) if ids else []
    routes = json_command(["ip", "-j", "-4", "route", "show", "table", "all"])
    addresses = json_command(["ip", "-j", "-4", "address", "show"])
    if not routes or not addresses:
        raise CheckError(
            "Empty host network inventory; cannot verify deployment safety."
        )
    return existing, routes, addresses


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-only",
        action="store_true",
        help="offline syntax/CIDR check only, not a deployment gate",
    )
    parser.add_argument(
        "compose", nargs=argparse.REMAINDER, help="-- docker compose [global options]"
    )
    args = parser.parse_args()
    compose = args.compose[1:] if args.compose[:1] == ["--"] else args.compose
    if compose[:2] != ["docker", "compose"]:
        parser.error(
            "supply -- docker compose followed by the deployment's global options"
        )
    try:
        config = json_command([*compose, "config", "--format", "json"])
        cloud, protected, explicit = settings(compose)
        if args.config_only:
            check(plans(config), protected)
            print(
                "Network configuration valid. Host routes, live networks, cloud metadata and DNS NOT checked; this is not deployment approval."
            )
            return
        existing, routes, addresses = live_inventory()
        if cloud == "aliyun":
            protected.append(aliyun_vpc())
        plan = plans(config, existing)
        check(
            plan,
            protected,
            existing,
            routes,
            addresses,
            resolve_endpoints(config, explicit),
        )
        print(
            f"Network preflight passed: {len(plan)} planned/reused network(s); cloud/protected ranges, all host route tables, interfaces, Docker networks and configured service DNS checked. No changes made."
        )
    except CheckError as error:
        print(f"Network preflight BLOCKED:\n{error}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
