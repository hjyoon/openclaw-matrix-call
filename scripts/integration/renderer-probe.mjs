import { readdir, readFile } from "node:fs/promises";

const renderers = [];
for (const name of await readdir("/proc")) {
  if (!/^\d+$/.test(name)) continue;
  try {
    const status = await readFile(`/proc/${name}/status`, "utf8");
    if (!/^Name:\s+(?:chrome|CrRendererMain)\s*$/m.test(status)) continue;
    const namespaces = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).length ?? 0;
    const filters = Number(status.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]);
    renderers.push({ namespaces, filters, seccomp: /Seccomp:\s+2/.test(status), noNewPrivileges: /NoNewPrivs:\s+1/.test(status) });
  } catch {}
}
console.log(JSON.stringify({ renderers, uid: process.getuid() }));
