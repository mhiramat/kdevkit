export type BranchRole = 'topic' | 'review' | 'maintainer' | 'other';
export type MaintainerCadence = 'fixes' | 'for-next' | 'custom';
export type GitOperationState = 'clean' | 'rebase' | 'am' | 'cherry-pick';

export interface BranchClassificationConfig {
  topicPrefix: string;
  reviewPrefix: string;
  maintainerPrefixes: string[];
  fixesSuffixes: string[];
  nextSuffixes: string[];
}

export interface BranchClassification {
  role: BranchRole;
  cadence?: MaintainerCadence;
  subsystem?: string;
}

export interface BranchInfo {
  name: string;
  role: BranchRole;
  cadence?: MaintainerCadence;
  subsystem?: string;
  isCurrent: boolean;
  baseRef?: string;
  upstreamRef?: string;
  version?: number;
  sourceMsgId?: string;
  aheadCount?: number;
}

export interface StackCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
  hasSignedOffBy: boolean;
  published: boolean;
  index: number; // 1-based from base (1 = oldest/bottom, N = HEAD/top)
}

export interface StackInspection {
  branch: string;
  role: BranchRole;
  cadence?: MaintainerCadence;
  subsystem?: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  commits: StackCommit[];
  opState: GitOperationState;
  conflictingFiles: string[];
  isDirty: boolean;
  hasStagedChanges: boolean;
  undoCount: number;
  poppedCount: number;
}

export interface StackMutationResult {
  status: 'ok' | 'conflict';
  conflictingFiles?: string[];
  message?: string;
  undoRef?: string;
}

export interface StagedSeriesRecord {
  version: number;
  stagedAt: string;
  baseSha: string;
  headSha: string;
  gitRef: string;
  undinedSeriesId?: string;
  coverMessageId?: string;
  webUrl?: string;
}

export interface SeriesMetadata {
  schemaVersion: 1;
  branch: string;
  version: number;
  subjectPrefix: string;
  baseRef: string;
  recipients: {
    to: string[];
    cc: string[];
  };
  inReplyTo: string | null;
  forceCoverLetter?: boolean;
  stagedHistory: StagedSeriesRecord[];
}

export interface FormattedPatch {
  index: number;
  isCoverLetter: boolean;
  filePath: string;
  subject: string;
  body: string;
  commitSha?: string;
}

export interface CheckpatchIssue {
  severity: 'ERROR' | 'WARNING' | 'CHECK';
  file?: string;
  line?: number;
  message: string;
}

export interface PreflightResult {
  maintainers: string[];
  checkpatchIssues: CheckpatchIssue[];
  missingSignoffShas: string[];
  errorCount: number;
  warningCount: number;
}

export interface PullRequestContext {
  generatedAt: string;
  branch: string;
  subsystem: string;
  cadence: MaintainerCadence;
  baseRef: string;
  baseSha: string;
  headSha: string;
  commitCount: number;
  existingSignedTags: string[];
  remotePushStatus: {
    remote: string;
    branchPushed: boolean;
    remoteHeadSha: string | null;
    pushedTags: string[];
  };
  shortlog: string;
  diffstat: string;
}
