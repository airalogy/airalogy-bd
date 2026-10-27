import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

test("deployment checker rejects automatic allocation and protected VPC overlap", () => {
  const script = `import importlib.util
s=importlib.util.spec_from_file_location('guard', 'deploy/network_preflight.py')
g=importlib.util.module_from_spec(s); s.loader.exec_module(g)
c={'name':'fixture','networks':{'default':{'name':'fixture_default','ipam':{}}}}
try: g.plans(c)
except g.CheckError: pass
else: raise AssertionError('automatic subnet allocation accepted')
c['networks']['default']['ipam']={'config':[{'subnet':'172.20.0.0/16'}]}
try: g.check(g.plans(c), [g.network('172.16.0.0/12','fixture')])
except g.CheckError: pass
else: raise AssertionError('overlapping VPC accepted')
c['networks']['default']['ipam']={'config':[{'subnet':'192.168.246.0/24'}]}
g.check(g.plans(c), [g.network('172.16.0.0/12','fixture')])
`;
  execFileSync("python3", ["-c", script], { cwd: root, stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
});

test("bdctl cannot create containers when the network check fails", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-network-gate-"));
  try {
    writeFileSync(path.join(directory, "bdctl"), readFileSync(path.join(root, "deploy/bdctl")));
    writeFileSync(path.join(directory, "compose.yaml"), "services: {}\n");
    writeFileSync(path.join(directory, ".env"), "");
    writeFileSync(path.join(directory, "network_preflight.py"), "raise SystemExit(17)\n");
    const marker = path.join(directory, "mutated");
    const docker = path.join(directory, "docker");
    writeFileSync(docker, '#!/bin/sh\ntouch "$MARKER"\n'); chmodSync(docker, 0o755);
    for (const command of ["up", "run", "create", "start", "restart", "build"]) {
      const result = spawnSync("bash", [path.join(directory, "bdctl"), command], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MARKER: marker }, encoding: "utf8",
      });
      assert.equal(result.status, 17);
      assert.throws(() => readFileSync(marker), { code: "ENOENT" });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("bdctl checks and executes the same override configuration", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-network-override-"));
  try {
    writeFileSync(path.join(directory, "bdctl"), readFileSync(path.join(root, "deploy/bdctl")));
    writeFileSync(path.join(directory, "compose.yaml"), "services: {}\n");
    writeFileSync(path.join(directory, ".env"), "");
    for (const name of ["python3", "docker"]) {
      const file = path.join(directory, name);
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "$TRACE/${name}.args"\n`);
      chmodSync(file, 0o755);
    }
    const override = path.join(directory, "override.yaml");
    writeFileSync(override, "networks: {}\n");
    execFileSync("bash", [path.join(directory, "bdctl"), "up", "--no-build"], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TRACE: directory, BD_COMPOSE_OVERRIDE: override },
    });
    const checked = readFileSync(path.join(directory, "python3.args"), "utf8").trim().split("\n");
    const executed = readFileSync(path.join(directory, "docker.args"), "utf8").trim().split("\n");
    assert.deepEqual(checked.slice(3), executed.slice(0, -2));
    assert.deepEqual(executed.slice(-4), ["-f", override, "up", "--no-build"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
