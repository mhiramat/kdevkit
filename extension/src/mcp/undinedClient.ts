import { McpStdioClient } from './mcpClient';

export interface UndineDClientOptions {
  undinedBin: string;
  configPath?: string;
  webBaseUrl?: string;
  requestTimeoutMs?: number;
  logger?: (line: string) => void;
}

export interface SeriesMessageInput {
  index: number;
  is_cover_letter: boolean;
  subject: string;
  body: string;
  commit_sha?: string;
  extra_to?: string[];
  extra_cc?: string[];
}

export interface StagePatchSeriesParams {
  series_key: string;
  branch?: string;
  version?: number;
  to: string[];
  cc?: string[];
  in_reply_to?: string;
  base_commit?: string;
  replace_existing?: boolean;
  messages: SeriesMessageInput[];
}

export interface StagePatchSeriesItemResult {
  index: number;
  draft_id: string;
  message_id: string;
  status: string;
}

export interface StagePatchSeriesResult {
  series_id: string;
  series_key: string;
  message_count: number;
  root_message_id: string;
  items: StagePatchSeriesItemResult[];
  web_url: string;
}

export interface CreateMailDraftParams {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  in_reply_to?: string;
  references?: string[];
  extra_headers?: Record<string, string>;
  tags?: string[];
}

export interface CreateMailDraftResult {
  draft_id: string;
  message_id: string;
  maildir_path: string;
  web_url: string;
}

export interface ExportThreadMboxParams {
  message_id: string;
  output_path?: string;
  patches_only?: boolean;
}

export interface ExportThreadMboxResult {
  mbox_path: string;
  patch_count: number;
  base_commit?: string;
  root_message_id?: string;
}

export interface ImportPatchSeriesB4Result {
  success: boolean;
  message_id: string;
  imported_count: number;
  indexed_ids: number[];
}

export interface PatchworkPatchInfo {
  id: number;
  state: string;
  is_delegated_to_me?: boolean;
  checks?: unknown[];
  series?: Record<string, unknown>;
}

/**
 * Typed wrapper around UndineD's MCP STDIO server (`undined --mcp-stdio`).
 * Strictly enforces the Draft-Only / Read / Patchwork boundary (zero SMTP send APIs).
 */
export class UndineDMcpClient {
  private readonly mcp: McpStdioClient;
  private readonly webBaseUrl: string;

  constructor(options: UndineDClientOptions) {
    const args: string[] = [];
    if (options.configPath) {
      args.push('--config', options.configPath);
    }
    args.push('--mcp-stdio');

    this.webBaseUrl = (options.webBaseUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    this.mcp = new McpStdioClient({
      command: options.undinedBin,
      args,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      clientName: 'kdevkit',
      clientVersion: '0.1.0',
      logger: options.logger,
    });
  }

  public getWebBaseUrl(): string {
    return this.webBaseUrl;
  }

  public async listTools() {
    return this.mcp.listTools();
  }

  public async stagePatchSeries(
    params: StagePatchSeriesParams
  ): Promise<StagePatchSeriesResult> {
    const res = await this.mcp.callTool<StagePatchSeriesResult>(
      'stage_patch_series',
      params as unknown as Record<string, unknown>
    );
    if (res && !res.web_url && res.series_id) {
      res.web_url = `${this.webBaseUrl}/#series/${res.series_id}`;
    }
    return res;
  }

  public async createMailDraft(
    params: CreateMailDraftParams
  ): Promise<CreateMailDraftResult> {
    const res = await this.mcp.callTool<CreateMailDraftResult>(
      'create_mail_draft',
      params as unknown as Record<string, unknown>
    );
    if (res && !res.web_url && res.draft_id) {
      res.web_url = `${this.webBaseUrl}/#drafts/${res.draft_id}`;
    }
    return res;
  }

  public async exportThreadMbox(
    params: ExportThreadMboxParams
  ): Promise<ExportThreadMboxResult> {
    return this.mcp.callTool<ExportThreadMboxResult>(
      'export_thread_mbox',
      params as unknown as Record<string, unknown>
    );
  }

  public async importPatchSeriesB4(
    messageIdOrUrl: string
  ): Promise<ImportPatchSeriesB4Result> {
    return this.mcp.callTool<ImportPatchSeriesB4Result>('import_patch_series_b4', {
      message_id_or_url: messageIdOrUrl,
    });
  }

  public async getPatchworkPatchInfo(messageId: string): Promise<PatchworkPatchInfo> {
    return this.mcp.callTool<PatchworkPatchInfo>('get_patchwork_patch_info', {
      message_id: messageId,
    });
  }

  public async updatePatchworkPatch(params: {
    patch_id: number;
    state?: string;
    delegate_to_me?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.mcp.callTool<Record<string, unknown>>('update_patchwork_patch', params);
  }

  public async dispose(): Promise<void> {
    await this.mcp.dispose();
  }
}
