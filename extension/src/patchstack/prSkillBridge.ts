import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit, tryGit } from './gitRunner';
import { classifyBranch, GitStackEngine } from './gitStackEngine';
import { BranchClassificationConfig, PullRequestContext } from './types';

/**
 * Collect structured Pull Request context for a maintainer branch (Section 6.3).
 */
export async function buildPullRequestContext(
  engine: GitStackEngine,
  branch: string,
  config: BranchClassificationConfig,
  publicRemote = 'origin'
): Promise<PullRequestContext> {
  const repoDir = engine.getRepoDir();
  const explicitRaw = await engine.getBranchConfig(branch, 'kdev-role');
  const explicitRole =
    explicitRaw === 'topic' || explicitRaw === 'review' || explicitRaw === 'maintainer'
      ? explicitRaw
      : undefined;
  const classification = classifyBranch(branch, config, explicitRole);

  const { baseRef, baseSha } = await engine.resolveBaseRefAndSha(branch);
  const headSha = (await runGit(repoDir, ['rev-parse', branch])).stdout.trim();
  const countRes = await runGit(repoDir, ['rev-list', '--count', `${baseSha}..${headSha}`]);
  const commitCount = Number.parseInt(countRes.stdout.trim(), 10) || 0;

  // Find annotated/signed tags pointing at HEAD
  const tagsRes = await tryGit(repoDir, ['tag', '--points-at', headSha]);
  const existingSignedTags =
    tagsRes.exitCode === 0
      ? tagsRes.stdout
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

  // Check remote push status without modifying anything
  let remoteHeadSha: string | null = null;
  let branchPushed = false;
  const pushedTags: string[] = [];

  const lsBranch = await tryGit(repoDir, ['ls-remote', publicRemote, `refs/heads/${branch}`], {
    timeoutMs: 15_000,
  });
  if (lsBranch.exitCode === 0 && lsBranch.stdout.trim()) {
    const firstCol = lsBranch.stdout.trim().split(/\s+/)[0];
    if (firstCol) {
      remoteHeadSha = firstCol;
      branchPushed = firstCol === headSha;
    }
  }

  if (existingSignedTags.length > 0) {
    const tagRefs = existingSignedTags.map((t) => `refs/tags/${t}`);
    const lsTags = await tryGit(repoDir, ['ls-remote', publicRemote, ...tagRefs], {
      timeoutMs: 15_000,
    });
    if (lsTags.exitCode === 0) {
      for (const line of lsTags.stdout.split(/\r?\n/)) {
        const m = line.match(/refs\/tags\/(\S+)/);
        if (m) {
          pushedTags.push(m[1]);
        }
      }
    }
  }

  const shortlogRes = await tryGit(repoDir, ['shortlog', `${baseSha}..${headSha}`]);
  const diffstatRes = await tryGit(repoDir, ['diff', '--stat', `${baseSha}..${headSha}`]);

  return {
    generatedAt: new Date().toISOString(),
    branch,
    subsystem: classification.subsystem ?? '',
    cadence: classification.cadence ?? 'custom',
    baseRef,
    baseSha,
    headSha,
    commitCount,
    existingSignedTags,
    remotePushStatus: {
      remote: publicRemote,
      branchPushed,
      remoteHeadSha,
      pushedTags,
    },
    shortlog: shortlogRes.stdout.trimEnd(),
    diffstat: diffstatRes.stdout.trimEnd(),
  };
}

export function writePullRequestContext(contextPath: string, ctx: PullRequestContext): void {
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, `${JSON.stringify(ctx, null, 2)}\n`, 'utf-8');
}

/**
 * Expand `{branch}`, `{contextFile}`, `{kernelDir}` placeholders in `kdev.git.prSkillCommand`.
 */
export function expandPrSkillCommand(
  template: string,
  vars: { branch: string; contextFile: string; kernelDir: string }
): string {
  return template
    .replace(/\{branch\}/g, vars.branch)
    .replace(/\{contextFile\}/g, vars.contextFile)
    .replace(/\{kernelDir\}/g, vars.kernelDir);
}
