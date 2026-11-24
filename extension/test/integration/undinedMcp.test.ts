import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UndineDMcpClient } from '../../src/mcp/undinedClient';

const undinedBin = process.env.KDEV_UNDINED_BIN || 'undined';

function hasUndinedBinary(): boolean {
  try {
    execFileSync(undinedBin, ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasUndinedBinary())(
  'UndineDMcpClient integration (Layer 3: isolated real undined --mcp-stdio)',
  () => {
    let tmpDir: string;
    let configPath: string;
    let maildirPath: string;
    let client: UndineDMcpClient;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdev-undined-int-'));
      const dataDir = path.join(tmpDir, 'data');
      maildirPath = path.join(dataDir, 'maildir');
      const dbPath = path.join(dataDir, 'undined.db');
      const logFile = path.join(tmpDir, 'undined.log');
      fs.mkdirSync(dataDir, { recursive: true });

      configPath = path.join(tmpDir, 'config.toml');
      fs.writeFileSync(
        configPath,
        [
          '[general]',
          'host = "127.0.0.1"',
          'port = 18080',
          `data_dir = "${dataDir}"`,
          `maildir_path = "${maildirPath}"`,
          `db_path = "${dbPath}"`,
          `log_file = "${logFile}"`,
          'log_level = "INFO"',
          '',
          '[smtp]',
          'host = "127.0.0.1"',
          'port = 1',
          'from_name = "Test Developer"',
          'from_email = "dev@kernel.org"',
          '',
          '[mcp]',
          'enabled = true',
          'transport = "stdio"',
          '',
        ].join('\n'),
        'utf-8'
      );

      client = new UndineDMcpClient({
        undinedBin,
        configPath,
        webBaseUrl: 'http://127.0.0.1:18080',
        requestTimeoutMs: 20_000,
      });
    });

    afterEach(async () => {
      await client.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stages a patch series and standalone mail draft into isolated Maildir Drafts without SMTP send', async () => {
      const tools = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('stage_patch_series');
      expect(toolNames).toContain('create_mail_draft');
      expect(toolNames).toContain('export_thread_mbox');

      const staged = await client.stagePatchSeries({
        series_key: 'topic/test-series:v1',
        branch: 'topic/test-series',
        version: 1,
        to: ['Maintainer <maintainer@kernel.org>'],
        cc: ['linux-kernel@vger.kernel.org'],
        base_commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        replace_existing: true,
        messages: [
          {
            index: 0,
            is_cover_letter: true,
            subject: '[PATCH 0/1] test: cover letter',
            body: 'Overview with\traw tab.\n',
          },
          {
            index: 1,
            is_cover_letter: false,
            subject: '[PATCH 1/1] test: sample patch',
            body: 'Sample commit body.\n\n---\n a.c | 1 +\n@@ -1 +1 @@\n+\treturn 0;\n',
            commit_sha: '1111111111111111111111111111111111111111',
          },
        ],
      });

      expect(staged.series_id).toBeTruthy();
      expect(staged.message_count).toBe(2);
      expect(staged.items).toHaveLength(2);
      expect(staged.items.every((item) => item.status === 'draft')).toBe(true);

      // Confirm drafts exist on disk in isolated Maildir/Drafts and preserve raw tabs
      const draftsCur = path.join(maildirPath, 'Drafts', 'cur');
      const draftFiles = fs.existsSync(draftsCur) ? fs.readdirSync(draftsCur) : [];
      expect(draftFiles.length).toBeGreaterThanOrEqual(2);
      const combinedDraftContent = draftFiles
        .map((f) => fs.readFileSync(path.join(draftsCur, f), 'utf-8'))
        .join('\n');
      expect(combinedDraftContent).toContain('+\treturn 0;');

      // Confirm create_mail_draft also stages standalone PR draft cleanly
      const prDraft = await client.createMailDraft({
        to: ['Linus Torvalds <torvalds@linux-foundation.org>'],
        cc: ['linux-kernel@vger.kernel.org'],
        subject: '[GIT PULL] probes: Fixes for v6.14-rc3',
        body: 'Hi Linus,\n\nPlease pull the following fixes:\n\t- fix 1\n',
        tags: ['PR-Draft'],
      });
      expect(prDraft.draft_id).toBeTruthy();
      expect(prDraft.maildir_path).toContain(maildirPath);
      expect(fs.existsSync(prDraft.maildir_path)).toBe(true);
    });
  }
);
