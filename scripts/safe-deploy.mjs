#!/usr/bin/env node
/**
 * safe-deploy.mjs -- verify-then-restart deployer for agentic-remote-pc runners.
 *
 * Prevents the failure mode where a bad build is pulled and the live service is
 * restarted into a crashing process. It boots the NEW code on a side port FIRST
 * (using the host real environment) and only restarts the live service if that
 * side boot answers /health. Otherwise it aborts and prints the crash stderr,
 * leaving the live service untouched.
 *
 * Configure via env:
 *   HOST_URL     https://your-host.example.com   (the live runner)
 *   HOST_KEY     RUNNER_API_KEY for that host
 *   HOST_OS      win | linux
 *   REPO_DIR     path to the repo on the host
 *   BRANCH       git branch to pull
 *   RESTART_CMD  command that restarts the host service, e.g.
 *                  win:   Restart-Service -Name ptait-desk03-runner
 *                  linux: sudo systemctl restart htpc01-runner
 *   SIDE_PORT    optional, default 7399
 *
 *   node scripts/safe-deploy.mjs
 */
const URL = process.env.HOST_URL;
const KEY = process.env.HOST_KEY;
const OS = process.env.HOST_OS || "linux";
const REPO = process.env.REPO_DIR;
const BRANCH = process.env.BRANCH;
const RESTART = process.env.RESTART_CMD;
const SIDE = process.env.SIDE_PORT || "7399";
const SHELL = OS === "win" ? "pwsh" : "bash";
const testKey = "safe-deploy-boottest";
for (const v of ["HOST_URL", "HOST_KEY", "REPO_DIR", "BRANCH", "RESTART_CMD"]) {
  if (!process.env[v]) { console.error("Missing env: " + v); process.exit(2); }
}
const headers = { "Content-Type": "application/json", Authorization: "Bearer " + KEY };
async function exec(command, timeoutMs) {
  const r = await fetch(URL + "/exec", { method: "POST", headers, body: JSON.stringify({ shell: SHELL, command, timeout: timeoutMs || 60000 }) });
  const j = await r.json();
  return { status: j.status, exit: j.exitCode, output: (j.output || "") + (j.stderr ? "\n[stderr] " + j.stderr : "") };
}
function bootCmd() {
  const pull = [
    "cd " + REPO,
    "git fetch origin " + BRANCH + " 2>&1 | " + (OS === "win" ? "Select-Object -Last 2" : "tail -2"),
    "git stash push -m safe-deploy 2>&1 | " + (OS === "win" ? "Select-Object -Last 1" : "tail -1"),
    "git pull origin " + BRANCH + " --ff-only 2>&1 | " + (OS === "win" ? "Select-Object -Last 2" : "tail -2"),
    "npm install --no-audit --no-fund 2>&1 | " + (OS === "win" ? "Select-Object -Last 2" : "tail -2")
  ];
  if (OS === "win") {
    return pull.concat([
      "[Environment]::SetEnvironmentVariable('RUNNER_PORT','" + SIDE + "','Process')",
      "[Environment]::SetEnvironmentVariable('RUNNER_API_KEY','" + testKey + "','Process')",
      "$p = Start-Process node -ArgumentList 'src/server.js' -PassThru -WindowStyle Hidden -RedirectStandardOutput side.out -RedirectStandardError side.err",
      "Start-Sleep -Seconds 3",
      "try { (Invoke-RestMethod -Uri 'http://localhost:" + SIDE + "/health' -TimeoutSec 5).ok } catch { 'NOHEALTH' }",
      "if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id }",
      "'---STDERR---'; Get-Content side.err -ErrorAction SilentlyContinue | Select-Object -First 40",
      "'---STDOUT---'; Get-Content side.out -ErrorAction SilentlyContinue | Select-Object -First 6"
    ]).join("\n");
  }
  return pull.concat([
    "RUNNER_PORT=" + SIDE + " RUNNER_API_KEY=" + testKey + " node src/server.js > /tmp/arp-side.out 2>/tmp/arp-side.err &",
    "echo $! > /tmp/arp-side.pid",
    "sleep 3",
    "curl -s -m 5 http://localhost:" + SIDE + "/health || echo NOHEALTH",
    "kill $(cat /tmp/arp-side.pid) 2>/dev/null || true",
    "echo '---STDERR---'; head -40 /tmp/arp-side.err 2>/dev/null",
    "echo '---STDOUT---'; head -6 /tmp/arp-side.out 2>/dev/null"
  ]).join("\n");
}
async function main() {
  console.log("safe-deploy to " + URL + " (" + OS + ") branch " + BRANCH);
  console.log("\n[1/3] pull + temp boot test on side port " + SIDE + " ...");
  const b = await exec(bootCmd(), 120000);
  console.log(b.output.trim());
  const head = b.output.split(/---STDERR---/)[0];
  const ok = /"ok"\s*:\s*true|^\s*True\s*$/m.test(head) && !/NOHEALTH/i.test(head);
  if (!ok) {
    console.log("\nABORT: side boot did not answer /health. Live service NOT restarted.");
    console.log("Fix the error above and re-run. The live runner on " + URL + " is untouched.");
    process.exit(1);
  }
  console.log("\n[2/3] side boot OK. Restarting live service (connection may drop) ...");
  try { const r = await exec(RESTART, 30000); console.log(r.output.trim().slice(0, 200)); }
  catch (e) { console.log("restart call dropped (expected): " + e); }
  console.log("\n[3/3] polling live /health ...");
  let live = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(x => setTimeout(x, 2000));
    try { const h = await (await fetch(URL + "/health", { signal: AbortSignal.timeout(5000) })).json(); if (h.ok) { live = true; console.log("LIVE HEALTH OK: " + JSON.stringify(h)); break; } } catch {}
  }
  if (!live) { console.log("WARNING: live health not back after 40s. Check the service manually."); process.exit(1); }
  const i = await (await fetch(URL + "/info", { headers })).json();
  console.log("DEPLOYED: service=" + i.service + " version=" + i.version + " tools=" + i.mcp.tools.length);
}
main().catch(e => { console.error("safe-deploy error:", e); process.exit(1); });
