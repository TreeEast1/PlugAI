// Usage: tsx scripts/probe/run-agent.mts <board> "<project name>" "<prompt>" [projectId]
import { agent, newProject, describeRun } from '../test/client.ts';
const [board, name, prompt, existing] = process.argv.slice(2);
const pid = existing ?? (await newProject(name, board as any)).id;
console.log('project', pid);
const r = await agent(pid, prompt, 1_200_000, (s) => console.log('  ', s));
describeRun(r).forEach((l) => console.log(l));
console.log('FINAL', r.summary.status, '\n' + (r.summary.summary ?? '').slice(0, 1500));
